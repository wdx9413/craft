import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { CraftStore } from "./store.js";
function text(value, name) { if (typeof value !== "string" || !value.trim())
    throw new Error(`${name} must not be empty`); return value.trim(); }
function digest(value) { return `sha256:${createHash("sha256").update(value).digest("hex")}`; }
/** Explicit local import for reviewed packages. It writes one chosen file and never enables a host capability. */
export class LocalCandidateImportKernel {
    store;
    constructor(store) { this.store = store; }
    async import(args) {
        const packageRecord = this.store.get("wiki_candidate_publication_package", text(args.package_id, "package_id"));
        if (packageRecord.status !== "prepared" || packageRecord.manual_import_required !== true || packageRecord.execution_authority !== false)
            throw new Error("Only a prepared non-executable manual package can be imported");
        if (args.confirmed !== true)
            throw new Error("Local package import requires explicit confirmed: true");
        const root = resolve(text(args.target_root, "target_root"));
        const requested = text(args.relative_path, "relative_path");
        const target = resolve(root, requested);
        const pathRelative = relative(root, target);
        if (!pathRelative || pathRelative.startsWith("..") || pathRelative.includes(":") || !pathRelative.endsWith(".md"))
            throw new Error("Local package import path must be a descendant Markdown file");
        const content = String(packageRecord.content);
        const importId = String(args.import_id ?? `wiki_candidate_local_import_${randomUUID().replaceAll("-", "")}`);
        const identity = { package_id: packageRecord.id, package_version: packageRecord.version, target_root: root, relative_path: pathRelative, content_digest: digest(content), reviewer: text(args.reviewer, "reviewer") };
        const existing = this.store.find("wiki_candidate_local_import", importId);
        if (existing) {
            if (existing.identity_digest !== digest(JSON.stringify(identity)))
                throw new Error("Local package import idempotency conflict");
            return { import: existing, idempotent: true };
        }
        try {
            await readFile(target, "utf8");
            throw new Error("Local package import refuses to overwrite an existing file");
        }
        catch (error) {
            if (!(error instanceof Error) || error.code !== "ENOENT")
                throw error;
        }
        await mkdir(resolve(root, pathRelative, ".."), { recursive: true });
        await writeFile(target, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
        const imported = this.store.create("wiki_candidate_local_import", importId, { ...identity, identity_digest: digest(JSON.stringify(identity)), target_uri: target, enabled: false, execution_authority: false, status: "imported" });
        return { import: imported, idempotent: false };
    }
    get(args) { return { import: this.store.get("wiki_candidate_local_import", text(args.import_id, "import_id")) }; }
}
//# sourceMappingURL=local-candidate-import.js.map