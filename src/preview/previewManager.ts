/**
 * Manages the webview panel lifecycle: creation, content updates, and disposal.
 * Handles the two-phase Claude Code submission pipeline.
 */
import * as vscode from 'vscode';
import * as fs from 'fs';
import { AnnotationStore } from '../annotations/annotationStore';
import { ClaudeRunner } from '../claude/claudeRunner';
import { PromptBuilder } from '../claude/promptBuilder';
import { MarkdownRenderer } from './markdownRenderer';
import { HtmlProvider } from '../webview/htmlProvider';
import { setupMessageHandler } from '../webview/messageHandler';
import { Annotation } from '../types';

interface HistoryEntry {
  id: string;
  timestamp: number;
  fileName: string;
  annotations: Array<{
    lineStart: number;
    lineEnd: number;
    selectedText: string;
    annotationText: string;
  }>;
  diff: string;
}

export class PreviewManager {
  private panel: vscode.WebviewPanel | null = null;
  private htmlProvider: HtmlProvider;
  private markdownRenderer: MarkdownRenderer;
  private disposables: vscode.Disposable[] = [];
  private _currentFilePath: string = '';
  private _currentFileContent: string = '';
  private phase1Output: string = '';
  private _retryTimer: NodeJS.Timeout | null = null;
  private analysisLogLines: string[] = [];
  private modificationHistory: HistoryEntry[] = [];

  constructor(
    private context: vscode.ExtensionContext,
    private annotationStore: AnnotationStore,
    private claudeRunner: ClaudeRunner,
    private promptBuilder: PromptBuilder
  ) {
    this.htmlProvider = new HtmlProvider(context);
    this.markdownRenderer = new MarkdownRenderer();

    // Listen for annotation store changes
    this.disposables.push(
      annotationStore.onDidChange((filePath) => {
        if (filePath === this._currentFilePath) {
          this.sendAnnotationsToWebview();
        }
      })
    );
  }

  get currentFilePath(): string {
    return this._currentFilePath;
  }

  /**
   * Create or reveal the preview panel.
   */
  async createOrShow(fileUri?: vscode.Uri): Promise<void> {
    let editor = vscode.window.activeTextEditor;

    // If triggered from explorer context menu, open the file first
    if (fileUri && (!editor || editor.document.uri.fsPath !== fileUri.fsPath)) {
      const doc = await vscode.workspace.openTextDocument(fileUri);
      editor = await vscode.window.showTextDocument(doc, { preview: false });
    }

    if (!editor) {
      vscode.window.showWarningMessage('No editor is active. Open a Markdown file first.');
      return;
    }

    if (editor.document.languageId !== 'markdown') {
      vscode.window.showWarningMessage('The active file is not a Markdown file.');
      return;
    }

    const filePath = editor.document.uri.fsPath;

    if (this.panel) {
      // Panel exists - reveal it
      this.panel.reveal(vscode.ViewColumn.Beside);

      // If the file changed, update content
      if (this._currentFilePath !== filePath) {
        this._currentFilePath = filePath;
        this._currentFileContent = editor.document.getText();
        await this.refreshPreview();
      }
    } else {
      // Create new panel
      this.panel = vscode.window.createWebviewPanel(
        'deepDocPreview',
        'Deep Doc Preview',
        vscode.ViewColumn.Beside,
        {
          enableScripts: true,
          retainContextWhenHidden: true,
          localResourceRoots: [
            vscode.Uri.file(this.context.extensionPath),
          ],
        }
      );

      this._currentFilePath = filePath;
      this._currentFileContent = editor.document.getText();

      // Render markdown NOW so we can embed it into the HTML
      const html = this.markdownRenderer.renderWithWrapper(this._currentFileContent);
      const annotations = this.annotationStore.getAnnotations(filePath);

      // Embed initial data into HTML so webview renders immediately
      this.panel.webview.html = this.htmlProvider.getHtml(
        this.panel.webview,
        this.context,
        { html, annotations, filePath }
      );

      // Set up message handling
      const { AnnotationManager } = require('../annotations/annotationManager');
      const Store = this.annotationStore;
      // We need an annotationManager instance for messageHandler
      // Use a simple inline impl
      const annotationManager = {
        getAnnotations: (fp: string) => this.annotationStore.getAnnotations(fp),
        createAnnotation: (fp: string, ls: number, le: number, st: string, at: string) => {
          const ann: Annotation = {
            id: `${Date.now().toString(36)}-${Math.random().toString(36).substring(2, 8)}`,
            filePath: fp,
            lineStart: ls,
            lineEnd: le,
            selectedText: st,
            annotationText: at,
            timestamp: Date.now(),
          };
          this.annotationStore.add(fp, ann);
          return ann;
        },
        deleteAnnotation: (fp: string, id: string) => this.annotationStore.remove(fp, id),
        updateAnnotation: (fp: string, id: string, text: string) => this.annotationStore.update(fp, id, text),
        async promptForAnnotation(ls: number, le: number, st: string) {
          const truncated = st.length > 60 ? st.substring(0, 60) + '...' : st;
          return vscode.window.showInputBox({
            title: 'Add Annotation',
            prompt: `Lines ${ls}-${le}: "${truncated}"`,
            placeHolder: 'Enter your annotation or comment...',
            validateInput: (value) => {
              if (!value || value.trim().length === 0) {
                return 'Annotation text cannot be empty';
              }
              return undefined;
            },
          });
        },
      };

      const handler = setupMessageHandler(
        this.panel.webview,
        this,
        annotationManager as any,
        () => this.sendAnnotationsToWebview()
      );
      this.disposables.push(handler);

      // Handle panel disposal
      this.panel.onDidDispose(() => {
        this.panel = null;
        this._currentFilePath = '';
        this._currentFileContent = '';
        this.phase1Output = '';
      }, null, this.disposables);

      // Use a dual-trigger strategy for initial content load:
      // 1. The webview sends 'ready' → messageHandler calls refreshPreview()
      // 2. Fallback: retry a few times with increasing delays
      this.retryRefreshWithFallback(3);
      return;
    }

    // Panel already exists - refresh immediately
    await this.refreshPreview();
  }

