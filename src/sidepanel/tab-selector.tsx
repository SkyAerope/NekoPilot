import { useEffect, useState } from "react";
import { Popover } from "radix-ui";
import { Check, ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { sendMessage } from "../shared/messaging";
import type { TargetTab, TargetTabStatus } from "../shared/target-tab";
import { TabIcon } from "./tab-icon";

export function TabSelector({
  status,
  running,
  picking,
  switching,
  onRefresh,
  onSelect,
}: {
  status: TargetTabStatus | null;
  running: boolean;
  picking: boolean;
  switching: boolean;
  onRefresh: () => Promise<void>;
  onSelect: (tabId: number) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [tabs, setTabs] = useState<TargetTab[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    if (!open) return;
    let disposed = false;
    let requestId = 0;
    let timer: number | undefined;
    const fetchTabs = async () => {
      const currentRequest = ++requestId;
      setLoading(true);
      try {
        const result = await sendMessage<{ tabs: TargetTab[] }>("target:list");
        if (!disposed && currentRequest === requestId) {
          setTabs(result.tabs);
          setError(null);
        }
      } catch (cause) {
        if (!disposed && currentRequest === requestId) {
          setError(
            (cause instanceof Error ? cause.message : String(cause)).replace(
              /^(?:Error:\s*)+/,
              "",
            ),
          );
        }
      } finally {
        if (!disposed && currentRequest === requestId) setLoading(false);
      }
    };
    const refresh = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => void fetchTabs(), 100);
    };
    void fetchTabs();
    chrome.tabs?.onCreated?.addListener(refresh);
    chrome.tabs?.onRemoved?.addListener(refresh);
    chrome.tabs?.onUpdated?.addListener(refresh);
    chrome.tabs?.onActivated?.addListener(refresh);
    return () => {
      disposed = true;
      window.clearTimeout(timer);
      chrome.tabs?.onCreated?.removeListener(refresh);
      chrome.tabs?.onRemoved?.removeListener(refresh);
      chrome.tabs?.onUpdated?.removeListener(refresh);
      chrome.tabs?.onActivated?.removeListener(refresh);
    };
  }, [open, retry]);

  const target = status?.target;
  const recent = tabs
    .filter((tab) => tab.id !== target?.id)
    .sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0));
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const candidates = target ? [target, ...recent] : recent;
  const visible = normalizedQuery
    ? candidates.filter((tab) =>
        `${tab.title}\n${tab.url}`
          .toLocaleLowerCase()
          .includes(normalizedQuery),
      )
    : target
      ? [target, ...recent.slice(0, 4)]
      : recent.slice(0, 4);
  const disabled = running || status?.busy || picking || switching;
  const needsReload = error === "Unknown message type: target:list";

  return (
    <Popover.Root
      open={open}
      onOpenChange={(value) => {
        setOpen(value);
        if (value) {
          setLoading(true);
          setQuery("");
          void onRefresh();
        }
      }}
    >
      <Popover.Trigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          aria-label="操作标签页"
          title={target?.title}
          className="h-7 min-w-0 max-w-[calc(100%-2.5rem)] gap-1.5 rounded-md px-2 text-xs font-normal"
        >
          {target && <TabIcon tab={target} />}
          <span className="min-w-0 truncate">
            {target?.title ||
              (status?.missing ? "操作标签页已关闭" : "尚无操作标签页")}
          </span>
          <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
        </Button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          side="top"
          align="start"
          sideOffset={4}
          aria-label="选择操作标签页"
          className="z-50 w-80 max-w-[calc(100vw-1.5rem)] rounded-md border bg-popover text-popover-foreground shadow-md"
        >
          <Command label="搜索标签页" shouldFilter={false}>
            <CommandInput
              aria-label="搜索标签页"
              placeholder="搜索标题或链接…"
              value={query}
              onValueChange={setQuery}
            />
            {(running || status?.busy) && (
              <p className="px-3 py-2 text-xs text-muted-foreground">
                请先停止任务，再切换标签页
              </p>
            )}
            {picking && (
              <p className="px-3 py-2 text-xs text-muted-foreground">
                请先结束元素选择，再切换标签页
              </p>
            )}
            <CommandList className="max-h-72 p-1" aria-busy={loading}>
              {visible.map((tab) => (
                <CommandItem
                  key={tab.id}
                  value={String(tab.id)}
                  aria-label={tab.title}
                  disabled={disabled}
                  data-target-selected={tab.id === target?.id}
                  className="min-w-0 cursor-pointer py-2"
                  onSelect={() => {
                    setOpen(false);
                    if (tab.id !== target?.id) void onSelect(tab.id);
                  }}
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 items-center gap-1.5">
                      <TabIcon tab={tab} />
                      <span className="min-w-0 truncate" title={tab.title}>
                        {tab.title}
                      </span>
                    </div>
                    <p
                      className="mt-0.5 truncate text-xs text-muted-foreground"
                      title={tab.url}
                    >
                      {tab.url || "暂无链接"}
                    </p>
                  </div>
                  {tab.id === target?.id && (
                    <Check
                      className="size-4 shrink-0"
                      data-slot="target-check"
                    />
                  )}
                </CommandItem>
              ))}
              {error && (
                <div
                  role="alert"
                  className="px-2 py-2 text-xs text-destructive"
                >
                  <p className="break-words">
                    {needsReload
                      ? "扩展后台仍是旧版本，请重新加载扩展。"
                      : `标签页列表加载失败：${error}`}
                  </p>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={needsReload && (running || picking)}
                    onClick={() =>
                      needsReload
                        ? chrome.runtime.reload()
                        : setRetry((value) => value + 1)
                    }
                  >
                    {needsReload ? "重新加载扩展" : "重试"}
                  </Button>
                </div>
              )}
              {!loading && !error && visible.length === 0 && (
                <p
                  role="status"
                  className="px-2 py-3 text-xs text-muted-foreground"
                >
                  没有匹配的标签页
                </p>
              )}
            </CommandList>
          </Command>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
