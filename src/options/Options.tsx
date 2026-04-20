import { useState, useEffect } from "react";
import {
  Box,
  Typography,
  TextField,
  Button,
  Stack,
  Paper,
  Alert,
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
} from "@mui/material";
import SaveIcon from "@mui/icons-material/Save";
import SmartToyIcon from "@mui/icons-material/SmartToy";
import LightModeIcon from "@mui/icons-material/LightMode";
import DarkModeIcon from "@mui/icons-material/DarkMode";
import SettingsBrightnessIcon from "@mui/icons-material/SettingsBrightness";
import Brightness4Icon from "@mui/icons-material/Brightness4";
import type { ThemeMode } from "../shared/theme";

interface Settings {
  apiKey: string;
  baseUrl: string;
  model: string;
  provider: string;
  elementTextLimit: number;
}

const defaultSettings: Settings = {
  apiKey: "",
  baseUrl: "https://api.openai.com/v1",
  model: "gpt-4o",
  provider: "openai",
  elementTextLimit: 128,
};

const providerPresets: Record<string, { baseUrl: string; models: string[] }> = {
  openai: {
    baseUrl: "https://api.openai.com/v1",
    models: ["gpt-4o", "gpt-4o-mini", "gpt-4-turbo", "gpt-3.5-turbo"],
  },
  anthropic: {
    baseUrl: "https://api.anthropic.com/v1",
    models: ["claude-sonnet-4-20250514", "claude-haiku-4-20250414"],
  },
  custom: {
    baseUrl: "",
    models: [],
  },
};

export default function Options({ mode, onThemeChange }: { mode: ThemeMode; onThemeChange: (m: ThemeMode) => void }) {
  const [settings, setSettings] = useState<Settings>(defaultSettings);
  const [saved, setSaved] = useState(false);
  const [anchorEl, setAnchorEl] = useState<null | HTMLElement>(null);

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

  const handleProviderChange = (provider: string) => {
    const preset = providerPresets[provider];
    setSettings((prev) => ({
      ...prev,
      provider,
      baseUrl: preset.baseUrl || prev.baseUrl,
      model: preset.models[0] || prev.model,
    }));
  };

  const handleSave = async () => {
    await chrome.storage.local.set({ settings });
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

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
              <MenuItem value="custom">自定义 (OpenAI 兼容)</MenuItem>
            </TextField>

            <Divider />

            <TextField
              label="API Key"
              type="password"
              value={settings.apiKey}
              onChange={(e) =>
                setSettings((prev) => ({ ...prev, apiKey: e.target.value }))
              }
              fullWidth
              placeholder="sk-..."
            />

            <TextField
              label="Base URL"
              value={settings.baseUrl}
              onChange={(e) =>
                setSettings((prev) => ({ ...prev, baseUrl: e.target.value }))
              }
              fullWidth
              helperText="OpenAI 兼容的 API 地址"
            />

            {providerPresets[settings.provider]?.models.length > 0 ? (
              <TextField
                select
                label="模型"
                value={settings.model}
                onChange={(e) =>
                  setSettings((prev) => ({ ...prev, model: e.target.value }))
                }
                fullWidth
              >
                {providerPresets[settings.provider].models.map((m) => (
                  <MenuItem key={m} value={m}>
                    {m}
                  </MenuItem>
                ))}
              </TextField>
            ) : (
              <TextField
                label="模型名称"
                value={settings.model}
                onChange={(e) =>
                  setSettings((prev) => ({ ...prev, model: e.target.value }))
                }
                fullWidth
                placeholder="your-model-name"
              />
            )}

            <Box sx={{ display: "flex", justifyContent: "flex-end", gap: 1 }}>
              <Button
                startIcon={<SaveIcon />}
                onClick={handleSave}
              >
                保存
              </Button>
            </Box>

            {saved && (
              <Alert severity="success" variant="outlined">
                设置已保存！
              </Alert>
            )}
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
                setSettings((prev) => ({ ...prev, elementTextLimit: Math.max(1, parseInt(e.target.value) || 128) }))
              }
              fullWidth
              helperText="选择页面元素时，截取元素文本的最大字符数（默认 128）"
              slotProps={{ htmlInput: { min: 1, max: 10000 } }}
            />
          </Stack>
        </Paper>
      </Stack>
    </Container>
    </>
  );
}
