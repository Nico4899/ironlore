import { Sparkles } from "lucide-react";
import { useCallback, useState } from "react";
import { Key, Reuleaux, Venn } from "./primitives/index.js";

/**
 * Onboarding wizard — 5 questions → keyword-matched team suggestion
 * from the library templates → template variable substitution.
 *
 * Surface refactored to match docs/09-ui-and-brand.md §Onboarding:
 * two-panel layout with a Venn watermark on the left and canvas-grammar
 * step content on the right (mono overline, Inter heading, focused
 * textarea, Back / Continue / skip footer with a blue-glow primary).
 * Answers + routing are unchanged from the prior implementation.
 *
 * See docs/04-ai-and-agents.md §Onboarding wizard and
 * docs/06-implementation-roadmap.md Phase 4.
 */

interface WizardAnswers {
  role: string;
  company: string;
  goals: string;
  painPoints: string;
  channels: string;
}

const QUESTIONS: Array<{
  key: keyof WizardAnswers;
  topic: string;
  label: string;
  placeholder: string;
}> = [
  {
    key: "role",
    topic: "about you",
    label: "What's your role?",
    placeholder: "e.g. Product Manager, Engineer, Researcher, Student",
  },
  {
    key: "company",
    topic: "about your team",
    label: "What's your company or project about?",
    placeholder: "e.g. B2B SaaS for developer tools",
  },
  {
    key: "goals",
    topic: "about your goals",
    label: "What do you want to achieve with your knowledge base?",
    placeholder: "e.g. Organize research, track decisions, write docs",
  },
  {
    key: "painPoints",
    topic: "about the pain",
    label: "What's your biggest pain point with existing tools?",
    placeholder: "e.g. Notes scattered across apps, can't find old decisions",
  },
  {
    key: "channels",
    topic: "about your sources",
    label: "Where does your information live today?",
    placeholder: "e.g. Notion, Google Docs, Slack, paper notebooks",
  },
];

interface OnboardingWizardProps {
  onComplete: (answers: WizardAnswers) => void;
  onSkip: () => void;
}

