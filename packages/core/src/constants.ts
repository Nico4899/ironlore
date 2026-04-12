/** The default (and only, until Phase 5) project identifier. */
export const DEFAULT_PROJECT_ID = "main";

/** Default server bind address — loopback only. */
export const DEFAULT_HOST = "127.0.0.1";

/** Default server port. */
export const DEFAULT_PORT = 3000;

/** Bootstrap credential file name at the install root. */
export const INSTALL_JSON = ".ironlore-install.json";

/** Per-project derived state directory (never in git). */
export const DERIVED_DIR = ".ironlore";

/** Agent content directory (user content, in git). */
export const AGENTS_DIR = ".agents";

/** Agent library directory (seeded persona templates). */
export const AGENTS_LIBRARY_DIR = ".agents/.library";

/** Shared skills directory. */
export const AGENTS_SHARED_DIR = ".agents/.shared";

/** IPC token file name. */
export const IPC_TOKEN_FILE = "ipc.token";

/** File permissions for sensitive files (POSIX mode 0600). */
export const SENSITIVE_FILE_MODE = 0o600;

/** Maximum login attempts per minute (per IP + username). */
export const AUTH_RATE_LIMIT = 5;

/** Default per-run token cap. */
export const DEFAULT_TOKEN_CAP = 100_000;

/** Default per-run tool-call cap. */
export const DEFAULT_TOOL_CALL_CAP = 50;

/** Default agent tool-call rate limit (per minute). */
export const AGENT_RATE_LIMIT = 60;

/** Auto-save debounce in milliseconds. */
export const AUTOSAVE_DEBOUNCE_MS = 500;

/** Frontmatter schema version. */
export const FRONTMATTER_SCHEMA_VERSION = 1;
