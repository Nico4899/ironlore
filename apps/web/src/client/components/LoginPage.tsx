import { messages } from "@ironlore/core";
import { useCallback, useEffect, useState } from "react";
import { ApiError, fetchFirstRunHint, login } from "../lib/api.js";
import { useAuthStore } from "../stores/auth.js";
import { Logo } from "./Logo.js";
import { Reuleaux } from "./primitives/index.js";

/** Auto-focus an input element via ref callback (a11y-safe, no autoFocus attr). */
function focusRef(el: HTMLInputElement | null) {
  el?.focus();
}

export function LoginPage() {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // First-run hint — when `.ironlore-install.json` still sits on disk,
  //  the admin password was printed to the server's terminal. Tell
  //  the user that so they stop staring at a blank form. Fetches once
  //  on mount; disappears on the next render after the install record
  //  is consumed (password change handler deletes it).
  const [firstRun, setFirstRun] = useState<"terminal" | null>(null);
  useEffect(() => {
    let cancelled = false;
    void fetchFirstRunHint().then((hint) => {
      if (!cancelled) setFirstRun(hint);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (submitting) return;

      setError(null);
      setSubmitting(true);

      try {
        const result = await login("admin", password);
        useAuthStore.getState().setAuthenticated(result.username, result.mustChangePassword);
        // Login only hands back `{username, mustChangePassword}`; the
        //  current project id is still server-side state. Refresh
        //  the session so `currentProjectId` hydrates before the
        //  sidebar re-mounts — otherwise the ProjectTile sees a null
        //  id and bails (#B3: tile disappearing after re-login).
        await useAuthStore.getState().checkSession();
      } catch (err) {
        if (err instanceof ApiError) {
          if (err.status === 429) {
            setError(messages.authRateLimited);
          } else {
            setError(messages.authInvalidCredentials);
          }
        } else {
          setError(messages.errorGeneric);
        }
        setSubmitting(false);
      }
    },
    [password, submitting],
  );

  return (
    <div className="flex h-screen items-center justify-center bg-ironlore-slate">
      <form onSubmit={handleSubmit} className="flex w-full max-w-xs flex-col gap-6">
        {/* Login-screen brand lockup — mark at 56 px stacked above the
         *  wordmark at 44 px per docs/09-ui-and-brand.md §Wordmark.
         *  `authLoginTitle` moves down to a mono under-rule so the
         *  wordmark itself owns the strongest visual anchor. */}
        <div className="flex flex-col items-center gap-3">
          <Logo size={56} />
          <span
            style={{
              fontFamily: "var(--font-sans)",
              fontWeight: 500,
              fontSize: 44,
              letterSpacing: "-0.02em",
              lineHeight: 1,
              color: "var(--il-text)",
            }}
          >
            {messages.appName}
          </span>
          <span
            className="font-mono uppercase"
            style={{
              fontSize: 10.5,
              letterSpacing: "0.08em",
              color: "var(--il-text3)",
              marginTop: 2,
            }}
          >
            {messages.authLoginTitle}
          </span>
        </div>

        {/* First-run hint — rendered only while `install.json` is still
         *  on disk. Mono uppercase line with a blue Reuleaux so it reads
         *  as a system notice, not an error. */}
        {firstRun === "terminal" && (
          <div
            className="flex items-start gap-2 rounded-sm px-3 py-2 font-mono"
            style={{
              background: "color-mix(in oklch, var(--il-blue) 8%, transparent)",
              border: "1px solid color-mix(in oklch, var(--il-blue) 25%, transparent)",
              fontSize: 10.5,
              letterSpacing: "0.04em",
              color: "var(--il-text2)",
              lineHeight: 1.5,
            }}
          >
            <span className="pt-0.5">
              <Reuleaux size={7} color="var(--il-blue)" />
            </span>
            <span>
              <span className="uppercase" style={{ color: "var(--il-blue)" }}>
                first run
              </span>
              <span style={{ color: "var(--il-text4)" }}> · </span>
              <span>
                your admin password was printed to the server's terminal log when Ironlore started.
                You'll be asked to change it right after login.
              </span>
            </span>
          </div>
        )}

        {/* Password field */}
        <div className="flex flex-col gap-1.5">
          <label htmlFor="login-password" className="text-xs font-medium text-secondary">
            {messages.authPasswordLabel}
          </label>
          <input
            ref={focusRef}
            id="login-password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={messages.authPasswordPlaceholder}
            className="rounded border border-border bg-transparent px-3 py-2 text-sm text-primary focus:border-ironlore-blue focus:outline-none"
            autoComplete="current-password"
            aria-invalid={error !== null}
            aria-describedby={error ? "login-error" : undefined}
            required
          />
        </div>

        {/* Error — aria-live so SRs announce failures; aria-describedby links it to the input. */}
        {error && (
          <p
            id="login-error"
            role="alert"
            aria-live="assertive"
            className="text-xs text-signal-red"
          >
            {error}
          </p>
        )}

        {/* Submit */}
        <button
          type="submit"
          disabled={submitting || !password}
          className="rounded bg-ironlore-blue px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          {messages.authLoginButton}
        </button>
      </form>
    </div>
  );
}
