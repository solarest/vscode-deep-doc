/**
 * Scroll synchronization between preview and annotation panel.
 * Uses IntersectionObserver for performant visibility tracking.
 */

export function initScrollSync(
  previewContainer: HTMLElement,
  onVisibleLinesChange: (start: number, end: number) => void
) {
  const observedElements = new Map<Element, number>(); // element -> lineStart
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        const lineStart = parseInt(
          entry.target.getAttribute('data-source-line-start') || '0',
          10
        );
        observedElements.set(entry.target, lineStart);
      });

      // Debounce the visibility report
      if (debounceTimer) {
        clearTimeout(debounceTimer);
      }
      debounceTimer = setTimeout(() => {
        // Collect currently visible line starts
        const visibleLines: number[] = [];
        observer.takeRecords().forEach((entry) => {
          const lineStart = parseInt(
            entry.target.getAttribute('data-source-line-start') || '0',
            10
          );
          if (entry.isIntersecting && lineStart > 0) {
            visibleLines.push(lineStart);
          }
        });

        // Also check entries from the initial batch
        entries.forEach((entry) => {
          const lineStart = parseInt(
            entry.target.getAttribute('data-source-line-start') || '0',
            10
          );
          if (entry.isIntersecting && lineStart > 0) {
            visibleLines.push(lineStart);
          }
        });

        if (visibleLines.length > 0) {
          const minLine = Math.min(...visibleLines);
          const maxLine = Math.max(...visibleLines);
          onVisibleLinesChange(minLine, maxLine);
        }
      }, 100);
    },
    {
      root: previewContainer,
      rootMargin: '0px',
      threshold: 0.1,
    }
  );

  // Observe all elements with data-source-line-start
  const elements = previewContainer.querySelectorAll('[data-source-line-start]');
  elements.forEach((el) => {
    observer.observe(el);
  });

  // Re-observe when content changes (mutation observer for dynamic content)
  const mutationObserver = new MutationObserver((mutations) => {
    mutations.forEach((mutation) => {
      mutation.addedNodes.forEach((node) => {
        if (node instanceof HTMLElement) {
          if (node.hasAttribute('data-source-line-start')) {
            observer.observe(node);
          }
          // Also check children
          node.querySelectorAll('[data-source-line-start]').forEach((child) => {
            observer.observe(child);
          });
        }
      });
    });
  });

  mutationObserver.observe(previewContainer, {
    childList: true,
    subtree: true,
  });

  return {
    destroy: () => {
      observer.disconnect();
      mutationObserver.disconnect();
      if (debounceTimer) {
        clearTimeout(debounceTimer);
      }
    },
  };
}
