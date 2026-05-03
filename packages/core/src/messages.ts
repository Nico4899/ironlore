/**
 * All user-facing UI strings, centralized for future i18n.
 * English-only in 1.0. This is a plain object, not an i18n library.
 */
export const messages = {
  // App
  appName: "ironlore",
  appTagline: "Self-hosted knowledge base with AI agents that remember everything.",

  // Auth
  authLoginTitle: "Sign in to Ironlore",
  authPasswordLabel: "Password",
  authPasswordPlaceholder: "Enter your password",
  authLoginButton: "Sign in",
  authInvalidCredentials: "Invalid credentials. Please try again.",
  authRateLimited: "Too many login attempts. Please wait before trying again.",
  authForcePasswordChange: "Please set a new password to continue.",
  authNewPasswordLabel: "New password",
  authConfirmPasswordLabel: "Confirm password",
  authChangePasswordButton: "Set password",

  // Errors
  errorGeneric: "Something went wrong.",
  errorNotFound: "Page not found.",
  errorConflict: "Page modified by another session — merge or discard your changes.",
  errorForbidden: "You don't have permission to access this resource.",
  errorPathTraversal: "Invalid file path.",
  errorEgressBlocked: "Network request blocked by project egress policy.",

  // Editor
  editorAutoSaved: "Saved",
  editorConflictBanner: "This page was modified elsewhere. Review changes below.",
  editorMerge: "Merge",
  editorDiscard: "Discard my changes",
  editorKeepMine: "Keep my version",
  editorMergeTitle: "Resolve {count} conflicting block(s)",
  editorMergeChooseYours: "Use yours",
  editorMergeChooseTheirs: "Use theirs",
  editorMergeKeepBoth: "Keep both",
  editorMergeEdit: "Edit",
  editorMergeSave: "Save merged",
  editorMergeYoursLabel: "Yours",
  editorMergeTheirsLabel: "Theirs",
  editorMergeBlockAdded: "Added on {side}",
  editorMergeUnresolved: "Still {count} conflict(s) to resolve.",

  // Sidebar
  sidebarSearch: "Search",
  sidebarSearchPlaceholder: "Search pages...",
  sidebarNewPage: "New page",
  sidebarNewFolder: "New folder",
  sidebarNewFile: "New file",
  sidebarRename: "Rename",
  sidebarDelete: "Delete",
  sidebarDeleteFileConfirm: "Delete {name}? This cannot be undone.",
  sidebarDeleteFolderConfirm: "Delete folder {name} and all its contents?",

  // AI panel
  aiPanelTitle: "AI",
  aiPanelPlaceholder: "Ask about your knowledge base...",
  aiPanelResuming: "Resuming conversation from where you left off.",
  aiPanelPaused: "Agent paused",
  aiPanelExhausted: "Agent budget exhausted — resets on {date}.",
  aiPanelFailureStreak: "Agent paused after {count} consecutive failures.",

  // Agents
  agentGeneral: "Librarian",
  agentEditor: "Editor",
  agentStatusActive: "Active",
  agentStatusPaused: "Paused",
  agentStatusExhausted: "Exhausted",

  // Health
  healthNotReady: "Server is starting up...",

  // Onboarding
  onboardingWelcome: "Welcome to Ironlore",
  onboardingSetPassword: "Set your admin password to get started.",
} as const;