export function OnboardingWizard({ onComplete, onSkip }: OnboardingWizardProps) {
  const [step, setStep] = useState(0);
  const [answers, setAnswers] = useState<WizardAnswers>({
    role: "",
    company: "",
    goals: "",
    painPoints: "",
    channels: "",
  });

  const current = QUESTIONS[step];
  const isLast = step === QUESTIONS.length - 1;
  const stepLabel = `step ${String(step + 1).padStart(2, "0")} / ${QUESTIONS.length}`;

  const handleNext = useCallback(() => {
    if (isLast) {
      onComplete(answers);
    } else {
      setStep((s) => s + 1);
    }
  }, [isLast, answers, onComplete]);

  const handleBack = useCallback(() => {
    setStep((s) => Math.max(0, s - 1));
  }, []);

  const handleChange = useCallback(
    (value: string) => {
      if (!current) return;
      setAnswers((prev) => ({ ...prev, [current.key]: value }));
    },
    [current],
  );

  if (!current) return null;

  const canContinue = answers[current.key].trim().length > 0;

  return (
    <div className="flex flex-1 flex-col" style={{ background: "var(--il-bg)", minHeight: 0 }}>
      {/* Header strip — logo dot + mono step counter */}
      <div
        className="flex h-11 items-center gap-2 px-5"
        style={{ borderBottom: "1px solid var(--il-border-soft)" }}
      >
        <Reuleaux size={10} color="var(--il-blue)" aria-label="Ironlore" />
        <span
          style={{
            fontFamily: "var(--font-sans)",
            fontSize: 14,
            fontWeight: 500,
            letterSpacing: "-0.02em",
            color: "var(--il-text)",
          }}
        >
          ironlore
        </span>
        <span className="flex-1" />
        <span
          className="font-mono uppercase"
          style={{
            fontSize: 10.5,
            color: "var(--il-text3)",
            letterSpacing: "0.06em",
          }}
        >
          {stepLabel}
        </span>
      </div>

      <div className="grid flex-1 grid-cols-1 md:grid-cols-2" style={{ minHeight: 0 }}>
        {/* Left panel — Venn watermark + model teaser */}
        <aside
          className="relative hidden overflow-hidden p-10 md:flex md:flex-col md:justify-end"
          style={{
            background: "var(--il-slate)",
            borderRight: "1px solid var(--il-border-soft)",
          }}
        >
          <div
            aria-hidden="true"
            style={{
              position: "absolute",
              top: "50%",
              left: "50%",
              transform: "translate(-50%, -55%)",
              opacity: 0.7,
            }}
          >
            <Venn size={280} fill="var(--il-blue)" color="var(--il-text3)" lineWidth={0.6} />
          </div>
          <div style={{ position: "relative", zIndex: 1, maxWidth: 420 }}>
            <div
              className="font-mono uppercase"
              style={{
                fontSize: 10.5,
                color: "var(--il-text3)",
                letterSpacing: "0.08em",
                marginBottom: 8,
              }}
            >
              the ironlore model
            </div>
            <p
              style={{
                fontFamily: "var(--font-sans)",
                fontWeight: 500,
                fontSize: 17,
                letterSpacing: "-0.015em",
                lineHeight: 1.4,
                color: "var(--il-text)",
                margin: 0,
              }}
            >
              Human intent, agent capability, and shared memory overlap at the center — your
              workspace.
            </p>
          </div>
        </aside>

        {/* Right panel — wizard step */}
        <section
          className="flex flex-col justify-center px-10 py-12 md:px-14"
          style={{ maxWidth: 640 }}
        >
          {/* Progress — 5 thin segments, filled up to current step */}
          <div className="mb-7 flex gap-1.5" aria-hidden="true">
            {QUESTIONS.map((q, i) => (
              <span
                key={q.key}
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

          <div
            className="font-mono uppercase"
            style={{
              fontSize: 10.5,
              color: "var(--il-text3)",
              letterSpacing: "0.06em",
              marginBottom: 10,
            }}
          >
            question {String(step + 1).padStart(2, "0")} · {current.topic}
          </div>

          <label
            htmlFor={`wizard-${current.key}`}
            style={{
              fontFamily: "var(--font-sans)",
              fontWeight: 600,
              fontSize: 26,
              letterSpacing: "-0.025em",
              lineHeight: 1.15,
              color: "var(--il-text)",
              margin: "0 0 18px",
              display: "block",
            }}
          >
            {current.label}
          </label>

          <textarea
            id={`wizard-${current.key}`}
            className="outline-none"
            style={{
              width: "100%",
              minHeight: 96,
              resize: "none",
              padding: "12px 14px",
              fontFamily: "var(--font-sans)",
              fontSize: 14,
              color: "var(--il-text)",
              background: "var(--il-slate)",
              border: "1px solid var(--il-border)",
              borderRadius: 4,
              lineHeight: 1.5,
            }}
            placeholder={current.placeholder}
            value={answers[current.key]}
            onChange={(e) => handleChange(e.target.value)}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                e.preventDefault();
                if (canContinue) handleNext();
              }
            }}
          />

          <div className="mt-7 flex items-center gap-3">
            <button
              type="button"
              onClick={handleBack}
              disabled={step === 0}
              style={{
                padding: "9px 18px",
                fontSize: 13,
                fontFamily: "var(--font-sans)",
                fontWeight: 500,
                background: "transparent",
                color: "var(--il-text2)",
                border: "1px solid var(--il-border)",
                borderRadius: 3,
                cursor: step === 0 ? "not-allowed" : "pointer",
                opacity: step === 0 ? 0.4 : 1,
              }}
            >
              Back
            </button>

            <button
              type="button"
              onClick={handleNext}
              disabled={!canContinue}
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
                cursor: canContinue ? "pointer" : "not-allowed",
                opacity: canContinue ? 1 : 0.4,
                boxShadow: canContinue ? "0 0 12px var(--il-blue-glow)" : "none",
              }}
            >
              {isLast ? (
                <>
                  <Sparkles className="h-3.5 w-3.5" />
                  Suggest agents
                </>
              ) : (
                <>
                  Continue <Key>↵</Key>
                </>
              )}
            </button>

            <span className="flex-1" />

            <button
              type="button"
              onClick={onSkip}
              className="inline-flex items-center gap-2 bg-transparent font-mono uppercase outline-none"
              style={{
                fontSize: 10.5,
                letterSpacing: "0.06em",
                color: "var(--il-text3)",
                border: "none",
                padding: "4px 8px",
                cursor: "pointer",
              }}
            >
              <Reuleaux size={7} color="var(--il-text3)" />
              skip · all defaults
            </button>
          </div>
        </section>
      </div>
    </div>
  );
}
