/**
 * Claude Code CLI runner using child_process.spawn.
 * Supports cancellation via AbortController.
 */
import * as vscode from 'vscode';
import { spawn, ChildProcess } from 'child_process';

export interface ClaudeResult {
  result: string;
  sessionId?: string;
  rawOutput?: string; // raw stdout + stderr from the CLI process
}

export type ClaudeOutputStream = 'claude' | 'stderr';
export type ClaudeOutputHandler = (stream: ClaudeOutputStream, chunk: string) => void;

export class ClaudeRunner {
  private currentProcess: ChildProcess | null = null;
  private abortController: AbortController | null = null;

  /**
   * Run a single Claude Code CLI command with the given prompt.
   */
  async run(prompt: string, onOutput?: ClaudeOutputHandler): Promise<ClaudeResult> {
    return this._runSingle(prompt, onOutput);
  }

  /**
   * Run multiple prompts in parallel with concurrency control.
   * onProgress(index, status, message, rawOutput?) is called for lifecycle events.
   * 'done' callbacks include the raw CLI stdout+stderr.
   */
  async runParallel(
    prompts: string[],
    concurrency: number = 3,
    onProgress?: (
      index: number,
      status: 'start' | 'output' | 'done' | 'error',
      message: string,
      rawOutput?: string,
      stream?: ClaudeOutputStream
    ) => void
  ): Promise<(ClaudeResult | null)[]> {
    console.log(`[DeepDoc] Running ${prompts.length} prompts in parallel (max concurrency: ${concurrency})`);

    const results: (ClaudeResult | null)[] = new Array(prompts.length).fill(null);
    const active: Promise<void>[] = [];
    let index = 0;

    const runNext = async (): Promise<void> => {
      while (index < prompts.length) {
        const currentIndex = index++;
        const label = `[${currentIndex + 1}/${prompts.length}]`;
        console.log(`[DeepDoc] Starting sub-agent ${label}`);
        onProgress?.(currentIndex, 'start', `Sub-agent ${currentIndex + 1}/${prompts.length} starting...`);

        try {
          const result = await this._runSingle(prompts[currentIndex], (stream, chunk) => {
            onProgress?.(currentIndex, 'output', chunk, undefined, stream);
          });
          results[currentIndex] = result;
          console.log(`[DeepDoc] Sub-agent ${label} completed`);
          onProgress?.(
            currentIndex,
            'done',
            `Sub-agent ${currentIndex + 1}/${prompts.length} completed`,
            result.rawOutput || result.result
          );
        } catch (err: any) {
          console.error(`[DeepDoc] Sub-agent ${label} failed:`, err.message);
          results[currentIndex] = null;
          onProgress?.(currentIndex, 'error', `Sub-agent ${currentIndex + 1}/${prompts.length} failed: ${err.message}`);
        }
      }
    };

    for (let i = 0; i < concurrency && i < prompts.length; i++) {
      active.push(runNext());
    }

    await Promise.all(active);

    const successCount = results.filter((r) => r !== null).length;
    console.log(`[DeepDoc] Parallel run complete: ${successCount}/${prompts.length} succeeded`);
    onProgress?.(-1, 'done', `Complete: ${successCount}/${prompts.length} succeeded`);
    return results;
  }

  private _runSingle(prompt: string, onOutput?: ClaudeOutputHandler): Promise<ClaudeResult> {
    const config = vscode.workspace.getConfiguration('vscode-deep-doc');
    const claudePath = config.get<string>('claudePath', 'claude');
    const timeoutSec = config.get<number>('claudeTimeout', 120);

    const args = [
      '--print',
      '--output-format', 'stream-json',
      '--verbose',
      prompt,
    ];

    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

    console.log(`[DeepDoc] Running claude (${prompt.length} chars prompt)...`);

    return new Promise<ClaudeResult>((resolve, reject) => {
      const proc = spawn(claudePath, args, {
        cwd: cwd || process.cwd(),
        env: { ...process.env },
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: timeoutSec * 1000,
      });
      this.currentProcess = proc;

      let stdout = '';
      let stderr = '';
      let stdoutBuffer = '';
      let result = '';
      let sessionId: string | undefined;

      proc.stdout?.on('data', (chunk: Buffer) => {
        const text = chunk.toString();
        stdout += text;
        stdoutBuffer += text;

        const lines = stdoutBuffer.split(/\r?\n/);
        stdoutBuffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) { continue; }

          try {
            const event = JSON.parse(trimmed);
            const parsed = this.parseClaudeStreamEvent(event);
            if (parsed.sessionId) {
              sessionId = parsed.sessionId;
            }
            if (parsed.result) {
              result = parsed.result;
            }
            if (parsed.log) {
              onOutput?.('claude', parsed.log);
            }
          } catch {
            onOutput?.('claude', trimmed);
          }
        }
      });

      proc.stderr?.on('data', (chunk: Buffer) => {
        const text = chunk.toString();
        stderr += text;
        onOutput?.('stderr', text);
        console.log(`[DeepDoc] Claude stderr: ${text.trim()}`);
      });

      proc.on('error', (err: Error) => {
        this.currentProcess = null;
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          reject(new Error(
            `Claude CLI not found at "${claudePath}". ` +
            'Install Claude Code or configure "vscode-deep-doc.claudePath".'
          ));
        } else {
          reject(new Error(`Failed to run Claude: ${err.message}`));
        }
      });

