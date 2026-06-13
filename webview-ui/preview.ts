/**
 * Markdown preview panel: renders HTML, handles text selection, manages annotation markers.
 */

interface PreviewCallbacks {
  onTextSelected: (lineStart: number, lineEnd: number, selectedText: string) => void;
  onScrollToLine: (lineStart: number) => void;
}

interface AnnotationMarker {
  id: string;
  lineStart: number;
  lineEnd: number;
}

export function initPreview(container: HTMLElement, callbacks: PreviewCallbacks) {
  let markers: AnnotationMarker[] = [];

  /**
   * Render markdown HTML into the preview container.
   */
  function render(html: string): void {
    container.innerHTML = html;
    markers = [];
  }

  /**
   * Find the source line range from a DOM element by walking up
   * to find data-source-line-start attribute.
   */
  function getLineRangeFromElement(el: Element | null): { lineStart: number; lineEnd: number } | null {
    while (el && el !== container) {
      const start = el.getAttribute('data-source-line-start');
      const end = el.getAttribute('data-source-line-end');
      if (start !== null) {
        return {
          lineStart: parseInt(start, 10),
          lineEnd: end !== null ? parseInt(end, 10) : parseInt(start, 10),
        };
      }
      el = el.parentElement;
    }
    return null;
  }

  /**
   * Handle text selection in the preview area.
   */
  container.addEventListener('mouseup', () => {
    // Small delay to let the selection settle
    setTimeout(() => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || !sel.toString().trim()) {
        return;
      }

      const range = sel.getRangeAt(0);
      const selectedText = sel.toString();

      // Find line range from the start container
      const startEl = range.startContainer.parentElement;
      const endEl = range.endContainer.parentElement;

      const startRange = getLineRangeFromElement(startEl);
      const endRange = getLineRangeFromElement(endEl);

      if (startRange && endRange) {
        callbacks.onTextSelected(
          startRange.lineStart,
          endRange.lineEnd,
          selectedText
        );
      }

      // Clear selection for better UX
      sel.removeAllRanges();
    }, 10);
  });

  /**
   * Add a visual marker for an annotation in the preview.
   */
  function addAnnotationMarker(annotation: AnnotationMarker): void {
    markers.push(annotation);

    // Find all elements within the line range and highlight them
    const elements = container.querySelectorAll('[data-source-line-start]');
    elements.forEach((el) => {
      const lineStart = parseInt(el.getAttribute('data-source-line-start') || '0', 10);
      const lineEnd = parseInt(el.getAttribute('data-source-line-end') || '0', 10);

      if (lineStart >= annotation.lineStart && lineEnd <= annotation.lineEnd + 1) {
        el.classList.add('has-annotation');
        el.setAttribute('data-annotation-ids',
          (el.getAttribute('data-annotation-ids') || '') + annotation.id + ','
        );
      }
    });
  }

  /**
   * Clear all annotation markers from the preview.
   */
  function clearMarkers(): void {
    const elements = container.querySelectorAll('.has-annotation');
    elements.forEach((el) => {
      el.classList.remove('has-annotation');
      el.removeAttribute('data-annotation-ids');
    });
    markers = [];
  }

  /**
   * Scroll the preview to a specific line.
   */
  function scrollToLine(lineStart: number): void {
    const el = container.querySelector(`[data-source-line-start="${lineStart}"]`);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      // Brief highlight
      el.classList.add('highlight-flash');
      setTimeout(() => el.classList.remove('highlight-flash'), 1500);
    }
  }

  return {
    render,
    addAnnotationMarker,
    clearMarkers,
    scrollToLine,
  };
}
