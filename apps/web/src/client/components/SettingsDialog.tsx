import { X } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { useFocusTrap } from "../hooks/useFocusTrap.js";
import {
  type AgentConfigResponse,
  type AgentListEntry,
  fetchAgentConfig,
  fetchAgents,
} from "../lib/api.js";
import {
  DEFAULT_ACCENT_HUE,
  type MotifSettings,
  type MotionSetting,
  type TypeDisplaySetting,
  useAppStore,
} from "../stores/app.js";

type Tab = "general" | "appearance" | "security";

/** Preset accent hues offered as quick swatches on the Appearance tab. */
const PRESET_HUES = [220, 258, 290, 320, 10, 40, 80, 148];

/**
 * Settings dialog — canvas-grammar per docs/09-ui-and-brand.md
 * §Settings. Left column is the category nav, right column is the
 * selected tab's content. Appearance is the one wired tab: Theme,
 * Density, Accent hue, and a Motifs note; the rest are placeholders
 * that will light up as each feature lands.
 *
 * Accent hue shifts `--il-accent-hue` via the store; lightness and
 * chroma stay pinned so contrast guarantees still hold.
 */
export function SettingsDialog() {
  const overlayRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  useFocusTrap(dialogRef, true);

  const close = useCallback(() => useAppStore.getState().toggleSettings(), []);

  const handleOverlayClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === overlayRef.current) close();
    },
    [close],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        close();
      }
    },
    [close],
  );

  const [activeTab, setActiveTab] = useState<Tab>("appearance");

  return (
    <div
      ref={overlayRef}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={handleOverlayClick}
      onKeyDown={handleKeyDown}
      role="dialog"
      aria-modal="true"
      aria-label="Settings"
    >
      <div
        ref={dialogRef}
        className="flex h-[min(640px,90vh)] w-full max-w-4xl overflow-hidden rounded-md shadow-2xl"
        style={{ background: "var(--il-slate)", border: "1px solid var(--il-border)" }}
      >
        {/* Category nav */}
        <aside
          className="flex w-52 flex-col"
          style={{
            background: "var(--il-slate)",
            borderRight: "1px solid var(--il-border-soft)",
            padding: "16px 10px",
          }}
        >
          <div
            className="font-mono uppercase"
            style={{
              fontSize: 10.5,
              color: "var(--il-text3)",
              letterSpacing: "0.08em",
              padding: "0 8px 10px",
            }}
          >
            settings
          </div>
          {/* Category order mirrors docs/09-ui-and-brand.md §Settings →
           *  Appearance: General · Projects · Agents · Security · Storage
           *  · Appearance. Unwired rows render at 50% opacity so the
           *  roadmap is visible at a glance. */}
          {(
            [
              ["general", "General", false],
              ["projects", "Projects", false],
              ["agents", "Agents", false],
              ["security", "Security", true],
              ["storage", "Storage", false],
              ["appearance", "Appearance", true],
            ] as Array<[Tab | "projects" | "agents" | "storage" | "general", string, boolean]>
          ).map(([key, label, wired]) => {
            const active = (key as string) === (activeTab as string);
            return (
              <button
                key={key}
                type="button"
                disabled={!wired}
                onClick={() => wired && setActiveTab(key as Tab)}
                className="text-left outline-none"
                style={{
                  padding: "6px 10px",
                  borderRadius: 3,
                  background: active
                    ? "color-mix(in oklch, var(--il-blue) 12%, transparent)"
                    : "transparent",
                  borderLeft: `2px solid ${active ? "var(--il-blue)" : "transparent"}`,
                  color: active ? "var(--il-text)" : "var(--il-text2)",
                  fontSize: 13,
                  marginBottom: 2,
                  cursor: wired ? "pointer" : "not-allowed",
                  opacity: wired ? 1 : 0.5,
                }}
              >
                {label}
              </button>
            );
          })}
        </aside>

        {/* Active tab content */}
        <div className="flex flex-1 flex-col overflow-hidden">
          <div
            className="flex items-center justify-between"
            style={{
              padding: "12px 20px",
              borderBottom: "1px solid var(--il-border-soft)",
            }}
          >
            <span
              className="font-mono uppercase"
              style={{
                fontSize: 10.5,
                color: "var(--il-text3)",
                letterSpacing: "0.08em",
              }}
            >
              {activeTab === "security" ? "06 / security" : "06 / settings"}
            </span>
            <button
              type="button"
              onClick={close}
              aria-label="Close settings"
              className="rounded p-1 text-secondary hover:bg-ironlore-slate-hover hover:text-primary"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          <div className="flex-1 overflow-y-auto" style={{ padding: "28px 36px" }}>
            {activeTab === "security" ? <SecurityTab /> : <AppearanceTab />}
          </div>
        </div>
      </div>
    </div>
  );
}

