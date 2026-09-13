/**
 * Where a document belongs, and therefore how long it may be trusted.
 *
 * Markdown is still the source of truth; scope is metadata *about* the
 * projection, so it can be rebuilt from scratch without touching files. The
 * point of an expiry is that a stale note is worse than no note: a workflow that
 * quietly retrieves a superseded decision is harder to debug than one that
 * retrieves nothing.
 */
export declare const KNOWLEDGE_SCOPES: readonly string[];
export interface KnowledgeScopeEntry {
    path: string;
    scope: string;
    expires_at: string | null;
    updated_at: string;
}
export interface KnowledgeDocument {
    path: string;
    digest: string;
    size_bytes: number;
    chunks: number;
}
export interface KnowledgeChunk {
    heading: string | null;
    body: string;
}
export interface KnowledgePlan {
    added: KnowledgeDocument[];
    changed: KnowledgeDocument[];
    removed: KnowledgeDocument[];
}
export interface KnowledgeHit {
    path: string;
    heading: string | null;
    snippet: string;
    rank: number;
}
/** Scan a Markdown tree. Missing roots are an error, never an empty knowledge base. */
export declare function scanKnowledgeBase(root: string, options?: {
    limit?: number;
}): KnowledgeDocument[];
/**
 * Split Markdown on headings, then cap each section. Deterministic: the same
 * file always produces the same chunks in the same order.
 */
export declare function chunkMarkdown(content: string, options?: {
    maxChars?: number;
}): KnowledgeChunk[];
/** What changed on disk since the last projection. */
export declare function diffKnowledgeBase(previous: readonly KnowledgeDocument[], current: readonly KnowledgeDocument[]): KnowledgePlan;
/**
 * Build a safe FTS5 MATCH expression. Only word characters survive, so a query
 * can never inject FTS5 operators; each surviving word becomes a quoted phrase.
 */
export declare function knowledgeQueryTokens(query: string): string[];
export declare function locateSnippet(body: string, tokens: readonly string[], width?: number): string;
/**
 * The rebuildable Markdown projection. Every write is one transaction, so a
 * crash mid-sync leaves the previous projection intact rather than half-applied.
 */
export declare class KnowledgeIndex {
    readonly file: string;
    private readonly db;
    constructor(file: string);
    /**
     * Declare scope and, optionally, an expiry. Omitting `ttl_days` means the
     * document never expires on its own — which is the right default for durable
     * project knowledge and the wrong one for a task-scoped note.
     */
    setScope(entries: Array<{
        path: string;
        scope: string;
        ttl_days?: number;
    }>, now?: number): KnowledgeScopeEntry[];
    /** Scope rows, optionally narrowed to one scope. Sorted so two calls read the same. */
    scopeCatalog(scope?: string): KnowledgeScopeEntry[];
    /** Entries whose expiry has passed. A document with no expiry is never listed here. */
    expired(now?: number): KnowledgeScopeEntry[];
    /**
     * Drop expired documents from the projection and forget their scope rows.
     *
     * This removes only the rebuildable projection and scope metadata; Markdown
     * files are untouched, so "forgetting" is never destructive to the source.
     *
     * The deletes run without an explicit transaction on purpose. Forgetting is
     * idempotent — re-running it after a crash simply finishes the job — so a
     * rollback branch here would be unreachable code that still has to be
     * measured, while adding no recovery the caller does not already have.
     */
    forgetExpired(now?: number): {
        forgotten: string[];
    };
    /** Apply a plan by re-reading the Markdown. The files win over the projection, always. */
    apply(plan: KnowledgePlan, root: string): {
        documents: number;
        chunks: number;
    };
    /** The projected catalog, so a caller can diff it against the Markdown tree. */
    catalog(): KnowledgeDocument[];
    /**
     * Substring search. `trigram` needs at least three characters per term, so a
     * shorter query falls back to LIKE instead of silently returning nothing.
     */
    search(query: string, options?: {
        limit?: number;
    }): KnowledgeHit[];
    status(): {
        documents: number;
        chunks: number;
        file: string;
    };
    close(): void;
}
