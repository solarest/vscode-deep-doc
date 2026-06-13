/**
 * Right-side annotation panel: renders expandable annotation cards.
 * Each card can expand to show sub-agent analysis results.
 */

interface AnnotationData {
  id: string;
  lineStart: number;
  lineEnd: number;
  selectedText: string;
  annotationText: string;
  timestamp: number;
}

export interface AnnotationStatus {
  id: string;
  status: 'idle' | 'running' | 'done' | 'error';
  analysis?: string;
  error?: string;
}

interface AnnotationPanelCallbacks {
  onDelete: (id: string) => void;
  onEdit: (id: string, annotationText: string) => void;
  onRequestScroll: (annotationId: string) => void;
}

export function initAnnotationPanel(
  container: HTMLElement,
  countElement: HTMLElement,
  callbacks: AnnotationPanelCallbacks
) {
  let currentAnnotations: AnnotationData[] = [];
  let statuses: Map<string, AnnotationStatus> = new Map();
  let editingId: string | null = null;

  /**
   * Render the full annotation list.
   */
  function render(annotations: AnnotationData[]): void {
    currentAnnotations = annotations;
    countElement.textContent = String(annotations.length);

    if (annotations.length === 0) {
      container.innerHTML = '<p class="placeholder">Select text in the preview to add annotations.</p>';
      return;
    }

    container.innerHTML = annotations
      .sort((a, b) => a.lineStart - b.lineStart)
      .map((a) => renderCard(a))
      .join('');

    bindCardEvents();
  }

  /**
   * Render a single expandable annotation card.
   */
  function renderCard(a: AnnotationData): string {
    const truncatedText = a.selectedText.length > 80
      ? a.selectedText.substring(0, 80) + '...'
      : a.selectedText;

    const lineLabel = a.lineStart === a.lineEnd
      ? `Line ${a.lineStart}`
      : `Lines ${a.lineStart}-${a.lineEnd}`;

    const timeStr = new Date(a.timestamp).toLocaleTimeString();
    const status = statuses.get(a.id);

    let statusBadge = '';
    let analysisBody = '';

    if (status) {
      if (status.status === 'running') {
        statusBadge = '<span class="card-badge badge-running">Analyzing</span>';
        analysisBody = '<div class="card-analysis-body"><div class="analysis-loading">Claude Code is analyzing this annotation.</div></div>';
      } else if (status.status === 'done' && status.analysis) {
        statusBadge = '<span class="card-badge badge-done">Done</span>';
        analysisBody = `<div class="card-analysis-body"><pre class="analysis-content">${escapeHtml(status.analysis)}</pre></div>`;
      } else if (status.status === 'error') {
        statusBadge = '<span class="card-badge badge-error">Failed</span>';
        analysisBody = `<div class="card-analysis-body"><div class="analysis-error">${escapeHtml(status.error || 'Unknown error')}</div></div>`;
      }
    }

    return `
      <div class="annotation-card" data-id="${a.id}">
        <div class="card-header">
          <div class="card-header-left">
            <span class="annotation-line-label">${lineLabel}</span>
            ${statusBadge}
          </div>
          <span class="card-expand-icon">▶</span>
        </div>
        <div class="card-body">
          <div class="annotation-selected-text">${escapeHtml(truncatedText)}</div>
          ${editingId === a.id ? renderEditForm(a) : `<div class="annotation-text">${escapeHtml(a.annotationText)}</div>`}
          <div class="annotation-meta">
            <span class="annotation-time">${timeStr}</span>
            <div class="annotation-actions">
              <button class="btn-edit" title="Edit" ${editingId === a.id ? 'disabled' : ''}>✎</button>
              <button class="btn-delete" title="Delete">×</button>
            </div>
          </div>
        </div>
        ${analysisBody}
      </div>
    `;
  }

  function renderEditForm(a: AnnotationData): string {
    return `
      <div class="annotation-edit-form">
        <textarea class="annotation-edit-input" spellcheck="false">${escapeHtml(a.annotationText)}</textarea>
        <div class="annotation-edit-actions">
          <button class="btn-save-edit">Save</button>
          <button class="btn-cancel-edit">Cancel</button>
        </div>
      </div>
    `;
  }

  function bindCardEvents(): void {
    container.querySelectorAll('.annotation-card').forEach((card) => {
      const id = card.getAttribute('data-id')!;

      // Click on card header toggles expand
      card.querySelector('.card-header')?.addEventListener('click', (e) => {
        const target = e.target as HTMLElement;
        if (target.tagName === 'BUTTON') { return; }

        const wasExpanded = card.classList.contains('expanded');
        // Close all others
        container.querySelectorAll('.annotation-card.expanded').forEach((c) => {
          c.classList.remove('expanded');
        });
        // Toggle this one
        if (!wasExpanded) {
          card.classList.add('expanded');
          callbacks.onRequestScroll(id);
        }
      });

      // Click on card body (not header) scrolls to annotation
      card.querySelector('.card-body')?.addEventListener('click', (e) => {
        const target = e.target as HTMLElement;
        if (target.closest('button') || target.closest('textarea')) { return; }
        callbacks.onRequestScroll(id);
      });

      card.querySelector('.btn-delete')?.addEventListener('click', (e) => {
        e.stopPropagation();
        callbacks.onDelete(id);
      });

      card.querySelector('.btn-edit')?.addEventListener('click', (e) => {
        e.stopPropagation();
        const ann = currentAnnotations.find((a) => a.id === id);
        if (!ann) { return; }
        editingId = id;
        render(currentAnnotations);
        const editCard = container.querySelector(`[data-id="${id}"]`);
        const input = editCard?.querySelector<HTMLTextAreaElement>('.annotation-edit-input');
        input?.focus();
        input?.setSelectionRange(input.value.length, input.value.length);
      });

      card.querySelector('.btn-save-edit')?.addEventListener('click', (e) => {
        e.stopPropagation();
        const input = card.querySelector<HTMLTextAreaElement>('.annotation-edit-input');
        const newText = input?.value.trim();
        if (!newText) { return; }
        editingId = null;
        callbacks.onEdit(id, newText);
      });

      card.querySelector('.btn-cancel-edit')?.addEventListener('click', (e) => {
        e.stopPropagation();
        editingId = null;
        render(currentAnnotations);
      });

      card.querySelector('.annotation-edit-input')?.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          editingId = null;
          render(currentAnnotations);
        }
        if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
          e.preventDefault();
          e.stopPropagation();
          const input = e.target as HTMLTextAreaElement;
          const newText = input.value.trim();
          if (!newText) { return; }
          editingId = null;
          callbacks.onEdit(id, newText);
        }
      });
    });
  }

  /**
   * Update a single annotation card's analysis status without full re-render.
   */
  function setAnnotationStatus(id: string, newStatus: AnnotationStatus): void {
    statuses.set(id, newStatus);
    render(currentAnnotations);

    // Re-expand the updated card if it has analysis content
    if (newStatus.status === 'done' || newStatus.status === 'error') {
      setTimeout(() => {
        const card = container.querySelector(`[data-id="${id}"]`);
        if (card) {
          card.classList.add('expanded');
        }
      }, 100);
    }
  }

  /**
   * Set all cards to idle (clear analysis state).
   */
  function clearAllStatuses(): void {
    statuses.clear();
    render(currentAnnotations);
  }

  /**
   * Highlight annotations within the visible line range.
   */
  function highlightVisible(visibleStart: number, visibleEnd: number): void {
    container.querySelectorAll('.annotation-card').forEach((card) => {
      const id = card.getAttribute('data-id')!;
      const ann = currentAnnotations.find((a) => a.id === id);
      if (!ann) { return; }
      const overlaps = ann.lineStart <= visibleEnd && ann.lineEnd >= visibleStart;
      card.classList.toggle('visible', overlaps);
    });
  }

  /**
   * Highlight a specific annotation by ID.
   */
  function highlightAnnotation(id: string): void {
    container.querySelectorAll('.annotation-card').forEach((card) => {
      card.classList.toggle('active', card.getAttribute('data-id') === id);
    });
    const targetCard = container.querySelector(`[data-id="${id}"]`);
    if (targetCard) {
      targetCard.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }

  function escapeHtml(text: string): string {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  return {
    render,
    highlightVisible,
    highlightAnnotation,
    setAnnotationStatus,
    clearAllStatuses,
  };
}
