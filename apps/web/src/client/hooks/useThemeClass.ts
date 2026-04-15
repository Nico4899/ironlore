import { useEffect } from "react";
import { useAppStore } from "../stores/app.js";

/**
 * Mirrors `useAppStore.theme` onto `<html>` so the `@custom-variant
 * light` block in globals.css can fire when the user picks light mode.
 *
 * Dark is the default per docs/09-ui-and-brand.md §Dark / light toggle,
 * so the `.light` class is only applied in light mode. `color-scheme`
 * tracks the theme too so native form controls, scrollbars, and
 * autofill overlays match.
 */
export function useThemeClass(): void {
  const theme = useAppStore((s) => s.theme);

  useEffect(() => {
    if (typeof document === "undefined") return;
    const root = document.documentElement;
    root.classList.toggle("light", theme === "light");
    root.style.colorScheme = theme;
  }, [theme]);
}
