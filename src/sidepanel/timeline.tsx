import { useState, useMemo } from "react";
import {
  Brain,
  Camera,
  Eye,
  Wrench,
  MousePointer2,
  ChevronDown,
  LoaderCircle,
  AlertCircle,
  X,
  CheckCircle2,
} from "lucide-react";
import type { ToolUIPart } from "ai";
import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from "@/components/ui/collapsible";
import {
  Reasoning,
  ReasoningTrigger,
} from "@/components/ai-elements/reasoning";
import { Tool, ToolContent } from "@/components/ai-elements/tool";
import {
  Confirmation,
  ConfirmationTitle,
  ConfirmationActions,
  ConfirmationAction,
} from "@/components/ai-elements/confirmation";
import { cn } from "@/lib/utils";
import { MarkdownMessage } from "./markdown";
import { IconAction } from "./controls";
import { useBottomScroll } from "./use-bottom-scroll";
import { ScreenshotPreview } from "./screenshot-preview";
import { useScreenshotImage } from "./use-screenshot-image";
import ToolDetails from "./tool-details";
import {
  type LogEntry,
  getToolLabel,
  getToolSubtitle,
  splitThinkText,
} from "./model";

const stepTriggerClassName =
  "flex h-8 w-full min-w-0 items-center gap-2 rounded-md px-2.5 text-left text-xs transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring";
const approvalBadgeClassName =
  "shrink-0 rounded bg-amber-500/10 px-1.5 py-0.5 text-xs text-amber-600 dark:text-amber-300";

type StepActions = {
  onApprove: (id: string) => void;
  onReject: (id: string) => void;
  onDismiss: (id: number) => void;
};

export function StepsGroup({
  entries,
  expanded,
  onToggle,
  pending,
  ...actions
}: {
  entries: LogEntry[];
  expanded: boolean;
  onToggle: () => void;
  pending?: boolean;
} & StepActions) {
  const stepCount = entries.filter(
    (entry) => entry.type === "tool_call" || entry.type === "thinking",
  ).length;
  const awaitingApproval = entries.some(
    (entry) =>
      entry.type === "tool_call" &&
      entry.needsPermission &&
      !entry.permissionResolved &&
      entry.toolResult === undefined,
  );
  const content = (
    <div className="space-y-1">
      {entries.map((entry, index) => (
        <TimelineStep
          key={entry.id}
          entry={entry}
          nextType={entries[index + 1]?.type}
          connected={index < entries.length - 1 || !!pending}
          {...actions}
        />
      ))}
      {pending && (
        <TimelineStep
          entry={{
            id: -1,
            type: "pending",
            content: "",
            timestamp: Date.now(),
          }}
          connected={false}
          {...actions}
        />
      )}
    </div>
  );
  if (stepCount <= 1) return content;
  return (
    <Collapsible open={expanded} onOpenChange={onToggle} className="w-full">
      <CollapsibleTrigger
        aria-label={`${stepCount} steps`}
        className="mb-2 flex w-full items-center gap-2 py-2 text-sm font-medium text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span>{stepCount} 个步骤</span>
        {awaitingApproval && !expanded && (
          <span className={cn("ml-auto", approvalBadgeClassName)}>待审批</span>
        )}
        <ChevronDown
          className={cn(
            "size-3.5 transition-transform duration-200 motion-reduce:transition-none",
            expanded && "rotate-180",
          )}
        />
      </CollapsibleTrigger>
      <CollapsibleContent className="collapsible-motion">
        {content}
      </CollapsibleContent>
    </Collapsible>
  );
}

function getToolIcon(name?: string) {
  if (name === "screenshot") return Camera;
  if (
    [
      "read_page_text",
      "read_page",
      "read_page_interactive",
      "find_element",
      "get_element_text",
      "get_element_rect",
    ].includes(name ?? "")
  )
    return Eye;
  if (
    ["click", "keyboard_type", "drag", "scroll", "hover", "press_key"].includes(
      name ?? "",
    )
  )
    return MousePointer2;
  return Wrench;
}

