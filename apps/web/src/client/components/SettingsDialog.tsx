import { composeBoundariesSection } from "@ironlore/core";
import { LogOut, X } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { useFocusTrap } from "../hooks/useFocusTrap.js";
import {
  type AgentConfigResponse,
  type AgentListEntry,
  activateAgent,
  type EmbeddingsStatus,
  fetchAgentConfig,
  fetchAgents,
  fetchEmbeddingsStatus,
  fetchLibraryTemplates,
  fetchProjects,
  fetchProviders,
  kickEmbeddingsBackfill,
  type LibraryTemplate,
  logout,
  type ProjectListEntry,
  type ProviderSummary,
  saveProviderKey,
  setAgentPaused,
  testProvider,
} from "../lib/api.js";
import { useAIPanelStore } from "../stores/ai-panel.js";
import {
  DEFAULT_ACCENT_HUE,
  type MotifSettings,
  type MotionSetting,
  type SettingsTab,
  type TypeDisplaySetting,
  useAppStore,
} from "../stores/app.js";
import { useAuthStore } from "../stores/auth.js";
import { AgentBuilderDialog } from "./AgentBuilderDialog.js";

type Tab = SettingsTab;

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

  // Active tab is source-of-truth'd in the app store so composer
  //  deep-links (`/ → Switch model`) can jump straight to a specific
  //  category without rendering the dialog first. Persisted per device.
  const activeTab = useAppStore((s) => s.settingsTab);
  const setActiveTab = useAppStore((s) => s.setSettingsTab);

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
           *  · Appearance. All six tabs are wired now. */}
          {(
            [
              ["general", "General"],
              ["providers", "Providers"],
              ["projects", "Projects"],
              ["agents", "Agents"],
              ["security", "Security"],
              ["storage", "Storage"],
              ["appearance", "Appearance"],
            ] as Array<[Tab, string]>
          ).map(([key, label]) => {
            const active = key === activeTab;
            return (
              <button
                key={key}
                type="button"
                onClick={() => setActiveTab(key)}
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
                  cursor: "pointer",
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
              06 / settings
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

          <div className="flex-1 overflow-y-auto" style={{ padding: "32px 48px" }}>
            {activeTab === "general" && <GeneralTab />}
            {activeTab === "providers" && <ProvidersTab />}
            {activeTab === "projects" && <ProjectsTab />}
            {activeTab === "agents" && <AgentsTab />}
            {activeTab === "security" && <SecurityTab />}
            {activeTab === "storage" && <StorageTab />}
            {activeTab === "appearance" && <AppearanceTab />}
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Tab hero — `TAB_TITLE` (Inter 600 26 safe, Instrument Serif 42 +
 * trailing italic `.` under `data-type-display="serif"`) plus a
 * short prose blurb. Matches the canvas grammar in
 * screen-more.jsx ScreenSettings + brand doc §Settings → Appearance
 * hero; every tab uses it so the surface reads as one variant family.
 */
function TabHero({ title, blurb }: { title: string; blurb: string }) {
  const typeDisplay = useAppStore((s) => s.typeDisplay);
  const serif = typeDisplay === "serif";
  return (
    <>
      <h1
        style={{
          fontFamily: serif ? "var(--font-serif)" : "var(--font-sans)",
          fontWeight: serif ? 400 : 600,
          fontSize: serif ? 42 : 26,
          letterSpacing: "-0.025em",
          lineHeight: 1.05,
          margin: "0 0 4px",
          color: "var(--il-text)",
        }}
      >
        {title}
        {serif && <span style={{ fontStyle: "italic", color: "var(--il-text2)" }}>.</span>}
      </h1>
      <p
        style={{
          margin: "0 0 24px",
          fontSize: 13.5,
          color: "var(--il-text2)",
          maxWidth: 520,
        }}
      >
        {blurb}
      </p>
    </>
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
      <TabHero
        title="Appearance"
        blurb="Adjust the visual density, theme, and accent hue. All settings apply instantly and persist per device."
      />

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
      <TabHero
        title="Security"
        blurb="One row per installed agent showing what it can reach — scope globs, writable kinds, declared tools, rate caps, and review mode. Scope itself is authored in each persona's frontmatter; this tab is a read-only audit."
      />

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
  const heartbeat = cfg?.persona?.heartbeat ?? null;

  // Boundaries paragraph — derived from the same structural fields
  //  the runtime gates on, rendered through the shared
  //  composeBoundariesSection helper. Stays coherent with the
  //  persona.md body produced by buildPersona() and seeded agents.
  const boundariesText = cfg
    ? composeBoundariesSection({
        scopePages: pages ?? [],
        canEditPages: (writableKinds ?? []).length > 0,
        reviewBeforeMerge: reviewMode === "inbox",
        heartbeat: heartbeat ?? undefined,
      })
    : null;

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

      {boundariesText && (
        <div
          style={{
            marginTop: 14,
            paddingTop: 12,
            borderTop: "1px solid var(--il-border-soft)",
          }}
        >
          <div
            className="font-mono uppercase"
            style={{
              fontSize: 10,
              letterSpacing: "0.06em",
              color: "var(--il-text3)",
              marginBottom: 6,
            }}
          >
            Boundaries · what this agent will and won't do
          </div>
          <pre
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: 11,
              lineHeight: 1.5,
              color: "var(--il-text2)",
              background: "var(--il-bg)",
              border: "1px solid var(--il-border-soft)",
              borderRadius: 3,
              padding: "8px 10px",
              margin: 0,
              whiteSpace: "pre-wrap",
              maxHeight: 200,
              overflowY: "auto",
            }}
          >
            {boundariesText}
          </pre>
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

/**
 * General tab — app-level preferences that don't fit anywhere else.
 *
 * Rows 01 (default agent) and 02/03 (effort + include-active-file)
 * proxy into the AI panel store so the composer and Settings stay
 * in sync; row 04 (developer mode) lives on the app store and
 * gates the embedded terminal + `Ctrl+\`` shortcut.
 */
function GeneralTab() {
  const defaultAgent = useAppStore((s) => s.defaultAgent);
  const setDefaultAgent = useAppStore((s) => s.setDefaultAgent);
  const devMode = useAppStore((s) => s.devMode);
  const setDevMode = useAppStore((s) => s.setDevMode);
  const effort = useAIPanelStore((s) => s.effort);
  const setEffort = useAIPanelStore((s) => s.setEffort);
  const include = useAIPanelStore((s) => s.includeActiveFileAsContext);
  const setInclude = useAIPanelStore((s) => s.setIncludeActiveFileAsContext);

  const [agents, setAgents] = useState<AgentListEntry[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetchAgents()
      .then((list) => {
        if (!cancelled) setAgents(list);
      })
      .catch(() => {
        if (!cancelled) setAgents([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <>
      <TabHero
        title="General"
        blurb="Defaults that follow you across projects. The AI-panel preferences mirror the composer's own controls — change either surface and the other updates."
      />

      <SettingRow
        n="01"
        label="Default AI agent"
        sub="Seeds the AI panel on boot. You can still switch agents ad-hoc from the panel header."
      >
        {agents === null ? (
          <span style={{ fontSize: 12.5, color: "var(--il-text3)" }}>Loading…</span>
        ) : agents.length === 0 ? (
          <span style={{ fontSize: 12.5, color: "var(--il-text3)" }}>No agents installed yet.</span>
        ) : (
          <SegChoice
            options={agents.map((a) => ({ value: a.slug, label: a.slug }))}
            active={defaultAgent}
            onChange={(v) => setDefaultAgent(v)}
          />
        )}
      </SettingRow>

      <SettingRow
        n="02"
        label="Effort level"
        sub="Forwarded to the agent run as a hint. Low keeps turns short; High allows longer, costlier reasoning."
      >
        <SegChoice
          options={[
            { value: "low", label: "Low" },
            { value: "medium", label: "Medium" },
            { value: "high", label: "High" },
          ]}
          active={effort}
          onChange={(v) => setEffort(v as "low" | "medium" | "high")}
        />
      </SettingRow>

      <SettingRow
        n="03"
        label="Include active file as context"
        sub="When on, the file you're editing is sent to the agent alongside each prompt. Toggle also lives inline on the composer."
      >
        <SegChoice
          options={[
            { value: "on", label: "On" },
            { value: "off", label: "Off" },
          ]}
          active={include ? "on" : "off"}
          onChange={(v) => setInclude(v === "on")}
        />
      </SettingRow>

      <SettingRow
        n="04"
        label="Developer mode"
        sub="Adds the embedded terminal button to the sidebar and the Ctrl+` shortcut. Off by default so the shell stays clean for non-technical users."
      >
        <SegChoice
          options={[
            { value: "off", label: "Off" },
            { value: "on", label: "On" },
          ]}
          active={devMode ? "on" : "off"}
          onChange={(v) => setDevMode(v === "on")}
        />
      </SettingRow>

      <SettingRow
        n="05"
        label="Account"
        sub="Session managed by the server; log out to clear this browser's cookie."
      >
        <AccountRow />
      </SettingRow>
    </>
  );
}

/**
 * Account row — shows the session username and a Log out button.
 * Previously lived on the sidebar's `ProfileTile`; migrated here
 * when the sidebar bottom rail was trimmed (the AppHeader's profile
 * avatar now opens this tab).
 */
function AccountRow() {
  const username = useAuthStore((s) => s.username);
  const [loggingOut, setLoggingOut] = useState(false);
  const onLogout = useCallback(async () => {
    if (loggingOut) return;
    setLoggingOut(true);
    try {
      await logout();
      // Re-check the session so the app flips back to LoginPage
      //  without a hard reload. Don't await — clearSession below
      //  will flip status synchronously if the server already
      //  invalidated the cookie.
      useAuthStore.getState().clearSession();
    } catch {
      /* best-effort — user can try again */
    } finally {
      setLoggingOut(false);
    }
  }, [loggingOut]);
  return (
    <div className="flex items-center gap-3">
      <span style={{ fontSize: 13, color: "var(--il-text)" }}>
        Signed in as{" "}
        <code
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 12,
            color: "var(--il-text2)",
          }}
        >
          {username ?? "—"}
        </code>
      </span>
      <span className="flex-1" />
      <button
        type="button"
        onClick={onLogout}
        disabled={loggingOut}
        className="inline-flex items-center gap-1.5 outline-none focus-visible:ring-1 focus-visible:ring-ironlore-blue/50"
        style={{
          padding: "6px 12px",
          fontSize: 12,
          fontFamily: "var(--font-sans)",
          fontWeight: 500,
          background: "transparent",
          color: "var(--il-text2)",
          border: "1px solid var(--il-border)",
          borderRadius: 3,
          cursor: loggingOut ? "progress" : "pointer",
          opacity: loggingOut ? 0.6 : 1,
        }}
      >
        <LogOut className="h-3.5 w-3.5" />
        {loggingOut ? "Logging out…" : "Log out"}
      </button>
    </div>
  );
}

/**
 * Providers tab — LLM provider credentials + connection status.
 *
 * Lists every known provider (Anthropic, Ollama today) with a
 * live status pip and, per row, an `Edit key` / `Test` pair. Keys
 * are persisted to `<installRoot>/.ironlore/providers.json` with
 * mode 0600 by the server; this tab is the UI front for that
 * store. Full Argon2id-vault encryption is a follow-up — the
 * amber strip below names that limitation honestly so the user
 * can decide whether to configure via env vars instead.
 */
function ProvidersTab() {
  const [providers, setProviders] = useState<ProviderSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const list = await fetchProviders();
      setProviders(list);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <>
      <TabHero
        title="Providers"
        blurb="LLM providers that power your agents. Set an API key to connect a provider, click Test to verify a round-trip, or remove the key to disconnect."
      />

      {/* Honest security note — keys sit in a mode-0600 JSON file,
       *  not in an Argon2id vault. Env vars take precedence when
       *  set, so operators can opt out of the UI path entirely. */}
      <div
        style={{
          borderLeft: "3px solid var(--il-amber)",
          background: "color-mix(in oklch, var(--il-amber) 8%, transparent)",
          padding: "10px 14px",
          borderRadius: "0 3px 3px 0",
          marginBottom: 18,
        }}
      >
        <div
          className="font-mono uppercase"
          style={{ fontSize: 10.5, color: "var(--il-amber)", letterSpacing: "0.08em" }}
        >
          local storage
        </div>
        <p style={{ margin: "4px 0 0", fontSize: 12.5, color: "var(--il-text2)", lineHeight: 1.5 }}>
          Keys are written to{" "}
          <code style={{ fontFamily: "var(--font-mono)", fontSize: 11.5, color: "var(--il-text)" }}>
            .ironlore/providers.json
          </code>{" "}
          with restricted file permissions (mode 0600). Full encryption is a follow-up — for now,
          set{" "}
          <code style={{ fontFamily: "var(--font-mono)", fontSize: 11.5, color: "var(--il-text)" }}>
            ANTHROPIC_API_KEY
          </code>{" "}
          in your shell if you want env-managed credentials instead (takes precedence on boot).
        </p>
      </div>

      {error && (
        <div style={{ fontSize: 12.5, color: "var(--il-red)" }}>
          Failed to load providers: {error}
        </div>
      )}
      {providers === null && !error && (
        <span style={{ fontSize: 12.5, color: "var(--il-text3)" }}>Loading…</span>
      )}
      {providers && (
        <div style={{ display: "grid", gap: 10 }}>
          {providers.map((p) => (
            <ProviderRow
              key={p.name}
              provider={p}
              editing={editing === p.name}
              onEdit={() => setEditing(p.name)}
              onClose={() => setEditing(null)}
              onSaved={(next) => {
                setProviders((prev) =>
                  prev ? prev.map((x) => (x.name === next.name ? next : x)) : prev,
                );
                setEditing(null);
              }}
            />
          ))}
        </div>
      )}
    </>
  );
}

function ProviderRow({
  provider,
  editing,
  onEdit,
  onClose,
  onSaved,
}: {
  provider: ProviderSummary;
  editing: boolean;
  onEdit: () => void;
  onClose: () => void;
  onSaved: (next: ProviderSummary) => void;
}) {
  const [keyDraft, setKeyDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; detail: string } | null>(null);
  const pipColor =
    provider.status === "connected"
      ? "var(--il-green)"
      : provider.status === "needs-key"
        ? "var(--il-text3)"
        : "var(--il-amber)";
  const statusLabel = {
    connected: "connected",
    "needs-key": "needs key",
    unreachable: "unreachable",
  }[provider.status];

  const save = async (value: string) => {
    setSaving(true);
    try {
      const result = await saveProviderKey(provider.name, value);
      onSaved(result.provider);
      setKeyDraft("");
    } catch (err) {
      setTestResult({ ok: false, detail: err instanceof Error ? err.message : String(err) });
    } finally {
      setSaving(false);
    }
  };

  const test = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const result = await testProvider(provider.name);
      setTestResult(result);
    } catch (err) {
      setTestResult({ ok: false, detail: err instanceof Error ? err.message : String(err) });
    } finally {
      setTesting(false);
    }
  };

  return (
    <div
      style={{
        padding: "14px 16px",
        border: "1px solid var(--il-border-soft)",
        borderRadius: 4,
        background: "var(--il-slate-elev)",
      }}
    >
      <div className="flex items-baseline gap-3">
        <span
          aria-hidden="true"
          style={{
            width: 8,
            height: 8,
            borderRadius: "50%",
            background: pipColor,
            marginTop: 2,
          }}
        />
        <span style={{ fontSize: 14, fontWeight: 500, color: "var(--il-text)" }}>
          {provider.name}
        </span>
        <span
          className="font-mono uppercase"
          style={{ fontSize: 10.5, letterSpacing: "0.06em", color: pipColor }}
        >
          {statusLabel}
        </span>
        <span className="flex-1" />
        {provider.name === "anthropic" && !editing && (
          <button
            type="button"
            onClick={onEdit}
            style={{
              padding: "5px 12px",
              fontSize: 12,
              fontFamily: "var(--font-sans)",
              fontWeight: 500,
              background: "transparent",
              color: "var(--il-text2)",
              border: "1px solid var(--il-border)",
              borderRadius: 3,
              cursor: "pointer",
            }}
          >
            {provider.keyConfigured ? "Edit key" : "Add key"}
          </button>
        )}
        <button
          type="button"
          onClick={test}
          disabled={testing}
          style={{
            padding: "5px 12px",
            fontSize: 12,
            fontFamily: "var(--font-sans)",
            fontWeight: 500,
            background: "transparent",
            color: "var(--il-text2)",
            border: "1px solid var(--il-border)",
            borderRadius: 3,
            cursor: testing ? "progress" : "pointer",
            opacity: testing ? 0.6 : 1,
          }}
        >
          {testing ? "Testing…" : "Test"}
        </button>
      </div>

      {editing && (
        <div className="mt-3 flex items-center gap-2">
          <input
            type="password"
            placeholder={provider.keyConfigured ? "(key already saved — replace)" : "sk-ant-…"}
            value={keyDraft}
            onChange={(e) => setKeyDraft(e.target.value)}
            className="outline-none focus-visible:ring-1 focus-visible:ring-ironlore-blue/50"
            style={{
              flex: 1,
              padding: "6px 10px",
              fontFamily: "var(--font-mono)",
              fontSize: 12,
              background: "var(--il-bg)",
              border: "1px solid var(--il-border)",
              borderRadius: 3,
              color: "var(--il-text)",
            }}
          />
          <button
            type="button"
            onClick={() => void save(keyDraft.trim())}
            disabled={saving || keyDraft.trim().length === 0}
            style={{
              padding: "6px 12px",
              fontSize: 12,
              fontFamily: "var(--font-sans)",
              fontWeight: 500,
              background: "var(--il-blue)",
              color: "var(--il-bg)",
              border: "none",
              borderRadius: 3,
              cursor: saving ? "progress" : "pointer",
              opacity: keyDraft.trim().length === 0 ? 0.4 : 1,
              boxShadow: keyDraft.trim().length === 0 ? "none" : "0 0 10px var(--il-blue-glow)",
            }}
          >
            {saving ? "Saving…" : "Save"}
          </button>
          {provider.keyConfigured && (
            <button
              type="button"
              onClick={() => void save("")}
              disabled={saving}
              style={{
                padding: "6px 12px",
                fontSize: 12,
                fontFamily: "var(--font-sans)",
                fontWeight: 500,
                background: "transparent",
                color: "var(--il-red)",
                border: "1px solid color-mix(in oklch, var(--il-red) 40%, transparent)",
                borderRadius: 3,
                cursor: "pointer",
              }}
            >
              Remove
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            style={{
              padding: "6px 12px",
              fontSize: 12,
              fontFamily: "var(--font-sans)",
              fontWeight: 500,
              background: "transparent",
              color: "var(--il-text3)",
              border: "1px solid var(--il-border-soft)",
              borderRadius: 3,
              cursor: "pointer",
            }}
          >
            Cancel
          </button>
        </div>
      )}

      {testResult && (
        <div
          style={{
            marginTop: 10,
            padding: "6px 10px",
            borderRadius: 3,
            fontSize: 12,
            fontFamily: "var(--font-mono)",
            color: testResult.ok ? "var(--il-green)" : "var(--il-red)",
            background: testResult.ok
              ? "color-mix(in oklch, var(--il-green) 10%, transparent)"
              : "color-mix(in oklch, var(--il-red) 10%, transparent)",
            border: `1px solid ${
              testResult.ok
                ? "color-mix(in oklch, var(--il-green) 40%, transparent)"
                : "color-mix(in oklch, var(--il-red) 40%, transparent)"
            }`,
          }}
        >
          {testResult.detail}
        </div>
      )}

      {provider.models.length > 0 && (
        <div
          className="mt-3 font-mono"
          style={{
            fontSize: 11,
            color: "var(--il-text3)",
            letterSpacing: "0.02em",
            lineHeight: 1.6,
          }}
        >
          models: {provider.models.slice(0, 6).join(" · ")}
          {provider.models.length > 6 && ` · +${provider.models.length - 6}`}
        </div>
      )}
    </div>
  );
}

/**
 * Projects tab — single-install multi-project scoreboard. Shows the
 * current project as a card, a button that re-opens the ⌘P switcher,
 * and a read-only list of every installed project. Project creation
 * stays in the CLI (`ironlore new-project …`) — no HTTP endpoint
 * yet.
 */
function ProjectsTab() {
  const currentProjectId = useAppStore((s) => s.currentProjectId);
  const toggleSwitcher = useAppStore((s) => s.toggleProjectSwitcher);
  const [projects, setProjects] = useState<ProjectListEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchProjects()
      .then((list) => {
        if (!cancelled) setProjects(list);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const current = projects?.find((p) => p.id === currentProjectId) ?? null;

  return (
    <>
      <TabHero
        title="Projects"
        blurb="Every installed project lives under the same Ironlore root. Use ⌘P to switch quickly; new projects are scaffolded from the CLI."
      />

      <SettingRow n="01" label="Current project">
        {current ? (
          <div
            style={{
              padding: "10px 12px",
              background: "var(--il-slate-elev)",
              border: "1px solid var(--il-border-soft)",
              borderRadius: 4,
            }}
          >
            <div style={{ fontSize: 14, fontWeight: 500, color: "var(--il-text)" }}>
              {current.name}
            </div>
            <div
              className="font-mono"
              style={{
                fontSize: 10.5,
                letterSpacing: "0.04em",
                color: "var(--il-text3)",
                marginTop: 3,
              }}
            >
              {current.id} · {current.preset} · created {formatProjectDate(current.createdAt)}
            </div>
          </div>
        ) : (
          <span style={{ fontSize: 12.5, color: "var(--il-text3)" }}>Loading…</span>
        )}
      </SettingRow>

      <SettingRow n="02" label="Switch project" sub="Opens the ⌘P palette.">
        <button
          type="button"
          onClick={() => {
            useAppStore.getState().toggleSettings();
            toggleSwitcher();
          }}
          style={{
            padding: "6px 14px",
            fontSize: 12.5,
            fontFamily: "var(--font-sans)",
            fontWeight: 500,
            background: "var(--il-blue)",
            color: "var(--il-bg)",
            border: "none",
            borderRadius: 3,
            cursor: "pointer",
            boxShadow: "0 0 10px var(--il-blue-glow)",
          }}
        >
          Open switcher
        </button>
      </SettingRow>

      <SettingRow
        n="03"
        label="All projects"
        sub="Click any row to switch projects. Creation is CLI-only for now — run `ironlore new-project <id> --preset main|research|sandbox`."
      >
        {error && (
          <div style={{ fontSize: 12.5, color: "var(--il-red)" }}>
            Failed to load projects: {error}
          </div>
        )}
        {projects === null && !error && (
          <span style={{ fontSize: 12.5, color: "var(--il-text3)" }}>Loading…</span>
        )}
        {projects && (
          <div style={{ display: "grid", gap: 6 }}>
            {projects.map((p) => {
              const active = p.id === currentProjectId;
              return (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => {
                    if (active) return;
                    // Hard reload matches ProjectSwitcher's commit path.
                    const url = new URL(window.location.href);
                    url.searchParams.set("project", p.id);
                    window.location.assign(url.toString());
                  }}
                  style={{
                    display: "grid",
                    gridTemplateColumns: "1fr auto auto",
                    alignItems: "center",
                    gap: 10,
                    padding: "8px 12px",
                    background: active
                      ? "color-mix(in oklch, var(--il-blue) 10%, transparent)"
                      : "var(--il-slate)",
                    border: `1px solid ${active ? "var(--il-blue)" : "var(--il-border-soft)"}`,
                    borderLeft: `2px solid ${active ? "var(--il-blue)" : "transparent"}`,
                    borderRadius: 3,
                    textAlign: "left",
                    cursor: active ? "default" : "pointer",
                  }}
                >
                  <div>
                    <div style={{ fontSize: 13, color: "var(--il-text)" }}>{p.name}</div>
                    <div
                      className="font-mono"
                      style={{
                        fontSize: 10.5,
                        color: "var(--il-text3)",
                        letterSpacing: "0.04em",
                        marginTop: 2,
                      }}
                    >
                      {p.id}
                    </div>
                  </div>
                  <span
                    className="font-mono uppercase"
                    style={{
                      fontSize: 10.5,
                      letterSpacing: "0.06em",
                      color: "var(--il-text3)",
                      padding: "1px 6px",
                      border: "1px solid var(--il-border-soft)",
                      borderRadius: 2,
                    }}
                  >
                    {p.preset}
                  </span>
                  {active && (
                    <span
                      className="font-mono uppercase"
                      style={{
                        fontSize: 10.5,
                        letterSpacing: "0.06em",
                        color: "var(--il-blue)",
                      }}
                    >
                      active
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        )}
      </SettingRow>
    </>
  );
}

function formatProjectDate(iso: string): string {
  try {
    const d = new Date(iso);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  } catch {
    return iso;
  }
}

/**
 * Agents tab — operational view of every installed agent. Shows
 * slug + status pip, rate caps, review mode, and two controls:
 * pause/resume (mutates `agent_state` via
 * `PATCH /agents/:slug/state`) and "Open detail" (sets
 * `activeAgentSlug` and closes the dialog).
 *
 * This tab is the operator's day-to-day view; the Security tab is
 * the scope-audit view of the same agents. Overlap is intentional —
 * different questions, same data.
 */
function AgentsTab() {
  const [agents, setAgents] = useState<AgentListEntry[] | null>(null);
  const [configs, setConfigs] = useState<Record<string, AgentConfigResponse | "error">>({});
  const [library, setLibrary] = useState<LibraryTemplate[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Local pause-state mirror so the toggle responds instantly; the
  //  next `fetchAgents()` pass will rehydrate from the server.
  const [pausedLocal, setPausedLocal] = useState<Record<string, boolean>>({});
  // Per-row activation state: slug currently being activated + the
  // last activation error per slug, surfaced inline rather than as a
  // toast so the mistake stays anchored to the card it came from.
  const [activating, setActivating] = useState<string | null>(null);
  const [activateErr, setActivateErr] = useState<Record<string, string>>({});
  // Visual Agent Builder modal — Phase-11 A.9.1.
  const [builderOpen, setBuilderOpen] = useState(false);

  const reload = useCallback(async () => {
    try {
      const [list, templates] = await Promise.all([fetchAgents(), fetchLibraryTemplates()]);
      setAgents(list);
      setLibrary(templates);
      setPausedLocal(Object.fromEntries(list.map((a) => [a.slug, a.status === "paused"])));
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
      setConfigs(Object.fromEntries(entries));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (cancelled) return;
      await reload();
    })();
    return () => {
      cancelled = true;
    };
  }, [reload]);

  const handleToggle = async (slug: string) => {
    const next = !pausedLocal[slug];
    setPausedLocal((prev) => ({ ...prev, [slug]: next }));
    try {
      await setAgentPaused(slug, next);
    } catch {
      // Revert on failure; caller sees a stale toggle for one tick.
      setPausedLocal((prev) => ({ ...prev, [slug]: !next }));
    }
  };

  const handleActivate = async (slug: string) => {
    if (activating) return; // one activation at a time
    setActivating(slug);
    setActivateErr((prev) => {
      const { [slug]: _, ...rest } = prev;
      return rest;
    });
    try {
      await activateAgent(slug);
      await reload();
      useAppStore.getState().toggleSettings();
      useAppStore.getState().setActiveAgentSlug(slug);
    } catch (err) {
      setActivateErr((prev) => ({
        ...prev,
        [slug]: err instanceof Error ? err.message : String(err),
      }));
    } finally {
      setActivating(null);
    }
  };

  return (
    <>
      <TabHero
        title="Agents"
        blurb="Pause or resume installed agents and jump to each detail page. Activate a library template to add it to this project. Scope is audited on the Security tab."
      />

      {error && (
        <div style={{ fontSize: 12.5, color: "var(--il-red)" }}>Failed to load agents: {error}</div>
      )}
      {agents === null && !error && (
        <span style={{ fontSize: 12.5, color: "var(--il-text3)" }}>Loading…</span>
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

      {agents && agents.length > 0 && <SectionLabel>Installed</SectionLabel>}
      <div style={{ display: "grid", gap: 10 }}>
        {agents?.map((a) => {
          const cfg = configs[a.slug];
          const loaded = cfg && cfg !== "error" ? cfg : null;
          const paused = pausedLocal[a.slug] ?? a.status === "paused";
          return (
            <div
              key={a.slug}
              style={{
                display: "grid",
                gridTemplateColumns: "1fr auto auto",
                gap: 14,
                alignItems: "center",
                padding: "12px 14px",
                background: "var(--il-slate-elev)",
                border: "1px solid var(--il-border-soft)",
                borderRadius: 4,
              }}
            >
              <div>
                <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                  <StatusChip status={paused ? "paused" : "active"} pauseReason={null} />
                  <span style={{ fontSize: 14, fontWeight: 500, color: "var(--il-text)" }}>
                    {a.slug}
                  </span>
                </div>
                {loaded && (
                  <div
                    className="font-mono"
                    style={{
                      fontSize: 10.5,
                      letterSpacing: "0.04em",
                      color: "var(--il-text3)",
                      marginTop: 4,
                    }}
                  >
                    {loaded.maxRunsPerHour}/hr · {loaded.maxRunsPerDay}/day · review{" "}
                    {loaded.persona?.reviewMode ?? "—"}
                  </div>
                )}
                {cfg === "error" && (
                  <div style={{ fontSize: 11.5, color: "var(--il-red)", marginTop: 3 }}>
                    Failed to load config.
                  </div>
                )}
              </div>
              <button
                type="button"
                onClick={() => handleToggle(a.slug)}
                style={{
                  padding: "5px 12px",
                  fontSize: 12,
                  fontFamily: "var(--font-sans)",
                  fontWeight: 500,
                  background: paused ? "var(--il-blue)" : "transparent",
                  color: paused ? "var(--il-bg)" : "var(--il-text2)",
                  border: paused ? "none" : "1px solid var(--il-border)",
                  borderRadius: 3,
                  cursor: "pointer",
                }}
              >
                {paused ? "Resume" : "Pause"}
              </button>
              <button
                type="button"
                onClick={() => {
                  useAppStore.getState().toggleSettings();
                  useAppStore.getState().setActiveAgentSlug(a.slug);
                }}
                style={{
                  padding: "5px 12px",
                  fontSize: 12,
                  fontFamily: "var(--font-sans)",
                  fontWeight: 500,
                  background: "transparent",
                  color: "var(--il-text2)",
                  border: "1px solid var(--il-border)",
                  borderRadius: 3,
                  cursor: "pointer",
                }}
              >
                Open detail
              </button>
            </div>
          );
        })}
      </div>

      {/* Visual Agent Builder — Phase-11 A.9.1 entry point. The
       *  dialog compiles plain-English form inputs into a properly-
       *  shaped persona.md so non-technical users don't have to
       *  edit YAML by hand. Clicking "Build a custom agent" opens
       *  the modal; on success we reload the agent list so the
       *  newly-built agent appears alongside library activations. */}
      <div style={{ marginTop: 18, marginBottom: 8, display: "flex", alignItems: "center" }}>
        <SectionLabel>Custom</SectionLabel>
        <span style={{ flex: 1 }} />
        <button
          type="button"
          onClick={() => setBuilderOpen(true)}
          className="rounded border border-ironlore-blue/50 px-2 py-0.5 text-[10px] font-medium text-ironlore-blue hover:bg-ironlore-blue/15"
        >
          Build a custom agent
        </button>
      </div>
      <p style={{ fontSize: 10.5, color: "var(--il-text3)", lineHeight: 1.5, marginBottom: 12 }}>
        Skip the library — describe an agent's role and constraints in plain English, and the
        builder writes the persona file for you.
      </p>

      {builderOpen && (
        <AgentBuilderDialog
          onClose={() => setBuilderOpen(false)}
          onCreated={(slug: string) => {
            void reload();
            setActivateErr((prev) => {
              const next = { ...prev };
              delete next[slug];
              return next;
            });
          }}
        />
      )}

      {library && library.length > 0 && (
        <>
          <SectionLabel>Library</SectionLabel>
          <div style={{ display: "grid", gap: 10 }}>
            {library.map((t) => (
              <LibraryTemplateRow
                key={t.slug}
                template={t}
                activating={activating === t.slug}
                disabled={activating !== null && activating !== t.slug}
                error={activateErr[t.slug] ?? null}
                onActivate={() => handleActivate(t.slug)}
              />
            ))}
          </div>
        </>
      )}
    </>
  );
}

function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <div
      className="font-mono"
      style={{
        fontSize: 10.5,
        letterSpacing: "0.08em",
        textTransform: "uppercase",
        color: "var(--il-text3)",
        marginTop: 18,
        marginBottom: 8,
      }}
    >
      {children}
    </div>
  );
}

function LibraryTemplateRow({
  template,
  activating,
  disabled,
  error,
  onActivate,
}: {
  template: LibraryTemplate;
  activating: boolean;
  disabled: boolean;
  error: string | null;
  onActivate: () => void;
}) {
  const heading = template.name ?? template.slug;
  const meta = [template.department, template.heartbeat].filter(Boolean).join(" · ");
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "1fr auto",
        gap: 14,
        alignItems: "center",
        padding: "12px 14px",
        background: "var(--il-slate-elev)",
        border: "1px solid var(--il-border-soft)",
        borderRadius: 4,
        // Muted rail on the left so the library section reads as
        // "not live yet" next to the installed section above.
        borderLeft: "2px solid var(--il-border)",
      }}
    >
      <div>
        <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
          {template.emoji && (
            <span style={{ fontSize: 14, lineHeight: 1 }} aria-hidden="true">
              {template.emoji}
            </span>
          )}
          <span style={{ fontSize: 14, fontWeight: 500, color: "var(--il-text)" }}>{heading}</span>
          <span
            className="font-mono"
            style={{
              fontSize: 10,
              letterSpacing: "0.08em",
              textTransform: "uppercase",
              color: "var(--il-text3)",
            }}
          >
            {template.slug}
          </span>
        </div>
        {template.description && (
          <div style={{ fontSize: 12.5, color: "var(--il-text2)", marginTop: 3 }}>
            {template.description}
          </div>
        )}
        {meta && (
          <div
            className="font-mono"
            style={{
              fontSize: 10.5,
              letterSpacing: "0.04em",
              color: "var(--il-text3)",
              marginTop: 4,
            }}
          >
            {meta}
          </div>
        )}
        {error && (
          <div style={{ fontSize: 11.5, color: "var(--il-red)", marginTop: 3 }}>{error}</div>
        )}
      </div>
      <button
        type="button"
        onClick={onActivate}
        disabled={activating || disabled}
        style={{
          padding: "5px 12px",
          fontSize: 12,
          fontFamily: "var(--font-sans)",
          fontWeight: 500,
          background: "var(--il-blue)",
          color: "var(--il-bg)",
          border: "none",
          borderRadius: 3,
          boxShadow: "0 0 10px var(--il-blue-glow)",
          cursor: activating || disabled ? "default" : "pointer",
          opacity: disabled && !activating ? 0.45 : 1,
        }}
      >
        {activating ? "Activating…" : "Activate"}
      </button>
    </div>
  );
}

/**
 * Storage tab — minimal today. The six maintenance verbs
 * (reindex · flush · repair · backup · restore · eval) still live in
 * the CLI; wiring them into the UI is tracked as a separate task.
 * This tab surfaces the project root, a link to the CLI commands,
 * and a copy affordance per command so users don't have to retype
 * the project flag.
 */
function StorageTab() {
  const currentProjectId = useAppStore((s) => s.currentProjectId);
  const commands: Array<[string, string]> = [
    ["Reindex search", `ironlore reindex --project ${currentProjectId}`],
    ["Flush pending writes", `ironlore flush --project ${currentProjectId}`],
    ["Integrity check", `ironlore repair --project ${currentProjectId} --dry-run`],
    ["Create backup", `ironlore backup --project ${currentProjectId}`],
    ["Restore from backup", `ironlore restore --project ${currentProjectId} <archive.tar.gz>`],
    ["Performance scorecard", `ironlore eval --project ${currentProjectId} --json`],
  ];

  return (
    <>
      <TabHero
        title="Storage"
        blurb="Project root on disk and the CLI commands that maintain it. One-click UI wiring for these verbs is on the roadmap; until then, copy the command you need."
      />

      <SettingRow n="01" label="Project root">
        <code
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 11.5,
            padding: "5px 8px",
            background: "var(--il-slate-elev)",
            border: "1px solid var(--il-border-soft)",
            borderRadius: 3,
            color: "var(--il-text2)",
          }}
        >
          projects/{currentProjectId}/
        </code>
      </SettingRow>

      <SettingRow
        n="02"
        label="Maintenance commands"
        sub="Run from a terminal at the Ironlore install root. Each row copies the full command (including the current project flag) to your clipboard."
      >
        <div style={{ display: "grid", gap: 6 }}>
          {commands.map(([label, cmd]) => (
            <CommandRow key={label} label={label} cmd={cmd} />
          ))}
        </div>
      </SettingRow>

      <SettingRow
        n="03"
        label="Embeddings (hybrid retrieval)"
        sub="Phase-11 vector index. Surfaces only when an embedding provider is configured (OpenAI key in Providers, or a local Ollama embedding model). Backfill runs in the background; the button below kicks a synchronous drain you can watch progress on."
      >
        <EmbeddingsCard />
      </SettingRow>
    </>
  );
}

/**
 * Embeddings status card on the Storage tab. Polls
 * `/api/projects/<id>/embeddings/status` every 5 seconds while
 * the dialog is open so the worker's background progress shows
 * live; the Backfill button drives a synchronous tick loop the
 * user can pin to.
 *
 * Renders four states:
 *   - `null` (no provider configured) → muted "connect a provider" hint
 *   - `total === 0` → empty-vault hint
 *   - `missing > 0` → progress + Backfill button
 *   - `missing === 0` → "Up to date" with model + dims chip
 */
function EmbeddingsCard() {
  const [status, setStatus] = useState<EmbeddingsStatus | null | "loading">("loading");
  const [draining, setDraining] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const next = await fetchEmbeddingsStatus();
      setStatus(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void reload();
    // Poll-based refresh — cheap (one SQL count) and avoids
    // wiring a WS topic for a Settings panel the user only opens
    // occasionally.
    const id = setInterval(() => {
      void reload();
    }, 5000);
    return () => clearInterval(id);
  }, [reload]);

  const handleBackfill = useCallback(async () => {
    setDraining(true);
    setError(null);
    try {
      // Loop synchronous ticks until remaining hits zero or one
      // tick reports zero progress (= every input failed; bail).
      // Each tick processes the worker's batch size (~32 chunks).
      let lastProcessed = -1;
      while (true) {
        const result = await kickEmbeddingsBackfill();
        if (!result) break;
        if (result.processed === 0 && lastProcessed === 0) break;
        lastProcessed = result.processed;
        await reload();
        if (result.remaining === 0) break;
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setDraining(false);
    }
  }, [reload]);

  if (status === "loading") {
    return (
      <div style={{ fontSize: 12.5, color: "var(--il-text3)" }}>Loading embedding status…</div>
    );
  }

  if (status === null) {
    return (
      <div
        style={{
          padding: "10px 12px",
          background: "var(--il-slate)",
          border: "1px dashed var(--il-border-soft)",
          borderRadius: 3,
          fontSize: 12.5,
          color: "var(--il-text2)",
        }}
      >
        No embedding provider configured. Add an OpenAI key in <strong>Providers</strong>, or
        install a local embedding model in Ollama (<code>nomic-embed-text</code>,{" "}
        <code>mxbai-embed-large</code>, or <code>all-minilm</code>) and restart the server.
      </div>
    );
  }

  const pct = status.total === 0 ? 100 : Math.round((status.embedded / status.total) * 100);

  return (
    <div
      style={{
        display: "grid",
        gap: 10,
        padding: "12px 14px",
        background: "var(--il-slate)",
        border: "1px solid var(--il-border-soft)",
        borderRadius: 3,
      }}
    >
      <div style={{ display: "grid", gridTemplateColumns: "auto 1fr auto", gap: 12 }}>
        <span style={{ fontSize: 12, color: "var(--il-text3)" }}>Coverage</span>
        <div
          // Progress bar — single track + amber fill scaled to
          // (embedded / total). 100% paints in green so the
          // "done" state is visually distinct.
          aria-label={`${status.embedded} of ${status.total} chunks embedded (${pct}%)`}
          role="progressbar"
          aria-valuenow={pct}
          aria-valuemin={0}
          aria-valuemax={100}
          style={{
            position: "relative",
            height: 8,
            background: "var(--il-slate-elev)",
            borderRadius: 2,
            overflow: "hidden",
          }}
        >
          <div
            style={{
              position: "absolute",
              left: 0,
              top: 0,
              bottom: 0,
              width: `${pct}%`,
              background: pct === 100 ? "var(--il-green)" : "var(--il-amber)",
              transition: "width var(--motion-transit) ease",
            }}
          />
        </div>
        <span
          style={{ fontSize: 12, color: "var(--il-text2)", fontVariantNumeric: "tabular-nums" }}
        >
          {status.embedded} / {status.total}
        </span>
      </div>

      <div
        style={{
          display: "flex",
          gap: 12,
          flexWrap: "wrap",
          fontSize: 11.5,
          color: "var(--il-text3)",
        }}
      >
        <span>
          model: <strong style={{ color: "var(--il-text2)" }}>{status.model}</strong>
        </span>
        <span>
          dims: <strong style={{ color: "var(--il-text2)" }}>{status.dims}</strong>
        </span>
        {status.mismatched > 0 && (
          <span style={{ color: "var(--il-amber)" }}>
            {status.mismatched} stale (model swap — reindex recommended)
          </span>
        )}
        <span style={{ color: status.running ? "var(--il-green)" : "var(--il-text3)" }}>
          worker: {status.running ? "live" : "stopped"}
        </span>
      </div>

      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <button
          type="button"
          onClick={handleBackfill}
          disabled={draining || status.missing === 0}
          style={{
            padding: "5px 12px",
            fontSize: 12,
            fontFamily: "var(--font-sans)",
            fontWeight: 500,
            background: draining
              ? "var(--il-slate-elev)"
              : status.missing === 0
                ? "var(--il-slate-elev)"
                : "var(--il-blue)",
            color: status.missing === 0 ? "var(--il-text3)" : "var(--il-bg)",
            border: "none",
            borderRadius: 3,
            cursor: draining || status.missing === 0 ? "default" : "pointer",
          }}
        >
          {draining ? "Backfilling…" : status.missing === 0 ? "Up to date" : "Backfill now"}
        </button>
        {status.missing > 0 && (
          <span style={{ fontSize: 11.5, color: "var(--il-text3)" }}>
            {status.missing} chunks pending
          </span>
        )}
        {error && <span style={{ fontSize: 11.5, color: "var(--il-red)" }}>{error}</span>}
      </div>
    </div>
  );
}

function CommandRow({ label, cmd }: { label: string; cmd: string }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(cmd);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      /* clipboard denied — silently ignore */
    }
  };
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "160px 1fr auto",
        gap: 12,
        alignItems: "center",
        padding: "8px 12px",
        background: "var(--il-slate)",
        border: "1px solid var(--il-border-soft)",
        borderRadius: 3,
      }}
    >
      <span style={{ fontSize: 13, color: "var(--il-text)" }}>{label}</span>
      <code
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: 11,
          color: "var(--il-text2)",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {cmd}
      </code>
      <button
        type="button"
        onClick={handleCopy}
        className="font-mono uppercase"
        style={{
          padding: "3px 8px",
          fontSize: 10.5,
          letterSpacing: "0.06em",
          color: copied ? "var(--il-green)" : "var(--il-text3)",
          background: "transparent",
          border: "1px solid var(--il-border-soft)",
          borderRadius: 2,
          cursor: "pointer",
        }}
      >
        {copied ? "copied" : "copy"}
      </button>
    </div>
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
        {/* `[NN]` bracketed index — matches the new SectionLabel
         *  grammar so numbering reads the same everywhere in the
         *  product. Size bumped from 10.5 → 13.5 and fontWeight 400
         *  so it carries the same hierarchy as the Home surface's
         *  `[01] Active runs`. */}
        <div
          className="font-mono"
          style={{
            fontSize: 13.5,
            fontWeight: 400,
            color: "var(--il-text3)",
            letterSpacing: "0.04em",
            marginBottom: 2,
            fontVariantNumeric: "tabular-nums",
          }}
        >
          [{n}]
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
