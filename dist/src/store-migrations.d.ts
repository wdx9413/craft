import type { DatabaseSync } from "node:sqlite";
/**
 * One ordered migration. `from` is the schema version before it runs, `to` is
 * the schema version after. `up` runs inside a transaction; if it throws, the
 * transaction is rolled back and the schema is unchanged. `down` reverses it
 * for explicit rollback. Both receive the raw `DatabaseSync` so tests can
 * exercise them against an in-memory DB.
 */
export interface Migration {
    from: number;
    to: number;
    description: string;
    up: (database: DatabaseSync) => void;
    down: (database: DatabaseSync) => void;
}
declare function readSchemaVersion(database: DatabaseSync): number;
declare function writeSchemaVersion(database: DatabaseSync, version: number): void;
/**
 * Ordered migration registry. Every migration declared here is part of the
 * shipped product; ad-hoc ALTER TABLE statements must never appear elsewhere.
 *
 * v0 → v1  Initial schema (meta, records, events).
 * v1 → v2  `meta.applied_at` column for the migration journal.
 * v2 → v3  `events.event_kind` and `events.outcome` projection columns used
 *          by the metrics aggregator so it does not have to JSON.parse the
 *          payload to filter.
 * v3 → v4  `effect_log` table backing Effect Policy (W11); nullable columns
 *          so existing rows remain readable. `policy_evaluations` table for
 *          the policy evaluator's verdict trail.
 */
export declare const MIGRATIONS: readonly Migration[];
export declare function findMigration(from: number, to: number): Migration[];
export interface ApplyOptions {
    /** When true, no SQL is applied and only the plan is returned. */
    dryRun?: boolean;
    /** When true, no exception is thrown if the target version equals the current one. */
    skipIfCurrent?: boolean;
}
export interface ApplyResult {
    from: number;
    to: number;
    applied: number;
    dryRun: boolean;
    migrations: Array<{
        from: number;
        to: number;
        description: string;
    }>;
}
export declare function applyMigrations(database: DatabaseSync, target?: number, options?: ApplyOptions): ApplyResult;
/**
 * Copy the source database file to `<backupsDir>/<basename>-<ts>.db`. The
 * caller passes the path explicitly because `node:sqlite`'s `DatabaseSync`
 * does not expose it. Returns the absolute backup path. This function never
 * deletes old backups; rotation is the operator's job.
 */
export declare function backupDatabase(source: string, backupsDir: string): string;
export declare function _internalsForTest(): {
    readSchemaVersion: typeof readSchemaVersion;
    writeSchemaVersion: typeof writeSchemaVersion;
};
export {};