function TimelineStep({
  entry,
  nextType,
  connected,
  onApprove,
  onReject,
  onDismiss,
}: {
  entry: LogEntry;
  nextType?: LogEntry["type"];
  connected: boolean;
} & StepActions) {
  const hasExpandableHeader =
    entry.type === "tool_call" || entry.type === "thinking";
  const iconOffset = hasExpandableHeader ? 6 : 0;
  const nextIconOffset =
    nextType === "tool_call" || nextType === "thinking" ? 6 : 0;
  const Icon =
    entry.type === "thinking"
      ? Brain
      : entry.type === "error"
        ? AlertCircle
        : entry.type === "pending"
          ? LoaderCircle
          : getToolIcon(entry.toolName);
  return (
    <div className="flex min-w-0 gap-2">
      <div className="relative w-5 shrink-0">
        {connected && (
          <span
            className="absolute left-2.5 w-px bg-border"
            // 图标容器高 20px、步骤间隔 4px，连线两端各留 4px。
            style={{ top: iconOffset + 24, bottom: -nextIconOffset }}
          />
        )}
        <span
          className="relative flex size-5 items-center justify-center rounded-full bg-background"
          style={{ marginTop: iconOffset }}
        >
          <Icon
            className={cn(
              "size-3.5 text-muted-foreground",
              entry.type === "error" && "text-destructive",
              entry.type === "pending" && "animate-spin",
            )}
          />
        </span>
      </div>
      <div className={cn("min-w-0 flex-1", !hasExpandableHeader && "pb-2")}>
        {entry.type === "tool_call" && (
          <ToolCallStep
            entry={entry}
            onApprove={onApprove}
            onReject={onReject}
          />
        )}
        {entry.type === "thinking" && <ThinkingStep entry={entry} />}
        {entry.type === "pending" && (
          <span className="text-xs text-muted-foreground">正在工作…</span>
        )}
        {entry.type === "error" && (
          <div role="alert" className="flex items-start gap-1">
            <p className="min-w-0 flex-1 break-words text-sm text-destructive">
              {entry.content}
            </p>
            <IconAction label="关闭错误" onClick={() => onDismiss(entry.id)}>
              <X />
            </IconAction>
          </div>
        )}
      </div>
    </div>
  );
}

function ThinkingStep({ entry }: { entry: LogEntry }) {
  const [expanded, setExpanded] = useState(false);
  const [userTouched, setUserTouched] = useState(false);
  const { think } = useMemo(
    () => splitThinkText(entry.content),
    [entry.content],
  );
  const content = think || entry.content.replace(/<\/?think(?:ing)?>/gi, "");
  const done = !!entry.thinkingDone;
  const open = done || userTouched ? expanded : true;
  const thinkingScroll = useBottomScroll(content, !done && open);
  const preview = content
    .split("\n")
    .find((line) => line.trim())
    ?.slice(0, 60);
  return (
    <Reasoning
      className="mb-0"
      defaultOpen={false}
      open={open}
      onOpenChange={(value) => {
        setUserTouched(true);
        setExpanded(value);
      }}
      isStreaming={!done}
      duration={entry.thinkSeconds}
    >
      <ReasoningTrigger disabled={!content} className={stepTriggerClassName}>
        <span className="shrink-0 font-medium text-muted-foreground">
          {done ? `已思考 ${entry.thinkSeconds ?? 1} 秒` : "Thinking…"}
        </span>
        <span className="min-w-0 flex-1 truncate font-mono text-muted-foreground/70">
          {!open && preview}
        </span>
        {done ? (
          <CheckCircle2 className="size-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <LoaderCircle className="size-3.5 shrink-0 animate-spin" />
        )}
        <ChevronDown
          className={cn(
            "size-3 shrink-0 transition-transform duration-200 motion-reduce:transition-none",
            open && "rotate-180",
          )}
        />
      </ReasoningTrigger>
      <CollapsibleContent className="collapsible-motion">
        <div
          ref={thinkingScroll.scrollRef}
          onScroll={thinkingScroll.onScroll}
          onWheelCapture={thinkingScroll.onWheelCapture}
          onPointerDownCapture={thinkingScroll.onPointerDownCapture}
          onKeyDownCapture={thinkingScroll.onKeyDownCapture}
          className="max-h-50 overflow-y-auto rounded-md border px-3 py-3 text-muted-foreground"
        >
          <MarkdownMessage content={content} streaming={!done} />
        </div>
      </CollapsibleContent>
    </Reasoning>
  );
}

