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

function appendSyntheticMathCloser(content: string, closer: string): string {
  if (closer.length >= 2) {
    return content + (content.endsWith("\n") ? "" : "\n") + closer;
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

  const { openMath } = scanMathSegments(content);
  if (openMath) {
    return appendSyntheticMathCloser(content, "$".repeat(openMath.length));
  }
  return content;
}

type CodeRange = { start: number; end: number };
type MathSegment = {
  expression: string;
  displayMode: boolean;
  start: number;
  end: number;
  raw: string;
};

function collectCodeRanges(content: string): CodeRange[] {
  const ranges: CodeRange[] = [];
  let fence: { marker: string; length: number; start: number } | null = null;

  for (let index = 0; index < content.length; index += 1) {
    if (index === 0 || content[index - 1] === "\n") {
      const lineEnd = content.indexOf("\n", index);
      const end = lineEnd === -1 ? content.length : lineEnd + 1;
      const line = content.slice(index, end).trimEnd();
      const match =
        /^[ \t]*(?:>[ \t]*)*(?:[-*+][ \t]+|\d+[.)][ \t]+)?(`{3,}|~{3,})(.*)$/.exec(
          line,
        );
      if (fence) {
        if (
          match &&
          match[1][0] === fence.marker &&
          match[1].length >= fence.length &&
          !match[2].trim()
        ) {
          ranges.push({ start: fence.start, end });
          fence = null;
        }
        index = end - 1;
        continue;
      }
      if (match && (match[1][0] !== "`" || !match[2].includes("`"))) {
        fence = { marker: match[1][0], length: match[1].length, start: index };
        index = end - 1;
        continue;
      }
    }

    if (content[index] === "\\") {
      index += 1;
      continue;
    }
    if (content[index] !== "`") continue;
    const start = index;
    while (content[index + 1] === "`") index += 1;
    const length = index - start + 1;
    // 行内代码只能由相同长度的反引号闭合，内部的转义不影响定界符。
    for (let cursor = index + 1; cursor < content.length; cursor += 1) {
      if (content[cursor] !== "`") continue;
      const closerStart = cursor;
      while (content[cursor + 1] === "`") cursor += 1;
      if (cursor - closerStart + 1 !== length) continue;
      ranges.push({ start, end: cursor + 1 });
      index = cursor;
      break;
    }
  }
  if (fence) ranges.push({ start: fence.start, end: content.length });
  return ranges;
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
  const ranges = collectCodeRanges(content);
  let result = "";
  let cursor = 0;
  for (const range of ranges) {
    result += normalizeBracketMathText(content.slice(cursor, range.start));
    result += content.slice(range.start, range.end);
    cursor = range.end;
  }
  return result + normalizeBracketMathText(content.slice(cursor));
}

function normalizeBracketMathText(content: string): string {
  const lines = content.split("\n");

  return lines
    .map((line) => {
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

function collectMathSegments(content: string): MathSegment[] {
  return scanMathSegments(content).segments;
}

function scanMathSegments(content: string): {
  segments: MathSegment[];
  openMath: { start: number; length: number; displayMode: boolean } | null;
} {
  const segments: MathSegment[] = [];
  const codeRanges = collectCodeRanges(content);
  let rangeIndex = 0;
  let openMath: { start: number; length: number; displayMode: boolean } | null =
    null;

  for (let index = 0; index < content.length; index += 1) {
    const range = codeRanges[rangeIndex];
    if (range && index === range.start) {
      index = range.end - 1;
      rangeIndex += 1;
      continue;
    }
    if (content[index] === "\\") {
      index += 1;
      continue;
    }
    // 行内公式不能跨空段落，避免将金额后的正文当成未闭合公式。
    if (
      openMath &&
      !openMath.displayMode &&
      content[index] === "\n" &&
      /^\n[ \t]*\n/.test(content.slice(index))
    ) {
      openMath = null;
    }
    if (content[index] !== "$") continue;

    const start = index;
    while (content[index + 1] === "$") index += 1;
    const length = index - start + 1;
    if (
      openMath &&
      (openMath.displayMode ? length >= openMath.length : length === 1)
    ) {
      const end = index + 1;
      segments.push({
        expression: content.slice(openMath.start + openMath.length, start),
        displayMode: openMath.displayMode,
        start: openMath.start,
        end,
        raw: content.slice(openMath.start, end),
      });
      openMath = null;
      continue;
    }
    if (openMath?.displayMode) continue;
    openMath = { start, length, displayMode: length >= 2 };
  }

  return { segments, openMath };
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
