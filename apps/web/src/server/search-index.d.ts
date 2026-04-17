import { type PageType } from "@ironlore/core";
export interface WikiLink {
    target: string;
    /** Optional relation type from the `[[target | rel]]` pipe form. */
    rel: string | null;
}
/**
 * Extract wiki-link targets from markdown content.
 * Returns deduplicated target page names with optional relation types.
 */
export declare function extractWikiLinks(markdown: string): WikiLink[];
export interface SearchResult {
    path: string;
    title: string;
    snippet: string;
    rank: number;
}
export interface BacklinkEntry {
    sourcePath: string;
    linkText: string;
    /** Typed-relation label from `[[target | rel]]` syntax, or null for plain links. */
    rel: string | null;
}
/**
 * Derived search index backed by `.ironlore/index.sqlite`.
 *
 * Contains:
 * - FTS5 full-text search over page content
 * - Backlinks table (wiki-link cross-references)
 * - Tags extracted from frontmatter
 * - Recent-edits tracking
 *
 * Rebuilt incrementally on every page write. Can be fully regenerated
 * from `data/` via `reindexAll()`.
 */
export declare class SearchIndex {
    private db;
    constructor(projectDir: string);
    private init;
    /**
     * Index a page after a write. Replaces any existing entry for this path.
     */
    indexPage(pagePath: string, content: string, author: string): void;
    /**
     * Remove a page from the index (after deletion).
     */
    removePage(pagePath: string): void;
    /**
     * Full-text search via FTS5. Returns results ranked by relevance.
     *
     * Each bare token is wrapped in double-quotes (to escape FTS operators)
     * and suffixed with `*` for prefix matching — so typing "carou" matches
     * "carousel". Empty queries short-circuit to an empty result.
     */
    search(query: string, limit?: number): SearchResult[];
    /**
     * Get all pages that link to the given target path or page name.
     *
     * Optionally filters by typed relation (`[[target | rel]]` syntax).
     * When `rel` is provided, only backlinks with that exact relation
     * label are returned. When omitted, all backlinks (typed + untyped)
     * are returned so existing callers behave unchanged.
     *
     * See docs/01-content-model.md §Wiki-link relations.
     */
    getBacklinks(targetPath: string, rel?: string): BacklinkEntry[];
    /**
     * Get all outgoing links from a page.
     */
    getOutlinks(sourcePath: string): string[];
    /**
     * Get pages by tag.
     */
    getPagesByTag(tag: string): string[];
    /**
     * Get recently edited pages.
     */
    getRecentEdits(limit?: number): Array<{
        path: string;
        updatedAt: string;
        author: string;
    }>;
    /**
     * Full reindex from filesystem. Nukes all existing data and rebuilds.
     * Called by `ironlore reindex`.
     *
     * Markdown files are indexed inline. Extractable binaries (.docx /
     * .xlsx / .eml) are queued and processed asynchronously after the walk
     * so a slow extractor doesn't hold up tree population.
     */
    reindexAll(dataRoot: string): Promise<{
        indexed: number;
    }>;
    /**
     * Insert or update a page entry in the pages table.
     * Also ensures all ancestor directories exist as entries.
     */
    upsertPage(pagePath: string, fileType: PageType | "directory"): void;
    /**
     * Ensure all directories in the chain exist as page entries.
     */
    private ensureDirectoryChain;
    /**
     * Delete a page from the pages table.
     */
    deletePage(pagePath: string): void;
    /**
     * Get all pages for the tree, ordered by path.
     */
    getTree(): Array<{
        path: string;
        name: string;
        type: PageType | "directory";
    }>;
    close(): void;
}
//# sourceMappingURL=search-index.d.ts.map