import { ArrowRight, FolderInput, PencilLine, Upload } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Key, Reuleaux, Venn } from "./primitives/index.js";

/**
 * First-run Onboarding — five guided screens that end inside a live
 * agent surface, not a "you're done" card. See screen-more.jsx
 * ScreenOnboarding + the attached spec prose for the target
 * silhouette. Principles carried across every step:
 *
 *   1. Never a blank field — every step pre-fills a smart default.
 *      The user confirms, they don't configure from scratch.
 *   2. Show the boundary — amber "what happens next" callouts
 *      appear before any agent gets write access.
 *   3. End in the product — step 05 is the first real surface,
 *      already live.
 *
 * Headings throughout use Instrument Serif regardless of the user's
 * `data-type-display` preference: onboarding is the marquee and
 * the silhouette is intentional. The main app respects the
 * user's choice after they land.
 */

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** Five writing-category scopes from step 02. */
export type ScopeKey =
  | "engineering"
  | "meeting-notes"
  | "customer-research"
  | "marketing-copy"
  | "runbooks";

interface ScopeDef {
  key: ScopeKey;
  label: string;
}

const SCOPES: ScopeDef[] = [
  { key: "engineering", label: "Engineering specs & RFCs" },
  { key: "meeting-notes", label: "Meeting notes & summaries" },
  { key: "customer-research", label: "Customer research reports" },
  { key: "marketing-copy", label: "Marketing & product copy" },
  { key: "runbooks", label: "Runbooks & operational docs" },
];

/**
 * Mapping from a scope to the agent the onboarding surface will
 * suggest in the WILL-SEED rail + step 03. Each agent carries a
 * canonical accent colour (`--il-*` token) so the left rail on a
 * card reads as signature — the user learns "blue = spec-reviewer"
 * once and the mental model sticks across the app.
 */
interface AgentSuggestion {
  slug: string;
  /** Accent colour for left rail / pip. */
  color: string;
  /** One-sentence description surfaced on step 03 + hover. */
  description: string;
  /** Tool chips shown on the agent card. */
  tools: string[];
}

const SCOPE_TO_AGENT: Record<ScopeKey, AgentSuggestion> = {
  engineering: {
    slug: "spec-reviewer",
    color: "var(--il-blue)",
    description:
      "Reviews RFCs and engineering specs for contradictions. Flags stale cross-references.",
    tools: ["kb.read", "kb.replace", "inbox"],
  },
  "meeting-notes": {
    slug: "meeting-scribe",
    color: "var(--il-violet)",
    description:
      "Summarizes Google Calendar meetings into meetings/YYYY-MM-DD.md. Links actions back to specs.",
    tools: ["cal.read", "kb.add"],
  },
  "customer-research": {
    slug: "research-synth",
    color: "var(--il-amber)",
    description: "Synthesizes interviews into a living research journal with tagged insight cards.",
    tools: ["kb.read", "kb.add"],
  },
  "marketing-copy": {
    slug: "copy-editor",
    color: "var(--il-green)",
    description: "Tunes tone + length on drafts. Flags off-brand language against the style guide.",
    tools: ["kb.read", "kb.replace"],
  },
  runbooks: {
    slug: "runbook-keeper",
    color: "var(--il-text3)",
    description: "Keeps runbooks in lockstep with the deployment manifest. Nudges on drift.",
    tools: ["kb.read", "kb.replace", "ops.diff"],
  },
};

/** Fallback pair so step 02 → 03 always lands non-empty (never-blank principle). */
const DEFAULT_SCOPES: ScopeKey[] = ["engineering", "meeting-notes"];

interface OnboardingState {
  step: 0 | 1 | 2 | 3 | 4;
  selectedScopes: Set<ScopeKey>;
  seedChoice: "drop" | "paste" | "notion" | "skipped" | null;
}

// ---------------------------------------------------------------------------
// Shell
// ---------------------------------------------------------------------------

export interface OnboardingCompletion {
  selectedScopes: ScopeKey[];
  acceptedAgents: string[];
  seedChoice: OnboardingState["seedChoice"];
}

interface OnboardingWizardProps {
  onComplete: (state: OnboardingCompletion) => void;
  onSkip: () => void;
}

