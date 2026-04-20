import { useState, useEffect, useRef, useCallback } from "react";
import {
  Box,
  TextField,
  IconButton,
  Typography,
  Paper,
  Chip,
  Stack,
  Tooltip,
  Switch,
  FormControlLabel,
  CircularProgress,
  AppBar,
  Toolbar,
} from "@mui/material";
import SendIcon from "@mui/icons-material/Send";
import StopIcon from "@mui/icons-material/Stop";
import SettingsIcon from "@mui/icons-material/Settings";
import LinkIcon from "@mui/icons-material/Link";
import LinkOffIcon from "@mui/icons-material/LinkOff";
import SmartToyIcon from "@mui/icons-material/SmartToy";
import { sendMessage } from "../shared/messaging";
import type { AgentEvent } from "../agent/types";

interface LogEntry {
  id: number;
  type: "user" | "assistant" | "thinking" | "tool_call" | "tool_result" | "error";
  content: string;
  timestamp: number;
}

let logIdCounter = 0;

export default function App() {
  const [input, setInput] = useState("");
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [running, setRunning] = useState(false);
  const [attached, setAttached] = useState(false);
  const [autoMode, setAutoMode] = useState(true);
  const logsEndRef = useRef<HTMLDivElement>(null);

  // 监听 agent 事件
  useEffect(() => {
    const listener = (message: { type: string; payload?: AgentEvent }) => {
      if (message.type !== "agent:event" || !message.payload) return;
      const event = message.payload;
      const entry: LogEntry = {
        id: ++logIdCounter,
        type: event.type as LogEntry["type"],
        content:
          typeof event.data === "string"
            ? event.data
            : JSON.stringify(event.data, null, 2),
        timestamp: Date.now(),
      };

      if (event.type === "done") {
        setRunning(false);
      }

      setLogs((prev) => [...prev, entry]);
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, []);

  // 自动滚动
  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs]);

  // 检查连接状态
  useEffect(() => {
    sendMessage<{ attached: boolean }>("cdp:status").then((res) =>
      setAttached(res.attached)
    );
  }, []);

  const handleAttach = useCallback(async () => {
    if (attached) {
      await sendMessage("cdp:detach");
      setAttached(false);
    } else {
      await sendMessage("cdp:attach");
      setAttached(true);
    }
  }, [attached]);

  const handleSend = useCallback(async () => {
    const text = input.trim();
    if (!text || running) return;

    setInput("");
    setLogs((prev) => [
      ...prev,
      {
        id: ++logIdCounter,
        type: "user",
        content: text,
        timestamp: Date.now(),
      },
    ]);

    // 读取设置
    const settings = await sendMessage<{
      apiKey?: string;
      baseUrl?: string;
      model?: string;
    }>("settings:get");

    if (!settings?.apiKey) {
      setLogs((prev) => [
        ...prev,
        {
          id: ++logIdCounter,
          type: "error",
          content: "请先在设置页面配置 API Key",
          timestamp: Date.now(),
        },
      ]);
      return;
    }

    setRunning(true);
    try {
      await sendMessage("agent:start", {
        userMessage: text,
        config: {
          apiKey: settings.apiKey,
          baseUrl: settings.baseUrl || "https://api.openai.com/v1",
          model: settings.model || "gpt-4o",
          maxIterations: 20,
          permissionMode: autoMode ? "auto" : "ask",
        },
      });
    } catch (err) {
      setLogs((prev) => [
        ...prev,
        {
          id: ++logIdCounter,
          type: "error",
          content: String(err),
          timestamp: Date.now(),
        },
      ]);
      setRunning(false);
    }
  }, [input, running, autoMode]);

  const handleStop = useCallback(async () => {
    await sendMessage("agent:stop");
    setRunning(false);
  }, []);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend]
  );

  return (
    <Box sx={{ display: "flex", flexDirection: "column", height: "100vh" }}>
      {/* 顶栏 */}
      <AppBar position="static" color="transparent" elevation={0}>
        <Toolbar variant="dense" sx={{ gap: 1 }}>
          <SmartToyIcon color="primary" />
          <Typography variant="subtitle1" sx={{ fontWeight: 700, flexGrow: 1 }}>
            NekoPilot
          </Typography>
          <Tooltip title={attached ? "断开 CDP" : "连接 CDP"}>
            <IconButton size="small" onClick={handleAttach}>
              {attached ? (
                <LinkIcon color="success" />
              ) : (
                <LinkOffIcon color="disabled" />
              )}
            </IconButton>
          </Tooltip>
          <Tooltip title="设置">
            <IconButton
              size="small"
              onClick={() => chrome.runtime.openOptionsPage()}
            >
              <SettingsIcon />
            </IconButton>
          </Tooltip>
        </Toolbar>
      </AppBar>

      {/* 日志区 */}
      <Box sx={{ flex: 1, overflow: "auto", px: 1.5, py: 1 }}>
        {logs.map((log) => (
          <LogItem key={log.id} entry={log} />
        ))}
        <div ref={logsEndRef} />
      </Box>

      {/* 底栏 */}
      <Paper
        elevation={4}
        sx={{ p: 1.5, borderTop: 1, borderColor: "divider" }}
      >
        <Stack direction="row" spacing={1} alignItems="flex-end">
          <FormControlLabel
            control={
              <Switch
                size="small"
                checked={autoMode}
                onChange={(_, v) => setAutoMode(v)}
              />
            }
            label={
              <Typography variant="caption">
                {autoMode ? "Auto" : "Ask"}
              </Typography>
            }
            sx={{ mr: 0 }}
          />
          <TextField
            fullWidth
            multiline
            maxRows={4}
            placeholder="输入你的指令..."
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={running}
          />
          {running ? (
            <IconButton color="error" onClick={handleStop}>
              <StopIcon />
            </IconButton>
          ) : (
            <IconButton color="primary" onClick={handleSend} disabled={!input.trim()}>
              <SendIcon />
            </IconButton>
          )}
        </Stack>
      </Paper>
    </Box>
  );
}

// ── 日志条目组件 ──

const typeConfig: Record<
  LogEntry["type"],
  { label: string; color: "default" | "primary" | "secondary" | "success" | "warning" | "error" | "info" }
> = {
  user: { label: "You", color: "primary" },
  assistant: { label: "NekoPilot", color: "secondary" },
  thinking: { label: "思考", color: "info" },
  tool_call: { label: "工具调用", color: "warning" },
  tool_result: { label: "工具结果", color: "success" },
  error: { label: "错误", color: "error" },
};

function LogItem({ entry }: { entry: LogEntry }) {
  const config = typeConfig[entry.type];
  const isUser = entry.type === "user";

  return (
    <Box sx={{ mb: 1, display: "flex", flexDirection: "column", alignItems: isUser ? "flex-end" : "flex-start" }}>
      <Chip label={config.label} color={config.color} size="small" sx={{ mb: 0.5 }} />
      <Paper
        variant="outlined"
        sx={{
          p: 1,
          maxWidth: "95%",
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
          fontSize: "0.82rem",
          lineHeight: 1.5,
          bgcolor: isUser ? "primary.dark" : "background.paper",
        }}
      >
        {entry.type === "tool_call" || entry.type === "tool_result" ? (
          <Typography
            component="pre"
            variant="body2"
            sx={{ fontFamily: "monospace", fontSize: "0.78rem", m: 0 }}
          >
            {entry.content}
          </Typography>
        ) : (
          <Typography variant="body2">{entry.content}</Typography>
        )}
        {entry.type === "thinking" && (
          <CircularProgress size={14} sx={{ ml: 1 }} />
        )}
      </Paper>
    </Box>
  );
}
