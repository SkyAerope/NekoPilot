import React from "react";
import ReactDOM from "react-dom/client";
import { ThemeProvider, CssBaseline } from "@mui/material";
import { buildTheme, resolveMode, type ThemeMode } from "../shared/theme";
import App from "./App";

function Root() {
  const [mode, setMode] = React.useState<ThemeMode>("auto");

  React.useEffect(() => {
    chrome.storage.local.get("themeMode", (data) => {
      if (data.themeMode) setMode(data.themeMode);
    });
    // 监听 storage 变化，与设置页同步
    const listener = (changes: Record<string, chrome.storage.StorageChange>) => {
      if (changes.themeMode) setMode(changes.themeMode.newValue);
    };
    chrome.storage.local.onChanged.addListener(listener);
    return () => chrome.storage.local.onChanged.removeListener(listener);
  }, []);

  const [, forceUpdate] = React.useReducer((x: number) => x + 1, 0);
  React.useEffect(() => {
    const mql = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = () => forceUpdate();
    mql.addEventListener("change", handler);
    return () => mql.removeEventListener("change", handler);
  }, []);

  const theme = React.useMemo(() => buildTheme(resolveMode(mode)), [mode]);

  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <App />
    </ThemeProvider>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>
);
