import { useMemo } from "react";
import "katex/dist/katex.min.css";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import type { MathPlugin, StreamdownProps } from "streamdown";
import { MessageResponse } from "@/components/ai-elements/message";

const KATEX_ERROR_COLOR = "__NEKOPILOT_KATEX_ERROR__";

type HastNode = {
  type: string;
  tagName?: string;
  value?: string;
  properties?: { className?: unknown; style?: unknown; encoding?: unknown };
  children?: HastNode[];
};

function extractAnnotationText(node: HastNode): string | null {
  if (
    node.tagName === "annotation" &&
    node.properties?.encoding === "application/x-tex"
  ) {
    return extractHastText(node);
  }
  if (!node.children) return null;
  for (const child of node.children) {
    const found = extractAnnotationText(child);
    if (found !== null) return found;
  }
  return null;
}

function extractHastText(node: HastNode): string {
  if (node.type === "text") return node.value ?? "";
  return node.children?.map(extractHastText).join("") ?? "";
}

function hasKatexError(node: HastNode): boolean {
  const classes = node.properties?.className;
  if (Array.isArray(classes) && classes.includes("katex-error")) return true;
  if (
    typeof node.properties?.style === "string" &&
    node.properties.style.includes(KATEX_ERROR_COLOR)
  ) {
    return true;
  }
  return node.children?.some(hasKatexError) ?? false;
}

function stripKatexErrors(node: HastNode): void {
  if (!node.children) return;
  for (let i = 0; i < node.children.length; i += 1) {
    const child = node.children[i];
    const classes = child.properties?.className;
    const isKatexRoot =
      Array.isArray(classes) &&
      (classes.includes("katex-display") ||
        classes.includes("katex") ||
        classes.includes("katex-error"));
    if (isKatexRoot && hasKatexError(child)) {
      const source = extractAnnotationText(child) ?? extractHastText(child);
      node.children[i] = { type: "text", value: source };
      continue;
    }
    stripKatexErrors(child);
  }
}

function rehypeSafeKatex() {
  const renderKatex = rehypeKatex({ errorColor: KATEX_ERROR_COLOR });
  return (
    tree: Parameters<typeof renderKatex>[0],
    file: Parameters<typeof renderKatex>[1],
  ) => {
    renderKatex(tree, file);
    stripKatexErrors(tree as unknown as HastNode);
  };
}

const mathPlugin: MathPlugin = {
  name: "katex",
  type: "math",
  remarkPlugin: remarkMath,
  rehypePlugin: rehypeSafeKatex,
};

type TextRange = { start: number; end: number };

