import { messages } from "@ironlore/core";
import { useCallback, useState } from "react";
import { ApiError, changePassword } from "../lib/api.js";
import { useAuthStore } from "../stores/auth.js";

/** Auto-focus an input element via ref callback (a11y-safe, no autoFocus attr). */
function focusRef(el: HTMLInputElement | null) {
  el?.focus();
}

export function ChangePasswordPage() {
  const username = useAuthStore((s) => s.username);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (submitting) return;

      setError(null);

      // Client-side validation
      if (newPassword.length < 12) {
        setError("New password must be at least 12 characters.");
        return;
      }
      if (newPassword !== confirmPassword) {
        setError("Passwords do not match.");
        return;
      }

      setSubmitting(true);

      try {
        await changePassword(currentPassword, newPassword);
        useAuthStore.getState().setAuthenticated(username ?? "admin", false);
      } catch (err) {
        if (err instanceof ApiError) {
          if (err.status === 401) {
            setError("Current password is incorrect.");
          } else {
            // Parse server error message from JSON body if possible
            try {
              const body = JSON.parse(err.body) as { error?: string };
              setError(body.error ?? messages.errorGeneric);
            } catch {
              setError(messages.errorGeneric);
            }
          }
        } else {
          setError(messages.errorGeneric);
        }
        setSubmitting(false);
      }
    },
    [currentPassword, newPassword, confirmPassword, submitting, username],
  );

  return (
    <div className="flex h-screen items-center justify-center bg-ironlore-slate">
      <form onSubmit={handleSubmit} className="flex w-full max-w-xs flex-col gap-6">
        {/* Wordmark */}
        <div className="flex flex-col items-center gap-2">
          <span className="text-lg font-medium tracking-tight text-primary">
            {messages.onboardingWelcome}
          </span>
          <span className="text-center text-sm text-secondary">
            {messages.onboardingSetPassword}
          </span>
        </div>

        {/* Current password */}
        <div className="flex flex-col gap-1.5">
          <label htmlFor="current-password" className="text-xs font-medium text-secondary">
            {messages.authPasswordLabel}
          </label>
          <input
            ref={focusRef}
            id="current-password"
            type="password"
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
            className="rounded border border-border bg-transparent px-3 py-2 text-sm text-primary focus:border-ironlore-blue focus:outline-none"
            autoComplete="current-password"
          />
        </div>

        {/* New password */}
        <div className="flex flex-col gap-1.5">
          <label htmlFor="new-password" className="text-xs font-medium text-secondary">
            {messages.authNewPasswordLabel}
          </label>
          <input
            id="new-password"
            type="password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            className="rounded border border-border bg-transparent px-3 py-2 text-sm text-primary focus:border-ironlore-blue focus:outline-none"
            autoComplete="new-password"
          />
        </div>

        {/* Confirm password */}
        <div className="flex flex-col gap-1.5">
          <label htmlFor="confirm-password" className="text-xs font-medium text-secondary">
            {messages.authConfirmPasswordLabel}
          </label>
          <input
            id="confirm-password"
            type="password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            className="rounded border border-border bg-transparent px-3 py-2 text-sm text-primary focus:border-ironlore-blue focus:outline-none"
            autoComplete="new-password"
          />
        </div>

        {/* Error */}
        {error && <p className="text-xs text-signal-red">{error}</p>}

        {/* Submit */}
        <button
          type="submit"
          disabled={submitting || !currentPassword || !newPassword || !confirmPassword}
          className="rounded bg-ironlore-blue px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          {messages.authChangePasswordButton}
        </button>
      </form>
    </div>
  );
}
