import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { CraftStore } from "./store.js";
function text(value, name) { if (typeof value !== "string" || !value.trim())
    throw new Error(`${name} must not be empty`); return value.trim(); }
function digest(value) { return `sha256:${createHash("sha256").update(String(value)).digest("hex")}`; }
function recordDigest(value) { return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`; }
function safeChild(root, path) {
    const target = resolve(root, path);
    /* node:coverage ignore next */
    if (relative(root, target).startsWith(".."))
        throw new Error("Project Knowledge path escapes the trusted project root");
    return target;
}
function noSecret(value) { if (/(?:api[_-]?key|password|secret|token)\s*[:=]\s*[^\s]{8,}/i.test(value))
    throw new Error("Project Knowledge content appears to contain a secret"); }
/** Read-only bridge for Serena's project-local Markdown memories. It never writes .serena. */
export class ProjectKnowledgeKernel {
    store;
    constructor(store) { this.store = store; }
    discover(args) {
        if (args.trusted !== true)
            throw new Error("Project Knowledge discovery requires trusted=true");
        const projectRoot = resolve(text(args.project_root, "project_root"));
        const memoriesRoot = safeChild(projectRoot, ".serena/memories");
        const children = existsSync(memoriesRoot) ? readdirSync(memoriesRoot, { withFileTypes: true }) : [];
        if (children.some((entry) => entry.isSymbolicLink()))
            throw new Error("Project Knowledge does not follow symbolic links");
        const entries = children.filter((entry) => entry.isFile() && entry.name.endsWith(".md")).sort((a, b) => a.name.localeCompare(b.name)).map((entry) => {
            const path = safeChild(memoriesRoot, entry.name);
            const stat = lstatSync(path);
            /* node:coverage ignore next */
            if (stat.isSymbolicLink())
                throw new Error("Project Knowledge does not follow symbolic links");
            const content = readFileSync(path, "utf8");
            return { memory_id: `serena:${entry.name.slice(0, -3)}`, path: `.serena/memories/${entry.name}`, name: entry.name.slice(0, -3), digest: digest(content), size_bytes: stat.size };
        });
        const identity = { project_root: projectRoot, provider: "serena_project_memory", descriptors: entries };
        const discoveryId = String(args.discovery_id ?? `project_knowledge_${recordDigest(identity).slice(-16)}`);
        const existing = this.store.find("project_knowledge_discovery", discoveryId);
        const discoveryDigest = recordDigest(identity);
        if (existing) {
            if (existing.discovery_digest !== discoveryDigest)
                throw new Error("Project Knowledge discovery idempotency conflict");
            return { discovery: existing, idempotent: true };
        }
        return { discovery: this.store.create("project_knowledge_discovery", discoveryId, { ...identity, discovery_digest: discoveryDigest }), idempotent: false };
    }
    resolve(args) {
        const discovery = this.store.get("project_knowledge_discovery", text(args.discovery_id, "discovery_id"));
        const requested = Array.isArray(args.memory_ids) ? args.memory_ids.map((item) => text(item, "memory_ids")) : [];
        if (!requested.length || requested.length > 3 || new Set(requested).size !== requested.length)
            throw new Error("Project Knowledge resolve accepts one to three unique memory_ids");
        const maxChars = args.max_chars === undefined ? 12_000 : Number(args.max_chars);
        if (!Number.isInteger(maxChars) || maxChars < 1 || maxChars > 100_000)
            throw new Error("max_chars must be an integer between 1 and 100000");
        const descriptors = new Map(discovery.descriptors.map((item) => [item.memory_id, item]));
        const root = text(discovery.project_root, "project_root");
        let used = 0;
        const memories = requested.map((memoryId) => { const entry = descriptors.get(memoryId); if (!entry)
            throw new Error("Project Knowledge memory is not in this discovery"); const path = safeChild(root, entry.path); const stat = lstatSync(path); if (stat.isSymbolicLink())
            throw new Error("Project Knowledge does not follow symbolic links"); const content = readFileSync(path, "utf8"); if (digest(content) !== entry.digest)
            throw new Error("Project Knowledge memory changed since discovery"); noSecret(content); used += content.length; if (used > maxChars)
            throw new Error("Project Knowledge exceeds max_chars"); return { memory_id: entry.memory_id, name: entry.name, content, digest: entry.digest }; });
        const identity = { discovery_id: discovery.id, discovery_version: discovery.version, selected: memories.map(({ memory_id, name, digest: itemDigest }) => ({ memory_id, name, digest: itemDigest })), max_chars: maxChars };
        const resolutionId = String(args.resolution_id ?? `project_knowledge_resolution_${recordDigest(identity).slice(-16)}`);
        const existing = this.store.find("project_knowledge_resolution", resolutionId);
        const resolutionDigest = recordDigest(identity);
        if (existing) {
            if (existing.resolution_digest !== resolutionDigest)
                throw new Error("Project Knowledge resolution idempotency conflict");
            return { resolution: existing, memories, idempotent: true };
        }
        return { resolution: this.store.create("project_knowledge_resolution", resolutionId, { ...identity, resolution_digest: resolutionDigest }), memories, idempotent: false };
    }
    proposeUpdate(args) {
        const discovery = this.store.get("project_knowledge_discovery", text(args.discovery_id, "discovery_id"));
        const evidenceIds = Array.isArray(args.evidence_ids) ? args.evidence_ids.map((item) => text(item, "evidence_ids")) : [];
        if (!evidenceIds.length)
            throw new Error("Project Knowledge update proposal requires evidence_ids");
        for (const evidenceId of evidenceIds)
            this.store.get("evidence", evidenceId);
        const identity = { discovery_id: discovery.id, discovery_version: discovery.version, memory_id: text(args.memory_id, "memory_id"), evidence_ids: evidenceIds, summary_digest: recordDigest(text(args.summary, "summary")) };
        if (!discovery.descriptors.some((item) => item.memory_id === identity.memory_id))
            throw new Error("Project Knowledge update target is not in discovery");
        const proposalId = String(args.proposal_id ?? `project_knowledge_proposal_${recordDigest(identity).slice(-16)}`);
        const existing = this.store.find("project_knowledge_proposal", proposalId);
        const proposalDigest = recordDigest(identity);
        if (existing) {
            if (existing.proposal_digest !== proposalDigest)
                throw new Error("Project Knowledge proposal idempotency conflict");
            return { proposal: existing, idempotent: true };
        }
        return { proposal: this.store.create("project_knowledge_proposal", proposalId, { ...identity, proposal_digest: proposalDigest, lifecycle: "draft", writes_external_memory: false }), idempotent: false };
    }
}
//# sourceMappingURL=project-knowledge.js.map