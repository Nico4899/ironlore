import { DollarSign, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useFocusTrap } from "../hooks/useFocusTrap.js";
import { getApiProject } from "../lib/api.js";

interface CostEstimate {
  model: string;
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  estimatedCostUsd: number;
  pricePerMillionInput: number;
  pricePerMillionOutput: number;
}

interface CostEstimateDialogProps {
  agentSlug: string;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * Pre-run cost confirmation dialog. Shown before starting an
 * autonomous agent run to give the user a heads-up on estimated
 * token usage and cost.
 */
export function CostEstimateDialog({ agentSlug, onConfirm, onCancel }: CostEstimateDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const [estimate, setEstimate] = useState<CostEstimate | null>(null);
  const [loading, setLoading] = useState(true);

  useFocusTrap(dialogRef, true);

  useEffect(() => {
    fetch(`/api/projects/${getApiProject()}/agents/${agentSlug}/cost-estimate`)
      .then((res) => res.json())
      .then((data) => setEstimate(data as CostEstimate))
      .catch(() => {
        // Estimation failed — allow run anyway
        setEstimate(null);
      })
      .finally(() => setLoading(false));
  }, [agentSlug]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onCancel]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div
        ref={dialogRef}
        className="surface-glass w-96 rounded-xl p-5"
        role="dialog"
        aria-label="Cost estimate"
      >
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-sm font-semibold text-primary">
            <DollarSign className="h-4 w-4 text-signal-amber" />
            Cost estimate
          </div>
          <button
            type="button"
            onClick={onCancel}
            className="rounded p-1 text-secondary hover:bg-ironlore-slate-hover"
            aria-label="Cancel"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="mt-4 text-xs text-secondary">
          {loading && "Estimating cost..."}
          {!loading && !estimate && "Could not estimate cost. You can proceed anyway."}
          {!loading && estimate && (
            <div className="space-y-2">
              <div className="flex justify-between">
                <span>Model</span>
                <span className="font-mono text-primary">{estimate.model}</span>
              </div>
              <div className="flex justify-between">
                <span>Input tokens (est.)</span>
                <span className="font-mono text-primary">
                  ~{estimate.estimatedInputTokens.toLocaleString()}
                </span>
              </div>
              <div className="flex justify-between">
                <span>Output tokens (est.)</span>
                <span className="font-mono text-primary">
                  ~{estimate.estimatedOutputTokens.toLocaleString()}
                </span>
              </div>
              <div className="border-t border-border pt-2">
                <div className="flex justify-between text-sm font-semibold">
                  <span className="text-primary">Estimated cost</span>
                  <span className="text-signal-amber">${estimate.estimatedCostUsd.toFixed(4)}</span>
                </div>
              </div>
              <div className="text-[10px] text-secondary">
                Prices: ${estimate.pricePerMillionInput}/M input, ${estimate.pricePerMillionOutput}
                /M output. Actual cost depends on conversation length and tool calls.
              </div>
            </div>
          )}
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-md border border-border px-3 py-1.5 text-xs text-secondary hover:bg-ironlore-slate-hover"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={loading}
            className="rounded-md bg-ironlore-blue px-3 py-1.5 text-xs font-medium text-white hover:bg-ironlore-blue/90 disabled:opacity-50"
          >
            Start run
          </button>
        </div>
      </div>
    </div>
  );
}
