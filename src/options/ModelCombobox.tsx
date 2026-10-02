import { useRef, useState } from "react";
import { Command as CommandPrimitive } from "cmdk";
import { Popover } from "radix-ui";
import { Check } from "lucide-react";
import { Command, CommandItem, CommandList } from "@/components/ui/command";
import { Input } from "@/components/ui/input";

export function ModelCombobox({
  value,
  onValueChange,
  options,
  loading,
  invalid,
}: {
  value: string;
  onValueChange: (value: string) => void;
  options: string[];
  loading: boolean;
  invalid: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const filteredOptions = options.filter((option) =>
    option.toLowerCase().includes(query.toLowerCase()),
  );

  return (
    <Command
      label="模型"
      shouldFilter={false}
      className="relative min-w-0 flex-1 overflow-visible bg-transparent"
      onKeyDownCapture={(event) => {
        // 组合输入期间的确认键不能触发候选选择。
        if (event.nativeEvent.isComposing || event.keyCode === 229)
          event.stopPropagation();
      }}
    >
      <Popover.Root open={open} onOpenChange={setOpen}>
        <Popover.Anchor asChild>
          <div className="relative">
            <CommandPrimitive.Input
              asChild
              ref={inputRef}
              value={value}
              onValueChange={(nextValue) => {
                onValueChange(nextValue);
                setQuery(nextValue);
                setOpen(true);
              }}
            >
              <Input
                aria-labelledby="model-label"
                placeholder="输入或从列表选择模型"
                aria-expanded={open}
                aria-invalid={invalid}
                aria-describedby={invalid ? "model-error" : undefined}
                onFocus={() => {
                  setQuery("");
                  setOpen(true);
                }}
                onBlur={() => setOpen(false)}
                onKeyDown={(event) => {
                  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                    setOpen(true);
                  } else if (event.key === "Escape") {
                    event.preventDefault();
                    event.stopPropagation();
                    setOpen(false);
                  } else if (
                    event.key === "Enter" &&
                    (!open || filteredOptions.length === 0)
                  ) {
                    setOpen(false);
                    event.stopPropagation();
                  }
                }}
              />
            </CommandPrimitive.Input>
          </div>
        </Popover.Anchor>
        <Popover.Portal>
          <Popover.Content
            align="start"
            sideOffset={4}
            className="z-50 w-(--radix-popover-trigger-width) rounded-md border bg-popover p-1 text-popover-foreground shadow-md"
            onOpenAutoFocus={(event) => event.preventDefault()}
            onCloseAutoFocus={(event) => event.preventDefault()}
            onInteractOutside={(event) => {
              if (
                event.target instanceof Node &&
                inputRef.current?.parentElement?.contains(event.target)
              )
                event.preventDefault();
            }}
          >
            <CommandList>
              {filteredOptions.map((model) => (
                <CommandItem
                  key={model}
                  value={model}
                  className="cursor-pointer break-all"
                  onMouseDown={(event) => event.preventDefault()}
                  onSelect={() => {
                    onValueChange(model);
                    setOpen(false);
                    inputRef.current?.focus();
                  }}
                >
                  <span className="min-w-0 flex-1">{model}</span>
                  {model === value && <Check className="size-4" />}
                </CommandItem>
              ))}
              {filteredOptions.length === 0 && (
                <p
                  role="status"
                  className="px-2 py-3 text-xs text-muted-foreground"
                >
                  {loading
                    ? "正在获取模型列表…"
                    : options.length > 0
                      ? "没有匹配的模型，可直接使用输入的名称"
                      : "未获取到模型，可手动输入或点击刷新重试"}
                </p>
              )}
            </CommandList>
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
    </Command>
  );
}
