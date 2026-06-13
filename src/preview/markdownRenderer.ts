/**
 * Markdown-to-HTML renderer using markdown-it.
 * Injects data-source-line attributes for source mapping.
 */
import MarkdownIt from 'markdown-it';

/**
 * Custom markdown-it plugin that adds data-source-line-start
 * and data-source-line-end attributes to block-level tokens.
 *
 * Strategy: Override md.render to walk parsed tokens BEFORE rendering,
 * and set data attributes on block-level open/self-closing tokens.
 */
function sourceLinePlugin(md: MarkdownIt): void {
  const originalRender = md.render.bind(md);

  md.render = function (src: string, env?: any): string {
    // Parse tokens first
    const tokens = md.parse(src, env ?? {});

    // Walk through all tokens and inject line attributes on block-level elements.
    // Only _open tokens and self-closing block tokens create HTML elements.
    const blockOpenTypes = new Set([
      'paragraph_open', 'heading_open', 'bullet_list_open', 'ordered_list_open',
      'list_item_open', 'blockquote_open', 'table_open', 'thead_open',
      'tbody_open', 'tr_open', 'th_open', 'td_open',
    ]);
    const selfClosingTypes = new Set(['fence', 'hr', 'html_block']);

    for (const token of tokens) {
      if (token.map && (blockOpenTypes.has(token.type) || selfClosingTypes.has(token.type))) {
        const lineStart = token.map[0] + 1; // 0-based → 1-based
        const lineEnd = token.map[1];       // exclusive end
        token.attrSet('data-source-line-start', String(lineStart));
        token.attrSet('data-source-line-end', String(lineEnd));
      }
    }

    // Render the modified tokens
    return md.renderer.render(tokens, md.options, env ?? {});
  };
}

export class MarkdownRenderer {
  private md: MarkdownIt;

  constructor() {
    this.md = new MarkdownIt({
      html: true,
      linkify: true,
      typographer: true,
      breaks: false,
    });

    this.md.use(sourceLinePlugin);
  }

  /**
   * Render markdown source to HTML with source line annotations.
   */
  render(source: string): string {
    return this.md.render(source);
  }

  /**
   * Render markdown source and wrap in a styled container.
   */
  renderWithWrapper(source: string): string {
    const bodyHtml = this.render(source);
    return `<div class="markdown-body">${bodyHtml}</div>`;
  }
}
