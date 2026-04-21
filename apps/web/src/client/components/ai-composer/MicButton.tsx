import { Mic } from "lucide-react";

/**
 * Voice-input placeholder — renders the mic glyph in the textarea's
 * right gutter per the brand mock. No backing implementation yet;
 * the button is focusable and announces itself to assistive tech,
 * but clicking currently does nothing. Kept as a placeholder so the
 * composer's shape matches the spec; wiring to a Web Speech /
 * MediaRecorder pipeline is a follow-up task.
 */

export function MicButton() {
  return (
    <button
      type="button"
      aria-label="Voice input (coming soon)"
      title="Voice input (coming soon)"
      disabled
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: 22,
        height: 22,
        background: "transparent",
        border: "none",
        color: "var(--il-text4)",
        cursor: "not-allowed",
        borderRadius: 3,
      }}
    >
      <Mic size={14} />
    </button>
  );
}
