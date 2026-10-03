import { useState, useEffect, useCallback, useRef, useId } from "react";
import {
  Bot,
  Sun,
  Moon,
  Monitor,
  Palette,
  RefreshCw,
  LoaderCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Slider } from "@/components/ui/slider";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ModelCombobox } from "./ModelCombobox";
import type { ThemeMode } from "../shared/theme";
interface Settings {
  apiKey: string;
  baseUrl: string;
  model: string;
  provider: string;
  elementTextLimit: number;
  showClickMarker: boolean;
  enableShortRefs: boolean;
  screenshotScaleMode: "off" | "claude46" | "claude47" | "custom";
  screenshotMaxLongEdge: number;
  screenshotMaxPixels: number;
  enableScreenshotPruning: boolean;
  screenshotKeepN: number;
  screenshotPruneTrigger: number;
  enableCodeExecution: boolean;
  codeExecutionTimeoutMs: number;
  codeExecutionMaxOutputChars: number;
  enablePromptCaching: boolean;
}

const defaultSettings: Settings = {
  apiKey: "",
  baseUrl: "https://api.openai.com/v1",
  model: "gpt-4o",
  provider: "openai",
  elementTextLimit: 128,
  showClickMarker: true,
  enableShortRefs: true,
  screenshotScaleMode: "claude46",
  screenshotMaxLongEdge: 1568,
  screenshotMaxPixels: 1150000,
  enableScreenshotPruning: true,
  screenshotKeepN: 3,
  screenshotPruneTrigger: 12,
  enableCodeExecution: true,
  codeExecutionTimeoutMs: 1000,
  codeExecutionMaxOutputChars: 6000,
  enablePromptCaching: false,
};

