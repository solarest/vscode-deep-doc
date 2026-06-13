/**
 * Generates the complete HTML for the webview panel.
 */
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { Annotation } from '../types';

export interface InitialData {
  html: string;
  annotations: Annotation[];
  filePath: string;
}

export class HtmlProvider {
  private templateHtml: string;

  constructor(context: vscode.ExtensionContext) {
    const templatePath = path.join(context.extensionPath, 'static', 'index.html');
    this.templateHtml = fs.readFileSync(templatePath, 'utf-8');
  }

  /**
   * Generate the full webview HTML with proper URIs for scripts and styles.
   * Injects initial content as embedded JSON so the webview can render immediately.
   */
  getHtml(
    webview: vscode.Webview,
    context: vscode.ExtensionContext,
    initialData?: InitialData
  ): string {
    const jsDiskPath = path.join(context.extensionPath, 'dist', 'webview.js');
    const cssDiskPath = path.join(context.extensionPath, 'webview-ui', 'styles', 'main.css');

    const jsUri = webview.asWebviewUri(vscode.Uri.file(jsDiskPath));
    const cssUri = webview.asWebviewUri(vscode.Uri.file(cssDiskPath));

    const nonce = getNonce();

    // Read CSS inline to avoid CSP issues
    let cssContent = '';
    try {
      cssContent = fs.readFileSync(cssDiskPath, 'utf-8');
    } catch {
      console.warn('[DeepDoc] Could not read CSS file');
    }

    // Use encodeURIComponent for safe embedding in HTML attribute.
    // Avoids all HTML entity encoding issues (double-encoding, etc.)
    const initialDataJson = initialData
      ? encodeURIComponent(JSON.stringify(initialData))
      : 'null';

    let html = this.templateHtml
      .replaceAll('{{WEBVIEW_JS_URI}}', jsUri.toString())
      .replaceAll('{{CSP_NONCE}}', nonce)
      .replaceAll('{{CSP_SOURCE}}', webview.cspSource)
      .replaceAll('{{INITIAL_DATA}}', initialDataJson);

    // Inline CSS
    if (cssContent) {
      html = html.replace(
        '<link rel="stylesheet" href="{{WEBVIEW_CSS_URI}}">',
        `<style nonce="${nonce}">${cssContent}</style>`
      );
    }

    return html;
  }
}

function getNonce(): string {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 64; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