  /**
   * Refresh the preview with current file content.
   */
  async refreshPreview(): Promise<void> {
    if (!this.panel || !this._currentFilePath) { return; }

    try {
      // Read file content
      this._currentFileContent = fs.readFileSync(this._currentFilePath, 'utf-8');

      // Render markdown to HTML
      const html = this.markdownRenderer.renderWithWrapper(this._currentFileContent);

      // Get annotations
      const annotations = this.annotationStore.getAnnotations(this._currentFilePath);

      // Send to webview
      await this.panel.webview.postMessage({
        type: 'renderMarkdown',
        html,
        annotations,
        filePath: this._currentFilePath,
      });
      await this.sendHistoryToWebview();
    } catch (err) {
      console.error('[DeepDoc] Failed to refresh preview:', err);
    }
  }

  /**
   * Send updated annotations to the webview.
   */
  private async sendAnnotationsToWebview(): Promise<void> {
    if (!this.panel || !this._currentFilePath) { return; }

    const annotations = this.annotationStore.getAnnotations(this._currentFilePath);
    await this.panel.webview.postMessage({
      type: 'updateAnnotations',
      annotations,
    });
  }

  private resetAnalysisLog(lines: string[] = []): void {
    this.analysisLogLines = lines;
    void this.sendAnalysisLog();
  }

  private appendAnalysisLog(text: string): void {
    this.analysisLogLines.push(text);
    void this.sendAnalysisLog();
  }

  private appendClaudeOutput(stream: 'claude' | 'stderr', chunk: string): void {
    if (stream === 'stderr') {
      this.appendAnalysisLog(chunk);
      return;
    }
    this.appendAnalysisLog(chunk);
  }

  private async sendAnalysisLog(): Promise<void> {
    if (!this.panel) { return; }

    await this.panel.webview.postMessage({
      type: 'logProgress',
      lines: [this.analysisLogLines.join('')],
    });
  }

  private async sendHistoryToWebview(): Promise<void> {
    if (!this.panel) { return; }

    await this.panel.webview.postMessage({
      type: 'updateHistory',
      entries: [...this.modificationHistory],
    });
  }

  private addHistoryEntry(filePath: string, annotations: Annotation[], before: string, after: string): void {
    const fileName = filePath.split('/').pop() || filePath;
    const diff = this.buildUnifiedDiff(fileName, before, after);

    this.modificationHistory.unshift({
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      timestamp: Date.now(),
      fileName,
      annotations: annotations.map((annotation) => ({
        lineStart: annotation.lineStart,
        lineEnd: annotation.lineEnd,
        selectedText: annotation.selectedText,
        annotationText: annotation.annotationText,
      })),
      diff,
    });

    this.modificationHistory = this.modificationHistory.slice(0, 20);
    void this.sendHistoryToWebview();
  }

