import { useEffect } from "react";
import { useAppStore } from "../stores/app.js";

/**
 * Mirrors user-tweakable appearance state from `useAppStore` onto
 * `<html>` so CSS can react:
 *
 *   - `theme` → `.light` class + `color-scheme`. Dark is the default
 *     per docs/09-ui-and-brand.md §Dark / light toggle, so `.light`
 *     only applies in light mode.
 *   - `density` → `data-density="comfortable" | "compact"`. Components
 *     can branch on it without subscribing to the store.
 *   - `accentHue` → `--il-accent-hue` inline style. The OKLCh tokens
 *     in globals.css reference this var, so sliding the hue shifts
 *     every Ironlore Blue surface in lockstep (lightness + chroma
 *     pinned, contrast guarantees intact).
 */
export function useThemeClass(): void {
  const theme = useAppStore((s) => s.theme);
  const density = useAppStore((s) => s.density);
  const accentHue = useAppStore((s) => s.accentHue);

  useEffect(() => {
    if (typeof document === "undefined") return;
    const root = document.documentElement;
    root.classList.toggle("light", theme === "light");
    root.style.colorScheme = theme;
    root.dataset.density = density;
    root.style.setProperty("--il-accent-hue", String(accentHue));
  }, [theme, density, accentHue]);
}
