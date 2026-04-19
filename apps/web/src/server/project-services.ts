import { join } from "node:path";
import type { WsEventInput } from "@ironlore/core";
import { FileWatcher } from "./file-watcher.js";
import { GitWorker } from "./git-worker.js";
import { LinksRegistry } from "./links-registry.js";
import { SearchIndex } from "./search-index.js";
import { StorageWriter } from "./storage-writer.js";
import type { Wal } from "./wal.js";

/**
 * Per-project service bundle (docs/08-projects-and-isolation.md
 * §Per-project state — what changes vs. what stays).
 *
 * Every project owns its own `StorageWriter`, `SearchIndex`,
 * `LinksRegistry`, `GitWorker`, and `FileWatcher`. The rails, job
 * queue, inbox, and agent-state tables are shared across projects but
 * already scoped by `project_id` in their schemas, so they don't live
 * in this bundle — callers pass `projectId` into the shared instances.
 *
 * The bundle is created eagerly at server startup for every known
 * project; if a new project is scaffolded via `ironlore new-project`,
 * the server picks it up on restart. A hot-reload path is a post-1.0
 * consideration — the restart cost is sub-second and the alternative
 * (live-mounting Hono routes) adds complexity every code path pays
 * for with no user benefit today.
 */
export class ProjectServices {
  readonly projectDir: string;
  readonly linksRegistry: LinksRegistry;
  readonly writer: StorageWriter;
  readonly searchIndex: SearchIndex;
  readonly wal: Wal;

  private gitWorker: GitWorker | null = null;
  private fileWatcher: FileWatcher | null = null;
  private started = false;

  constructor(projectDir: string) {
    this.projectDir = projectDir;
    this.linksRegistry = new LinksRegistry(this.projectDir);
    this.writer = new StorageWriter(this.projectDir, this.linksRegistry.validator());
    this.searchIndex = new SearchIndex(this.projectDir);
    this.wal = this.writer.getWal();
  }

  /** Data root (`projects/<id>/data`) — the content tree for this project. */
  getDataRoot(): string {
    return this.writer.getDataRoot();
  }

  /**
   * Replay uncommitted WAL entries, reindex pages, and start background
   * workers (git batcher + filesystem watcher). Called once at server
   * startup per project.
   */
  async start(broadcast: (event: WsEventInput) => void): Promise<{
    recovered: number;
    warnings: string[];
    warningsStructured: Array<{ path: string; message: string }>;
    indexed: number;
  }> {
    if (this.started) {
      throw new Error(`ProjectServices for ${this.projectDir} already started`);
    }
    this.started = true;

    const recovery = this.writer.recover();
    const indexResult = await this.searchIndex.reindexAll(this.getDataRoot());

    this.gitWorker = new GitWorker(this.projectDir, this.wal);
    await this.gitWorker.start();

    this.fileWatcher = new FileWatcher(this.getDataRoot(), this.wal, this.searchIndex, broadcast);
    this.fileWatcher.start();

    return {
      recovered: recovery.recovered,
      warnings: recovery.warnings,
      warningsStructured: recovery.warningsStructured,
      indexed: indexResult.indexed,
    };
  }

  /** Stop background workers and close every db handle. Idempotent. */
  async stop(): Promise<void> {
    this.fileWatcher?.stop();
    this.fileWatcher = null;
    if (this.gitWorker) {
      this.gitWorker.stop();
      this.gitWorker = null;
    }
    this.writer.close();
    this.searchIndex.close();
    this.linksRegistry.close();
    this.started = false;
  }

  /**
   * Build a project-scoped services bundle for an arbitrary project
   * directory — the install-root `projects/<id>/` convention.
   */
  static forProject(installRoot: string, projectId: string): ProjectServices {
    return new ProjectServices(join(installRoot, "projects", projectId));
  }
}
