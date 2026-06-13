/**
 * Extension entry point.
 * Registers all commands and manages the extension lifecycle.
 */
import * as vscode from 'vscode';
import { registerCommands } from './commands';
import { PreviewManager } from './preview/previewManager';
import { AnnotationStore } from './annotations/annotationStore';
import { AnnotationManager } from './annotations/annotationManager';
import { ClaudeRunner } from './claude/claudeRunner';
import { PromptBuilder } from './claude/promptBuilder';

let previewManager: PreviewManager;
let annotationStore: AnnotationStore;
let annotationManager: AnnotationManager;
let claudeRunner: ClaudeRunner;
let promptBuilder: PromptBuilder;

export function activate(context: vscode.ExtensionContext): void {
  console.log('[DeepDoc] Extension activating...');

  // Initialize services
  annotationStore = new AnnotationStore(context);
  annotationManager = new AnnotationManager(annotationStore);
  promptBuilder = new PromptBuilder();
  claudeRunner = new ClaudeRunner();
  previewManager = new PreviewManager(context, annotationStore, claudeRunner, promptBuilder);

  // Register commands
  registerCommands(context, previewManager, annotationManager, annotationStore, claudeRunner, promptBuilder);

  // Watch for markdown file changes to auto-refresh preview
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (editor && editor.document.languageId === 'markdown') {
        previewManager.onActiveEditorChanged(editor);
      }
    })
  );

  // Watch for document saves to auto-refresh preview
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (doc.languageId === 'markdown') {
        previewManager.onDocumentSaved(doc);
      }
    })
  );

  console.log('[DeepDoc] Extension activated.');
}

export function deactivate(): void {
  console.log('[DeepDoc] Extension deactivating...');
  if (previewManager) {
    previewManager.dispose();
  }
}
