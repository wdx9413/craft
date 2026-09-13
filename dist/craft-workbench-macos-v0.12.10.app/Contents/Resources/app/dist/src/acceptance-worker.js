import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, readFile } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve } from "node:path";
import {} from "./service.js";
import {} from "./store.js";
function text(value, name) { if (typeof value !== "string" || !value.trim())
    throw new Error(`${name} must not be empty`); return value.trim(); }
function positive(value, name, fallback) { const parsed = value === undefined ? fallback : Number(value); if (!Number.isInteger(parsed) || parsed < 1)
    throw new Error(`${name} must be a positive integer`); return parsed; }
function contained(root, target) { const rel = relative(root, target); return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel)); }
async function readJsonArtifact(job) { const input = job.input; const workspace = resolve(text(input.workspace, "input.workspace")); const relativePath = text(input.relative_path, "input.relative_path"); if (isAbsolute(relativePath))
    throw new Error("input.relative_path must be relative"); const target = resolve(workspace, relativePath); if (!contained(workspace, target))
    throw new Error("input.relative_path escapes the workspace"); const stat = await lstat(target); if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 10 * 1024 * 1024)
    throw new Error("JSON evidence must be a regular non-symlink file of at most 10 MiB"); const parsed = JSON.parse(await readFile(target, "utf8")); if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("JSON evidence must contain an object"); return { data: parsed, path: relativePath }; }
function finite(value, name) { const parsed = Number(value); if (!Number.isFinite(parsed) || parsed < 0)
    throw new Error(`${name} must be a non-negative finite number`); return parsed; }
