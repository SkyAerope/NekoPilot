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
} from "@mui/material";
import SaveIcon from "@mui/icons-material/Save";
import SmartToyIcon from "@mui/icons-material/SmartToy";

interface Settings {
  apiKey: string;
  baseUrl: string;
  model: string;
  provider: string;
}

const defaultSettings: Settings = {
  apiKey: "",
  baseUrl: "https://api.openai.com/v1",
  model: "gpt-4o",
  provider: "openai",
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

export default function Options() {
  const [settings, setSettings] = useState<Settings>(defaultSettings);
  const [saved, setSaved] = useState(false);

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
    <Container maxWidth="sm" sx={{ py: 4 }}>
      <Stack spacing={3}>
        <Stack direction="row" spacing={1} alignItems="center">
          <SmartToyIcon color="primary" fontSize="large" />
          <Typography variant="h5" fontWeight={700}>
            NekoPilot 设置
          </Typography>
        </Stack>

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
      </Stack>
    </Container>
  );
}