export function OnboardingWizard({ onComplete, onSkip }: OnboardingWizardProps) {
  const [state, setState] = useState<OnboardingState>({
    step: 0,
    selectedScopes: new Set(),
    seedChoice: null,
  });

  // Scopes actually seeded into step 03 — resolves the "never blank"
  //  rule. If the user checked nothing, we advance with the default
  //  pair so the agent cards are never empty.
  const resolvedScopes: ScopeKey[] = useMemo(() => {
    const arr = Array.from(state.selectedScopes);
    return arr.length > 0 ? arr : DEFAULT_SCOPES;
  }, [state.selectedScopes]);

  const suggestedAgents = useMemo(
    () => resolvedScopes.map((k) => SCOPE_TO_AGENT[k]),
    [resolvedScopes],
  );

  const goNext = useCallback(() => {
    setState((s) => ({ ...s, step: Math.min(4, s.step + 1) as OnboardingState["step"] }));
  }, []);
  const goBack = useCallback(() => {
    setState((s) => ({ ...s, step: Math.max(0, s.step - 1) as OnboardingState["step"] }));
  }, []);

  const toggleScope = useCallback((key: ScopeKey) => {
    setState((s) => {
      const next = new Set(s.selectedScopes);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return { ...s, selectedScopes: next };
    });
  }, []);

  const finish = useCallback(() => {
    onComplete({
      selectedScopes: Array.from(state.selectedScopes),
      acceptedAgents: suggestedAgents.map((a) => a.slug),
      seedChoice: state.seedChoice,
    });
  }, [onComplete, state.selectedScopes, state.seedChoice, suggestedAgents]);

  // ── Global shortcuts ────────────────────────────────────────────
  // `Enter` advances (except on step 02 where the checklist has
  //  focus) via each step's own `Continue` / `Accept` CTA; no global
  //  binding. `S` skips the seed step (spec hint). The witness step
  //  binds `Enter` to the primary "Open workspace" CTA.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (state.step === 3 && (e.key === "s" || e.key === "S")) {
        const target = e.target as HTMLElement | null;
        if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;
        e.preventDefault();
        setState((s) => ({ ...s, seedChoice: "skipped", step: 4 }));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [state.step]);

  return (
    <div
      className="flex h-full flex-col"
      style={{ background: "var(--il-bg)", color: "var(--il-text)" }}
    >
      <HeaderBar step={state.step} />

      <div className="flex-1 overflow-hidden">
        {state.step === 0 && <StepWelcome onBegin={goNext} />}
        {state.step === 1 && (
          <StepScope
            selected={state.selectedScopes}
            onToggle={toggleScope}
            onBack={goBack}
            onContinue={goNext}
          />
        )}
        {state.step === 2 && (
          <StepAgents agents={suggestedAgents} onBack={goBack} onAccept={goNext} />
        )}
        {state.step === 3 && (
          <StepSeed
            onBack={goBack}
            onContinue={() => {
              setState((s) => ({ ...s, seedChoice: s.seedChoice ?? "skipped" }));
              goNext();
            }}
            onSkip={() => {
              setState((s) => ({ ...s, seedChoice: "skipped" }));
              goNext();
            }}
            onPick={(choice) => setState((s) => ({ ...s, seedChoice: choice }))}
            choice={state.seedChoice}
          />
        )}
        {state.step === 4 && (
          <StepWitness
            primaryAgent={suggestedAgents[0]?.slug ?? "spec-reviewer"}
            onOpenWorkspace={finish}
            onKeepWatching={onSkip}
          />
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Header (progress bar spanning full width)
// ---------------------------------------------------------------------------

function HeaderBar({ step }: { step: number }) {
  return (
    <header
      className="flex items-center gap-3"
      style={{
        height: 44,
        padding: "0 18px",
        borderBottom: "1px solid var(--il-border-soft)",
      }}
    >
      {/* Decorative traffic-light dots — same placement as the
       *  WindowChrome mock so the onboarding shell reads as a
       *  standalone window even though we don't own the frame. */}
      <div className="flex gap-1.5" aria-hidden="true">
        <span
          style={{ width: 10, height: 10, borderRadius: "50%", background: "var(--il-text4)" }}
        />
        <span
          style={{ width: 10, height: 10, borderRadius: "50%", background: "var(--il-text4)" }}
        />
        <span
          style={{ width: 10, height: 10, borderRadius: "50%", background: "var(--il-text4)" }}
        />
      </div>

      {/* 5-segment progress bar — flex:1 strip so it fills the
       *  header width. Completed and current segments fill blue; the
       *  rest stay border-muted. */}
      <div className="flex flex-1 gap-1.5" aria-hidden="true">
        {Array.from({ length: 5 }).map((_, i) => (
          <span
            // biome-ignore lint/suspicious/noArrayIndexKey: fixed-length progress row
            key={i}
            style={{
              flex: 1,
              height: 2,
              borderRadius: 1,
              background: i <= step ? "var(--il-blue)" : "var(--il-border)",
              transition: "background var(--motion-transit) ease",
            }}
          />
        ))}
      </div>

      <span
        className="font-mono uppercase"
        style={{ fontSize: 10.5, letterSpacing: "0.08em", color: "var(--il-text3)" }}
      >
        step {String(step + 1).padStart(2, "0")} / 05
        {step === 4 && <span style={{ color: "var(--il-green)" }}> · complete</span>}
      </span>
    </header>
  );
}

// ---------------------------------------------------------------------------
// Shared step helpers
// ---------------------------------------------------------------------------

/**
 * Step-level mono overline (`NN · THEME`). All onboarding steps
 * start with one so the user always knows where they are without
 * reading the heading.
 */
function StepOverline({ n, theme }: { n: string; theme: string }) {
  return (
    <div
      className="font-mono uppercase"
      style={{
        fontSize: 11,
        color: "var(--il-text3)",
        letterSpacing: "0.08em",
        marginBottom: 14,
      }}
    >
      <span style={{ color: "var(--il-text4)" }}>{n}</span>{" "}
      <span style={{ color: "var(--il-text4)" }}>·</span> {theme}
    </div>
  );
}

/**
 * Serif hero heading — Instrument Serif 38/44 with an optional
 * italic clause rendered on `--il-text2` so the eye catches the
 * qualifier. Onboarding is unconditionally serif per spec; the rest
 * of the app respects `data-type-display`.
 */
function SerifHeading({ children }: { children: React.ReactNode }) {
  return (
    <h1
      style={{
        fontFamily: "var(--font-display)",
        fontWeight: 400,
        fontSize: 40,
        letterSpacing: "-0.02em",
        lineHeight: 1.1,
        margin: 0,
        color: "var(--il-text)",
      }}
    >
      {children}
    </h1>
  );
}

function SerifItalic({ children }: { children: React.ReactNode }) {
  return <span style={{ fontStyle: "italic", color: "var(--il-text2)" }}>{children}</span>;
}

function PrimaryButton({
  children,
  onClick,
  disabled,
  kbd,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  kbd?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="inline-flex items-center gap-2 outline-none focus-visible:ring-1 focus-visible:ring-ironlore-blue/40"
      style={{
        padding: "9px 18px",
        fontSize: 13,
        fontFamily: "var(--font-sans)",
        fontWeight: 500,
        background: "var(--il-blue)",
        color: "var(--il-bg)",
        border: "none",
        borderRadius: 3,
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.4 : 1,
        boxShadow: disabled ? "none" : "0 0 12px var(--il-blue-glow)",
      }}
    >
      {children}
      {kbd && <Key>{kbd}</Key>}
    </button>
  );
}

function GhostButton({
  children,
  onClick,
  disabled,
  kbd,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  kbd?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="inline-flex items-center gap-2"
      style={{
        padding: "9px 18px",
        fontSize: 13,
        fontFamily: "var(--font-sans)",
        fontWeight: 500,
        background: "transparent",
        color: "var(--il-text2)",
        border: "1px solid var(--il-border)",
        borderRadius: 3,
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.5 : 1,
      }}
    >
      {children}
      {kbd && <Key>{kbd}</Key>}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Step 01 — Welcome
// ---------------------------------------------------------------------------

function StepWelcome({ onBegin }: { onBegin: () => void }) {
  // Enter triggers Begin — the only primary CTA on this step.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Enter") {
        e.preventDefault();
        onBegin();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onBegin]);

  return (
    <div className="grid h-full grid-cols-1 md:grid-cols-2">
      {/* Left — Venn centred. Dimmer here than the watermark on
       *  step 05 so the copy feels primary; step 05 is the payoff. */}
      <aside
        className="relative hidden overflow-hidden md:flex md:flex-col md:justify-end"
        style={{
          background: "var(--il-slate)",
          borderRight: "1px solid var(--il-border-soft)",
          padding: "40px 44px",
        }}
      >
        <div
          aria-hidden="true"
          style={{
            position: "absolute",
            top: "50%",
            left: "50%",
            transform: "translate(-50%, -55%)",
          }}
        >
          <Venn
            size={280}
            fill="color-mix(in oklch, var(--il-blue) 70%, transparent)"
            color="var(--il-text4)"
            lineWidth={0.6}
          />
        </div>
        <div style={{ position: "relative", zIndex: 1, maxWidth: 320 }}>
          <StepOverline n="" theme="The Ironlore Model" />
          <SerifHeading>
            Three rings,
            <br />
            one center.
          </SerifHeading>
        </div>
      </aside>

      {/* Right — welcome copy + CTAs. */}
      <section className="flex flex-col justify-center" style={{ padding: "48px 56px" }}>
        <div style={{ maxWidth: 520 }}>
          <StepOverline n="" theme="Welcome" />
          <SerifHeading>
            Writing <SerifItalic>alongside agents.</SerifItalic>
          </SerifHeading>
          <p
            style={{
              margin: "18px 0 28px",
              fontSize: 14.5,
              lineHeight: 1.55,
              color: "var(--il-text2)",
            }}
          >
            Ironlore is a workspace where human intent, agent capability, and shared memory overlap.
            Let's configure yours in five short steps.
          </p>
          <div className="flex items-center gap-3">
            <PrimaryButton onClick={onBegin} kbd="↵">
              Begin
            </PrimaryButton>
            <GhostButton onClick={() => {}} disabled>
              Import from another tool
            </GhostButton>
          </div>
        </div>
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 02 — Scope (checkboxes + WILL SEED rail)
// ---------------------------------------------------------------------------

function StepScope({
  selected,
  onToggle,
  onBack,
  onContinue,
}: {
  selected: Set<ScopeKey>;
  onToggle: (key: ScopeKey) => void;
  onBack: () => void;
  onContinue: () => void;
}) {
  const suggestionEntries = Array.from(selected).map((k) => SCOPE_TO_AGENT[k]);
  return (
    <div className="grid h-full grid-cols-[1fr_300px]">
      {/* Main */}
      <section className="flex flex-col" style={{ padding: "48px 56px" }}>
        <div style={{ maxWidth: 620 }}>
          <StepOverline n="02" theme="Scope" />
          <SerifHeading>
            What do you spend
            <br />
            the most time <SerifItalic>writing?</SerifItalic>
          </SerifHeading>

          <div className="mt-8 grid gap-2">
            {SCOPES.map((s) => (
              <ScopeRow
                key={s.key}
                label={s.label}
                checked={selected.has(s.key)}
                onToggle={() => onToggle(s.key)}
              />
            ))}
          </div>

          <div className="mt-8 flex items-center gap-3">
            <GhostButton onClick={onBack}>Back</GhostButton>
            <PrimaryButton onClick={onContinue} kbd="↵">
              Continue
            </PrimaryButton>
            <span className="flex-1" />
            <span
              className="font-mono uppercase"
              style={{ fontSize: 10.5, color: "var(--il-text3)", letterSpacing: "0.08em" }}
            >
              {selected.size} of {SCOPES.length} selected
            </span>
          </div>
        </div>
      </section>

      {/* Right rail — WILL SEED */}
      <aside
        className="flex flex-col overflow-hidden"
        style={{ background: "var(--il-slate)", padding: "48px 24px" }}
      >
        <div
          className="font-mono uppercase"
          style={{
            fontSize: 11,
            color: "var(--il-text3)",
            letterSpacing: "0.1em",
            marginBottom: 16,
          }}
        >
          Will seed
        </div>
        <div className="flex flex-col gap-2">
          {suggestionEntries.length === 0 ? (
            <div
              style={{
                padding: "10px 12px",
                border: "1px dashed var(--il-border-soft)",
                borderRadius: 3,
                fontSize: 12.5,
                color: "var(--il-text3)",
                fontStyle: "italic",
              }}
            >
              Pick one or more to seed suggestions.
            </div>
          ) : (
            suggestionEntries.map((a) => <SuggestionCard key={a.slug} agent={a} />)
          )}
        </div>
      </aside>
    </div>
  );
}

function ScopeRow({
  label,
  checked,
  onToggle,
}: {
  label: string;
  checked: boolean;
  onToggle: () => void;
}) {
  return (
    <label
      className="flex cursor-pointer items-center gap-3"
      style={{
        padding: "11px 14px",
        background: checked
          ? "color-mix(in oklch, var(--il-blue) 10%, transparent)"
          : "var(--il-slate)",
        border: `1px solid ${checked ? "var(--il-blue)" : "var(--il-border-soft)"}`,
        borderRadius: 4,
        transition: "background var(--motion-snap) ease-out, border-color var(--motion-snap)",
      }}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={onToggle}
        aria-label={label}
        className="sr-only"
      />
      <span
        aria-hidden="true"
        style={{
          width: 16,
          height: 16,
          borderRadius: 3,
          background: checked ? "var(--il-blue)" : "transparent",
          border: `1.5px solid ${checked ? "var(--il-blue)" : "var(--il-border-strong)"}`,
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          color: "var(--il-bg)",
          fontSize: 10,
          fontWeight: 700,
        }}
      >
        {checked ? "✓" : ""}
      </span>
      <span style={{ fontSize: 13.5, color: "var(--il-text)" }}>{label}</span>
    </label>
  );
}

function SuggestionCard({ agent }: { agent: AgentSuggestion }) {
  return (
    <div
      style={{
        padding: "12px 14px",
        borderLeft: `2px solid ${agent.color}`,
        background: "var(--il-slate-elev)",
        borderRadius: "0 3px 3px 0",
      }}
    >
      <div
        style={{
          fontFamily: "var(--font-display)",
          fontStyle: "italic",
          fontSize: 17,
          letterSpacing: "-0.01em",
          color: "var(--il-text)",
        }}
      >
        {agent.slug}
      </div>
      <div
        className="font-mono uppercase"
        style={{
          fontSize: 10.5,
          letterSpacing: "0.06em",
          color: "var(--il-text3)",
          marginTop: 4,
        }}
      >
        suggested
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 03 — Agents
// ---------------------------------------------------------------------------

function StepAgents({
  agents,
  onBack,
  onAccept,
}: {
  agents: AgentSuggestion[];
  onBack: () => void;
  onAccept: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Enter") {
        e.preventDefault();
        onAccept();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onAccept]);

  const title =
    agents.length === 1
      ? "One agent"
      : agents.length === 2
        ? "Two agents"
        : `${agents.length} agents`;
  return (
    <section className="flex h-full flex-col" style={{ padding: "48px 56px" }}>
      <StepOverline n="03" theme="Your Team" />
      <SerifHeading>
        {title}, <SerifItalic>ready to begin.</SerifItalic>
      </SerifHeading>

      <div
        className="mt-8 grid gap-4"
        style={{ gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))" }}
      >
        {agents.map((a) => (
          <AgentCard key={a.slug} agent={a} />
        ))}
      </div>

      <span className="flex-1" />

      <div className="flex items-center gap-3">
        <GhostButton onClick={onBack}>Back</GhostButton>
        <GhostButton onClick={() => {}} disabled>
          Browse library <ArrowRight className="h-3 w-3" />
        </GhostButton>
        <span className="flex-1" />
        <PrimaryButton onClick={onAccept} kbd="↵">
          {agents.length > 1 ? "Accept both" : "Accept"}
        </PrimaryButton>
      </div>
    </section>
  );
}

function AgentCard({ agent }: { agent: AgentSuggestion }) {
  return (
    <div
      style={{
        padding: "20px 22px",
        borderLeft: `2px solid ${agent.color}`,
        background: "var(--il-slate-elev)",
        borderRadius: "0 4px 4px 0",
      }}
    >
      <div className="flex items-baseline gap-2">
        <Reuleaux size={8} color={agent.color} />
        <span
          style={{
            fontFamily: "var(--font-display)",
            fontStyle: "italic",
            fontSize: 22,
            letterSpacing: "-0.01em",
            color: "var(--il-text)",
          }}
        >
          {agent.slug}
        </span>
        <span className="flex-1" />
        <span
          className="font-mono uppercase"
          style={{ fontSize: 10.5, letterSpacing: "0.08em", color: "var(--il-text3)" }}
        >
          suggested
        </span>
      </div>
      <p
        style={{
          margin: "10px 0 14px",
          fontSize: 13.5,
          lineHeight: 1.5,
          color: "var(--il-text2)",
        }}
      >
        {agent.description}
      </p>
      <div className="flex flex-wrap gap-1.5">
        {agent.tools.map((t) => (
          <code
            key={t}
            className="font-mono"
            style={{
              fontSize: 11,
              padding: "2px 7px",
              background: "var(--il-slate)",
              border: "1px solid var(--il-border-soft)",
              borderRadius: 2,
              color: "var(--il-text2)",
            }}
          >
            {t}
          </code>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 04 — Seed
// ---------------------------------------------------------------------------

function StepSeed({
  onBack,
  onContinue,
  onSkip,
  onPick,
  choice,
}: {
  onBack: () => void;
  onContinue: () => void;
  onSkip: () => void;
  onPick: (c: "drop" | "paste" | "notion") => void;
  choice: OnboardingState["seedChoice"];
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  return (
    <div className="grid h-full grid-cols-[1fr_320px]">
      <section className="flex flex-col" style={{ padding: "48px 56px" }}>
        <StepOverline n="04" theme="Seed the Memory" />
        <SerifHeading>
          Drop in a folder <SerifItalic>or a single doc.</SerifItalic>
        </SerifHeading>

        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={() => onPick("drop")}
        />

        <div
          className="mt-7 flex flex-col items-center justify-center text-center"
          style={{
            border: "1px dashed var(--il-border)",
            borderRadius: 6,
            padding: "56px 24px",
            background:
              choice === "drop"
                ? "color-mix(in oklch, var(--il-blue) 6%, transparent)"
                : "transparent",
          }}
        >
          <Venn size={36} fill="var(--il-text4)" color="var(--il-text4)" lineWidth={0.6} />
          <p
            style={{
              margin: "16px 0 0",
              fontSize: 14,
              lineHeight: 1.55,
              color: "var(--il-text2)",
              maxWidth: 380,
            }}
          >
            Drop markdown, PDFs, or a whole folder. Ironlore indexes them into shared memory —
            nothing leaves your machine.
          </p>
          <div
            className="font-mono uppercase"
            style={{
              fontSize: 10.5,
              letterSpacing: "0.08em",
              color: "var(--il-text4)",
              margin: "18px 0 12px",
            }}
          >
            or
          </div>
          <div className="flex flex-wrap items-center justify-center gap-2">
            <GhostButton
              onClick={() => {
                fileInputRef.current?.click();
                onPick("drop");
              }}
            >
              <Upload className="h-3 w-3" /> Pick files…
            </GhostButton>
            <GhostButton onClick={() => onPick("paste")}>
              <PencilLine className="h-3 w-3" /> Paste text
            </GhostButton>
            <GhostButton onClick={() => onPick("notion")} disabled>
              <FolderInput className="h-3 w-3" /> Import from Notion
            </GhostButton>
          </div>
        </div>

        <span className="flex-1" />

        <div className="mt-8 flex items-center gap-3">
          <GhostButton onClick={onBack}>Back</GhostButton>
          <span className="flex-1" />
          <GhostButton onClick={onSkip} kbd="S">
            Skip — I'll add docs later
          </GhostButton>
          <PrimaryButton onClick={onContinue} kbd="↵">
            Continue
          </PrimaryButton>
        </div>
      </section>

      {/* Right rail — WHAT HAPPENS NEXT (amber). Non-negotiable per
       *  the "show the boundary" principle: nothing goes opaque —
       *  the user sees the agent trust ladder before any files are
       *  read. */}
      <aside
        className="flex flex-col overflow-hidden"
        style={{
          background: "var(--il-slate)",
          borderLeft: "3px solid var(--il-amber)",
          padding: "48px 24px",
        }}
      >
        <div
          className="font-mono uppercase"
          style={{
            fontSize: 11,
            color: "var(--il-amber)",
            letterSpacing: "0.1em",
            marginBottom: 16,
          }}
        >
          What happens next
        </div>
        <ol style={{ margin: 0, padding: 0, listStyle: "none" }}>
          {[
            "Indexed to local FTS5",
            "Chunked into blocks",
            "Agents get read access",
            "No writes until approved",
          ].map((item, i) => (
            <li
              // biome-ignore lint/suspicious/noArrayIndexKey: fixed 4-row list
              key={i}
              className="flex items-baseline gap-3"
              style={{ padding: "6px 0", fontSize: 13.5, color: "var(--il-text)" }}
            >
              <span
                className="font-mono"
                style={{
                  fontSize: 11,
                  color: "var(--il-text3)",
                  letterSpacing: "0.06em",
                  minWidth: 20,
                }}
              >
                {String(i + 1).padStart(2, "0")}
              </span>
              <span>{item}</span>
            </li>
          ))}
        </ol>
      </aside>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 05 — Witness (scripted live log, ends at Inbox)
// ---------------------------------------------------------------------------

interface LogLine {
  t: string;
  /** Verb colour tier. */
  kind: "read" | "flag" | "propose";
  verb: string;
  rest: string;
}

const SCRIPT: LogLine[] = [
  { t: "09:21:02", kind: "read", verb: "read", rest: "architecture.md · 23 blocks" },
  { t: "09:21:04", kind: "read", verb: "read", rest: "rfc-014.md · 18 blocks" },
  {
    t: "09:21:07",
    kind: "flag",
    verb: "flag",
    rest: "stale cross-ref · architecture.md#blk_a4f2",
  },
  { t: "09:21:09", kind: "read", verb: "read", rest: "storage-writer.md · 11 blocks" },
  { t: "09:21:11", kind: "flag", verb: "flag", rest: "conflict · specs/billing.md#blk_910e" },
  { t: "09:21:14", kind: "propose", verb: "propose", rest: "replace blk_a4f2 · awaiting review" },
  {
    t: "09:21:16",
    kind: "propose",
    verb: "propose",
    rest: "add cross-ref to storage-writer§4",
  },
];

function StepWitness({
  primaryAgent,
  onOpenWorkspace,
  onKeepWatching,
}: {
  primaryAgent: string;
  onOpenWorkspace: () => void;
  onKeepWatching: () => void;
}) {
  // Scripted log ticker — prepend one line every 600 ms so the
  //  user sees motion without us depending on a real agent run.
  const [visible, setVisible] = useState(1);
  const [inboxShown, setInboxShown] = useState(false);
  useEffect(() => {
    if (visible >= SCRIPT.length) {
      const t = setTimeout(() => setInboxShown(true), 600);
      return () => clearTimeout(t);
    }
    const t = setTimeout(() => setVisible((v) => v + 1), 600);
    return () => clearTimeout(t);
  }, [visible]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Enter") {
        e.preventDefault();
        onOpenWorkspace();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onOpenWorkspace]);

  return (
    <div className="grid h-full grid-cols-1 md:grid-cols-2">
      {/* Left — serif copy + CTAs */}
      <section
        className="flex flex-col justify-center"
        style={{ padding: "48px 56px", background: "var(--il-bg)" }}
      >
        <div style={{ maxWidth: 520 }}>
          <StepOverline n="05" theme="First Run" />
          <SerifHeading>
            Watching
            <br />
            <SerifItalic>{primaryAgent}</SerifItalic> read.
          </SerifHeading>
          <p
            style={{
              margin: "18px 0 28px",
              fontSize: 14.5,
              lineHeight: 1.55,
              color: "var(--il-text2)",
            }}
          >
            Every block your agents touch shows up here first. When something is ready for your
            attention, it lands in the Inbox — nothing edits your memory without a review.
          </p>
          <div className="flex items-center gap-3">
            <PrimaryButton onClick={onOpenWorkspace} kbd="↵">
              Open workspace
            </PrimaryButton>
            <GhostButton onClick={onKeepWatching}>Keep watching</GhostButton>
          </div>
        </div>
      </section>

      {/* Right — live log pane */}
      <section
        className="flex flex-col overflow-hidden"
        style={{
          background: "var(--il-bg)",
          borderLeft: "1px solid var(--il-border-soft)",
          padding: "28px 32px",
          position: "relative",
        }}
      >
        {/* Header */}
        <div className="flex items-baseline gap-3" style={{ marginBottom: 18 }}>
          <Reuleaux size={10} color="var(--il-blue)" spin />
          <span
            style={{
              fontFamily: "var(--font-display)",
              fontStyle: "italic",
              fontSize: 20,
              color: "var(--il-text)",
            }}
          >
            {primaryAgent}
          </span>
          <span
            className="font-mono"
            style={{
              fontSize: 11,
              letterSpacing: "0.04em",
              color: "var(--il-text3)",
            }}
          >
            step {String(Math.min(visible + 2, 12)).padStart(2, "0")} / 12
          </span>
          <span className="flex-1" />
          <span
            className="font-mono uppercase inline-flex items-center gap-1.5"
            style={{ fontSize: 10.5, letterSpacing: "0.08em", color: "var(--il-green)" }}
          >
            <span
              aria-hidden="true"
              style={{
                width: 6,
                height: 6,
                borderRadius: "50%",
                background: "var(--il-green)",
                boxShadow: "0 0 6px var(--il-green)",
              }}
            />
            live
          </span>
        </div>

        {/* Log */}
        <div className="flex flex-1 flex-col gap-1 overflow-hidden">
          {SCRIPT.slice(0, visible).map((line) => (
            <LogRow key={line.t} line={line} />
          ))}
        </div>

        {/* Inbox banner */}
        {inboxShown && (
          <div
            className="mt-4"
            style={{
              borderLeft: "3px solid var(--il-amber)",
              background: "color-mix(in oklch, var(--il-amber) 10%, transparent)",
              padding: "12px 16px",
              borderRadius: "0 3px 3px 0",
              animation: "ilSnapIn var(--motion-snap) ease-out",
            }}
          >
            <div
              className="font-mono uppercase flex items-baseline gap-2"
              style={{
                fontSize: 10.5,
                letterSpacing: "0.08em",
                color: "var(--il-amber)",
              }}
            >
              <span aria-hidden="true">·</span>
              <span>2 items in inbox</span>
              <span className="flex-1" />
              <button
                type="button"
                onClick={onOpenWorkspace}
                style={{
                  background: "transparent",
                  border: "none",
                  color: "var(--il-amber)",
                  cursor: "pointer",
                  fontFamily: "var(--font-mono)",
                  fontSize: 10.5,
                  letterSpacing: "0.08em",
                  textTransform: "uppercase",
                }}
              >
                → open first
              </button>
            </div>
            <div style={{ fontSize: 13.5, color: "var(--il-text)", marginTop: 4 }}>
              Your first proposals are ready for review.
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

function LogRow({ line }: { line: LogLine }) {
  const verbColor =
    line.kind === "read"
      ? "var(--il-blue)"
      : line.kind === "flag"
        ? "var(--il-amber)"
        : "var(--il-green)";
  return (
    <div
      className="font-mono"
      style={{
        fontSize: 12.5,
        lineHeight: 1.6,
        letterSpacing: "0.01em",
        animation: "ilSnapIn var(--motion-snap) ease-out",
      }}
    >
      <span style={{ color: "var(--il-text3)" }}>{line.t}</span>{" "}
      <span style={{ color: verbColor }}>{line.verb}</span>{" "}
      <span style={{ color: "var(--il-text)" }}>{line.rest}</span>
    </div>
  );
}
