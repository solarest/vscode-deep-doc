/**
 * Business logic for annotation operations.
 * Bridges webview messages with the annotation store.
 */
import * as vscode from 'vscode';
import { AnnotationStore } from './annotationStore';
import { Annotation } from '../types';

let idCounter = 0;

function generateId(): string {
  idCounter++;
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 8);
  return `${timestamp}-${random}-${idCounter}`;
}

export class AnnotationManager {
  constructor(private store: AnnotationStore) {}

  createAnnotation(
    filePath: string,
    lineStart: number,
    lineEnd: number,
    selectedText: string,
    annotationText: string
  ): Annotation {
    const annotation: Annotation = {
      id: generateId(),
      filePath,
      lineStart,
      lineEnd,
      selectedText,
      annotationText,
      timestamp: Date.now(),
    };
    this.store.add(filePath, annotation);
    return annotation;
  }

  getAnnotations(filePath: string): Annotation[] {
    return this.store.getAnnotations(filePath);
  }

  deleteAnnotation(filePath: string, id: string): boolean {
    return this.store.remove(filePath, id);
  }

  updateAnnotation(filePath: string, id: string, annotationText: string): boolean {
    return this.store.update(filePath, id, annotationText);
  }

  clearAnnotations(filePath: string): void {
    this.store.clear(filePath);
  }

  exportAnnotations(filePath: string): string {
    return this.store.export(filePath);
  }

  /** Prompt user for annotation text via VSCode input box */
  async promptForAnnotation(
    lineStart: number,
    lineEnd: number,
    selectedText: string
  ): Promise<string | undefined> {
    const truncated = selectedText.length > 60
      ? selectedText.substring(0, 60) + '...'
      : selectedText;

    return vscode.window.showInputBox({
      title: 'Add Annotation',
      prompt: `Lines ${lineStart}-${lineEnd}: "${truncated}"`,
      placeHolder: 'Enter your annotation or comment...',
      validateInput: (value) => {
        if (!value || value.trim().length === 0) {
          return 'Annotation text cannot be empty';
        }
        return undefined;
      },
    });
  }

  /** Check if annotations exist for a file */
  hasAnnotations(filePath: string): boolean {
    return this.getAnnotations(filePath).length > 0;
  }
}
