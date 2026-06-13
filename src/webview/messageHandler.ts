/**
 * Handles messages from the webview panel.
 * Routes to AnnotationManager, ClaudeRunner, and PreviewManager.
 */
import * as vscode from 'vscode';
import { PreviewManager } from '../preview/previewManager';
import { AnnotationManager } from '../annotations/annotationManager';
import { Annotation } from '../types';

export function setupMessageHandler(
  webview: vscode.Webview,
  previewManager: PreviewManager,
  annotationManager: AnnotationManager,
  onAnnotationChange: () => void
): vscode.Disposable {
  return webview.onDidReceiveMessage(
    async (message) => {
      const filePath = previewManager.currentFilePath;

      switch (message.type) {
        case 'ready': {
          console.log('[DeepDoc] Webview ready');
          // Refresh content for the current markdown file
          if (filePath) {
            await previewManager.refreshPreview();
          }
          break;
        }

        case 'textSelected': {
          if (!filePath) {
            vscode.window.showWarningMessage('No markdown file is open.');
            return;
          }

          const { lineStart, lineEnd, selectedText } = message.payload;

          // Prompt user for annotation text
          const annotationText = await annotationManager.promptForAnnotation(
            lineStart,
            lineEnd,
            selectedText
          );

          if (annotationText) {
            const annotation = annotationManager.createAnnotation(
              filePath,
              lineStart,
              lineEnd,
              selectedText,
              annotationText
            );
            console.log(`[DeepDoc] Added annotation ${annotation.id}`);
            onAnnotationChange();
          }
          break;
        }

        case 'addAnnotation': {
          if (!filePath) { return; }

          const { lineStart, lineEnd, selectedText, annotationText } = message.payload;
          const annotation = annotationManager.createAnnotation(
            filePath,
            lineStart,
            lineEnd,
            selectedText,
            annotationText
          );
          console.log(`[DeepDoc] Added annotation ${annotation.id}`);
          onAnnotationChange();
          break;
        }

        case 'deleteAnnotation': {
          if (!filePath) { return; }

          annotationManager.deleteAnnotation(filePath, message.id);
          console.log(`[DeepDoc] Deleted annotation ${message.id}`);
          onAnnotationChange();
          break;
        }

        case 'updateAnnotation': {
          if (!filePath) { return; }

          annotationManager.updateAnnotation(filePath, message.id, message.annotationText);
          console.log(`[DeepDoc] Updated annotation ${message.id}`);
          onAnnotationChange();
          break;
        }

        case 'requestScroll': {
          // Scroll the webview to the annotation location
          // This is handled by the webview itself - send a message back
          await webview.postMessage({
            type: 'scrollToAnnotation',
            annotationId: message.annotationId,
          });
          break;
        }

        case 'submitToClaude': {
          if (!filePath) {
            vscode.window.showWarningMessage('No markdown file is open.');
            return;
          }

          await previewManager.submitAnnotations();
          break;
        }

        case 'getAnnotations': {
          if (!filePath) { return; }
          const annotations = annotationManager.getAnnotations(filePath);
          await webview.postMessage({
            type: 'updateAnnotations',
            annotations,
          });
          break;
        }

        default: {
          console.warn(`[DeepDoc] Unknown message type: ${(message as any).type}`);
        }
      }
    },
    undefined,
    []
  );
}
