import { DEFAULT_HOST } from "@ironlore/core";

const LOOPBACK_ADDRESSES = new Set(["127.0.0.1", "::1", "localhost"]);

/**
 * Validate bind address against security policy.
 *
 * Ironlore binds to 127.0.0.1 by default. Remote access is opt-in:
 * binding 0.0.0.0 requires IRONLORE_PUBLIC_URL set to an https:// origin.
 */
export function validateBind(host: string): void {
  if (LOOPBACK_ADDRESSES.has(host)) {
    return; // loopback is always safe
  }

  const publicUrl = process.env.IRONLORE_PUBLIC_URL;

  if (!publicUrl) {
    console.error(
      `Error: binding to ${host} requires IRONLORE_PUBLIC_URL to be set.\n` +
        `Set IRONLORE_PUBLIC_URL=https://your-domain.com to enable remote access,\n` +
        `or omit IRONLORE_BIND to use the default (${DEFAULT_HOST}).`,
    );
    process.exit(1);
  }

  if (!publicUrl.startsWith("https://")) {
    console.error(
      `Error: IRONLORE_PUBLIC_URL must start with https://\n` +
        `Got: ${publicUrl}\n` +
        `HTTPS is required for remote access — no exceptions.`,
    );
    process.exit(1);
  }
}
