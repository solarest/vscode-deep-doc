/**
 * Command registration and handlers.
 * Wires VSCode commands to the extension services.
 */
import * as vscode from 'vscode';
import * as fs from 'fs';
import { PreviewManager } from './preview/previewManager';
import { AnnotationManager } from './annotations/annotationManager';
import { AnnotationStore } from './annotations/annotationStore';
import { ClaudeRunner } from './claude/claudeRunner';
import { PromptBuilder } from './claude/promptBuilder';

export function registerCommands(
  context: vscode.ExtensionContext,
  previewManager: PreviewManager,
  annotationManager: AnnotationManager,
  annotationStore: AnnotationStore,
  claudeRunner: ClaudeRunner,
  promptBuilder: PromptBuilder
): void {
  // Show preview panel
  context.subscriptions.push(
    vscode.commands.registerCommand('vscode-deep-doc.showPreview', async (fileUri?: vscode.Uri) => {
      try {
        await previewManager.createOrShow(fileUri);
      } catch (err: any) {
        vscode.window.showErrorMessage(`Deep Doc: Failed to show preview - ${err.message}`);
      }
    })
  );

  // Submit annotations to Claude Code
  context.subscriptions.push(
    vscode.commands.registerCommand('vscode-deep-doc.submitToClaude', async () => {
      try {
        await previewManager.submitAnnotations();
      } catch (err: any) {
        vscode.window.showErrorMessage(`Deep Doc: Submit failed - ${err.message}`);
      }
    })
  );

  // Clear all annotations for the current file
  context.subscriptions.push(
    vscode.commands.registerCommand('vscode-deep-doc.clearAnnotations', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.document.languageId !== 'markdown') {
        vscode.window.showWarningMessage('No markdown file is open.');
        return;
      }

      const filePath = editor.document.uri.fsPath;
      const count = annotationManager.getAnnotations(filePath).length;

      if (count === 0) {
        vscode.window.showInformationMessage('No annotations to clear.');
        return;
      }

      const confirmed = await vscode.window.showWarningMessage(
        `Clear all ${count} annotation(s) for this file?`,
        { modal: true },
        'Yes, Clear All'
      );

      if (confirmed === 'Yes, Clear All') {
        annotationManager.clearAnnotations(filePath);
        vscode.window.showInformationMessage(`Cleared ${count} annotation(s).`);
      }
    })
  );

  // Export annotations as JSON
  context.subscriptions.push(
    vscode.commands.registerCommand('vscode-deep-doc.exportAnnotations', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.document.languageId !== 'markdown') {
        vscode.window.showWarningMessage('No markdown file is open.');
        return;
      }

      const filePath = editor.document.uri.fsPath;
      const json = annotationManager.exportAnnotations(filePath);

      if (json === '[]') {
        vscode.window.showInformationMessage('No annotations to export.');
        return;
      }

      // Save to a file next to the original
      const exportPath = filePath.replace(/\.md$/, '-annotations.json');
      fs.writeFileSync(exportPath, json, 'utf-8');

      vscode.window.showInformationMessage(
        `Exported annotations to ${exportPath.split('/').pop()}`
      );
    })
  );

  // Check Claude CLI availability on activation
  checkClaudeAvailability();
}

async function checkClaudeAvailability(): Promise<void> {
  const config = vscode.workspace.getConfiguration('vscode-deep-doc');
  const claudePath = config.get<string>('claudePath', 'claude');

  const available = await ClaudeRunner.checkAvailability(claudePath);

  if (!available) {
    console.warn(`[DeepDoc] Claude CLI not found at "${claudePath}"`);
    // Don't block activation - user might install later
    // Just log a warning
  } else {
    console.log(`[DeepDoc] Claude CLI found at "${claudePath}"`);
  }
}
