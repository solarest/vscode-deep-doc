/**
 * Webview entry point.
 * Initializes the VSCode API, preview renderer, annotation panel, and scroll sync.
 * Reads initial content from embedded JSON if available, otherwise waits for postMessage.
 */
import { initPreview } from './preview';
import { initAnnotationPanel } from './annotationPanel';
import { initScrollSync } from './scrollSync';

declare function acquireVsCodeApi(): {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
};

// VSCode webview API
const vscodeApi = acquireVsCodeApi();

// Application state
let currentFilePath = '';
let annotations: AnnotationData[] = [];
let scrollSync: ReturnType<typeof initScrollSync> | null = null;

interface AnnotationData {
  id: string;
  filePath: string;
  lineStart: number;
  lineEnd: number;
  selectedText: string;
  annotationText: string;
  timestamp: number;
}

interface InitialData {
  html: string;
  annotations: AnnotationData[];
  filePath: string;
}

// Initialize modules
const preview = initPreview(document.getElementById('markdown-content')!, {
  onTextSelected: (lineStart, lineEnd, selectedText) => {
    vscodeApi.postMessage({
      type: 'textSelected',
      payload: { lineStart, lineEnd, selectedText },
    });
  },
  onScrollToLine: (lineStart: number) => {
    const el = document.querySelector(`[data-source-line-start="${lineStart}"]`);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  },
});

const annotationPanel = initAnnotationPanel(
  document.getElementById('annotation-list')!,
  document.getElementById('annotation-count')!,
  {
    onDelete: (id: string) => {
      vscodeApi.postMessage({ type: 'deleteAnnotation', id });
    },
    onEdit: (id: string, annotationText: string) => {
      vscodeApi.postMessage({ type: 'updateAnnotation', id, annotationText });
    },
    onRequestScroll: (annotationId: string) => {
      vscodeApi.postMessage({ type: 'requestScroll', annotationId });
    },
  }
);

// Toolbar buttons
const btnSubmit = document.getElementById('btn-submit')!;
const processingBadge = document.getElementById('processing-badge')!;

function switchRightTab(tab: 'annotations' | 'suggestions' | 'analysis'): void {
  document.querySelectorAll<HTMLElement>('.right-tab').forEach((button) => {
    const isActive = button.dataset.tab === tab;
    button.classList.toggle('active', isActive);
    button.setAttribute('aria-selected', String(isActive));
  });

  document.querySelectorAll<HTMLElement>('.tab-panel').forEach((panel) => {
    panel.classList.toggle('active', panel.dataset.panel === tab);
  });
}

document.querySelectorAll<HTMLButtonElement>('.right-tab').forEach((button) => {
  button.addEventListener('click', () => {
    const tab = button.dataset.tab;
    if (tab === 'annotations' || tab === 'suggestions' || tab === 'analysis') {
      switchRightTab(tab);
    }
  });
});

btnSubmit.addEventListener('click', () => {
  vscodeApi.postMessage({ type: 'submitToClaude' });
});

/**
 * Render the full preview: markdown HTML, annotations, scroll sync, markers.
 * Called both for initial load and subsequent postMessage updates.
 */
function renderFullPreview(html: string, filePath: string, anns: AnnotationData[]): void {
  currentFilePath = filePath;
  annotations = anns;

  // Render markdown HTML in preview pane
  preview.render(html);

  // Render annotations in right panel
  annotationPanel.render(annotations);

  // Update submit button state
  btnSubmit.disabled = annotations.length === 0;

  // Update file name in toolbar
  const fileName = filePath.split('/').pop() || filePath;
  document.getElementById('file-name')!.textContent = fileName;

  // Re-init scroll sync
  if (scrollSync) {
    scrollSync.destroy();
  }
  scrollSync = initScrollSync(
    document.getElementById('preview-container')!,
    (visibleStart: number, visibleEnd: number) => {
      annotationPanel.highlightVisible(visibleStart, visibleEnd);
    }
  );

  // Add annotation markers in preview
  annotations.forEach((a) => {
    preview.addAnnotationMarker(a);
  });
}

