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

  // Container escape hatch — `IRONLORE_TRUST_NETWORK_BIND=1` opts
  // out of the HTTPS public-URL requirement. Used by the bundled
  // Docker compose where the container's network namespace is
  // isolated and the Docker port mapping (`-p 127.0.0.1:3000:3000`)
  // is the actual host-exposure boundary. Outside a container this
  // env stays unset and the strict rail applies.
  if (process.env.IRONLORE_TRUST_NETWORK_BIND === "1") {
    return;
  }

  const publicUrl = process.env.IRONLORE_PUBLIC_URL;

  if (!publicUrl) {
    console.error(
      `Error: binding to ${host} requires IRONLORE_PUBLIC_URL to be set.\n` +
        `Set IRONLORE_PUBLIC_URL=https://your-domain.com to enable remote access,\n` +
        `or omit IRONLORE_BIND to use the default (${DEFAULT_HOST}).`,
    );
    process.exit(1);
    return; // unreachable at runtime, satisfies control flow when exit is mocked
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
