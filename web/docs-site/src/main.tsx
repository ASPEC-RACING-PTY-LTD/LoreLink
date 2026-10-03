import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { initTheme } from "@lorelink/shared/theme";
import { DocsShell } from "./DocsShell";
import "./index.css";

initTheme();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <DocsShell />
  </StrictMode>,
);
