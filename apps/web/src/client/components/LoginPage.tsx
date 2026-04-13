import { messages } from "@ironlore/core";
import { useCallback, useState } from "react";
import { ApiError, login } from "../lib/api.js";
import { useAuthStore } from "../stores/auth.js";

/** Auto-focus an input element via ref callback (a11y-safe, no autoFocus attr). */
function focusRef(el: HTMLInputElement | null) {
  el?.focus();
}

export function LoginPage() {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (submitting) return;

      setError(null);
      setSubmitting(true);

      try {
        const result = await login("admin", password);
        useAuthStore.getState().setAuthenticated(result.username, result.mustChangePassword);
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
        {/* Wordmark */}
        <div className="flex flex-col items-center gap-2">
          <span className="text-lg font-medium tracking-tight text-primary">
            {messages.appName}
          </span>
          <span className="text-sm text-secondary">{messages.authLoginTitle}</span>
        </div>

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
          />
        </div>

        {/* Error */}
        {error && <p className="text-xs text-signal-red">{error}</p>}

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