function AppearanceTab() {
  const theme = useAppStore((s) => s.theme);
  const density = useAppStore((s) => s.density);
  const accentHue = useAppStore((s) => s.accentHue);
  const motion = useAppStore((s) => s.motion);
  const typeDisplay = useAppStore((s) => s.typeDisplay);
  const motifs = useAppStore((s) => s.motifs);

  return (
    <>
      <h1
        style={{
          fontFamily: "var(--font-sans)",
          fontWeight: 600,
          fontSize: 26,
          letterSpacing: "-0.025em",
          margin: "0 0 4px",
          color: "var(--il-text)",
        }}
      >
        Appearance
      </h1>
      <p
        style={{
          margin: "0 0 24px",
          fontSize: 13.5,
          color: "var(--il-text2)",
          maxWidth: 520,
        }}
      >
        Adjust the visual density, theme, and accent hue. All settings apply instantly and persist
        per device.
      </p>

      <SettingRow n="01" label="Theme">
        <SegChoice
          options={[
            { value: "dark", label: "Dark" },
            { value: "light", label: "Light" },
          ]}
          active={theme}
          onChange={(v) => useAppStore.getState().setTheme(v as "dark" | "light")}
        />
      </SettingRow>

      <SettingRow n="02" label="Density">
        <SegChoice
          options={[
            { value: "comfortable", label: "Comfortable" },
            { value: "compact", label: "Compact" },
          ]}
          active={density}
          onChange={(v) => useAppStore.getState().setDensity(v as "comfortable" | "compact")}
        />
      </SettingRow>

      <SettingRow
        n="03"
        label="Accent hue"
        sub="Shifts the Ironlore Blue hue only. Lightness and chroma are fixed so contrast stays safe."
      >
        <AccentHueControl hue={accentHue} />
      </SettingRow>

      <SettingRow
        n="04"
        label="Motion"
        sub="Full runs every keyframe; Reduced fades the pulse and stops the Reuleaux rotation; None disables both. The OS Reduce Motion preference is still honored on top of this setting."
      >
        <SegChoice
          options={[
            { value: "full", label: "Full" },
            { value: "reduced", label: "Reduced" },
            { value: "none", label: "None" },
          ]}
          active={motion}
          onChange={(v) => useAppStore.getState().setMotion(v as MotionSetting)}
        />
      </SettingRow>

      <SettingRow
        n="05"
        label="Display type"
        sub="Sans keeps every heading in Inter. Serif opts the Home greeting, Agent-detail hero slug, and Onboarding copy into Instrument Serif — the display silhouette in the brand spec."
      >
        <SegChoice
          options={[
            { value: "sans", label: "Sans" },
            { value: "serif", label: "Serif" },
          ]}
          active={typeDisplay}
          onChange={(v) => useAppStore.getState().setTypeDisplay(v as TypeDisplaySetting)}
        />
      </SettingRow>

      <SettingRow
        n="06"
        label="Motif visibility"
        sub="Persisted per device. Two motifs have live plumbing today; the other two save state for future features."
      >
        <MotifToggleList motifs={motifs} />
      </SettingRow>
    </>
  );
}

/**
 * Security tab — per-agent scope review surface (docs/06-implementation-
 * roadmap.md Phase 8 §Settings → Security tab).
 *
 * Fetches the installed agents via `GET /agents`, then one
 * `/agents/:slug/config` per slug. Renders a read-only card for each
 * agent showing the fields that gate its filesystem/egress reach:
 *  · scope.pages           — glob allow-list of pages the agent may write
 *  · scope.writableKinds   — file-kind restrictions (e.g. ["md", "yaml"])
 *  · tools                 — declared tool surface
 *  · rate caps (rph/rpd)   — mirrored from agent_state
 *  · reviewMode            — inbox vs auto-commit
 *  · status                — active / paused (with pause reason)
 *
 * This is a review surface, not an editor: scope is authored in the
 * persona.md frontmatter. The tab surfaces what the running system
 * actually sees so the admin can audit it from one place rather than
 * opening each persona file individually.
 */
