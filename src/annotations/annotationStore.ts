/**
 * Persistent storage for annotations.
 * Stores annotations in a JSON file at `<workspace>/.vscode/annotations.json`.
 * Falls back to extension globalState if no workspace is open.
 */
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { Annotation } from '../types';

export class AnnotationStore {
  private annotations: Map<string, Annotation[]> = new Map();
  private _onDidChange = new vscode.EventEmitter<string>();
  readonly onDidChange = this._onDidChange.event;

  private storageDir: string | null = null;

  constructor(private context: vscode.ExtensionContext) {
    this.storageDir = this.resolveStorageDir();
    this.load();
  }

  private resolveStorageDir(): string | null {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (workspaceFolders && workspaceFolders.length > 0) {
      const vscodeDir = path.join(workspaceFolders[0].uri.fsPath, '.vscode');
      if (!fs.existsSync(vscodeDir)) {
        fs.mkdirSync(vscodeDir, { recursive: true });
      }
      return vscodeDir;
    }
    return null;
  }

  private get storagePath(): string {
    if (this.storageDir) {
      return path.join(this.storageDir, 'annotations.json');
    }
    return '';
  }

  private load(): void {
    try {
      // Try file-based persistence first
      if (this.storageDir) {
        const filePath = this.storagePath;
        if (fs.existsSync(filePath)) {
          const raw = fs.readFileSync(filePath, 'utf-8');
          const data: Record<string, Annotation[]> = JSON.parse(raw);
          this.annotations = new Map(Object.entries(data));
          console.log(`[DeepDoc] Loaded annotations from ${filePath}`);
          return;
        }
      }
      // Fallback: extension global state
      const globalData = this.context.globalState.get<Record<string, Annotation[]>>('annotations');
      if (globalData) {
        this.annotations = new Map(Object.entries(globalData));
        console.log('[DeepDoc] Loaded annotations from globalState');
      }
    } catch (err) {
      console.error('[DeepDoc] Failed to load annotations:', err);
    }
  }

  private save(): void {
    const data: Record<string, Annotation[]> = Object.fromEntries(this.annotations);
    try {
      // File-based persistence
      if (this.storageDir) {
        const filePath = this.storagePath;
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
        console.log(`[DeepDoc] Saved annotations to ${filePath}`);
      }
      // Always save to global state as backup
      this.context.globalState.update('annotations', data);
    } catch (err) {
      console.error('[DeepDoc] Failed to save annotations:', err);
    }
  }

  getAnnotations(filePath: string): Annotation[] {
    return this.annotations.get(filePath) || [];
  }

  add(filePath: string, annotation: Annotation): void {
    const list = this.annotations.get(filePath) || [];
    list.push(annotation);
    this.annotations.set(filePath, list);
    this.save();
    this._onDidChange.fire(filePath);
  }

  remove(filePath: string, id: string): boolean {
    const list = this.annotations.get(filePath);
    if (!list) { return false; }
    const idx = list.findIndex((a) => a.id === id);
    if (idx === -1) { return false; }
    list.splice(idx, 1);
    this.annotations.set(filePath, list);
    this.save();
    this._onDidChange.fire(filePath);
    return true;
  }

  update(filePath: string, id: string, annotationText: string): boolean {
    const list = this.annotations.get(filePath);
    if (!list) { return false; }
    const annotation = list.find((a) => a.id === id);
    if (!annotation) { return false; }
    annotation.annotationText = annotationText;
    annotation.timestamp = Date.now();
    this.save();
    this._onDidChange.fire(filePath);
    return true;
  }

  clear(filePath: string): void {
    this.annotations.delete(filePath);
    this.save();
    this._onDidChange.fire(filePath);
  }

  clearAll(): void {
    this.annotations.clear();
    this.save();
  }

  /** Export annotations for a file as a JSON string */
  export(filePath: string): string {
    const annotations = this.getAnnotations(filePath);
    return JSON.stringify(annotations, null, 2);
  }
}
