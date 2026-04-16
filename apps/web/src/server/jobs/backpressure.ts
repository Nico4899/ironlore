/**
 * Adaptive backpressure — per-provider concurrency self-tuning.
 *
 * When the worker pool hits a 429 or rate-limit error from a provider,
 * the backpressure layer halves that provider's concurrency cap. Clean
 * minutes recover the cap exponentially (2× per minute) back toward
 * the configured maximum.
 *
 * Per-provider isolation: Anthropic hitting its limit doesn't throttle
 * OpenAI, and vice versa.
 *
 * See docs/04-ai-and-agents.md §Cost safety rails.
 */

export class BackpressureController {
  private caps = new Map<string, number>();
  private active = new Map<string, number>();
  private lastThrottle = new Map<string, number>();
  private maxParallel: number;
  private recoveryTimer: ReturnType<typeof setInterval> | null = null;

  constructor(maxParallel = 20) {
    this.maxParallel = maxParallel;
  }

  /**
   * Start the recovery timer. Should be called once at pool startup.
   */
  start(): void {
    // Every 60s, try to recover throttled providers.
    this.recoveryTimer = setInterval(() => this.recover(), 60_000);
    if (this.recoveryTimer.unref) this.recoveryTimer.unref();
  }

  stop(): void {
    if (this.recoveryTimer) {
      clearInterval(this.recoveryTimer);
      this.recoveryTimer = null;
    }
  }

  /**
   * Check whether a new request can be sent to this provider.
   */
  canProceed(providerId: string): boolean {
    const cap = this.caps.get(providerId) ?? this.maxParallel;
    const current = this.active.get(providerId) ?? 0;
    return current < cap;
  }

  /**
   * Mark a request as started for a provider.
   */
  acquire(providerId: string): void {
    this.active.set(providerId, (this.active.get(providerId) ?? 0) + 1);
  }

  /**
   * Mark a request as finished for a provider.
   */
  release(providerId: string): void {
    const current = this.active.get(providerId) ?? 0;
    this.active.set(providerId, Math.max(0, current - 1));
  }

  /**
   * Signal that a provider returned a rate-limit error (429).
   * Halves the concurrency cap for that provider.
   */
  onRateLimit(providerId: string): void {
    const current = this.caps.get(providerId) ?? this.maxParallel;
    const halved = Math.max(1, Math.floor(current / 2));
    this.caps.set(providerId, halved);
    this.lastThrottle.set(providerId, Date.now());
  }

  /**
   * Get the current concurrency cap for a provider.
   */
  getCap(providerId: string): number {
    return this.caps.get(providerId) ?? this.maxParallel;
  }

  /**
   * Get the current active count for a provider.
   */
  getActive(providerId: string): number {
    return this.active.get(providerId) ?? 0;
  }

  /**
   * Recovery tick — double the cap for providers that haven't been
   * throttled in the last 60s, up to maxParallel.
   */
  private recover(): void {
    const now = Date.now();
    for (const [providerId, cap] of this.caps) {
      const lastThrottle = this.lastThrottle.get(providerId) ?? 0;
      if (now - lastThrottle >= 60_000 && cap < this.maxParallel) {
        this.caps.set(providerId, Math.min(this.maxParallel, cap * 2));
      }
    }
  }
}
