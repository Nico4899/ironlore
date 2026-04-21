import { AtSign, CircleUserRound, Eraser, FileUp, Settings2 } from "lucide-react";
import { type EffortLevel, useAIPanelStore } from "../../stores/ai-panel.js";
import { ComposerPopover, PopoverItem, PopoverSectionHeader } from "./ComposerPopover.js";

/**
 * `/` composer popover — three sections (Context · Model · Slash
 * commands) per the user spec. Opens on click OR when `/` is typed
 * as the first character of an empty draft.
 *
 * Actions are handed back to the composer via callback props so the
 * popover stays presentational — the composer owns the textarea,
 * file input, and conversation state.
 */

export type SlashAction =
  | "attach-file"
  | "mention"
  | "clear-conversation"
  | "switch-model"
  | "account-usage"
  | "slash.clear"
  | "slash.summarize"
  | "slash.retry"
  | "slash.continue";

interface SlashMenuProps {
  open: boolean;
  onClose: () => void;
  onAction: (action: SlashAction) => void;
}

export function SlashMenu({ open, onClose, onAction }: SlashMenuProps) {
  const effort = useAIPanelStore((s) => s.effort);
  const setEffort = useAIPanelStore((s) => s.setEffort);

  // Helper so every item closes the popover after dispatching.
  const fire = (action: SlashAction) => () => {
    onAction(action);
    onClose();
  };

  return (
    <ComposerPopover
      open={open}
      onClose={onClose}
      ariaLabel="Commands"
      minWidth={260}
      maxWidth={320}
    >
      <PopoverSectionHeader label="Context" />
      <PopoverItem icon={<FileUp size={14} />} label="Attach file" onClick={fire("attach-file")} />
      <PopoverItem
        icon={<AtSign size={14} />}
        label="Mention file or agent"
        hint="@"
        onClick={fire("mention")}
      />
      <PopoverItem
        icon={<Eraser size={14} />}
        label="Clear conversation"
        onClick={fire("clear-conversation")}
      />

      <PopoverSectionHeader label="Model" />
      <PopoverItem
        icon={<Settings2 size={14} />}
        label="Switch model"
        onClick={fire("switch-model")}
      />
      <EffortSlider value={effort} onChange={setEffort} />
      <PopoverItem
        icon={<CircleUserRound size={14} />}
        label="Account & usage"
        onClick={fire("account-usage")}
      />

      <PopoverSectionHeader label="Slash commands" />
      <PopoverItem label="/clear" hint="clear conversation" onClick={fire("slash.clear")} />
      <PopoverItem label="/summarize" hint="summarize so far" onClick={fire("slash.summarize")} />
      <PopoverItem label="/retry" hint="retry last turn" onClick={fire("slash.retry")} />
      <PopoverItem label="/continue" hint="keep going" onClick={fire("slash.continue")} />
    </ComposerPopover>
  );
}

/**
 * Effort slider embedded as a menu row. Three-stop slider matches
 * the SegChoice grammar in SettingsDialog (mono label + chunked
 * selection) but stays inline so the popover reads as a single
 * vertical stack. Persists via `setEffort` on change.
 */
function EffortSlider({
  value,
  onChange,
}: {
  value: EffortLevel;
  onChange: (v: EffortLevel) => void;
}) {
  const options: Array<{ value: EffortLevel; label: string }> = [
    { value: "low", label: "Low" },
    { value: "medium", label: "Medium" },
    { value: "high", label: "High" },
  ];
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "6px 8px",
      }}
    >
      <span
        style={{
          flex: 1,
          fontSize: 12.5,
          fontFamily: "var(--font-sans)",
          color: "var(--il-text)",
        }}
      >
        Effort
      </span>
      <div
        style={{
          display: "inline-flex",
          padding: 2,
          background: "var(--il-slate)",
          border: "1px solid var(--il-border-soft)",
          borderRadius: 4,
        }}
      >
        {options.map((o) => {
          const selected = o.value === value;
          return (
            <button
              key={o.value}
              type="button"
              aria-pressed={selected}
              onClick={() => onChange(o.value)}
              style={{
                padding: "3px 8px",
                fontSize: 10.5,
                fontFamily: "var(--font-mono)",
                letterSpacing: "0.04em",
                textTransform: "uppercase",
                color: selected ? "var(--il-text)" : "var(--il-text3)",
                background: selected ? "var(--il-slate-elev)" : "transparent",
                border: `1px solid ${selected ? "var(--il-border)" : "transparent"}`,
                borderRadius: 3,
                cursor: "pointer",
              }}
            >
              {o.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