function getToolState(entry: LogEntry): ToolUIPart["state"] {
  if (entry.toolResult !== undefined)
    return entry.toolSuccess ? "output-available" : "output-error";
  if (entry.needsPermission && !entry.permissionResolved)
    return "approval-requested";
  return "input-available";
}

function ToolCallStep({
  entry,
  onApprove,
  onReject,
}: {
  entry: LogEntry;
  onApprove: (id: string) => void;
  onReject: (id: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [prewarmScreenshot, setPrewarmScreenshot] = useState(false);
  const screenshotImage = useScreenshotImage(
    entry,
    expanded || prewarmScreenshot,
  );
  const state = getToolState(entry);
  const awaitingApproval = state === "approval-requested";
  const executing = state === "input-available";
  const subtitle = getToolSubtitle(entry.toolName, entry.content);
  const headerSubtitle =
    entry.toolName === "execute_js" && (expanded || awaitingApproval)
      ? ""
      : subtitle;
  return (
    <Tool
      open={expanded}
      onOpenChange={setExpanded}
      className="mb-0 min-w-0 border-0"
    >
      <CollapsibleTrigger
        className={stepTriggerClassName}
        onPointerEnter={() => {
          if (entry.toolName === "screenshot") setPrewarmScreenshot(true);
        }}
        onFocus={() => {
          if (entry.toolName === "screenshot") setPrewarmScreenshot(true);
        }}
      >
        <span className="shrink-0 font-medium text-muted-foreground">
          {getToolLabel(entry.toolName)}
        </span>
        <span
          className="min-w-0 flex-1 truncate font-mono text-muted-foreground/70"
          title={headerSubtitle || undefined}
        >
          {headerSubtitle}
        </span>
        {awaitingApproval && (
          <span className={approvalBadgeClassName}>待审批</span>
        )}
        {executing && <LoaderCircle className="size-3 shrink-0 animate-spin" />}
        {state === "output-available" && (
          <CheckCircle2 className="size-3.5 shrink-0 text-muted-foreground" />
        )}
        {state === "output-error" && (
          <AlertCircle className="size-3.5 shrink-0 text-destructive" />
        )}
        <ChevronDown
          className={cn(
            "size-3 shrink-0 transition-transform",
            expanded && "rotate-180",
          )}
        />
      </CollapsibleTrigger>
      <div
        className={cn(
          "min-w-0 overflow-hidden rounded-md",
          awaitingApproval && entry.toolName !== "screenshot" && "border",
        )}
      >
        <ToolContent className="min-w-0">
          <div
            className={cn(
              "min-w-0 overflow-hidden rounded-md",
              !awaitingApproval && entry.toolName !== "screenshot" && "border",
            )}
          >
            {entry.toolName === "screenshot" &&
             (entry.screenshot || entry.screenshotData || entry.toolResult === undefined) ? (
              <ScreenshotPreview entry={entry} image={screenshotImage} />
            ) : (
              <ToolDetails entry={entry} />
            )}
          </div>
        </ToolContent>
        {awaitingApproval && entry.toolCallId && (
          <Confirmation
            state={state}
            approval={{ id: entry.toolCallId }}
            className={cn(
              "flex-row items-center justify-between gap-2 rounded-none border-0 bg-muted/30 px-3 py-3",
              expanded && "border-t",
            )}
          >
            <ConfirmationTitle className="text-xs">
              需要你的确认
            </ConfirmationTitle>
            <ConfirmationActions>
              <ConfirmationAction
                variant="outline"
                onClick={() => onReject(entry.toolCallId!)}
              >
                拒绝
              </ConfirmationAction>
              <ConfirmationAction onClick={() => onApprove(entry.toolCallId!)}>
                允许
              </ConfirmationAction>
            </ConfirmationActions>
          </Confirmation>
        )}
      </div>
    </Tool>
  );
}
