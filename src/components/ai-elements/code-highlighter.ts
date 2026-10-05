import type { BundledLanguage, ShikiTransformer } from "shiki";
import { createHighlighterCore } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import json from "shiki/langs/json.mjs";
import javascript from "shiki/langs/javascript.mjs";
import oneLight from "shiki/themes/one-light.mjs";
import oneDark from "shiki/themes/one-dark-pro.mjs";

// 仅在需要高亮时初始化工具详情支持的语言和主题。
const highlighterPromise = createHighlighterCore({
  langs: [json, javascript],
  themes: [oneLight, oneDark],
  engine: createJavaScriptRegexEngine(),
});

const lineNumberTransformer: ShikiTransformer = {
  name: "line-numbers",
  line(node, line) {
    node.children.unshift({
      type: "element",
      tagName: "span",
      properties: {
        className: [
          "inline-block",
          "min-w-10",
          "mr-4",
          "text-right",
          "select-none",
          "text-muted-foreground",
        ],
      },
      children: [{ type: "text", value: String(line) }],
    });
  },
};

export async function highlightCode(
  code: string,
  language: BundledLanguage | "text",
  showLineNumbers = false,
) {
  const transformers: ShikiTransformer[] = showLineNumbers
    ? [lineNumberTransformer]
    : [];
  const highlighter = await highlighterPromise;
  const lang =
    language !== "text" && highlighter.getLoadedLanguages().includes(language)
      ? language
      : "text";
  return [
    highlighter.codeToHtml(code, { lang, theme: "one-light", transformers }),
    highlighter.codeToHtml(code, { lang, theme: "one-dark-pro", transformers }),
  ] as const;
}