export default function Options({
  mode,
  onThemeChange,
}: {
  mode: ThemeMode;
  onThemeChange: (m: ThemeMode) => void;
}) {
  const [settings, setSettings] = useState<Settings>(defaultSettings);
  const [modelOptions, setModelOptions] = useState<string[]>([]);
  const [fetchingModels, setFetchingModels] = useState(false);
  const [modelError, setModelError] = useState("");
  const saveTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    chrome.storage.local.get("settings", (data) => {
      if (data.settings) {
        setSettings({ ...defaultSettings, ...data.settings });
      }
    });
  }, []);

  // onChange 防抖自动保存
  const updateSettings = useCallback((patch: Partial<Settings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...patch };
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = setTimeout(() => {
        chrome.storage.local.set({ settings: next });
      }, 400);
      return next;
    });
  }, []);

  const handleProviderChange = useCallback(
    (provider: string) => {
      updateSettings({ provider });
      setModelOptions([]);
    },
    [updateSettings],
  );

  const handleFetchModels = useCallback(async () => {
    if (!settings.baseUrl || !settings.apiKey) {
      setModelError("请先填写 API Key 和 Base URL");
      return;
    }
    setFetchingModels(true);
    setModelError("");
    try {
      const url = settings.baseUrl.replace(/\/+$/, "") + "/models";
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${settings.apiKey}` },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      const ids: string[] = (json.data || [])
        .map((m: { id: string }) => m.id)
        .sort();
      setModelOptions(ids);
      if (ids.length === 0) setModelError("未获取到模型列表");
    } catch (err) {
      setModelError("获取模型列表失败: " + String(err));
      setModelOptions([]);
    } finally {
      setFetchingModels(false);
    }
  }, [settings.baseUrl, settings.apiKey]);

  return (
    <>
      <header className="sticky top-0 z-10 border-b bg-card/95 backdrop-blur">
        <div className="mx-auto flex max-w-2xl items-center gap-3 px-6 py-4">
          <Bot className="size-6 text-primary" />
          <h1 className="flex-1 text-lg font-semibold">NekoPilot 设置</h1>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" aria-label="切换主题">
                <Palette />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuRadioGroup
                value={mode}
                onValueChange={(value) => onThemeChange(value as ThemeMode)}
              >
                <DropdownMenuRadioItem value="light">
                  <Sun className="mr-2 size-4" />
                  明亮模式
                </DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="dark">
                  <Moon className="mr-2 size-4" />
                  暗黑模式
                </DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="auto">
                  <Monitor className="mr-2 size-4" />
                  跟随系统
                </DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>
      <main className="mx-auto grid max-w-2xl gap-6 px-6 py-8">
        <SettingsSection
          title="LLM 提供商"
          description="连接模型服务，修改后自动保存。"
        >
          <SelectField
            label="接口类型"
            value={settings.provider}
            onChange={handleProviderChange}
            options={[
              ["openai", "OpenAI"],
              ["anthropic", "Anthropic"],
            ]}
          />
          <TextField
            label="API Key"
            type="password"
            value={settings.apiKey}
            placeholder="sk-..."
            onChange={(value) => updateSettings({ apiKey: value })}
          />
          <TextField
            label="Base URL"
            value={settings.baseUrl}
            placeholder="https://api.openai.com/v1"
            description="末尾请带上 /v1"
            onChange={(value) => updateSettings({ baseUrl: value })}
          />
          <div className="space-y-2">
            <Label id="model-label">模型</Label>
            <div className="flex items-center gap-2">
              <ModelCombobox
                value={settings.model}
                onValueChange={(model) => updateSettings({ model })}
                options={modelOptions}
                loading={fetchingModels}
                invalid={!!modelError}
              />
              <Button
                variant="outline"
                size="icon"
                disabled={fetchingModels}
                onClick={handleFetchModels}
                aria-label="从 API 获取模型列表"
                title="从 API 获取模型列表"
              >
                {fetchingModels ? (
                  <LoaderCircle className="animate-spin" />
                ) : (
                  <RefreshCw />
                )}
              </Button>
            </div>
            {modelError && (
              <p
                id="model-error"
                role="alert"
                className="text-xs text-destructive"
              >
                {modelError}
              </p>
            )}
          </div>
          {settings.provider === "anthropic" && (
            <SwitchField
              label="启用提示缓存 (Prompt Caching)"
              checked={settings.enablePromptCaching}
              onChange={(value) =>
                updateSettings({ enablePromptCaching: value })
              }
            />
          )}
        </SettingsSection>
        <SettingsSection
          title="元素选择器"
          description="控制页面元素引用与操作提示。"
        >
          <SwitchField
            label="启用 #n 简短元素引用"
            description="为元素提供形如 #114 的自增编号短引用，执行时自动还原为 CSS 选择器。"
            checked={settings.enableShortRefs}
            onChange={(value) => updateSettings({ enableShortRefs: value })}
          />
          <TextField
            label="元素文本截取长度"
            type="number"
            min={1}
            max={10000}
            value={settings.elementTextLimit}
            onChange={(value) =>
              updateSettings({
                elementTextLimit: Math.max(1, parseInt(value) || 128),
              })
            }
          />
          <SwitchField
            label="Click 操作时标记坐标位置"
            description="等待审批时在页面上显示点击位置标记。"
            checked={settings.showClickMarker}
            onChange={(value) => updateSettings({ showClickMarker: value })}
          />
        </SettingsSection>
        <SettingsSection
          title="工具行为"
          description="配置沙箱执行与截图上下文。"
        >
          <SwitchField
            label="启用 execute_js 沙箱代码执行工具"
            description="在独立 QuickJS 沙箱中执行纯 JavaScript 计算，无 DOM、网络或扩展 API；审批模式下需审批。"
            checked={settings.enableCodeExecution}
            onChange={(value) => updateSettings({ enableCodeExecution: value })}
          />
          {settings.enableCodeExecution && (
            <>
              <SliderField
                label="execute_js 超时"
                value={[settings.codeExecutionTimeoutMs]}
                min={100}
                max={5000}
                step={100}
                display={`${settings.codeExecutionTimeoutMs} ms`}
                marks={[
                  [100, "100"],
                  [1000, "1000"],
                  [5000, "5000"],
                ]}
                onChange={([value]) =>
                  updateSettings({ codeExecutionTimeoutMs: value })
                }
                description="限制最长运行时间，避免死循环或长时间占用后台。"
              />
              <SliderField
                label="execute_js 最大输出字符"
                value={[settings.codeExecutionMaxOutputChars]}
                min={1000}
                max={20000}
                step={500}
                display={String(settings.codeExecutionMaxOutputChars)}
                marks={[
                  [1000, "1k"],
                  [6000, "6k"],
                  [20000, "20k"],
                ]}
                onChange={([value]) =>
                  updateSettings({ codeExecutionMaxOutputChars: value })
                }
                description="超出限制的返回结果和 console 输出会被截断并标记 truncated。"
              />
            </>
          )}
          <SelectField
            label="截图缩放"
            value={settings.screenshotScaleMode}
            onChange={(value) =>
              updateSettings({
                screenshotScaleMode: value as Settings["screenshotScaleMode"],
              })
            }
            options={[
              ["off", "关"],
              ["claude46", "1568（Claude 4.6 及更低版本）"],
              ["claude47", "2576（Claude 4.7 及更高版本）"],
              ["custom", "自定义"],
            ]}
          />
          {settings.screenshotScaleMode === "custom" && (
            <div className="grid grid-cols-2 gap-4">
              <TextField
                label="最长边像素"
                type="number"
                min={1}
                value={settings.screenshotMaxLongEdge}
                onChange={(value) =>
                  updateSettings({
                    screenshotMaxLongEdge: Math.max(1, parseInt(value) || 1568),
                  })
                }
              />
              <TextField
                label="最大像素数"
                type="number"
                min={1}
                value={settings.screenshotMaxPixels}
                onChange={(value) =>
                  updateSettings({
                    screenshotMaxPixels: Math.max(
                      1,
                      parseInt(value) || 1150000,
                    ),
                  })
                }
              />
            </div>
          )}
          <p className="text-xs leading-relaxed text-muted-foreground">
            截图按最长边与总像素限制等比缩放，页面坐标与模型输出坐标将自动转换。
          </p>
          <SwitchField
            label="启用截图清理"
            description="上下文中的截图达到阈值时，将更早的截图替换为占位文本。截图始终显示在用户界面。"
            checked={settings.enableScreenshotPruning}
            onChange={(value) =>
              updateSettings({ enableScreenshotPruning: value })
            }
          />
          <SliderField
            label="截图保留与清理阈值"
            value={[settings.screenshotKeepN, settings.screenshotPruneTrigger]}
            min={1}
            max={30}
            step={1}
            minStepsBetweenThumbs={1}
            disabled={!settings.enableScreenshotPruning}
            display={`清理时保留最新 ${settings.screenshotKeepN} 张 / 达到 ${settings.screenshotPruneTrigger} 张时清理`}
            marks={[
              [1, "1"],
              [10, "10"],
              [20, "20"],
              [30, "30"],
            ]}
            onChange={([keepN, trigger]) =>
              updateSettings({
                screenshotKeepN: keepN,
                screenshotPruneTrigger: trigger,
              })
            }
          />
        </SettingsSection>
      </main>
    </>
  );
}

function SettingsSection({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">{children}</CardContent>
    </Card>
  );
}

function TextField({
  label,
  description,
  value,
  onChange,
  ...props
}: {
  label: string;
  description?: string;
  value: string | number;
  onChange: (value: string) => void;
} & Omit<React.ComponentProps<typeof Input>, "value" | "onChange">) {
  const id = useId();
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <Input
        {...props}
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        aria-describedby={description ? `${id}-description` : undefined}
      />
      {description && (
        <p id={`${id}-description`} className="text-xs text-muted-foreground">
          {description}
        </p>
      )}
    </div>
  );
}

function SelectField({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: [string, string][];
}) {
  const id = useId();
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger id={id} className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map(([key, text]) => (
            <SelectItem key={key} value={key}>
              {text}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

function SwitchField({
  label,
  description,
  checked,
  onChange,
}: {
  label: string;
  description?: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  const id = useId();
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="space-y-2">
        <Label htmlFor={id}>{label}</Label>
        {description && (
          <p
            id={`${id}-description`}
            className="text-xs leading-relaxed text-muted-foreground"
          >
            {description}
          </p>
        )}
      </div>
      <Switch
        id={id}
        checked={checked}
        onCheckedChange={onChange}
        aria-describedby={description ? `${id}-description` : undefined}
      />
    </div>
  );
}

function SliderField({
  label,
  display,
  description,
  marks,
  onChange,
  ...props
}: {
  label: string;
  display: string;
  description?: string;
  marks: [number, string][];
  onChange: (value: number[]) => void;
} & Omit<React.ComponentProps<typeof Slider>, "onValueChange" | "onChange">) {
  const id = useId();
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap justify-between gap-2">
        <Label id={id}>{label}</Label>
        <span className="text-xs text-muted-foreground">{display}</span>
      </div>
      <Slider {...props} aria-labelledby={id} onValueChange={onChange} />
      <div className="relative h-4 text-xs text-muted-foreground">
        {marks.map(([value, text]) => (
          <span
            key={value}
            className="absolute"
            style={{
              left: `${((value - (props.min ?? 0)) / ((props.max ?? 100) - (props.min ?? 0))) * 100}%`,
              transform:
                value === props.min
                  ? undefined
                  : value === props.max
                    ? "translateX(-100%)"
                    : "translateX(-50%)",
            }}
          >
            {text}
          </span>
        ))}
      </div>
      {description && (
        <p className="text-xs leading-relaxed text-muted-foreground">
          {description}
        </p>
      )}
    </div>
  );
}
