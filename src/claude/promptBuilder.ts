/**
 * Prompt builder for Claude Code two-phase processing.
 * Phase 1 runs per-annotation sub-agents in parallel, each doing web search
 * verification and generating supplementary materials before suggesting edits.
 */
import { Annotation } from '../types';

export class PromptBuilder {
  /**
   * Build a per-annotation prompt for a single sub-agent.
   * Includes: surrounding context, the annotation, and web search / supplement instructions.
   */
  buildSingleAnnotationPrompt(
    annotation: Annotation,
    fileContent: string,
    filePath: string,
    annotationIndex: number,
    totalAnnotations: number
  ): string {
    const lines = fileContent.split('\n');

    // Extract surrounding context (±5 lines around the annotation range)
    const contextStart = Math.max(0, annotation.lineStart - 6); // 0-based, -5 lines
    const contextEnd = Math.min(lines.length, annotation.lineEnd + 5);
    const contextLines = lines.slice(contextStart, contextEnd)
      .map((line, idx) => `[${contextStart + idx + 1}] ${line}`)
      .join('\n');

    return `You are a professional documentation review assistant. You are processing annotation ${annotationIndex + 1}/${totalAnnotations}.
Only handle the single annotation below. Do not infer or process any other annotation.

===== DOCUMENT CONTEXT (±5 lines around the annotation) =====
${contextLines}

===== CURRENT ANNOTATION =====
Annotation ID: ${annotation.id}
Line range: ${annotation.lineStart}-${annotation.lineEnd}
Selected text: "${annotation.selectedText}"
Annotation comment: "${annotation.annotationText}"
Document name: ${filePath.split('/').pop() || filePath}

===== TASK =====
Complete the review in three steps:

**Step 1 — Verification**
Verify the annotation's claim before proposing a change.
- Use web search when the annotation involves current facts, external references, terminology, statistics, product names, APIs, or anything that may be time-sensitive.
- If the annotation is purely about clarity, style, structure, or local document consistency, use the provided document context instead of unnecessary web search.
- Treat verification as evidence for the final suggestion, not as extra prose for its own sake.

**Step 2 — Supplements**
Based on the verification result, prepare concise supporting material:
- If a more accurate term or phrasing exists, show the comparison.
- If background, examples, or links should be added, organize them into reusable source material.
- If the annotation involves technical details, provide a precise technical explanation.

**Step 3 — Suggestion**
Produce a final edit suggestion based on the annotation, the local context, and any verified external evidence.

===== OUTPUT FORMAT =====
Return exactly the following structure. All three sections are required:

--- ANALYSIS START ---
ID: ${annotation.id}
LINES: ${annotation.lineStart}-${annotation.lineEnd}
ANNOTATION: "${annotation.annotationText}"

=== VERIFICATION ===
<Verification findings. Include source URLs when web search was used. If no web search was needed, state why local context was sufficient.>

=== SUPPLEMENTS ===
<Supplementary material: references, examples, comparisons, or technical explanation. Keep it concise.>

=== SUGGESTION ===
ORIGINAL: <The exact selected text from the annotation. Preserve formatting exactly.>
REPLACE: <The revised text. Preserve Markdown formatting and indentation. If the annotation is only a comment/question and does not request a concrete edit, write "NO_CHANGE".>
RATIONALE: <Brief reason for the suggested edit, grounded in verification and supplements.>
--- ANALYSIS END ---

**Important constraints:**
1. ORIGINAL must exactly match the selected text in the annotation.
2. REPLACE must preserve the original indentation style and Markdown format.
3. If the annotation is a question/comment rather than a clear edit request, set REPLACE to "NO_CHANGE" and explain why in RATIONALE.
4. When web search is used, every factual claim from external sources must include its source URL.
5. If the document conflicts with verified evidence, explicitly identify the conflict.
6. Do not rewrite unrelated nearby text. Only suggest the smallest change that satisfies the annotation.`;
  }

  /**
   * Build Phase 2 prompt: apply all modification suggestions to the original document.
   */
  buildPhase2Prompt(
    fileContent: string,
    suggestionsDoc: string
  ): string {
    return `You are a precise documentation editor. Apply the following suggestions to the original document and output the complete modified document.

===== ORIGINAL DOCUMENT =====
${fileContent}

===== MODIFICATION SUGGESTIONS =====
${suggestionsDoc}

===== OUTPUT REQUIREMENTS =====
Apply all valid modification suggestions to the original document and output the complete modified document.

**Critical constraints:**
1. Output only the complete modified document. Do not include explanations, comments, or code fences.
2. Do not add introductory text such as "Here is the modified document".
3. Preserve the document's overall structure, indentation style, heading hierarchy, and blank-line style.
4. For each suggestion, replace ORIGINAL with REPLACE exactly.
5. If a suggestion has REPLACE set to "NO_CHANGE", skip that suggestion.
6. Preserve all content that is not directly targeted by a valid suggestion.

**Conflict handling:**
- If multiple suggestions modify the same text, apply them in the order they appear; the later suggestion wins.
- If a suggestion cannot be applied unambiguously, leave the original text unchanged.`;
  }

  /**
   * Merge multiple per-annotation analysis outputs into a unified suggestions document.
   */
  mergeAnalyses(analyses: string[], annotations: Annotation[]): string {
    const sections: string[] = [
      '# Modification Suggestions',
      '',
      `Generated from ${analyses.length} annotation(s) with web search verification.`,
      '',
      'Each section below contains: Verification results, Supplementary materials, and Modification suggestions.',
      '',
      '---',
      '',
    ];

    analyses.forEach((analysis, i) => {
      const ann = annotations[i];
      sections.push(`## Annotation ${i + 1}: ${ann.annotationText.substring(0, 80)}`);
      sections.push('');
      sections.push('```');
      sections.push(analysis.trim());
      sections.push('```');
      sections.push('');
    });

    return sections.join('\n');
  }

  /**
   * Parse a single annotation's analysis output into a structured suggestion.
   */
  parseSingleAnalysis(raw: string): {
    id: string;
    lines: string;
    original: string;
    replace: string;
    rationale: string;
  } | null {
    const match = raw.match(/=== SUGGESTION ===\s*\nORIGINAL:\s*(.+?)\nREPLACE:\s*(.+?)\nRATIONALE:\s*(.+?)(?:\n---|\n===|\n$)/s);
    if (!match) { return null; }

    const idMatch = raw.match(/ID:\s*(\S+)/);
    const linesMatch = raw.match(/LINES:\s*(\d+-\d+)/);

    return {
      id: idMatch ? idMatch[1] : '',
      lines: linesMatch ? linesMatch[1] : '',
      original: match[1].trim(),
      replace: match[2].trim(),
      rationale: match[3].trim(),
    };
  }
}
