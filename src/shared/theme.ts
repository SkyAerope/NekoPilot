import { useEffect, useState } from "react";

export type ThemeMode = "light" | "dark" | "auto";

function isThemeMode(value: unknown): value is ThemeMode {
  return value === "light" || value === "dark" || value === "auto";
}

export function useTheme() {
  const [mode, setMode] = useState<ThemeMode>("auto");

  useEffect(() => {
    chrome.storage.local.get("themeMode", (data) => {
      if (isThemeMode(data.themeMode)) setMode(data.themeMode);
    });
    const listener = (
      changes: Record<string, chrome.storage.StorageChange>,
    ) => {
      if (changes.themeMode) {
        setMode(
          isThemeMode(changes.themeMode.newValue)
            ? changes.themeMode.newValue
            : "auto",
        );
      }
    };
    chrome.storage.local.onChanged.addListener(listener);
    return () => chrome.storage.local.onChanged.removeListener(listener);
  }, []);

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const applyTheme = () => {
      document.documentElement.classList.toggle(
        "dark",
        mode === "dark" || (mode === "auto" && media.matches),
      );
    };
    applyTheme();
    media.addEventListener("change", applyTheme);
    return () => media.removeEventListener("change", applyTheme);
  }, [mode]);

  const changeTheme = (next: ThemeMode) => {
    setMode(next);
    chrome.storage.local.set({ themeMode: next });
  };

  return { mode, changeTheme };
}
