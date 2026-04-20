import React from "react";
import ReactDOM from "react-dom/client";
import { ThemeProvider, CssBaseline } from "@mui/material";
import Options from "./Options";
import { buildTheme, resolveMode, type ThemeMode } from "../shared/theme";

function Root() {
  const [mode, setMode] = React.useState<ThemeMode>("auto");

  React.useEffect(() => {
    chrome.storage.local.get("themeMode", (data) => {
      if (data.themeMode) setMode(data.themeMode);
    });
  }, []);

  const [, forceUpdate] = React.useReducer((x: number) => x + 1, 0);
  React.useEffect(() => {
    const mql = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = () => forceUpdate();
    mql.addEventListener("change", handler);
    return () => mql.removeEventListener("change", handler);
  }, []);

  const theme = React.useMemo(() => buildTheme(resolveMode(mode)), [mode]);

  const handleThemeChange = (newMode: ThemeMode) => {
    setMode(newMode);
    chrome.storage.local.set({ themeMode: newMode });
  };

  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <Options mode={mode} onThemeChange={handleThemeChange} />
    </ThemeProvider>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>
);