function SecurityTab() {
  const [agents, setAgents] = useState<AgentListEntry[] | null>(null);
  const [configs, setConfigs] = useState<Record<string, AgentConfigResponse | "error">>({});
  const [listError, setListError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const list = await fetchAgents();
        if (cancelled) return;
        setAgents(list);
        // Fetch configs in parallel — small N, no pagination worry.
        const entries = await Promise.all(
          list.map(async (a) => {
            try {
              const cfg = await fetchAgentConfig(a.slug);
              return [a.slug, cfg] as const;
            } catch {
              return [a.slug, "error"] as const;
            }
          }),
        );
        if (cancelled) return;
        setConfigs(Object.fromEntries(entries));
      } catch (err) {
        if (cancelled) return;
        setListError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <>
      <h1
        style={{
          fontFamily: "var(--font-sans)",
          fontWeight: 600,
          fontSize: 26,
          letterSpacing: "-0.025em",
          margin: "0 0 4px",
          color: "var(--il-text)",
        }}
      >
        Security
      </h1>
      <p style={{ margin: "0 0 24px", fontSize: 13.5, color: "var(--il-text2)", maxWidth: 560 }}>
        One row per installed agent showing what it can reach — scope globs, writable kinds,
        declared tools, rate caps, and review mode. Scope itself is authored in each persona's
        frontmatter; this tab is a read-only audit.
      </p>

      {listError && (
        <div
          style={{
            padding: 12,
            border: "1px solid var(--il-border)",
            borderRadius: 4,
            color: "var(--il-red)",
            fontSize: 12.5,
          }}
        >
          Failed to load agents: {listError}
        </div>
      )}

      {agents && agents.length === 0 && (
        <div
          style={{
            padding: 12,
            border: "1px dashed var(--il-border-soft)",
            borderRadius: 4,
            color: "var(--il-text3)",
            fontSize: 12.5,
          }}
        >
          No agents installed yet.
        </div>
      )}

      {agents === null && !listError && (
        <div style={{ color: "var(--il-text3)", fontSize: 12.5 }}>Loading…</div>
      )}

      <div style={{ display: "grid", gap: 14 }}>
        {agents?.map((a) => (
          <AgentSecurityCard key={a.slug} listEntry={a} config={configs[a.slug]} />
        ))}
      </div>
    </>
  );
}

function AgentSecurityCard({
  listEntry,
  config,
}: {
  listEntry: AgentListEntry;
  config: AgentConfigResponse | "error" | undefined;
}) {
  const loading = config === undefined;
  const errored = config === "error";
  const cfg = !loading && !errored ? config : null;

  const pages = cfg?.persona?.scope?.pages ?? null;
  const writableKinds = cfg?.persona?.scope?.writableKinds ?? null;
  const tools = cfg?.persona?.tools ?? null;
  const reviewMode = cfg?.persona?.reviewMode ?? null;

  return (
    <div
      style={{
        border: "1px solid var(--il-border-soft)",
        borderRadius: 4,
        padding: "14px 16px",
        background: "var(--il-slate-elev)",
      }}
    >
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 10 }}>
        <span
          className="font-mono"
          style={{
            fontSize: 10.5,
            letterSpacing: "0.06em",
            color: "var(--il-text3)",
            textTransform: "uppercase",
          }}
        >
          agent
        </span>
        <span style={{ fontSize: 14, fontWeight: 500, color: "var(--il-text)" }}>
          {listEntry.slug}
        </span>
        <StatusChip status={listEntry.status} pauseReason={cfg?.pauseReason ?? null} />
      </div>

      {loading && <div style={{ color: "var(--il-text3)", fontSize: 12 }}>Loading config…</div>}
      {errored && (
        <div style={{ color: "var(--il-red)", fontSize: 12 }}>
          Failed to load this agent's config.
        </div>
      )}

      {cfg && (
        <div
          style={{ display: "grid", gridTemplateColumns: "150px 1fr", rowGap: 6, columnGap: 20 }}
        >
          <FieldLabel>Scope · pages</FieldLabel>
          <ScopeGlobs globs={pages} />

          <FieldLabel>Scope · writable kinds</FieldLabel>
          <ScopeGlobs globs={writableKinds} />

          <FieldLabel>Tools</FieldLabel>
          <ScopeGlobs globs={tools} />

          <FieldLabel>Rate caps</FieldLabel>
          <FieldValue>
            {cfg.maxRunsPerHour}/hr · {cfg.maxRunsPerDay}/day
          </FieldValue>

          <FieldLabel>Review mode</FieldLabel>
          <FieldValue>{reviewMode ?? "—"}</FieldValue>

          <FieldLabel>Failure streak</FieldLabel>
          <FieldValue>{cfg.failureStreak === 0 ? "—" : `${cfg.failureStreak}`}</FieldValue>
        </div>
      )}
    </div>
  );
}

