import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { SessionStore } from "./auth.js";

/**
 * Shared cookie + session authentication for WebSocket upgrade
 * handlers. Both the real-time event stream (`/ws`) and the terminal
 * PTY (`/ws/terminal`) go through this so there's one auth code path
 * per the spec — *"no separate port, no separate process, no
 * separate login"* (docs/06-implementation-roadmap.md Phase 3).
 */

export const SESSION_COOKIE = "ironlore_session";

/**
 * Extract the value of a named cookie from a raw `Cookie:` header.
 * Handles the common cases (no whitespace, lots of whitespace, values
 * containing `=`). Returns null when the cookie is absent or malformed.
 */
export function parseCookieValue(cookieHeader: string | undefined, name: string): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return null;
}

/**
 * Authenticate an HTTP-upgrade request against the session store. On
 * success invokes `onAuthorized`; on failure writes a 401 to the raw
 * socket and destroys it. Callers never see the unauthenticated
 * upgrade — the helper closes the socket before returning.
 */
export function authenticateUpgrade(
  req: IncomingMessage,
  socket: Duplex,
  sessionStore: SessionStore,
  verifySessionCookie: (cookie: string) => string | null,
  onAuthorized: () => void,
): void {
  // Reasoned response body so a debugging client (websocat,
  // a hand-rolled wscat, the browser DevTools network tab) sees
  // *why* the upgrade was refused instead of the bare "WebSocket
  // protocol error" the client surfaces by default.
  const reject = (reason: string) => {
    const body = `WebSocket upgrade refused: ${reason}\n`;
    socket.write(
      `HTTP/1.1 401 Unauthorized\r\n` +
        `Content-Type: text/plain; charset=utf-8\r\n` +
        `Content-Length: ${Buffer.byteLength(body)}\r\n` +
        `Connection: close\r\n\r\n` +
        body,
    );
    socket.destroy();
  };

  const cookieValue = parseCookieValue(req.headers.cookie, SESSION_COOKIE);
  if (!cookieValue) {
    reject(`missing '${SESSION_COOKIE}' cookie (forward it via the Cookie header)`);
    return;
  }

  const sessionId = verifySessionCookie(cookieValue);
  if (!sessionId) {
    reject("session cookie failed signature verification");
    return;
  }

  const session = sessionStore.getSession(sessionId);
  if (!session) {
    reject("session not found (expired or revoked — re-login)");
    return;
  }

  onAuthorized();
}
