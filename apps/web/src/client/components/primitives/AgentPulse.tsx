import type { CSSProperties, ReactNode } from "react";

/**
 * AgentPulse — ambient horizontal gradient sweep for live agent
 * surfaces.
 *
 * Applied to the AI panel composer while `isStreaming`, to individual
 * run cards when their agent is mid-tool-call, and to the 1px line at
 * the bottom of the header when any agent anywhere is running. The
 * sweep period is 3.2s so it reads as the building's heartbeat, not
 * an anxious progress bar.
 *
 * Reduced-motion users see a static 0.3-opacity overlay — the
 * keyframe bypass is handled by `.il-pulse::before` in globals.css.
 *
 * Rule (spec §Signature motifs / Agent pulse): never combine with a
 * rotating Reuleaux on the same element. One motion signal per
 * surface.
 */

export interface AgentPulseProps {
  /** Enable the sweep. Pass `false` when the agent is idle. */
  active?: boolean;
  children?: ReactNode;
  className?: string;
  style?: CSSProperties;
}

export function AgentPulse({ active = true, children, className, style }: AgentPulseProps) {
  return (
    <div className={[active ? "il-pulse" : "", className].filter(Boolean).join(" ")} style={style}>
      {children}
    </div>
  );
}
