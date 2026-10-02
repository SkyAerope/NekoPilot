import { useMemo, useRef } from "react";
import katex from "katex";
import "katex/dist/katex.min.css";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import { MessageResponse } from "@/components/ai-elements/message";

function escapeMathDelimiters(raw: string): string {
  return raw.replace(/\$/g, "\\$");
}

function appendSyntheticMathCloser(
  content: string,
  closer: "$" | "$$",
): string {
  if (closer === "$$") {
    return content + (content.endsWith("\n") ? "" : "\n") + "$$";
  }

  let trailingBackslashes = 0;
  for (
    let index = content.length - 1;
    index >= 0 && content[index] === "\\";
    index -= 1
  ) {
    trailingBackslashes += 1;
  }

  if (trailingBackslashes % 2 === 1) return content + " " + closer;

  return content + closer;
}

function getStreamingMarkdownPreview(
  content: string,
  streaming: boolean,
): string {
  if (!streaming || !content) return content;

  let insideInlineCode = false;
  let insideFence = false;
  let insideInlineMath = false;
  let insideBlockMath = false;

  for (let index = 0; index < content.length; index += 1) {
    const char = content[index];
    const prev = index > 0 ? content[index - 1] : "";

    if (!insideInlineCode && char === "`" && prev !== "\\") {
      const tickStart = index;
      while (index + 1 < content.length && content[index + 1] === "`")
        index += 1;
      const tickCount = index - tickStart + 1;
      const lineStart = tickStart === 0 || content[tickStart - 1] === "\n";

      if (tickCount >= 3 && lineStart) {
        insideFence = !insideFence;
        continue;
      }

      if (!insideFence && tickCount === 1) {
        insideInlineCode = !insideInlineCode;
      }
      continue;
    }

    if (insideFence || insideInlineCode) continue;

    if (char === "\\") {
      index += 1;
      continue;
    }

    if (char !== "$") continue;

    const dollarStart = index;
    while (index + 1 < content.length && content[index + 1] === "$") index += 1;
    const dollarCount = index - dollarStart + 1;

    if (insideBlockMath) {
      if (dollarCount >= 2) insideBlockMath = false;
      continue;
    }

    if (dollarCount >= 2) {
      insideBlockMath = true;
      if (dollarCount % 2 === 1) insideInlineMath = !insideInlineMath;
      continue;
    }

    insideInlineMath = !insideInlineMath;
  }

  if (insideBlockMath) return appendSyntheticMathCloser(content, "$$");
  if (insideInlineMath) return appendSyntheticMathCloser(content, "$");
  return content;
}

function normalizeDisplayMathBlocks(content: string): string {
  const segments = collectMathSegments(content);
  if (segments.length === 0) return content;

  let next = "";
  let cursor = 0;

  for (const segment of segments) {
    next += content.slice(cursor, segment.start);
    if (!segment.displayMode) {
      next += segment.raw;
      cursor = segment.end;
      continue;
    }

    const needsLeadingBreak =
      segment.start > 0 && content[segment.start - 1] !== "\n";
    const needsTrailingBreak =
      segment.end < content.length && content[segment.end] !== "\n";
    next += `${needsLeadingBreak ? "\n" : ""}$$\n${segment.expression.trim()}\n$$${needsTrailingBreak ? "\n" : ""}`;
    cursor = segment.end;
  }

  next += content.slice(cursor);
  return next;
}

function normalizeBracketMath(content: string): string {
  const lines = content.split("\n");
  let insideFence = false;

  return lines
    .map((line) => {
      const trimmed = line.trimStart();
      if (trimmed.startsWith("```")) {
        insideFence = !insideFence;
        return line;
      }
      if (insideFence) return line;

      // LaTeX 的转义定界符先归一化，避免被普通方括号规则拆成转义美元符号。
      if (/^\s*\\\[\s*$/.test(line) || /^\s*\\\]\s*$/.test(line)) return "$$";
      const normalizedLine = line.replace(
        /\\\[([^\n]*?)\\\]/g,
        (_match, expression: string) => `\n$$\n${expression}\n$$`,
      );
      if (!normalizedLine.includes("[")) return normalizedLine;

      return normalizedLine.replace(
        /(^|[^!])\[([^\]\n]+)\](?!\()/g,
        (match, prefix: string, expression: string) => {
          const math = expression.trim();
          if (!isLikelyBracketMath(math)) return match;
          const before = prefix.trimEnd();
          const isWholeLineMath =
            /^\s*(?:[-*+]\s*|\d+[.)]\s*)?$/.test(prefix) &&
            normalizedLine
              .slice(normalizedLine.indexOf(match) + match.length)
              .trim() === "";
          if (isWholeLineMath) {
            return `${before ? `${before} ` : ""}\n$$\n${math}\n$$`;
          }
          return `${prefix}$${math}$`;
        },
      );
    })
    .join("\n");
}

