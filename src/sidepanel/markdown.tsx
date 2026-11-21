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

// 仅检查最后一个自然段，避免跨段把金额 "$20" 与后续公式错配并泄漏尾部 "$"
function completeTrailingInlineMath(text: string): string {
  const paragraphStart = text.lastIndexOf("\n\n");
  const tail = paragraphStart === -1 ? text : text.slice(paragraphStart + 2);
  if (!tail.includes("$") || /^\s*(`{3,}|~{3,})/.test(tail)) return text;

  let openInline = false;
  for (let i = 0; i < tail.length; i += 1) {
    if (tail[i] === "\\") {
      i += 1;
      continue;
    }
    if (tail[i] === "`") {
      const start = i;
      while (tail[i + 1] === "`") i += 1;
      const len = i - start + 1;
      for (let j = i + 1; j < tail.length; j += 1) {
        if (tail[j] !== "`") continue;
        const cStart = j;
        while (tail[j + 1] === "`") j += 1;
        if (j - cStart + 1 === len) {
          i = j;
          break;
        }
      }
      continue;
    }
    if (tail[i] !== "$") continue;
    const start = i;
    while (tail[i + 1] === "$") i += 1;
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

// 将常见的 LaTeX 块级定界符 \[...\] 转为 remark-math 支持的 $$...$$（跳过代码围栏）
function normalizeLatexBrackets(content: string): string {
  if (!content.includes("\\[") && !content.includes("\\]")) return content;
  const lines = content.split("\n");
  let fence: { marker: string; length: number } | null = null;
  return lines
    .map((line) => {
      const fenceMatch =
        /^[ \t]*(?:>[ \t]*)*(?:[-*+][ \t]+|\d+[.)][ \t]+)?(`{3,}|~{3,})(.*)$/.exec(
          line,
        );
      if (fence) {
        if (
          fenceMatch &&
          fenceMatch[1][0] === fence.marker &&
          fenceMatch[1].length >= fence.length &&
          !fenceMatch[2].trim()
        ) {
          fence = null;
        }
        return line;
      }
      if (
        fenceMatch &&
        (fenceMatch[1][0] !== "`" || !fenceMatch[2].includes("`"))
      ) {
        fence = { marker: fenceMatch[1][0], length: fenceMatch[1].length };
        return line;
      }
      if (/^\s*\\\[\s*$/.test(line) || /^\s*\\\]\s*$/.test(line)) return "$$";
      return line.replace(
        /\\\[([^\n]*?)\\\]/g,
        (_match, expr: string) => `\n$$\n${expr}\n$$`,
      );
    })
    .join("\n");
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
    () => normalizeLatexBrackets(content),
    [content],
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
