"use client";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { CheckIcon, CopyIcon } from "lucide-react";
import {
  type ComponentProps,
  createContext,
  type HTMLAttributes,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import type { BundledLanguage, ShikiTransformer } from "shiki";
import { createHighlighterCore } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import json from "shiki/langs/json.mjs";
import javascript from "shiki/langs/javascript.mjs";
import oneLight from "shiki/themes/one-light.mjs";
import oneDark from "shiki/themes/one-dark-pro.mjs";

// 工具详情只需 JSON 和 JavaScript，避免把全部语言与主题打包进扩展。
const highlighterPromise = createHighlighterCore({
  langs: [json, javascript],
  themes: [oneLight, oneDark],
  engine: createJavaScriptRegexEngine(),
});

type CodeBlockProps = HTMLAttributes<HTMLDivElement> & {
  code: string;
  language: BundledLanguage | "text";
  showLineNumbers?: boolean;
};

type CodeBlockContextType = {
  code: string;
};

const CodeBlockContext = createContext<CodeBlockContextType>({
  code: "",
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
    highlighter.codeToHtml(code, {
      lang,
      theme: "one-light",
      transformers,
    }),
    highlighter.codeToHtml(code, {
      lang,
      theme: "one-dark-pro",
      transformers,
    }),
  ];
}

export const CodeBlock = ({
  code,
  language,
  showLineNumbers = false,
  className,
  children,
  ...props
}: CodeBlockProps) => {
  const [html, setHtml] = useState<string>("");
  const [darkHtml, setDarkHtml] = useState<string>("");
  // 保持属性对象稳定，避免无关渲染重写文本节点并破坏原生选区。
  const lightMarkup = useMemo(() => ({ __html: html }), [html]);
  const darkMarkup = useMemo(() => ({ __html: darkHtml }), [darkHtml]);
  useEffect(() => {
    let cancelled = false;
    highlightCode(code, language, showLineNumbers)
      .then(([light, dark]) => {
        if (!cancelled) {
          setHtml(light);
          setDarkHtml(dark);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setHtml("");
          setDarkHtml("");
        }
      });

    return () => {
      cancelled = true;
    };
  }, [code, language, showLineNumbers]);

  return (
    <CodeBlockContext.Provider value={{ code }}>
      <div
        className={cn(
          "group relative w-full overflow-hidden rounded-md border bg-background text-foreground",
          className,
        )}
        {...props}
      >
        <div className="relative">
          {!html && (
            <pre className="overflow-auto p-4 text-sm">
              <code>{code}</code>
            </pre>
          )}
          <div
            className="overflow-auto dark:hidden [&>pre]:m-0 [&>pre]:bg-background! [&>pre]:p-4 [&>pre]:text-foreground! [&>pre]:text-sm [&_code]:font-mono [&_code]:text-sm"
            dangerouslySetInnerHTML={lightMarkup}
          />
          <div
            className="hidden overflow-auto dark:block [&>pre]:m-0 [&>pre]:bg-background! [&>pre]:p-4 [&>pre]:text-foreground! [&>pre]:text-sm [&_code]:font-mono [&_code]:text-sm"
            dangerouslySetInnerHTML={darkMarkup}
          />
          {children && (
            <div className="absolute top-2 right-2 flex items-center gap-2">
              {children}
            </div>
          )}
        </div>
      </div>
    </CodeBlockContext.Provider>
  );
};

export type CodeBlockCopyButtonProps = ComponentProps<typeof Button> & {
  code?: string;
  onCopy?: () => void;
  onError?: (error: Error) => void;
  timeout?: number;
};

export const CodeBlockCopyButton = ({
  code: explicitCode,
  onCopy,
  onError,
  timeout = 2000,
  children,
  className,
  ...props
}: CodeBlockCopyButtonProps) => {
  const [isCopied, setIsCopied] = useState(false);
  const { code: contextCode } = useContext(CodeBlockContext);
  const code = explicitCode ?? contextCode;

  const copyToClipboard = async () => {
    if (typeof window === "undefined" || !navigator?.clipboard?.writeText) {
      onError?.(new Error("Clipboard API not available"));
      return;
    }

    try {
      await navigator.clipboard.writeText(code);
      setIsCopied(true);
      onCopy?.();
      setTimeout(() => setIsCopied(false), timeout);
    } catch (error) {
      onError?.(error as Error);
    }
  };

  const Icon = isCopied ? CheckIcon : CopyIcon;

  return (
    <Button
      className={cn("shrink-0", className)}
      onClick={copyToClipboard}
      size="icon"
      variant="ghost"
      {...props}
    >
      {children ?? <Icon size={14} />}
    </Button>
  );
};