/** One cross-platform SDK tick: lease matching work, isolate evaluator failures, and submit attributable receipts. */
export async function runAcceptanceAdapterTick(service, adapterId, execute, options = {}) {
    const claimed = service.acceptanceEvaluationClaim({ adapter_id: text(adapterId, "adapter_id"), limit: options.limit, lease_seconds: options.leaseSeconds });
    const reports = [];
    for (const job of claimed.jobs) {
        let result;
        try {
            result = await execute(job);
        }
        catch (error) {
            result = { result: "blocked", summary: "Domain evaluator could not complete safely.", receipt: { error_class: error instanceof Error ? error.name : "NonErrorThrow" } };
        }
        reports.push(service.acceptanceEvaluationReport({ job_id: job.id, lease_id: job.lease_id, adapter_id: adapterId, result: result.result, summary: result.summary, receipt: result.receipt ?? {} }));
    }
    return { claimed: claimed.jobs.length, reports };
}
/** Built-in deterministic artifact check shared by documents, media, data, and development outputs. */
export async function evaluateFileArtifact(job) {
    const input = job.input;
    const configuration = job.evaluator_configuration;
    const workspace = resolve(text(input.workspace, "input.workspace"));
    const relativePath = text(input.relative_path, "input.relative_path");
    if (isAbsolute(relativePath))
        throw new Error("input.relative_path must be relative");
    const target = resolve(workspace, relativePath);
    if (!contained(workspace, target))
        throw new Error("input.relative_path escapes the workspace");
    if (!existsSync(target))
        return { result: "failed", summary: "Required artifact does not exist.", receipt: { check: "file_artifact", exists: false } };
    const stat = await lstat(target);
    if (stat.isSymbolicLink())
        return { result: "blocked", summary: "Artifact is a symbolic link and was not followed.", receipt: { check: "file_artifact", symlink: true } };
    if (!stat.isFile())
        return { result: "failed", summary: "Artifact path is not a regular file.", receipt: { check: "file_artifact", regular_file: false } };
    const maxBytes = positive(configuration.max_bytes, "configuration.max_bytes", 50 * 1024 * 1024);
    if (stat.size > maxBytes)
        return { result: "failed", summary: "Artifact exceeds the configured size limit.", receipt: { check: "file_artifact", size_bytes: stat.size, max_bytes: maxBytes } };
    const allowed = configuration.allowed_extensions === undefined ? [] : configuration.allowed_extensions;
    if (!Array.isArray(allowed) || allowed.some((item) => typeof item !== "string" || !item.startsWith(".")))
        throw new Error("configuration.allowed_extensions must contain file extensions");
    const extension = extname(target).toLowerCase();
    if (allowed.length && !allowed.map((item) => item.toLowerCase()).includes(extension))
        return { result: "failed", summary: "Artifact extension is not allowed.", receipt: { check: "file_artifact", extension } };
    const digest = createHash("sha256").update(await readFile(target)).digest("hex");
    const expected = input.expected_sha256 === undefined ? null : text(input.expected_sha256, "input.expected_sha256").toLowerCase();
    if (expected !== null && expected !== digest)
        return { result: "failed", summary: "Artifact digest does not match the expected value.", receipt: { check: "file_artifact", size_bytes: stat.size, sha256: digest, digest_match: false } };
    return { result: "passed", summary: "Artifact exists and satisfies the configured deterministic checks.", receipt: { check: "file_artifact", size_bytes: stat.size, extension, sha256: digest, digest_match: expected === null ? null : true } };
}
/** Deterministic Istanbul/nyc coverage-summary gate. It reads evidence; it never asks a model to estimate coverage. */
export async function evaluateCoverageReport(job) {
    const { data, path } = await readJsonArtifact(job);
    const configuration = job.evaluator_configuration;
    const total = data.total;
    if (!total || typeof total !== "object" || Array.isArray(total))
        throw new Error("Coverage report must contain a total object");
    const metrics = ["lines", "branches", "functions", "statements"];
    const observed = {};
    const thresholds = {};
    for (const metric of metrics) {
        const entry = total[metric];
        if (!entry || typeof entry !== "object" || Array.isArray(entry))
            throw new Error(`Coverage report total.${metric} is missing`);
        observed[metric] = finite(entry.pct, `total.${metric}.pct`);
        const threshold = finite(configuration[`${metric}_threshold`] ?? 0, `${metric}_threshold`);
        if (threshold > 100)
            throw new Error(`${metric}_threshold must not exceed 100`);
        thresholds[metric] = threshold;
    }
    const failed = metrics.filter((metric) => Number(observed[metric]) < Number(thresholds[metric]));
    return { result: failed.length ? "failed" : "passed", summary: failed.length ? `Coverage is below threshold for: ${failed.join(", ")}.` : "Coverage report satisfies every configured threshold.", receipt: { check: "coverage_report", report_path: path, observed, thresholds, failed_metrics: failed } };
}
/** Deterministic ffprobe JSON gate. The probe remains an external tool; Craft validates its structured evidence. */
export async function evaluateMediaProbeReport(job) {
    const { data, path } = await readJsonArtifact(job);
    const configuration = job.evaluator_configuration;
    const streams = data.streams;
    const format = data.format;
    if (!Array.isArray(streams) || !format || typeof format !== "object" || Array.isArray(format))
        throw new Error("Media probe must contain streams and format");
    const video = streams.find((item) => item && typeof item === "object" && item.codec_type === "video");
    const duration = finite(format.duration, "format.duration");
    const minDuration = finite(configuration.min_duration_seconds ?? 0, "min_duration_seconds");
    const minWidth = finite(configuration.min_width ?? 0, "min_width");
    const minHeight = finite(configuration.min_height ?? 0, "min_height");
    const width = video ? finite(video.width, "video.width") : 0;
    const height = video ? finite(video.height, "video.height") : 0;
    const failures = [...(!video ? ["video_stream"] : []), ...(duration < minDuration ? ["duration"] : []), ...(width < minWidth ? ["width"] : []), ...(height < minHeight ? ["height"] : [])];
    return { result: failures.length ? "failed" : "passed", summary: failures.length ? `Media probe failed: ${failures.join(", ")}.` : "Media probe satisfies the configured technical constraints.", receipt: { check: "media_probe", report_path: path, duration_seconds: duration, width, height, video_codec: video?.codec_name ?? null, audio_streams: streams.filter((item) => item && typeof item === "object" && item.codec_type === "audio").length, failed_constraints: failures } };
}
/** Run every built-in deterministic evaluator without mixing their leases or evidence. */
export async function runBuiltinAcceptanceTicks(service) { const file = await runAcceptanceAdapterTick(service, "builtin:file-artifact", evaluateFileArtifact); const coverage = await runAcceptanceAdapterTick(service, "builtin:coverage-report", evaluateCoverageReport); const media = await runAcceptanceAdapterTick(service, "builtin:media-probe", evaluateMediaProbeReport); return { file, coverage, media }; }
//# sourceMappingURL=acceptance-worker.js.map