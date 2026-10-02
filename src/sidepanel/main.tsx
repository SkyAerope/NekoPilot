import React from "react";
import ReactDOM from "react-dom/client";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useTheme } from "../shared/theme";
import "../styles.css";
import App from "./App";

function Root() {
  useTheme();
  return (
    <TooltipProvider>
      <App />
    </TooltipProvider>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>,
);
