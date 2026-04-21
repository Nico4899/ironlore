import { useEffect, useRef } from "react";

/**
 * Shared popover shell used by `PlusMenu`, `SlashMenu`, and
 * `MentionPicker`. Anchored above the composer toolbar, opens on
 * `--motion-snap` (80ms) per the four-token motion spec, closes on
 * Escape or outside click. Background uses `--il-bg-raised`,
 * border `--il-border-soft`, 6px radius — the same material as the
 * DiffPreview card.
 *
 * The shell is deliberately dumb: callers render their own body and
 * supply `onClose`. Keyboard handling inside the popover (arrow nav,
 * enter, etc.) is the caller's responsibility so each menu can tune
 * its own grammar.
 */

interface ComposerPopoverProps {
  open: boolean;
  onClose: () => void;
  children: React.ReactNode;
  /** ARIA label surfaced on the popover root. */
  ariaLabel: string;
  /** Pixel offset from the trigger's left edge. Default 0. */
  offsetX?: number;
  /** Minimum width; the body is free to grow past this. */
  minWidth?: number;
  /** Maximum width. Default 320. */
  maxWidth?: number;
}

export function ComposerPopover({
  open,
  onClose,
  children,
  ariaLabel,
  offsetX = 0,
  minWidth = 220,
  maxWidth = 320,
}: ComposerPopoverProps) {
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    const onClick = (e: MouseEvent) => {
      const root = rootRef.current;
      if (!root) return;
      if (!root.contains(e.target as Node)) onClose();
    };
    window.addEventListener("keydown", onKey);
    // Defer the outside-click listener by a tick so the same click
    //  that opened the popover doesn't close it.
    const timer = setTimeout(() => window.addEventListener("mousedown", onClick), 0);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onClick);
      clearTimeout(timer);
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      ref={rootRef}
      role="dialog"
      aria-label={ariaLabel}
      style={{
        position: "absolute",
        bottom: "calc(100% + 6px)",
        left: offsetX,
        minWidth,
        maxWidth,
        background: "var(--il-bg-raised)",
        border: "1px solid var(--il-border-soft)",
        borderRadius: 6,
        boxShadow: "0 6px 20px oklch(0 0 0 / 0.35)",
        padding: 6,
        zIndex: 40,
        animation: "ilSnapIn var(--motion-snap) ease-out",
      }}
    >
      {children}
    </div>
  );
}

/**
 * Mono-uppercase section header used inside the Slash menu — matches
 * the JournalCard overline grammar (10.5 / 0.06em letter-spacing, text3).
 */
export function PopoverSectionHeader({ label }: { label: string }) {
  return (
    <div
      className="font-mono uppercase"
      style={{
        fontSize: 10.5,
        letterSpacing: "0.08em",
        color: "var(--il-text3)",
        padding: "6px 8px 4px",
      }}
    >
      {label}
    </div>
  );
}

/**
 * Generic clickable row inside a composer popover. Icon on the left
 * (Lucide, size 14), label in Inter 12.5, optional trailing hint in
 * mono 10.5 text4 (e.g. a keyboard shortcut or "just inserts @").
 */
interface PopoverItemProps {
  icon?: React.ReactNode;
  label: string;
  hint?: string;
  onClick: () => void;
  disabled?: boolean;
}

export function PopoverItem({ icon, label, hint, onClick, disabled }: PopoverItemProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="il-popover-item"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        width: "100%",
        padding: "6px 8px",
        border: "none",
        background: "transparent",
        color: disabled ? "var(--il-text4)" : "var(--il-text)",
        borderRadius: 4,
        fontSize: 12.5,
        fontFamily: "var(--font-sans)",
        textAlign: "left",
        cursor: disabled ? "not-allowed" : "pointer",
      }}
    >
      {icon && (
        <span
          style={{ display: "inline-flex", width: 14, height: 14, color: "var(--il-text3)" }}
          aria-hidden="true"
        >
          {icon}
        </span>
      )}
      <span style={{ flex: 1 }}>{label}</span>
      {hint && (
        <span
          className="font-mono"
          style={{ fontSize: 10.5, letterSpacing: "0.04em", color: "var(--il-text4)" }}
        >
          {hint}
        </span>
      )}
    </button>
  );
}
