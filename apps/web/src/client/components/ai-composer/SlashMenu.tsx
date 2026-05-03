import { AtSign, CircleUserRound, Eraser, FileUp, Settings2 } from "lucide-react";
import { useEffect, useState } from "react";
import { fetchProviders, type ProviderSummary } from "../../lib/api.js";
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
      <ModelPicker />
      <PopoverItem
        icon={<Settings2 size={14} />}
        label="Open Settings → Providers"
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
 * Inline runtime-override picker. Lists every registered provider's
 * available models so the user can pin a per-conversation override
 * without leaving the composer. Selecting an entry writes to
 * `useAIPanelStore.runtimeOverride`; the next send carries that
 * override through the four-level resolver chain (action > runtime
 * > persona > global). "No override" clears it back to persona/global.
 *
 * Loads `fetchProviders()` lazily on first open; cached in component
 * state for the popover's lifetime. Empty provider list (none
 * configured) renders a help hint pointing to Settings → Providers.
 */
function ModelPicker() {
  const runtimeOverride = useAIPanelStore((s) => s.runtimeOverride);
  const setRuntimeOverride = useAIPanelStore((s) => s.setRuntimeOverride);
  const [providers, setProviders] = useState<ProviderSummary[] | null>(null);

  useEffect(() => {
    fetchProviders()
      .then(setProviders)
      .catch(() => setProviders([]));
  }, []);

  type ProviderId = "anthropic" | "ollama" | "openai" | "claude-cli";
  const KNOWN: ProviderId[] = ["anthropic", "ollama", "openai", "claude-cli"];
  const allModels: Array<{ provider: ProviderId; model: string }> = [];
  for (const p of providers ?? []) {
    if (p.status === "needs-key") continue;
    if (!(KNOWN as string[]).includes(p.name)) continue;
    for (const m of p.models) allModels.push({ provider: p.name as ProviderId, model: m });
  }

  if (providers === null) {
    return (
      <div style={{ padding: "6px 8px", fontSize: 11, color: "var(--il-text3)" }}>
        Loading providers…
      </div>
    );
  }
  if (allModels.length === 0) {
    return (
      <div style={{ padding: "6px 8px", fontSize: 11, color: "var(--il-text3)" }}>
        No provider configured. Open Settings → Providers to add a key.
      </div>
    );
  }

  const currentLabel = runtimeOverride.model ? runtimeOverride.model : "(persona / global)";

  return (
    <div
      style={{
        padding: "6px 8px",
        display: "flex",
        flexDirection: "column",
        gap: 4,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          fontSize: 12.5,
          fontFamily: "var(--font-sans)",
          color: "var(--il-text)",
        }}
      >
        <span style={{ flex: 1 }}>Pin model</span>
        <span
          className="font-mono"
          style={{ fontSize: 10.5, color: "var(--il-text3)", letterSpacing: "0.04em" }}
          title="Active runtime override"
        >
          {currentLabel}
        </span>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 1, marginTop: 2 }}>
        <button
          type="button"
          onClick={() => setRuntimeOverride({})}
          style={{
            padding: "4px 6px",
            fontSize: 11.5,
            textAlign: "left",
            background:
              runtimeOverride.model === undefined
                ? "color-mix(in oklch, var(--il-blue) 14%, transparent)"
                : "transparent",
            border: `1px solid ${
              runtimeOverride.model === undefined
                ? "color-mix(in oklch, var(--il-blue) 30%, transparent)"
                : "transparent"
            }`,
            borderRadius: 3,
            color: "var(--il-text2)",
            cursor: "pointer",
          }}
        >
          No override · use persona/global
        </button>
        {allModels.map(({ provider, model }) => {
          const selected = runtimeOverride.model === model && runtimeOverride.provider === provider;
          return (
            <button
              key={`${provider}:${model}`}
              type="button"
              onClick={() => setRuntimeOverride({ provider, model })}
              style={{
                padding: "4px 6px",
                fontSize: 11.5,
                textAlign: "left",
                background: selected
                  ? "color-mix(in oklch, var(--il-blue) 14%, transparent)"
                  : "transparent",
                border: `1px solid ${selected ? "color-mix(in oklch, var(--il-blue) 30%, transparent)" : "transparent"}`,
                borderRadius: 3,
                color: "var(--il-text)",
                cursor: "pointer",
                display: "flex",
                gap: 6,
                alignItems: "baseline",
              }}
            >
              <span
                className="font-mono uppercase"
                style={{ fontSize: 9.5, letterSpacing: "0.06em", color: "var(--il-text3)" }}
              >
                {provider}
              </span>
              <span style={{ flex: 1 }}>{model}</span>
            </button>
          );
        })}
      </div>
    </div>
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
