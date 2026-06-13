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

const expandedHistoryIds = new Set<string>();

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

function switchRightTab(tab: 'annotations' | 'analysis' | 'history'): void {
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
    if (tab === 'annotations' || tab === 'analysis' || tab === 'history') {
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

    case 'updateHistory': {
      renderHistory(message.entries || []);
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

function showProgressLog(lines: string[]): void {
  const panel = document.getElementById('analysis-panel')!;
  const contentEl = document.getElementById('analysis-content')!;

  panel.classList.remove('collapsed');
  contentEl.innerHTML = renderTerminalLog(lines.join(''));
  contentEl.scrollTop = contentEl.scrollHeight;
}

function renderHistory(entries: HistoryEntry[]): void {
  const contentEl = document.getElementById('history-content')!;

  if (entries.length === 0) {
    contentEl.innerHTML = '<p class="placeholder">Applied diffs will appear here.</p>';
    return;
  }

  contentEl.innerHTML = entries.map((entry, index) => {
    const time = new Date(entry.timestamp).toLocaleTimeString();
    const expanded = expandedHistoryIds.has(entry.id);
    return `
      <article class="history-entry ${expanded ? 'expanded' : ''}" data-history-id="${entry.id}">
        <button class="history-entry-header">
          <div>
            <div class="history-entry-title">Run ${entries.length - index}</div>
            <div class="history-entry-meta">${escapeHtml(entry.fileName)} · ${time} · ${entry.annotations.length} annotation(s)</div>
          </div>
          <span class="history-expand-icon">▶</span>
        </button>
        <div class="history-annotations">
          ${renderHistoryAnnotations(entry)}
        </div>
        <div class="history-diff-wrap">
          ${renderDiff(entry.diff)}
        </div>
      </article>
    `;
  }).join('');

  contentEl.querySelectorAll<HTMLElement>('.history-entry-header').forEach((header) => {
    header.addEventListener('click', () => {
      const entry = header.closest<HTMLElement>('.history-entry');
      const id = entry?.dataset.historyId;
      if (!id) { return; }

      if (expandedHistoryIds.has(id)) {
        expandedHistoryIds.delete(id);
      } else {
        expandedHistoryIds.add(id);
      }
      renderHistory(entries);
    });
  });
}

function renderHistoryAnnotations(entry: HistoryEntry): string {
  if (entry.annotations.length === 0) {
    return '<p class="history-empty">No annotation snapshot was recorded.</p>';
  }

  return entry.annotations.map((annotation, index) => {
    const lineLabel = annotation.lineStart === annotation.lineEnd
      ? `Line ${annotation.lineStart}`
      : `Lines ${annotation.lineStart}-${annotation.lineEnd}`;
    const selected = annotation.selectedText.length > 120
      ? annotation.selectedText.slice(0, 120) + '...'
      : annotation.selectedText;

    return `
      <div class="history-annotation">
        <div class="history-annotation-header">
          <span>${index + 1}. ${lineLabel}</span>
        </div>
        <div class="history-annotation-text">${escapeHtml(annotation.annotationText)}</div>
        <div class="history-annotation-selected">${escapeHtml(selected)}</div>
      </div>
    `;
  }).join('');
}

function renderDiff(diff: string): string {
  const rows = diff.split(/\r?\n/).map((line) => {
    let kind = 'context';
    if (line.startsWith('+') && !line.startsWith('+++')) {
      kind = 'add';
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      kind = 'remove';
    } else if (line.startsWith('@@')) {
      kind = 'hunk';
    } else if (line.startsWith('---') || line.startsWith('+++')) {
      kind = 'file';
    }

    return `<div class="diff-line diff-${kind}">${escapeHtml(line || ' ')}</div>`;
  }).join('');

  return `<div class="history-diff">${rows}</div>`;
}

function showAnalysis(content: string): void {
  const panel = document.getElementById('analysis-panel')!;
  const contentEl = document.getElementById('analysis-content')!;

  if (!content) {
    panel.classList.add('hidden');
    return;
  }

  panel.classList.remove('hidden');
  contentEl.innerHTML = renderTerminalLog(content);
}

function renderTerminalLog(content: string): string {
  if (!content.trim()) {
    return '<p class="placeholder">Claude Code activity will appear here.</p>';
  }

  const events = parseClaudeCodeLog(content);
  if (events.length === 0) {
    if (containsOnlyFilteredClaudeEvents(content)) {
      return '<p class="placeholder">Claude Code activity will appear here.</p>';
    }
    return `<pre class="terminal-log">${escapeHtml(content)}</pre>`;
  }

  const rows = events.map((event) => `
    <div class="cc-log-item cc-log-${event.kind}">
      <div class="cc-log-marker"></div>
      <div class="cc-log-content">
        ${renderClaudeLogEventContent(event)}
      </div>
    </div>
  `).join('');

  return `<div class="cc-log-timeline">${rows}</div>`;
}

interface ClaudeLogEvent {
  kind: 'thought' | 'message' | 'tool' | 'result' | 'error' | 'raw';
  title: string;
  meta?: string;
  body?: string;
}

function renderClaudeLogEventContent(event: ClaudeLogEvent): string {
  if (event.kind === 'thought' && event.body) {
    return `
      <details class="cc-log-thought-details">
        <summary>
          <span class="cc-log-main">${escapeHtml(event.title)}</span>
          ${event.meta ? `<span class="cc-log-meta">${escapeHtml(event.meta)}</span>` : ''}
        </summary>
        <div class="cc-log-body">${escapeHtml(event.body)}</div>
      </details>
    `;
  }

  return `
    ${event.meta ? `<div class="cc-log-meta">${escapeHtml(event.meta)}</div>` : ''}
    <div class="cc-log-main">${escapeHtml(event.title)}</div>
    ${event.body ? `<div class="cc-log-body">${escapeHtml(event.body)}</div>` : ''}
  `;
}

function parseClaudeCodeLog(content: string): ClaudeLogEvent[] {
  const events: ClaudeLogEvent[] = [];

  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) { continue; }

    try {
      const event = JSON.parse(trimmed);
      appendClaudeEvent(events, event);
    } catch {
      events.push({ kind: 'raw', title: line });
    }
  }

  return compactClaudeEvents(events);
}

function containsOnlyFilteredClaudeEvents(content: string): boolean {
  let sawJson = false;

  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) { continue; }

    try {
      const event = JSON.parse(trimmed);
      sawJson = true;
      if (!isFilteredClaudeEvent(event)) {
        return false;
      }
    } catch {
      return false;
    }
  }

  return sawJson;
}