function FieldLabel({ children }: { children: ReactNode }) {
  return (
    <span
      className="font-mono uppercase"
      style={{
        fontSize: 10.5,
        letterSpacing: "0.06em",
        color: "var(--il-text3)",
        paddingTop: 2,
      }}
    >
      {children}
    </span>
  );
}

function FieldValue({ children }: { children: ReactNode }) {
  return <span style={{ fontSize: 12.5, color: "var(--il-text)" }}>{children}</span>;
}

function ScopeGlobs({ globs }: { globs: string[] | null }) {
  if (!globs || globs.length === 0) {
    return (
      <span
        style={{ fontSize: 12.5, color: "var(--il-text3)" }}
        title="Not declared in persona frontmatter"
      >
        —
      </span>
    );
  }
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
      {globs.map((g) => (
        <code
          key={g}
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 11,
            padding: "1px 6px",
            borderRadius: 2,
            background: "var(--il-slate)",
            border: "1px solid var(--il-border-soft)",
            color: "var(--il-text2)",
          }}
        >
          {g}
        </code>
      ))}
    </div>
  );
}

function StatusChip({
  status,
  pauseReason,
}: {
  status: "active" | "paused";
  pauseReason: string | null;
}) {
  const paused = status === "paused";
  return (
    <span
      className="font-mono uppercase"
      title={pauseReason ?? undefined}
      style={{
        fontSize: 10.5,
        letterSpacing: "0.06em",
        padding: "1px 5px",
        borderRadius: 2,
        border: "1px solid var(--il-border-soft)",
        color: paused ? "var(--il-amber)" : "var(--il-text2)",
      }}
    >
      {paused ? "paused" : "active"}
    </span>
  );
}

interface MotifToggleDef {
  key: keyof MotifSettings;
  label: string;
  /** True when the toggle actually affects rendering today. */
  live: boolean;
}

const MOTIF_TOGGLES: MotifToggleDef[] = [
  { key: "provenance", label: "Provenance strip on cited blocks", live: true },
  { key: "agentPulse", label: "Agent pulse on live surfaces", live: true },
  { key: "blockrefPreview", label: "Blockref hover preview", live: false },
  { key: "reuleauxPips", label: "Reuleaux status pips (vs. standard dots)", live: false },
];

function MotifToggleList({ motifs }: { motifs: MotifSettings }) {
  const setMotif = useAppStore((s) => s.setMotif);
  return (
    <div className="grid gap-2">
      {MOTIF_TOGGLES.map((def) => (
        <MotifToggle
          key={def.key}
          label={def.label}
          live={def.live}
          value={motifs[def.key]}
          onChange={(v) => setMotif(def.key, v)}
        />
      ))}
    </div>
  );
}

interface MotifToggleProps {
  label: string;
  live: boolean;
  value: boolean;
  onChange: (value: boolean) => void;
}

/**
 * Canvas-shape switch: 26×14 pill with a 10×10 thumb that slides
 * right when on. The "not live yet" badge appears next to the label
 * when flipping the toggle doesn't affect rendering today — honest
 * about which switches are cosmetic state vs. real feature gates.
 */
function MotifToggle({ label, live, value, onChange }: MotifToggleProps) {
  // A real <input type="checkbox"> with a role="switch" — Biome's
  //  a11y rule rejects a role on a non-interactive element, and also
  //  rejects a <label> that wraps nothing except styled spans. Using
  //  a hidden checkbox + clickable text keeps keyboard + screen
  //  reader semantics correct without hand-rolling them.
  return (
    <label className="inline-flex cursor-pointer items-center gap-3" style={{ userSelect: "none" }}>
      <input
        type="checkbox"
        role="switch"
        checked={value}
        aria-checked={value}
        onChange={(e) => onChange(e.target.checked)}
        aria-label={label}
        className="sr-only"
      />
      <span
        aria-hidden="true"
        style={{
          width: 26,
          height: 14,
          borderRadius: 7,
          background: value ? "var(--il-blue)" : "var(--il-slate-elev)",
          border: "1px solid var(--il-border)",
          position: "relative",
          transition: "background var(--motion-snap) ease-out",
        }}
      >
        <span
          aria-hidden="true"
          style={{
            position: "absolute",
            top: 1,
            left: value ? 13 : 1,
            width: 10,
            height: 10,
            borderRadius: "50%",
            background: "var(--il-bg)",
            transition: "left var(--motion-snap) ease-out",
          }}
        />
      </span>
      <span style={{ fontSize: 13, color: "var(--il-text)" }}>{label}</span>
      {!live && (
        <span
          className="font-mono uppercase"
          style={{
            fontSize: 10.5,
            letterSpacing: "0.04em",
            color: "var(--il-text3)",
            padding: "1px 4px",
            border: "1px solid var(--il-border-soft)",
            borderRadius: 2,
          }}
          title="Saved per device; no runtime effect in the current build."
        >
          soon
        </span>
      )}
    </label>
  );
}

