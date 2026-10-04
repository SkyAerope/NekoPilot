import { useEffect, useRef, useState } from "react";
import {
  CodeBlock,
  CodeBlockCopyButton,
} from "@/components/ai-elements/code-block";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import type { LogEntry } from "./model";

// 与执行器中只返回完成标记的操作对应；异常或额外返回信息仍保留结果页。
const completionOnlyTools = new Set([
  "click",
  "keyboard_type",
  "scroll",
  "drag",
  "navigate",
  "wait",
  "hover",
  "handle_dialog",
]);

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
      className="rounded-none border-0 [&_pre]:max-h-64 [&_pre]:p-3! [&_pre]:text-xs! [&_code]:text-xs!"
    />
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
  const description =
    hasCode && typeof fields?.description === "string"
      ? fields.description.trim()
      : "";
  const descriptionContent = description ? (
    <p className="break-words px-3 py-2 text-xs leading-relaxed text-muted-foreground">
      {description}
    </p>
  ) : null;
  const hasResult = entry.toolResult !== undefined || !!entry.screenshotData;
  const result = parseJson(entry.toolResult ?? "");
  const hideTabs =
    !entry.screenshotData &&
    entry.toolSuccess !== false &&
    (entry.toolResult === "done" ||
      result === "done" ||
      (entry.toolResult === undefined &&
        completionOnlyTools.has(entry.toolName ?? "")));
  const [tab, setTab] = useState(hasResult ? "result" : "input");
  const userSelected = useRef(false);
  // 结果到达时自动展示；用户主动选择的标签页保持不变。
  useEffect(() => {
    if (hasResult && !userSelected.current) setTab("result");
  }, [hasResult]);
  const extraFields = hasCode
    ? Object.entries(fields!).filter(
        ([key]) => !["code", "description"].includes(key),
      )
    : [];
  const extraInputText =
    extraFields.length > 0
      ? JSON.stringify(Object.fromEntries(extraFields), null, 2)
      : "";
  const inputText = hasCode
    ? (fields!.code as string)
    : args !== undefined
      ? JSON.stringify(args, null, 2)
      : entry.content;
  const inputCopyText = extraInputText
    ? `${inputText}\n\n${extraInputText}`
    : inputText;
  const resultText =
    result !== undefined
      ? JSON.stringify(result, null, 2)
      : entry.toolResult || "工具未返回内容。";
  const copyButton = (value: "input" | "result") => (
    <CodeBlockCopyButton
      key={value}
      code={value === "input" ? inputCopyText : resultText}
      aria-label={
        value === "input" ? (hasCode ? "复制代码" : "复制参数") : "复制结果"
      }
      className="size-6 text-muted-foreground"
    />
  );
  const resultContent = entry.screenshotData ? (
    <div>
      <img
        src={`data:${entry.screenshotMime || "image/png"};base64,${entry.screenshotData}`}
        alt="浏览器截图"
        className={cn(
          "max-h-64 max-w-full rounded-md border object-contain",
          entry.prunedFromContext && "opacity-50 grayscale",
        )}
      />
      {entry.prunedFromContext && (
        <p className="mt-2 text-xs text-muted-foreground">已从上下文删除</p>
      )}
    </div>
  ) : result !== undefined ? (
    <DetailCode code={resultText} language="json" />
  ) : (
    <DetailCode code={resultText} language="text" />
  );
  if (entry.toolName === "screenshot") {
    return (
      <div className="min-w-0">
        {hasResult && !entry.screenshotData && (
          <div className="flex justify-end px-3">{copyButton("result")}</div>
        )}
        {hasResult ? (
          resultContent
        ) : (
          <p className="px-3 py-2 text-xs text-muted-foreground">正在截屏…</p>
        )}
      </div>
    );
  }
  const inputContent = (
    <>
      {hasCode ? (
        <>
          <DetailCode code={inputText} language="javascript" />
          {extraFields.length > 0 && (
            <DetailCode code={extraInputText} language="json" />
          )}
        </>
      ) : (
        <DetailCode
          code={inputText}
          language={args !== undefined ? "json" : "text"}
        />
      )}
    </>
  );
  if (hideTabs)
    return (
      <div className="min-w-0 py-2">
        <div className="flex justify-end px-3">{copyButton("input")}</div>
        {descriptionContent}
        {inputContent}
      </div>
    );
  return (
    <Tabs
      value={tab}
      onValueChange={(value) => {
        userSelected.current = true;
        setTab(value);
      }}
      className="min-w-0"
    >
      <div className="flex items-center justify-between gap-2 px-3 pt-3">
        <TabsList aria-label="工具详情" className="h-8">
          <TabsTrigger value="input">{hasCode ? "代码" : "参数"}</TabsTrigger>
          <TabsTrigger value="result" disabled={!hasResult}>
            结果
          </TabsTrigger>
        </TabsList>
        {(tab === "input" || !entry.screenshotData) &&
          copyButton(tab === "input" ? "input" : "result")}
      </div>
      {descriptionContent}
      <TabsContent value="input" className="mt-2 pb-2">
        {inputContent}
      </TabsContent>
      <TabsContent value="result" className="mt-2 pb-2">
        {resultContent}
      </TabsContent>
    </Tabs>
  );
}
