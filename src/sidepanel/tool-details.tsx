import { useEffect, useRef, useState } from "react";
import {
  CodeBlock,
  CodeBlockCopyButton,
} from "@/components/ai-elements/code-block";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { MarkdownMessage } from "./markdown";
import type { LogEntry } from "./model";

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function DetailCode({
  code,
  language,
}: {
  code: string;
  language: "javascript" | "json" | "text";
}) {
  return (
    <CodeBlock
      code={code}
      language={language}
      className="rounded-none border-0 [&_pre]:max-h-64 [&_pre]:p-3! [&_pre]:pr-10! [&_pre]:text-xs! [&_code]:text-xs!"
    >
      <CodeBlockCopyButton
        aria-label="复制代码"
        className="size-6 text-muted-foreground"
      />
    </CodeBlock>
  );
}

export default function ToolDetails({ entry }: { entry: LogEntry }) {
  const args = parseJson(entry.content);
  const fields =
    args && typeof args === "object" && !Array.isArray(args)
      ? (args as Record<string, unknown>)
      : undefined;
  const hasCode =
    entry.toolName === "execute_js" && typeof fields?.code === "string";
  const hasResult = entry.toolResult !== undefined || !!entry.screenshotData;
  const [tab, setTab] = useState(hasResult ? "result" : "input");
  const userSelected = useRef(false);
  // 结果到达时自动展示；用户主动选择的标签页保持不变。
  useEffect(() => {
    if (hasResult && !userSelected.current) setTab("result");
  }, [hasResult]);
  const result = parseJson(entry.toolResult ?? "");
  const extraFields = hasCode
    ? Object.entries(fields!).filter(
        ([key]) => !["code", "description"].includes(key),
      )
    : [];
  return (
    <Tabs
      value={tab}
      onValueChange={(value) => {
        userSelected.current = true;
        setTab(value);
      }}
      className="min-w-0"
    >
      <div className="px-3 pt-3">
        <TabsList aria-label="工具详情" className="h-8">
          <TabsTrigger value="input">{hasCode ? "代码" : "参数"}</TabsTrigger>
          <TabsTrigger value="result" disabled={!hasResult}>
            结果
          </TabsTrigger>
        </TabsList>
      </div>
      <TabsContent value="input" className="mt-2 pb-2">
        {hasCode ? (
          <>
            {typeof fields!.description === "string" &&
              fields!.description.length > 60 && (
                <p className="px-3 py-2 text-xs leading-relaxed text-muted-foreground">
                  {fields!.description}
                </p>
              )}
            <DetailCode code={fields!.code as string} language="javascript" />
            {extraFields.length > 0 && (
              <DetailCode
                code={JSON.stringify(Object.fromEntries(extraFields), null, 2)}
                language="json"
              />
            )}
          </>
        ) : (
          <DetailCode
            code={
              args !== undefined ? JSON.stringify(args, null, 2) : entry.content
            }
            language={args !== undefined ? "json" : "text"}
          />
        )}
      </TabsContent>
      <TabsContent value="result" className="mt-2 pb-2">
        {entry.screenshotData ? (
          <div className="px-3 py-2">
            <img
              src={`data:${entry.screenshotMime || "image/png"};base64,${entry.screenshotData}`}
              alt="浏览器截图"
              className={cn(
                "max-h-64 max-w-full rounded-md border object-contain",
                entry.prunedFromContext && "opacity-50 grayscale",
              )}
            />
            {entry.prunedFromContext && (
              <p className="mt-2 text-xs text-muted-foreground">
                已从上下文删除
              </p>
            )}
          </div>
        ) : result !== undefined ? (
          <DetailCode code={JSON.stringify(result, null, 2)} language="json" />
        ) : (
          <div className="max-h-64 overflow-auto px-3 py-2 text-xs">
            <MarkdownMessage
              content={entry.toolResult || "工具未返回内容。"}
              streaming={false}
            />
          </div>
        )}
      </TabsContent>
    </Tabs>
  );
}