function isFilteredClaudeEvent(event: any): boolean {
  return event.type === 'system';
}

function appendClaudeEvent(events: ClaudeLogEvent[], event: any): void {
  if (event.type === 'system') {
    return;
  }

  if (event.type === 'assistant' && event.message?.content) {
    for (const block of event.message.content) {
      if (block.type === 'thinking') {
        const text = String(block.thinking || '').trim();
        if (text) {
          events.push({ kind: 'thought', title: 'Thought', body: text });
        }
      } else if (block.type === 'text') {
        const text = String(block.text || '').trim();
        if (text) {
          events.push({ kind: 'message', title: text });
        }
      } else if (block.type === 'tool_use') {
        events.push({
          kind: 'tool',
          title: block.name || 'Tool',
          body: summarizeToolUse(block.name, block.input),
        });
      }
    }
    return;
  }

  if (event.type === 'user' && event.message?.content) {
    for (const block of event.message.content) {
      if (block.type !== 'tool_result') { continue; }
      const content = typeof block.content === 'string' ? block.content : JSON.stringify(block.content);
      events.push({
        kind: block.is_error ? 'error' : 'result',
        title: block.is_error ? 'Tool error' : 'Tool result',
        body: truncateLogBody(content),
      });
    }
    return;
  }

  if (event.type === 'result') {
    const meta = [
      event.duration_ms ? `${Math.round(event.duration_ms / 1000)}s` : '',
      typeof event.total_cost_usd === 'number' ? `$${event.total_cost_usd.toFixed(4)}` : '',
    ].filter(Boolean).join(' · ');
    events.push({
      kind: 'result',
      title: event.subtype || 'Completed',
      meta,
    });
    return;
  }

  if (event.type === 'error') {
    events.push({
      kind: 'error',
      title: event.message || event.error || 'Error',
    });
  }
}

function summarizeToolUse(name: string, input: any): string {
  if (!input || typeof input !== 'object') { return ''; }

  if (input.file_path) {
    return String(input.file_path).split('/').pop() || String(input.file_path);
  }
  if (input.command) {
    return truncateLogBody(String(input.command), 320);
  }
  if (input.pattern) {
    return String(input.pattern);
  }
  return truncateLogBody(JSON.stringify(input), 320);
}

function compactClaudeEvents(events: ClaudeLogEvent[]): ClaudeLogEvent[] {
  const compacted: ClaudeLogEvent[] = [];

  for (const event of events) {
    const previous = compacted[compacted.length - 1];
    if (previous && previous.kind === 'message' && event.kind === 'message') {
      previous.title += '\n' + event.title;
    } else {
      compacted.push(event);
    }
  }

  return compacted;
}

function truncateLogBody(text: string, maxLength: number = 1800): string {
  if (text.length <= maxLength) { return text; }
  return text.slice(0, maxLength) + '\n...';
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
      switchRightTab('history');
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
