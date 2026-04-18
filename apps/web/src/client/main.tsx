import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";

// Self-hosted typographic triad — WOFF2 files shipped through Vite's
// asset pipeline so the app shell doesn't depend on fonts.googleapis.com
// at runtime. Keep this list narrow: Inter 400/500/600 cover body +
// semibold, Instrument Serif 400 + italic cover display headlines,
// JetBrains Mono 400 covers every metadata overline and keyboard hint.
// Per docs/09-ui-and-brand.md §Typography.
import "@fontsource/inter/latin-400.css";
import "@fontsource/inter/latin-500.css";
import "@fontsource/inter/latin-600.css";
import "@fontsource/instrument-serif/latin-400.css";
import "@fontsource/instrument-serif/latin-400-italic.css";
import "@fontsource/jetbrains-mono/latin-400.css";

import "./styles/globals.css";

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root element");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
