import { createTheme, type PaletteMode } from "@mui/material/styles";

export type ThemeMode = "light" | "dark" | "auto";

const common = {
  typography: {
    fontFamily: "'Segoe UI', 'Noto Sans SC', sans-serif",
    fontSize: 13,
  },
  shape: { borderRadius: 10 },
  components: {
    MuiButton: {
      defaultProps: { size: "small" as const, variant: "contained" as const },
    },
    MuiTextField: {
      defaultProps: { size: "small" as const, variant: "outlined" as const },
    },
  },
};

export function buildTheme(paletteMode: PaletteMode) {
  return createTheme({
    ...common,
    palette:
      paletteMode === "dark"
        ? {
            mode: "dark",
            primary: { main: "#a78bfa" },
            secondary: { main: "#f472b6" },
            background: { default: "#1a1a2e", paper: "#16213e" },
          }
        : {
            mode: "light",
            primary: { main: "#7c3aed" },
            secondary: { main: "#ec4899" },
          },
  });
}

export function resolveMode(mode: ThemeMode): PaletteMode {
  if (mode === "auto") {
    return window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";
  }
  return mode;
}

export const theme = buildTheme("dark");