function collectCodeRanges(content: string): TextRange[] {
  const ranges: TextRange[] = [];
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

// 仅检查最后一个自然段（且位于代码块外），避免跨段把金额 "$20" 与后续公式错配并泄漏尾部 "$"
function completeTrailingInlineMath(text: string): string {
  if (!text.includes("$")) return text;
  const codeRanges = collectCodeRanges(text);
  const lastRange = codeRanges[codeRanges.length - 1];
  if (lastRange && lastRange.end === text.length) return text;

  const paragraphStart = text.lastIndexOf("\n\n");
  const tailStart = paragraphStart === -1 ? 0 : paragraphStart + 2;

  let rangeIndex = 0;
  while (
    rangeIndex < codeRanges.length &&
    codeRanges[rangeIndex].end <= tailStart
  ) {
    rangeIndex += 1;
  }

  let openInline = false;
  for (let i = tailStart; i < text.length; i += 1) {
    const range = codeRanges[rangeIndex];
    if (range && i >= range.start) {
      i = range.end - 1;
      rangeIndex += 1;
      continue;
    }
    if (text[i] === "\\") {
      i += 1;
      continue;
    }
    if (text[i] !== "$") continue;
    const start = i;
    while (text[i + 1] === "$") i += 1;
    if (i - start + 1 === 1) {
      openInline = !openInline;
    }
  }

  if (!openInline) return text;
  let trailingBackslashes = 0;
  for (let i = text.length - 1; i >= 0 && text[i] === "\\"; i -= 1) {
    trailingBackslashes += 1;
  }
  return trailingBackslashes % 2 === 1 ? `${text} $` : `${text}$`;
}

const remendOptions: StreamdownProps["remend"] = {
  katex: true,
  inlineKatex: false,
  handlers: [
    {
      name: "trailing-inline-math",
      priority: 90,
      handle: completeTrailingInlineMath,
    },
  ],
};

function isLikelyBracketMath(expression: string): boolean {
  if (!expression || expression.length > 300) return false;
  if (/^https?:\/\//i.test(expression)) return false;
  return /\\[A-Za-z]+|[_^=|]|\b(?:det|sin|cos|tan|log|ln)\s*\(/.test(
    expression,
  );
}

function collectDollarMathRanges(content: string, streaming: boolean): TextRange[] {
  const ranges: TextRange[] = [];
  let open: { start: number; length: number; block: boolean } | undefined;

  for (const token of content.matchAll(
    /^(?<block>[ \t]*\${2,}[ \t]*\r?)$|\\[^\r\n]|(?<inline>\$+)|\r?\n(?=[ \t]*\r?\n)/gm,
  )) {
    const { block, inline } = token.groups!;
    const start = token.index;
    if (!block && !inline) {
      if (!open?.block && token[0].endsWith("\n")) open = undefined;
      continue;
    }

    const length = (block ?? inline).trim().length;
    if (open?.block) {
      if (!block || length < open.length) continue;
    } else if (block || length !== open?.length) {
      open = { start, length, block: block !== undefined };
      continue;
    }

    ranges.push({ start: open.start, end: start + token[0].length });
    open = undefined;
  }

  if (open && (open.block || streaming)) {
    ranges.push({ start: open.start, end: content.length });
  }
  return ranges;
}

function normalizeMathChunk(
  chunk: string,
  startsAtLineStart: boolean,
  endsAtLineEnd: boolean,
  streaming: boolean,
): string {
  const rawLines = chunk.split("\n");
  const latexNormalized = rawLines
    .map((line, index) => {
      const atStart = index > 0 || startsAtLineStart;
      const atEnd = index < rawLines.length - 1 || endsAtLineEnd;
      if (atStart && atEnd && /^\s*\\[\[\]]\s*$/.test(line)) return "$$";

      return line.replace(
        /\\\[([^\n]*?)\\\]/g,
        (_match, expr: string) => `\n$$\n${expr}\n$$`,
      );
    })
    .join("\n");
  const lines = latexNormalized.split("\n");
  const mathRanges = latexNormalized.includes("[")
    ? collectDollarMathRanges(latexNormalized, streaming)
    : [];
  let rangeIndex = 0;
  let nextLineStart = 0;

  return lines
    .map((line, index) => {
      const atStart = index > 0 || startsAtLineStart;
      const atEnd = index < lines.length - 1 || endsAtLineEnd;
      const lineStart = nextLineStart;
      nextLineStart += line.length + 1;
      let normalized = line;

      if (line.includes("[")) {
        normalized = line.replace(
          /(^|[^!])\[([^\]\n]+)\](?!\()/g,
          (match, prefix: string, expression: string, offset: number) => {
            const bracketStart = lineStart + offset + prefix.length;
            while (
              rangeIndex < mathRanges.length &&
              mathRanges[rangeIndex].end <= bracketStart
            ) {
              rangeIndex += 1;
            }
            const mathRange = mathRanges[rangeIndex];
            if (
              mathRange &&
              mathRange.start < lineStart + offset + match.length
            ) {
              return match;
            }

            const math = expression.trim();
            if (!isLikelyBracketMath(math)) return match;
            const before = prefix.trimEnd();
            const isWholeLineMath =
              atStart &&
              atEnd &&
              offset === 0 &&
              /^\s*(?:[-*+]\s*|\d+[.)]\s*)?$/.test(prefix) &&
              normalized.slice(offset + match.length).trim() === "";
            if (isWholeLineMath) {
              return `${before ? `${before} ` : ""}\n$$\n${math}\n$$`;
            }
            return `${prefix}$${math}$`;
          },
        );
      }

      if (normalized.includes("$$")) {
        normalized = normalized.replace(
          /(?<!\\)(?<!\$)\$\$(?!\$)((?:\\.|[^\\\n$])+?)(?<!\\)\$\$(?!\$)/g,
          (match, expression: string, offset: number) => {
            const trimmed = expression.trim();
            if (!trimmed) return match;
            const needsLeadingBreak = !atStart || offset > 0;
            const needsTrailingBreak =
              !atEnd || offset + match.length < normalized.length;
            return `${needsLeadingBreak ? "\n" : ""}$$\n${trimmed}\n$$${needsTrailingBreak ? "\n" : ""}`;
          },
        );
      }

      return normalized;
    })
    .join("\n");
}

// 归一化 LaTeX \[...\]、裸方括号公式与单行 $$...$$，同时跳过代码围栏与行内代码
function normalizeMathDelimiters(content: string, streaming: boolean): string {
  if (
    !content.includes("\\[") &&
    !content.includes("\\]") &&
    !content.includes("[") &&
    !content.includes("$$")
  ) {
    return content;
  }

  const ranges = collectCodeRanges(content);
  let result = "";
  let cursor = 0;
  for (const range of ranges) {
    if (cursor < range.start) {
      result += normalizeMathChunk(
        content.slice(cursor, range.start),
        cursor === 0 || content[cursor - 1] === "\n",
        content[range.start] === "\n",
        false,
      );
    }
    result += content.slice(range.start, range.end);
    cursor = range.end;
  }
  if (cursor < content.length) {
    result += normalizeMathChunk(
      content.slice(cursor),
      cursor === 0 || content[cursor - 1] === "\n",
      true,
      streaming,
    );
  }
  return result;
}

const streamdownPlugins = { math: mathPlugin };

export function MarkdownMessage({
  content,
  streaming,
}: {
  content: string;
  streaming: boolean;
}) {
  const normalizedContent = useMemo(
    () => normalizeMathDelimiters(content, streaming),
    [content, streaming],
  );

  return (
    <MessageResponse
      mode={streaming ? "streaming" : "static"}
      isAnimating={streaming}
      plugins={streamdownPlugins}
      remend={remendOptions}
      className="markdown text-sm leading-relaxed"
    >
      {normalizedContent}
    </MessageResponse>
  );
}
