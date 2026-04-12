/**
 * Worker process entry point — Phase 0 stub.
 *
 * The worker polls the job queue and executes agent runs. In Phase 0 it's
 * a placeholder that validates the project structure compiles. The real
 * implementation ships in Phase 4 (jobs, agents, AI panel).
 */

import { DEFAULT_PROJECT_ID } from "@ironlore/core";

console.log(`ironlore worker started (project: ${DEFAULT_PROJECT_ID})`);
console.log("Worker is a Phase 0 stub — no job processing yet.");