// Handle messages from the extension host
window.addEventListener('message', (event) => {
  const message = event.data;

  switch (message.type) {
    case 'renderMarkdown': {
      renderFullPreview(message.html, message.filePath, message.annotations || []);
      break;
    }

    case 'updateAnnotations': {
      annotations = message.annotations || [];
      annotationPanel.render(annotations);
      btnSubmit.disabled = annotations.length === 0;

      preview.clearMarkers();
      annotations.forEach((a) => {
        preview.addAnnotationMarker(a);
      });
      break;
    }

    case 'scrollToAnnotation': {
      const ann = annotations.find((a) => a.id === message.annotationId);
      if (ann) {
        preview.scrollToLine(ann.lineStart);
        annotationPanel.highlightAnnotation(message.annotationId);
      }
      break;
    }

    case 'processingStatus': {
      updateProcessingStatus(message.status, message.message);
      break;
    }

    case 'displayAnalysis': {
      showAnalysis(message.content);
      break;
    }

    case 'logProgress': {
      showProgressLog(message.lines);
      break;
    }

    case 'showSuggestions': {
      showEditableSuggestions(message.content);
      break;
    }

    case 'annotationStatus': {
      annotationPanel.setAnnotationStatus(message.annotationId, {
        id: message.annotationId,
        status: message.status,
        analysis: message.analysis,
        error: message.error,
      });
      break;
    }

    case 'promptAnnotation': {
      const { lineStart, lineEnd, selectedText } = message.payload;
      const annotationText = prompt(
        `Add annotation for lines ${lineStart}-${lineEnd}: "${selectedText.substring(0, 100)}"`
      );
      if (annotationText) {
        vscodeApi.postMessage({
          type: 'addAnnotation',
          payload: { lineStart, lineEnd, selectedText, annotationText },
        });
      }
      break;
    }
  }
});

function showEditableSuggestions(content: string): void {
  const panel = document.getElementById('suggestions-panel')!;
  const editor = document.getElementById('suggestions-editor') as HTMLTextAreaElement;

  editor.value = content;
  editor.readOnly = true;
  panel.classList.remove('hidden');
  switchRightTab('suggestions');
}

function hideEditableSuggestions(): void {
  switchRightTab('annotations');
}

function showProgressLog(lines: string[]): void {
  const panel = document.getElementById('analysis-panel')!;
  const contentEl = document.getElementById('analysis-content')!;

  panel.classList.remove('collapsed');
  contentEl.innerHTML = renderClaudeLog(lines);
  contentEl.scrollTop = contentEl.scrollHeight;
}

function showAnalysis(content: string): void {
  const panel = document.getElementById('analysis-panel')!;
  const contentEl = document.getElementById('analysis-content')!;

  if (!content) {
    panel.classList.add('hidden');
    return;
  }

  panel.classList.remove('hidden');
  contentEl.innerHTML = renderClaudeLog(content.split(/\r?\n/));
}

function renderClaudeLog(lines: string[]): string {
  if (lines.length === 0) {
    return '<div class="claude-log"><p class="placeholder">Claude Code output will appear here.</p></div>';
  }

  const rows = lines.map((line) => {
    if (!line.trim()) {
      return '<div class="claude-log-spacer"></div>';
    }

    const kind = getClaudeLogKind(line);
    return `<div class="claude-log-row ${kind}"><span class="claude-log-prefix"></span><span class="claude-log-text">${escapeHtml(line)}</span></div>`;
  }).join('');

  return `<div class="claude-log">${rows}</div>`;
}

