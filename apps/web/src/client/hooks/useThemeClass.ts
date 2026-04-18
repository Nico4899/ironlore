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
 *   - `motion` → `data-motion="full" | "reduced" | "none"`. Gates the
 *     `ilPulse` + `ilSpin` keyframes in globals.css without touching
 *     the components that use them.
 *   - `motifs` → one `data-motif-<key>="on" | "off"` attr each. The
 *     two motifs with live plumbing (`provenance`, `agentPulse`) are
 *     CSS-gated. The other two persist in the attribute for future
 *     features to read from.
 */
export function useThemeClass(): void {
  const theme = useAppStore((s) => s.theme);
  const density = useAppStore((s) => s.density);
  const accentHue = useAppStore((s) => s.accentHue);
  const motion = useAppStore((s) => s.motion);
  const motifs = useAppStore((s) => s.motifs);

  useEffect(() => {
    if (typeof document === "undefined") return;
    const root = document.documentElement;
    root.classList.toggle("light", theme === "light");
    root.style.colorScheme = theme;
    root.dataset.density = density;
    root.style.setProperty("--il-accent-hue", String(accentHue));
    root.dataset.motion = motion;
    root.dataset.motifProvenance = motifs.provenance ? "on" : "off";
    root.dataset.motifAgentPulse = motifs.agentPulse ? "on" : "off";
    root.dataset.motifBlockrefPreview = motifs.blockrefPreview ? "on" : "off";
    root.dataset.motifReuleauxPips = motifs.reuleauxPips ? "on" : "off";
  }, [theme, density, accentHue, motion, motifs]);
}
