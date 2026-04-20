import { createTheme } from "@mui/material/styles";

export const theme = createTheme({
  palette: {
    mode: "dark",
    primary: { main: "#a78bfa" }, // 淡紫色
    secondary: { main: "#f472b6" }, // 粉色
    background: {
      default: "#1a1a2e",
      paper: "#16213e",
    },
  },
  typography: {
    fontFamily: "'Segoe UI', 'Noto Sans SC', sans-serif",
    fontSize: 13,
  },
  shape: { borderRadius: 10 },
  components: {
    MuiButton: {
      defaultProps: { size: "small", variant: "contained" },
    },
    MuiTextField: {
      defaultProps: { size: "small", variant: "outlined" },
    },
  },
});
