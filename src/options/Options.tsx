import { useState, useEffect, useCallback, useRef } from "react";
import {
  Box,
  Typography,
  TextField,
  Stack,
  Paper,
  MenuItem,
  Divider,
  Container,
  AppBar,
  Toolbar,
  IconButton,
  Tooltip,
  Menu,
  ListItemIcon,
  ListItemText,
  Autocomplete,
  CircularProgress,
  FormControlLabel,
  Switch,
  Slider,
} from "@mui/material";
import SmartToyIcon from "@mui/icons-material/SmartToy";
import LightModeIcon from "@mui/icons-material/LightMode";
import DarkModeIcon from "@mui/icons-material/DarkMode";
import SettingsBrightnessIcon from "@mui/icons-material/SettingsBrightness";
import Brightness4Icon from "@mui/icons-material/Brightness4";
import RefreshIcon from "@mui/icons-material/Refresh";
import type { ThemeMode } from "../shared/theme";

interface Settings {
  apiKey: string;
  baseUrl: string;
  model: string;
  provider: string;
  elementTextLimit: number;
  showClickMarker: boolean;
  enableShortRefs: boolean;
  screenshotQuality: number;
}

const defaultSettings: Settings = {
  apiKey: "",
  baseUrl: "https://api.openai.com/v1",
  model: "gpt-4o",
  provider: "openai",
  elementTextLimit: 128,
  showClickMarker: true,
  enableShortRefs: true,
  screenshotQuality: 80,
};

const providerPresets: Record<string, { baseUrl: string }> = {
  openai: { baseUrl: "https://api.openai.com/v1" },
  anthropic: { baseUrl: "https://api.anthropic.com/v1" },
};

