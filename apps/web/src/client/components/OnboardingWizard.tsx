import { Bot, ChevronRight, Sparkles } from "lucide-react";
import { useCallback, useState } from "react";

/**
 * Onboarding wizard — 5 questions → keyword-matched team suggestion
 * from the library templates → template variable substitution.
 *
 * The wizard writes the suggested persona with user-supplied values
 * filled in (`{{company_name}}`, `{{company_description}}`, `{{goals}}`).
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
  label: string;
  placeholder: string;
}> = [
  {
    key: "role",
    label: "What's your role?",
    placeholder: "e.g. Product Manager, Engineer, Researcher, Student",
  },
  {
    key: "company",
    label: "What's your company or project about?",
    placeholder: "e.g. B2B SaaS for developer tools",
  },
  {
    key: "goals",
    label: "What do you want to achieve with your knowledge base?",
    placeholder: "e.g. Organize research, track decisions, write docs",
  },
  {
    key: "painPoints",
    label: "What's your biggest pain point with existing tools?",
    placeholder: "e.g. Notes scattered across apps, can't find old decisions",
  },
  {
    key: "channels",
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

  const handleNext = useCallback(() => {
    if (isLast) {
      onComplete(answers);
    } else {
      setStep((s) => s + 1);
    }
  }, [isLast, answers, onComplete]);

  const handleChange = useCallback(
    (value: string) => {
      if (!current) return;
      setAnswers((prev) => ({ ...prev, [current.key]: value }));
    },
    [current],
  );

  if (!current) return null;

  return (
    <div className="flex h-full items-center justify-center px-8">
      <div className="w-full max-w-md">
        <div className="mb-6 flex items-center gap-2">
          <Bot className="h-5 w-5 text-ironlore-blue" />
          <span className="text-sm font-semibold text-primary">Set up your AI team</span>
          <span className="ml-auto text-xs text-secondary">
            {step + 1} / {QUESTIONS.length}
          </span>
        </div>

        {/* Progress bar */}
        <div className="mb-6 h-1 rounded-full bg-border">
          <div
            className="h-1 rounded-full bg-ironlore-blue transition-all"
            style={{ width: `${((step + 1) / QUESTIONS.length) * 100}%` }}
          />
        </div>

        <label className="mb-2 block text-sm font-medium text-primary">{current.label}</label>
        <textarea
          className="h-20 w-full resize-none rounded-lg border border-border bg-background px-3 py-2 text-sm text-primary placeholder:text-secondary focus:border-ironlore-blue focus:outline-none"
          placeholder={current.placeholder}
          value={answers[current.key]}
          onChange={(e) => handleChange(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
              e.preventDefault();
              handleNext();
            }
          }}
        />

        <div className="mt-4 flex items-center gap-3">
          <button
            type="button"
            onClick={handleNext}
            disabled={!answers[current.key].trim()}
            className="flex items-center gap-1.5 rounded-lg bg-ironlore-blue px-4 py-2 text-xs font-semibold text-white hover:bg-ironlore-blue-strong disabled:opacity-40"
          >
            {isLast ? (
              <>
                <Sparkles className="h-3.5 w-3.5" />
                Suggest agents
              </>
            ) : (
              <>
                Next
                <ChevronRight className="h-3.5 w-3.5" />
              </>
            )}
          </button>
          <button
            type="button"
            onClick={onSkip}
            className="text-xs text-secondary hover:text-primary"
          >
            Skip for now
          </button>
        </div>
      </div>
    </div>
  );
}
