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
import type { BundledLanguage } from "shiki";

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

export async function highlightCode(
  code: string,
  language: BundledLanguage | "text",
  showLineNumbers = false,
) {
  const highlighter = await import("./code-highlighter");
  return highlighter.highlightCode(code, language, showLineNumbers);
}

type HighlightedCode = {
  readonly code: string;
  readonly language: BundledLanguage | "text";
  readonly showLineNumbers: boolean;
  readonly light: string;
  readonly dark: string;
};

export const CodeBlock = ({
  code,
  language,
  showLineNumbers = false,
  className,
  children,
  ...props
}: CodeBlockProps) => {
  const [highlighted, setHighlighted] = useState<HighlightedCode>();
  const current =
    highlighted?.code === code &&
    highlighted.language === language &&
    highlighted.showLineNumbers === showLineNumbers
      ? highlighted
      : undefined;
  const html = current?.light ?? "";
  const darkHtml = current?.dark ?? "";
  // 保持属性对象稳定，避免无关渲染重写文本节点并破坏原生选区。
  const lightMarkup = useMemo(() => ({ __html: html }), [html]);
  const darkMarkup = useMemo(() => ({ __html: darkHtml }), [darkHtml]);
  useEffect(() => {
    if (language === "text" && !showLineNumbers) return;
    let cancelled = false;
    highlightCode(code, language, showLineNumbers)
      .then(([light, dark]) => {
        if (!cancelled) {
          setHighlighted({ code, language, showLineNumbers, light, dark });
        }
      })
      .catch((error: unknown) => {
        if (!(error instanceof Error)) throw error;
        if (!cancelled) {
          setHighlighted(undefined);
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
            <pre className="m-0 overflow-auto p-4 font-mono text-sm">
              <code className="font-mono">{code}</code>
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