function SettingRow({
  n,
  label,
  sub,
  children,
}: {
  n: string;
  label: string;
  sub?: string;
  children: ReactNode;
}) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "200px 1fr",
        gap: 40,
        padding: "18px 0",
        borderTop: "1px solid var(--il-border-soft)",
      }}
    >
      <div>
        <div
          className="font-mono"
          style={{
            fontSize: 10.5,
            color: "var(--il-text4)",
            letterSpacing: "0.08em",
            marginBottom: 4,
          }}
        >
          {n}
        </div>
        <div style={{ fontSize: 13.5, fontWeight: 500, color: "var(--il-text)" }}>{label}</div>
        {sub && (
          <div
            style={{
              fontSize: 11.5,
              color: "var(--il-text3)",
              marginTop: 4,
              lineHeight: 1.4,
            }}
          >
            {sub}
          </div>
        )}
      </div>
      <div>{children}</div>
    </div>
  );
}

interface SegChoiceProps<V extends string> {
  options: Array<{ value: V; label: string }>;
  active: V;
  onChange: (v: V) => void;
}

function SegChoice<V extends string>({ options, active, onChange }: SegChoiceProps<V>) {
  return (
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
        const selected = o.value === active;
        return (
          <button
            key={o.value}
            type="button"
            aria-pressed={selected}
            onClick={() => onChange(o.value)}
            style={{
              padding: "5px 12px",
              fontSize: 12,
              fontFamily: "var(--font-sans)",
              fontWeight: 500,
              color: selected ? "var(--il-text)" : "var(--il-text2)",
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
  );
}

function AccentHueControl({ hue }: { hue: number }) {
  const setAccentHue = useAppStore((s) => s.setAccentHue);

  return (
    <div>
      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        {PRESET_HUES.map((h) => {
          const selected = Math.round(hue) === h;
          return (
            <button
              key={h}
              type="button"
              aria-label={`Accent hue ${h}°`}
              onClick={() => setAccentHue(h)}
              style={{
                width: 22,
                height: 22,
                borderRadius: 4,
                background: `oklch(0.68 0.17 ${h})`,
                border: selected ? "2px solid var(--il-text)" : "1px solid var(--il-border)",
                padding: 0,
                cursor: "pointer",
              }}
            />
          );
        })}
        <button
          type="button"
          onClick={() => setAccentHue(DEFAULT_ACCENT_HUE)}
          className="font-mono uppercase"
          style={{
            marginLeft: 4,
            padding: "4px 8px",
            fontSize: 10.5,
            letterSpacing: "0.06em",
            color: "var(--il-text2)",
            background: "transparent",
            border: "1px solid var(--il-border-soft)",
            borderRadius: 3,
            cursor: "pointer",
          }}
          title="Reset to seed hue"
        >
          reset
        </button>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 14 }}>
        <input
          type="range"
          min={0}
          max={359}
          step={1}
          value={Math.round(hue)}
          onChange={(e) => setAccentHue(Number.parseFloat(e.target.value))}
          aria-label="Accent hue"
          className="il-hue-slider"
          style={{ flex: 1 }}
        />
        <span
          className="font-mono"
          style={{
            fontSize: 10.5,
            color: "var(--il-text2)",
            letterSpacing: "0.04em",
            minWidth: 56,
            textAlign: "right",
            // Tabular figures keep the digits column-locked so the
            //  readout doesn't jiggle horizontally as the user drags
            //  the thumb — per docs/09-ui-and-brand.md §Settings →
            //  Appearance / Primitive details.
            fontVariantNumeric: "tabular-nums",
          }}
        >
          h · {Math.round(hue)}°
        </span>
      </div>
    </div>
  );
}