      proc.on('close', (code) => {
        this.currentProcess = null;
        const pending = stdoutBuffer.trim();
        if (pending) {
          try {
            const event = JSON.parse(pending);
            const parsed = this.parseClaudeStreamEvent(event);
            if (parsed.sessionId) {
              sessionId = parsed.sessionId;
            }
            if (parsed.result) {
              result = parsed.result;
            }
            if (parsed.log) {
              onOutput?.('claude', parsed.log);
            }
          } catch {
            onOutput?.('claude', pending);
          }
        }

        const rawOutput = (stdout + (stderr ? '\n--- stderr ---\n' + stderr : '')).trim();

        if (code !== 0) {
          reject(new Error(stderr.trim() || rawOutput || `Exit code ${code}`));
          return;
        }
        if (!stdout.trim()) {
          reject(new Error('Empty output'));
          return;
        }
        resolve({
          result: result || this.extractFallbackResult(stdout),
          sessionId,
          rawOutput,
        });
      });
    });
  }

  private parseClaudeStreamEvent(event: any): { log?: string; result?: string; sessionId?: string } {
    const sessionId = event.session_id || event.sessionId;

    if (event.type === 'system' || event.type === 'init') {
      return { sessionId };
    }

    if (event.type === 'assistant' && event.message?.content) {
      const lines = this.formatMessageContent(event.message.content);
      return {
        log: lines.length > 0 ? lines.join('\n') : undefined,
        sessionId,
      };
    }

    if (event.type === 'user' && event.message?.content) {
      const toolResults = this.formatToolResults(event.message.content);
      return {
        log: toolResults.length > 0 ? toolResults.join('\n') : undefined,
        sessionId,
      };
    }

    if (event.type === 'result') {
      return {
        result: event.result,
        sessionId,
      };
    }

    if (event.type === 'error') {
      return {
        log: `Error: ${event.message || event.error || JSON.stringify(event)}`,
        sessionId,
      };
    }

    return { sessionId };
  }

  private formatMessageContent(content: any[]): string[] {
    const lines: string[] = [];

    for (const block of content) {
      if (block.type === 'text' && block.text) {
        lines.push(block.text.trim());
      } else if (block.type === 'tool_use') {
        const input = this.summarizeToolInput(block.input);
        lines.push(`${block.name}${input ? ` ${input}` : ''}`);
      }
    }

    return lines.filter(Boolean);
  }

  private formatToolResults(content: any[]): string[] {
    const lines: string[] = [];

    for (const block of content) {
      if (block.type !== 'tool_result') { continue; }

      const content = typeof block.content === 'string'
        ? block.content
        : JSON.stringify(block.content);
      const label = block.is_error ? 'Error' : 'Output';
      lines.push(`${label}\n${this.truncateLogContent(content)}`);
    }

    return lines;
  }

  private summarizeToolInput(input: any): string {
    if (!input || typeof input !== 'object') { return ''; }

    if (input.command) {
      return this.truncateLogContent(String(input.command), 300);
    }
    if (input.file_path) {
      return String(input.file_path);
    }
    if (input.pattern) {
      return String(input.pattern);
    }

    return this.truncateLogContent(JSON.stringify(input), 300);
  }

  private truncateLogContent(text: string, maxLength: number = 2000): string {
    if (text.length <= maxLength) { return text; }
    return text.slice(0, maxLength) + '\n... (truncated)';
  }

  private extractFallbackResult(stdout: string): string {
    let fallback = '';
    for (const line of stdout.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) { continue; }
      try {
        const event = JSON.parse(trimmed);
        if (event.type === 'assistant' && event.message?.content) {
          const text = event.message.content
            .filter((block: any) => block.type === 'text' && block.text)
            .map((block: any) => block.text)
            .join('\n');
          if (text) {
            fallback += (fallback ? '\n' : '') + text;
          }
        }
      } catch {
        // Ignore malformed stream fragments in fallback extraction.
      }
    }
    return fallback || stdout.trim();
  }

  /**
   * Cancel the currently running Claude process.
   */
  cancel(): void {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    if (this.currentProcess) {
      this.currentProcess.kill('SIGTERM');
      this.currentProcess = null;
    }
  }

  /**
   * Check if Claude CLI is available.
   */
  static async checkAvailability(claudePath: string = 'claude'): Promise<boolean> {
    return new Promise((resolve) => {
      const proc = spawn('which', [claudePath], { stdio: 'pipe' });
      proc.on('close', (code) => resolve(code === 0));
      proc.on('error', () => resolve(false));
    });
  }
}