  /**
   * Submit annotations to Claude Code (Phase 1).
   */
  async submitAnnotations(): Promise<void> {
    if (!this._currentFilePath || !this.panel) { return; }

    const annotations = this.annotationStore.getAnnotations(this._currentFilePath);
    if (annotations.length === 0) {
      vscode.window.showWarningMessage('No annotations to submit. Add annotations first.');
      return;
    }

    // Update status
    await this.panel.webview.postMessage({
      type: 'processingStatus',
      status: 'phase1',
      message: 'Phase 1: Analyzing annotations...',
    });

    try {
      // Phase 1: Build per-annotation prompts and run sub-agents in parallel
      const prompts = annotations.map((a, i) =>
        this.promptBuilder.buildSingleAnnotationPrompt(
          a, this._currentFileContent, this._currentFilePath, i, annotations.length
        )
      );

      this.resetAnalysisLog();

      console.log(`[DeepDoc] Phase 1: Running ${prompts.length} sub-agents in parallel...`);
      const results = await this.claudeRunner.runParallel(
        prompts,
        3,
        (index, status, message, rawOutput, stream) => {
          // Update per-annotation card status badge
          if (this.panel && index >= 0 && index < annotations.length && status !== 'output') {
            const ann = annotations[index];
            const ws: 'running' | 'done' | 'error' = status === 'start' ? 'running' : status;
            void this.panel.webview.postMessage({
              type: 'annotationStatus',
              annotationId: ann.id,
              status: ws,
              error: ws === 'error' ? message : undefined,
            });
          }

          if (status === 'output' && stream) {
            this.appendClaudeOutput(stream, message);
          }
        }
      );

      // Collect successful analyses
      const analyses = results.filter((r): r is NonNullable<typeof r> => r !== null).map((r) => r.result);
      const failedCount = results.length - analyses.length;

      // Merge into unified suggestions document
      this.phase1Output = this.promptBuilder.mergeAnalyses(analyses, annotations);

      // Parse individual suggestions from each analysis
      const suggestions = analyses
        .map((a) => this.promptBuilder.parseSingleAnalysis(a))
        .filter((s): s is NonNullable<typeof s> => s !== null);

      // Send per-annotation analysis results to cards
      for (let i = 0; i < annotations.length; i++) {
        const ann = annotations[i];
        const result = results[i];
        if (result && this.panel) {
          await this.panel.webview.postMessage({
            type: 'annotationStatus',
            annotationId: ann.id,
            status: 'done',
            analysis: result.result,
          });
        } else if (!result && this.panel) {
          await this.panel.webview.postMessage({
            type: 'annotationStatus',
            annotationId: ann.id,
            status: 'error',
            error: 'Sub-agent failed to produce output',
          });
        }
      }

      // Analysis log stays as-is (Claude Code stream events already sent via logProgress).
      // Per-annotation details are visible in expanded cards.
      // Show status
      const statusMsg = `${suggestions.length} suggestions` +
        (failedCount > 0 ? ` (${failedCount} failed)` : '');

      await this.panel.webview.postMessage({
        type: 'processingStatus',
        status: 'phase2',
        message: `Applying ${statusMsg}...`,
      });
      await this.runPhase2([...annotations]);
    } catch (err: any) {
      console.error('[DeepDoc] Phase 1 failed:', err);
      await this.panel.webview.postMessage({
        type: 'processingStatus',
        status: 'error',
        message: err.message || 'Phase 1 failed',
      });
      vscode.window.showErrorMessage(`Deep Doc: Phase 1 failed - ${err.message}`);
    }
  }

