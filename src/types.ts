/**
 * Core type definitions for vscode-deep-doc extension.
 */

/** A single annotation on a markdown document */
export interface Annotation {
  id: string;
  filePath: string;
  lineStart: number;       // 1-based, inclusive
  lineEnd: number;         // 1-based, inclusive
  selectedText: string;
  annotationText: string;
  timestamp: number;
}

/** Messages sent from the webview to the extension host */
export type WebviewToExtension =
  | { type: 'ready' }
  | {
      type: 'textSelected';
      payload: {
        lineStart: number;
        lineEnd: number;
        selectedText: string;
      };
    }
  | {
      type: 'addAnnotation';
      payload: {
        lineStart: number;
        lineEnd: number;
        selectedText: string;
        annotationText: string;
      };
    }
  | { type: 'deleteAnnotation'; id: string }
  | { type: 'updateAnnotation'; id: string; annotationText: string }
  | { type: 'requestScroll'; annotationId: string }
  | { type: 'submitToClaude' }
  | { type: 'getAnnotations' };

/** Messages sent from the extension host to the webview */
export type ExtensionToWebview =
  | { type: 'renderMarkdown'; html: string; annotations: Annotation[]; filePath: string }
  | { type: 'updateAnnotations'; annotations: Annotation[] }
  | { type: 'scrollToAnnotation'; annotationId: string }
  | {
      type: 'processingStatus';
      status: 'idle' | 'phase1' | 'phase1_done' | 'phase2' | 'done' | 'error';
      message?: string;
    }
  | { type: 'promptAnnotation'; payload: { lineStart: number; lineEnd: number; selectedText: string } }
  | { type: 'displayAnalysis'; content: string }
  | { type: 'logProgress'; lines: string[] }
  | { type: 'annotationStatus'; annotationId: string; status: 'running' | 'done' | 'error'; analysis?: string; error?: string }
  | { type: 'showSuggestions'; content: string };

/** Result from Phase 1 Claude processing */
export interface Phase1Suggestion {
  id: string;
  lines: string;       // e.g. "3-3"
  original: string;
  replace: string;
  rationale: string;
}

/** Result from Phase 2 Claude processing */
export interface Phase2Result {
  modifiedContent: string;
}