export default function Options({ mode, onThemeChange }: { mode: ThemeMode; onThemeChange: (m: ThemeMode) => void }) {
  const [settings, setSettings] = useState<Settings>(defaultSettings);
  const [anchorEl, setAnchorEl] = useState<null | HTMLElement>(null);
  const [modelOptions, setModelOptions] = useState<string[]>([]);
  const [fetchingModels, setFetchingModels] = useState(false);
  const [modelError, setModelError] = useState("");
  const saveTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  const handleMenuOpen = (e: React.MouseEvent<HTMLElement>) => setAnchorEl(e.currentTarget);
  const handleMenuClose = () => setAnchorEl(null);
  const handleThemeChange = (m: ThemeMode) => {
    onThemeChange(m);
    handleMenuClose();
  };

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

  const handleProviderChange = useCallback((provider: string) => {
    const preset = providerPresets[provider];
    updateSettings({
      provider,
      baseUrl: preset?.baseUrl || "",
    });
    setModelOptions([]);
  }, [updateSettings]);

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
      <AppBar position="static" color="default" elevation={1}>
        <Toolbar sx={{ gap: 1 }}>
          <SmartToyIcon color="primary" />
          <Typography variant="h6" component="h1" sx={{ flexGrow: 1 }}>
            NekoPilot 设置
          </Typography>

          <Tooltip title="主题">
            <IconButton onClick={handleMenuOpen} color="inherit">
              <Brightness4Icon />
            </IconButton>
          </Tooltip>
          <Menu
            anchorEl={anchorEl}
            open={Boolean(anchorEl)}
            onClose={handleMenuClose}
            anchorOrigin={{ vertical: "bottom", horizontal: "right" }}
            transformOrigin={{ vertical: "top", horizontal: "right" }}
          >
            <MenuItem onClick={() => handleThemeChange("light")} selected={mode === "light"}>
              <ListItemIcon><LightModeIcon fontSize="small" /></ListItemIcon>
              <ListItemText>明亮模式</ListItemText>
            </MenuItem>
            <MenuItem onClick={() => handleThemeChange("dark")} selected={mode === "dark"}>
              <ListItemIcon><DarkModeIcon fontSize="small" /></ListItemIcon>
              <ListItemText>暗黑模式</ListItemText>
            </MenuItem>
            <Divider />
            <MenuItem onClick={() => handleThemeChange("auto")} selected={mode === "auto"}>
              <ListItemIcon><SettingsBrightnessIcon fontSize="small" /></ListItemIcon>
              <ListItemText>跟随系统</ListItemText>
            </MenuItem>
          </Menu>
        </Toolbar>
      </AppBar>

      <Container maxWidth="sm" sx={{ py: 4 }}>
        <Stack spacing={3}>

          <Paper sx={{ p: 3 }}>
          <Stack spacing={2.5}>
            <Typography variant="subtitle2" color="text.secondary">
              LLM 提供商
            </Typography>

            <TextField
              select
              label="提供商"
              value={settings.provider}
              onChange={(e) => handleProviderChange(e.target.value)}
              fullWidth
            >
              <MenuItem value="openai">OpenAI</MenuItem>
              <MenuItem value="anthropic">Anthropic</MenuItem>
            </TextField>

            <Divider />

            <TextField
              label="API Key"
              type="password"
              value={settings.apiKey}
              onChange={(e) => updateSettings({ apiKey: e.target.value })}
              fullWidth
              placeholder="sk-..."
            />

            <TextField
              label="Base URL"
              value={settings.baseUrl}
              onChange={(e) => updateSettings({ baseUrl: e.target.value })}
              fullWidth
              helperText="OpenAI 兼容的 API 地址"
            />

            <Box sx={{ display: "flex", gap: 1, alignItems: "center" }}>
              <Autocomplete
                freeSolo
                fullWidth
                options={modelOptions}
                value={settings.model}
                onInputChange={(_e, value) => updateSettings({ model: value })}
                renderInput={(params) => (
                  <TextField
                    {...params}
                    label="模型"
                    placeholder="输入或从列表选择模型"
                    helperText={modelError || undefined}
                    error={!!modelError}
                  />
                )}
              />
              <Tooltip title="从 API 获取模型列表">
                <IconButton
                  onClick={handleFetchModels}
                  disabled={fetchingModels}
                >
                  {fetchingModels ? <CircularProgress size={20} /> : <RefreshIcon />}
                </IconButton>
              </Tooltip>
            </Box>
          </Stack>
        </Paper>

        <Paper sx={{ p: 3 }}>
          <Stack spacing={2.5}>
            <Typography variant="subtitle2" color="text.secondary">
              元素选择器
            </Typography>

            <TextField
              label="元素文本截取长度"
              type="number"
              value={settings.elementTextLimit}
              onChange={(e) =>
                updateSettings({ elementTextLimit: Math.max(1, parseInt(e.target.value) || 128) })
              }
              fullWidth
              helperText="选择页面元素时，截取元素文本的最大字符数（默认 128）"
              slotProps={{ htmlInput: { min: 1, max: 10000 } }}
            />

            <FormControlLabel
              control={
                <Switch
                  checked={settings.showClickMarker}
                  onChange={(e) => updateSettings({ showClickMarker: e.target.checked })}
                />
              }
              label="Click 操作时标记坐标位置"
            />
            <Typography variant="caption" color="text.secondary" sx={{ mt: -1.5 }}>
              在 Ask 模式下，Click 等待审批时在页面上显示点击位置标记
            </Typography>
          </Stack>
        </Paper>

        <Paper sx={{ p: 3 }}>
          <Stack spacing={2.5}>
            <Typography variant="subtitle2" color="text.secondary">
              工具行为
            </Typography>

            <FormControlLabel
              control={
                <Switch
                  checked={settings.enableShortRefs}
                  onChange={(e) => updateSettings({ enableShortRefs: e.target.checked })}
                />
              }
              label="启用 #n 简短元素引用"
            />
            <Typography variant="caption" color="text.secondary" sx={{ mt: -1.5 }}>
              read_page_interactive / find_element 返回的元素会附带 <code>ref: "#1"</code> 形式的短引用，模型可以直接用 <code>#1</code> 替代复杂 CSS 选择器；执行时由扩展自动还原。该编号在一次对话内自增。
            </Typography>

            <Divider />

            <Typography variant="body2" sx={{ fontWeight: 500 }}>
              截图压缩质量：{settings.screenshotQuality}%
            </Typography>
            <Slider
              value={settings.screenshotQuality}
              onChange={(_e, v) => updateSettings({ screenshotQuality: v as number })}
              min={10}
              max={100}
              step={5}
              marks={[
                { value: 10, label: "10%" },
                { value: 50, label: "50%" },
                { value: 100, label: "100%" },
              ]}
              valueLabelDisplay="auto"
              sx={{ mt: -0.5 }}
            />
            <Typography variant="caption" color="text.secondary" sx={{ mt: -1 }}>
              较低的质量可显著减少 token 消耗。100% 时使用无损 PNG，否则使用 JPEG 压缩。
            </Typography>
          </Stack>
        </Paper>
      </Stack>
    </Container>
    </>
  );
}