  /**
   * Execute Phase 2: send original + suggestions to Claude.
   */
  private async runPhase2(historyAnnotations: Annotation[]): Promise<void> {
    if (!this.panel || !this._currentFilePath) { return; }

    await this.panel.webview.postMessage({
      type: 'processingStatus',
      status: 'phase2',
      message: 'Phase 2: Applying modifications...',
    });

    try {
      const prompt = this.promptBuilder.buildPhase2Prompt(
        this._currentFileContent,
        this.phase1Output
      );

      console.log('[DeepDoc] Phase 2: Running Claude...');
      const result = await this.claudeRunner.run(prompt, (stream, chunk) => {
        this.appendClaudeOutput(stream, chunk);
      });

      // Apply the modified content back to the file
      const originalContent = this._currentFileContent;
      const modifiedContent = result.result;

      // Write back using VSCode API for undo support
      const uri = vscode.Uri.file(this._currentFilePath);
      const edit = new vscode.WorkspaceEdit();

      // Replace entire file content
      const fullRange = new vscode.Range(
        new vscode.Position(0, 0),
        new vscode.Position(
          this._currentFileContent.split('\n').length,
          0
        )
      );

      edit.replace(uri, fullRange, modifiedContent);
      await vscode.workspace.applyEdit(edit);

      // Save the file
      const doc = await vscode.workspace.openTextDocument(uri);
      await doc.save();

      this.addHistoryEntry(this._currentFilePath, historyAnnotations, originalContent, modifiedContent);

      // Clear annotations after successful apply
      this.annotationStore.clear(this._currentFilePath);

      // Refresh preview
      await this.refreshPreview();

      // Update status
      await this.panel.webview.postMessage({
        type: 'processingStatus',
        status: 'done',
        message: 'Modifications applied successfully!',
      });

      vscode.window.showInformationMessage(
        `Deep Doc: Applied modifications to ${this._currentFilePath.split('/').pop()}`
      );
    } catch (err: any) {
      console.error('[DeepDoc] Phase 2 failed:', err);
      await this.panel.webview.postMessage({
        type: 'processingStatus',
        status: 'error',
        message: err.message || 'Phase 2 failed',
      });
      vscode.window.showErrorMessage(`Deep Doc: Phase 2 failed - ${err.message}`);
    }
  }

  /**
   * Handle active editor change (for auto-refresh).
   */
  onActiveEditorChanged(editor: vscode.TextEditor): void {
    if (!this.panel) { return; }
    const filePath = editor.document.uri.fsPath;
    if (filePath !== this._currentFilePath) {
      this._currentFilePath = filePath;
      this._currentFileContent = editor.document.getText();
      this.refreshPreview();
    }
  }

  /**
   * Handle document save (for auto-refresh).
   */
  onDocumentSaved(doc: vscode.TextDocument): void {
    if (!this.panel || doc.uri.fsPath !== this._currentFilePath) { return; }
    this._currentFileContent = doc.getText();
    this.refreshPreview();
  }

  private buildUnifiedDiff(fileName: string, before: string, after: string): string {
    if (before === after) {
      return `--- ${fileName}\n+++ ${fileName}\n@@ no changes @@\n`;
    }

    const beforeLines = before.split('\n');
    const afterLines = after.split('\n');
    const rows = beforeLines.length + 1;
    const cols = afterLines.length + 1;
    const table: number[][] = Array.from({ length: rows }, () => new Array(cols).fill(0));

    for (let i = beforeLines.length - 1; i >= 0; i--) {
      for (let j = afterLines.length - 1; j >= 0; j--) {
        table[i][j] = beforeLines[i] === afterLines[j]
          ? table[i + 1][j + 1] + 1
          : Math.max(table[i + 1][j], table[i][j + 1]);
      }
    }

    const diffLines: string[] = [
      `--- ${fileName}`,
      `+++ ${fileName}`,
      '@@ applied changes @@',
    ];

    let i = 0;
    let j = 0;
    while (i < beforeLines.length && j < afterLines.length) {
      if (beforeLines[i] === afterLines[j]) {
        diffLines.push(` ${beforeLines[i]}`);
        i++;
        j++;
      } else if (table[i + 1][j] >= table[i][j + 1]) {
        diffLines.push(`-${beforeLines[i]}`);
        i++;
      } else {
        diffLines.push(`+${afterLines[j]}`);
        j++;
      }
    }

    while (i < beforeLines.length) {
      diffLines.push(`-${beforeLines[i++]}`);
    }
    while (j < afterLines.length) {
      diffLines.push(`+${afterLines[j++]}`);
    }

    return diffLines.join('\n');
  }

  /**
   * Retry refreshing the preview with increasing delays.
   * Used as a fallback in case the webview's 'ready' message is delayed.
   */
  private retryRefreshWithFallback(attemptsLeft: number): void {
    if (this._retryTimer) {
      clearTimeout(this._retryTimer);
    }
    this._retryTimer = setTimeout(async () => {
      console.log(`[DeepDoc] Retry refresh, attempts left: ${attemptsLeft}`);
      await this.refreshPreview();
    }, 300);
  }

  /**
   * Clean up resources.
   */
  dispose(): void {
    if (this._retryTimer) {
      clearTimeout(this._retryTimer);
      this._retryTimer = null;
    }
    this.disposables.forEach((d) => d.dispose());
    this.disposables = [];
    if (this.panel) {
      this.panel.dispose();
      this.panel = null;
    }
    this.claudeRunner.cancel();
  }
}
