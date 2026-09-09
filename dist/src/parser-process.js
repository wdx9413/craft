import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { SecurityBrokerKernel } from "./security.js";
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
function text(value, name) {
    if (typeof value !== "string" || !value.trim())
        throw new Error(`${name} must not be empty`);
    return value;
}
export function resolveParserWorkerPath(entry = process.argv[1] ?? "", cwd = process.cwd(), fileExists = existsSync) {
    const entryDir = dirname(entry);
    const candidates = entry.endsWith(".ts")
        ? [join(cwd, "bin", "craft-parser-worker.ts")]
        : [join(entryDir, "craft-parser-worker.js"), join(entryDir, "..", "bin", "craft-parser-worker.js"),
            join(cwd, "dist", "bin", "craft-parser-worker.js")];
    const found = candidates.find(fileExists);
    if (!found)
        throw new Error("Parser worker entrypoint is unavailable; rebuild the Craft distribution");
    return found;
}
export function scrubParserEnvironment(environment = process.env) {
    const names = ["SystemRoot", "WINDIR", "TMP", "TEMP", "TMPDIR"];
    return { ...Object.fromEntries(names.flatMap((name) => environment[name] === undefined ? [] : [[name, environment[name]]])),
        NODE_V8_COVERAGE: "" };
}
export function runParserWorker(request, options = {}) {
    const path = options.workerPath ?? resolveParserWorkerPath();
    const timeoutMs = options.timeoutMs ?? 5_000;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 10 || timeoutMs > 30_000)
        throw new Error("timeout_ms must be an integer between 10 and 30000");
    return new Promise((resolve, reject) => {
        const args = [...(path.endsWith(".ts") ? ["--experimental-strip-types"] : []), "--max-old-space-size=64", path];
        const child = (options.spawnProcess ?? spawn)(process.execPath, args, { stdio: ["pipe", "pipe", "pipe"], env: scrubParserEnvironment(), windowsHide: true });
        let stdout = "";
        let stderr = "";
        let settled = false;
        const finish = (error, result) => {
            settled = true;
            clearTimeout(timer);
            error ? reject(error) : resolve(result);
        };
        const timer = setTimeout(() => { child.kill(); finish(new Error("Parser worker timed out")); }, timeoutMs);
        child.on("error", (error) => finish(error));
        child.stdout.on("data", (chunk) => {
            stdout += chunk.toString("utf8");
            if (Buffer.byteLength(stdout) > MAX_OUTPUT_BYTES) {
                child.kill();
                finish(new Error("Parser worker output exceeded 2 MiB"));
            }
        });
        child.stderr.on("data", (chunk) => { if (stderr.length < 4096)
            stderr += chunk.toString("utf8"); });
        child.on("close", (code) => {
            if (settled)
                return;
            let response;
            try {
                response = JSON.parse(stdout);
            }
            catch {
                finish(new Error(`Parser worker returned invalid JSON${stderr ? ": " + stderr.trim() : ""}`));
                return;
            }
            if (code !== 0 || response.ok !== true) {
                finish(new Error(String(response.error ?? `Parser worker exited with code ${code}`)));
                return;
            }
            finish(undefined, response.analysis);
        });
        child.stdin.end(JSON.stringify(request));
    });
}
export class ParserProcessAdapter {
    security;
    constructor(security) { this.security = security; }
    async parse(args) {
        const contentId = text(args.content_id, "content_id").trim();
        const raw = text(args.raw_content, "raw_content");
        const content = this.security.store.get("untrusted_content", contentId);
        const digest = `sha256:${createHash("sha256").update(raw).digest("hex")}`;
        if (content.content_digest !== digest)
            throw new Error("raw_content digest does not match the registered content envelope");
        const receiptId = typeof args.receipt_id === "string" && args.receipt_id.trim() ? args.receipt_id.trim()
            : `parser_process_${randomUUID().replaceAll("-", "")}`;
        const started = Date.now();
        try {
            const analysis = await runParserWorker({ raw_content: raw, format: args.format, selectors: args.selectors }, { timeoutMs: args.timeout_ms === undefined ? undefined : Number(args.timeout_ms) });
            const parserFormat = String(analysis.format);
            const parserSelectors = analysis.selectors;
            const fieldSources = Object.fromEntries(Object.entries(parserSelectors).map(([field, selector]) => [field, { selector, citations: [`content:${contentId}${selector}`] }]));
            const result = this.security.extractionRecord({ content_id: contentId, extraction_id: args.extraction_id,
                extractor: `craft-parser-process-${parserFormat}-v1`, schema_id: text(args.schema_id, "schema_id").trim(),
                structured_data: analysis.structured_data, field_sources: fieldSources,
                detected_instructions: analysis.detected_instructions, citations: [`content:${contentId}`] });
            const receipt = this.security.store.create("parser_process_receipt", receiptId, { content_id: contentId,
                content_digest: digest, worker_protocol: 1, status: "passed", duration_ms: Date.now() - started,
                extraction_id: result.extraction.id, raw_content_stored: false });
            return { ...result, receipt };
        }
        catch (error) {
            this.security.store.create("parser_process_receipt", receiptId, { content_id: contentId, content_digest: digest,
                worker_protocol: 1, status: "failed", duration_ms: Date.now() - started,
                error_type: "ParserProcessError", raw_content_stored: false });
            throw error;
        }
    }
}
//# sourceMappingURL=parser-process.js.map