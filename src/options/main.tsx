import React from "react";
import ReactDOM from "react-dom/client";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useTheme } from "../shared/theme";
import "../styles.css";
import Options from "./Options";

function Root() {
  const { mode, changeTheme } = useTheme();
  return (
    <TooltipProvider>
      <Options mode={mode} onThemeChange={changeTheme} />
    </TooltipProvider>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>,
);