function getClaudeLogKind(line: string): string {
  const trimmed = line.trimStart();

  if (/^(Error|Tool error|stderr>)/.test(trimmed)) {
    return 'is-error';
  }
  if (/^(Tool result|Output)/.test(trimmed)) {
    return 'is-result';
  }
  if (/^[A-Z][A-Za-z0-9_-]*(\(|\s)/.test(trimmed)) {
    return 'is-tool';
  }
  return 'is-message';
}

function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function updateProcessingStatus(status: string, msg?: string): void {
  processingBadge.classList.remove('status-done', 'status-error');

  switch (status) {
    case 'idle':
      processingBadge.classList.add('hidden');
      btnSubmit.disabled = annotations.length === 0;
      break;
    case 'phase1':
      processingBadge.classList.remove('hidden');
      processingBadge.textContent = 'Phase 1: Analyzing...';
      btnSubmit.disabled = true;
      switchRightTab('analysis');
      break;
    case 'phase1_done':
      processingBadge.classList.remove('hidden');
      processingBadge.textContent = 'Phase 1 done. Review suggestions.';
      break;
    case 'phase2':
      processingBadge.classList.remove('hidden');
      processingBadge.textContent = 'Phase 2: Applying...';
      break;
    case 'done':
      processingBadge.classList.remove('hidden');
      processingBadge.classList.add('status-done');
      processingBadge.textContent = 'Done!';
      setTimeout(() => {
        processingBadge.classList.add('hidden');
        btnSubmit.disabled = annotations.length === 0;
      }, 3000);
      break;
    case 'error':
      processingBadge.classList.remove('hidden');
      processingBadge.classList.add('status-error');
      processingBadge.textContent = `Error: ${msg || 'Unknown error'}`;
      btnSubmit.disabled = annotations.length === 0;
      break;
  }
}

// ===== INITIAL LOAD: read embedded data from data-initial attribute =====
function loadInitialData(): void {
  const app = document.getElementById('app');
  if (!app) { return; }

  const raw = app.getAttribute('data-initial');
  if (!raw || raw === 'null') { return; }

  try {
    // Data is URI-encoded JSON for safe HTML attribute embedding
    const decoded = decodeURIComponent(raw);
    const data: InitialData = JSON.parse(decoded);
    if (data && data.html) {
      console.log('[DeepDoc Webview] Loading initial data:', data.filePath);
      renderFullPreview(data.html, data.filePath, data.annotations || []);
      app.removeAttribute('data-initial');
    }
  } catch (err) {
    console.error('[DeepDoc Webview] Failed to parse initial data:', err);
  }
}

// ===== Draggable divider between preview and right sidebar =====
(function setupSidebarResize() {
  const divider = document.getElementById('sidebar-divider')!;
  const sidebar = document.getElementById('annotation-container')!;
  const mainContent = document.getElementById('main-content')!;

  let isDragging = false;
  let startX = 0;
  let startWidth = 0;

  function getBounds(): { min: number; max: number } {
    const totalWidth = mainContent.offsetWidth;
    const minPreviewWidth = 360;
    const minSidebarWidth = 280;
    const maxSidebarWidth = Math.min(760, Math.max(minSidebarWidth, totalWidth - minPreviewWidth));
    return { min: minSidebarWidth, max: maxSidebarWidth };
  }

  function setSidebarWidth(width: number): void {
    const { min, max } = getBounds();
    const clamped = Math.max(min, Math.min(max, width));
    sidebar.style.flex = `0 0 ${clamped}px`;
    sidebar.style.width = `${clamped}px`;
  }

  divider.addEventListener('mousedown', (e) => {
    isDragging = true;
    startX = e.clientX;
    startWidth = sidebar.offsetWidth;
    divider.classList.add('dragging');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    e.preventDefault();
  });

  document.addEventListener('mousemove', (e) => {
    if (!isDragging) { return; }
    const delta = startX - e.clientX;
    setSidebarWidth(startWidth + delta);
  });

  document.addEventListener('mouseup', () => {
    if (!isDragging) { return; }
    isDragging = false;
    divider.classList.remove('dragging');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  });

  window.addEventListener('resize', () => {
    if (sidebar.style.width) {
      setSidebarWidth(sidebar.offsetWidth);
    }
  });
})();

// Load initial data synchronously before sending 'ready'
loadInitialData();

// Notify extension that the webview is ready for future postMessage updates
vscodeApi.postMessage({ type: 'ready' });