function isLikelyBracketMath(expression: string): boolean {
  if (!expression || expression.length > 300) return false;
  if (/^https?:\/\//i.test(expression)) return false;
  return /\\[A-Za-z]+|[_^=|]|\b(?:det|sin|cos|tan|log|ln)\s*\(/.test(
    expression,
  );
}

function escapeInvalidMathBlocks(content: string): string {
  const segments = collectMathSegments(content);
  if (segments.length === 0) return content;

  let next = "";
  let cursor = 0;

  for (const segment of segments) {
    next += content.slice(cursor, segment.start);
    next += canRenderMathSegment(segment)
      ? segment.raw
      : escapeMathDelimiters(segment.raw);
    cursor = segment.end;
  }

  next += content.slice(cursor);
  return next;
}

function collectMathSegments(content: string): Array<{
  expression: string;
  displayMode: boolean;
  start: number;
  end: number;
  raw: string;
}> {
  const segments: Array<{
    expression: string;
    displayMode: boolean;
    start: number;
    end: number;
    raw: string;
  }> = [];
  let insideInlineCode = false;
  let insideFence = false;
  let inlineMathStart = -1;
  let blockMathStart = -1;

  for (let index = 0; index < content.length; index += 1) {
    const char = content[index];
    const prev = index > 0 ? content[index - 1] : "";

    if (!insideInlineCode && char === "`" && prev !== "\\") {
      const tickStart = index;
      while (index + 1 < content.length && content[index + 1] === "`")
        index += 1;
      const tickCount = index - tickStart + 1;
      const lineStart = tickStart === 0 || content[tickStart - 1] === "\n";

      if (tickCount >= 3 && lineStart) {
        insideFence = !insideFence;
        continue;
      }

      if (!insideFence && tickCount === 1) {
        insideInlineCode = !insideInlineCode;
      }
      continue;
    }

    if (insideFence || insideInlineCode) continue;

    if (char === "\\") {
      index += 1;
      continue;
    }

    if (char !== "$") continue;

    const dollarStart = index;
    while (index + 1 < content.length && content[index + 1] === "$") index += 1;
    const dollarCount = index - dollarStart + 1;

    if (blockMathStart !== -1) {
      if (dollarCount >= 2) {
        const start = blockMathStart - 2;
        const end = dollarStart + dollarCount;
        segments.push({
          expression: content.slice(blockMathStart, dollarStart),
          displayMode: true,
          start,
          end,
          raw: content.slice(start, end),
        });
        blockMathStart = -1;
      }
      continue;
    }

    if (inlineMathStart !== -1) {
      if (dollarCount === 1) {
        const start = inlineMathStart - 1;
        const end = dollarStart + 1;
        segments.push({
          expression: content.slice(inlineMathStart, dollarStart),
          displayMode: false,
          start,
          end,
          raw: content.slice(start, end),
        });
        inlineMathStart = -1;
        continue;
      }

      inlineMathStart = -1;
    }

    if (dollarCount >= 2) {
      blockMathStart = dollarStart + 2;
      continue;
    }

    inlineMathStart = dollarStart + 1;
  }

  return segments;
}

function canRenderMathSegment(segment: {
  expression: string;
  displayMode: boolean;
}): boolean {
  const trimmed = segment.expression.trimEnd();
  if (!trimmed) return false;

  let braceDepth = 0;
  let escaped = false;
  for (const char of trimmed) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === "{") braceDepth += 1;
    if (char === "}" && braceDepth > 0) braceDepth -= 1;
  }

  if (escaped || braceDepth > 0) return false;
  if (/[\\_^]$/.test(trimmed)) return false;
  if (/\\[A-Za-z]*$/.test(trimmed)) return false;

  try {
    katex.renderToString(segment.expression, {
      displayMode: segment.displayMode,
      throwOnError: true,
    });
    return true;
  } catch {
    return false;
  }
}

function getStableMathPreview(
  content: string,
  previousSegments: Array<{ raw: string; displayMode: boolean }>,
): {
  renderContent: string;
  nextSegments: Array<{ raw: string; displayMode: boolean }>;
} {
  const segments = collectMathSegments(content);
  if (segments.length === 0) {
    return { renderContent: content, nextSegments: [] };
  }

  let renderContent = "";
  let cursor = 0;
  const nextSegments: Array<{ raw: string; displayMode: boolean }> = [];

  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    renderContent += content.slice(cursor, segment.start);

    if (canRenderMathSegment(segment)) {
      renderContent += segment.raw;
      nextSegments.push({ raw: segment.raw, displayMode: segment.displayMode });
    } else {
      const cached = previousSegments[index];
      if (cached && cached.displayMode === segment.displayMode) {
        renderContent += cached.raw;
        nextSegments.push(cached);
      }
    }

    cursor = segment.end;
  }

  renderContent += content.slice(cursor);
  return { renderContent, nextSegments };
}

export function MarkdownMessage({
  content,
  streaming,
}: {
  content: string;
  streaming: boolean;
}) {
  const lastGoodSegmentsRef = useRef<
    Array<{ raw: string; displayMode: boolean }>
  >([]);
  const renderContent = useMemo(() => {
    const previewContent = getStreamingMarkdownPreview(content, streaming);
    const bracketNormalizedContent = normalizeBracketMath(previewContent);
    const normalizedContent = normalizeDisplayMathBlocks(
      bracketNormalizedContent,
    );
    const sanitizedContent = escapeInvalidMathBlocks(normalizedContent);
    const stablePreview = getStableMathPreview(
      sanitizedContent,
      lastGoodSegmentsRef.current,
    );
    lastGoodSegmentsRef.current = stablePreview.nextSegments;
    return stablePreview.renderContent;
  }, [content, streaming]);

  return (
    <MessageResponse
      remarkPlugins={[remarkGfm, remarkMath]}
      rehypePlugins={[rehypeKatex]}
      mode="static"
      className="markdown text-sm leading-relaxed"
    >
      {renderContent}
    </MessageResponse>
  );
}
