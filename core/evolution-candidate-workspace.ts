import { createHash } from "node:crypto";
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { ensureProjectStorageDirectory, type CraftPaths } from "../common/craft-common-store-local/src/paths.ts";
import type { CraftStore, JsonObject } from "./infrastructure/store.ts";
import { stableDigest } from "./digest.ts";

type CandidateEntry = { path: string; digest: string; size_bytes?: number };
type CandidateManifest = { schema: "craft.evolution-candidate.v1"; candidate_id: string; workspace_id: string; checkpoint_id: string;
  checkpoint_version: number; source_digest: string; entries: CandidateEntry[] };
const MAX_CANDIDATE_CHANGED_PATHS = 100;

function requireId(value: unknown, name: string): string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{1,160}$/u.test(value)) throw new Error(`${name} is invalid`);
  return value;
}

function safeRelative(value: unknown): string {
  if (typeof value !== "string" || !value || isAbsolute(value) || value.split(/[\\/]+/u).includes(".."))
    throw new Error("Candidate snapshot entry path must be relative");
  const normalized = value.replaceAll("\\", "/").replace(/^(?:\.\/)+/u, "");
  if (!normalized || normalized === ".") throw new Error("Candidate snapshot entry path must name a file");
  return normalized;
}

function ensureDirectory(path: string): void {
  const absolute = resolve(path);
  if (!existsSync(absolute)) mkdirSync(absolute, { mode: 0o700 });
  const stat = lstatSync(absolute);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("Candidate workspace path is unsafe");
}

function ensureNested(root: string, path: string): string {
  const target = resolve(root, path), rel = relative(root, target);
  let current = root;
  const parts = rel.split(/[\\/]+/u);
  for (const part of parts.slice(0, -1)) {
    current = join(current, part);
    if (!existsSync(current)) mkdirSync(current, { mode: 0o700 });
    const stat = lstatSync(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("Candidate workspace contains an unsafe directory");
  }
  return target;
}

function readNested(root: string, path: string): string {
  const target = resolve(root, path), rel = relative(root, target);
  let current = root;
  const parts = rel.split(/[\\/]+/u);
  for (const part of parts.slice(0, -1)) {
    current = join(current, part);
    const stat = lstatSync(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("Candidate checkpoint contains an unsafe directory");
  }
  const stat = lstatSync(target);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("Candidate checkpoint contains a non-regular file");
  return target;
}

function verifyWorkspaceDirectory(path: string): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("Candidate workspace directory is unsafe");
}

function verifyManifest(path: string, expected: CandidateManifest): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("Candidate manifest is unsafe");
  const actual = JSON.parse(readFileSync(path, "utf8")) as CandidateManifest;
  if (actual.schema !== expected.schema || actual.candidate_id !== expected.candidate_id || actual.workspace_id !== expected.workspace_id
    || actual.checkpoint_id !== expected.checkpoint_id || actual.checkpoint_version !== expected.checkpoint_version
    || actual.source_digest !== expected.source_digest || stableDigest(actual.entries) !== stableDigest(expected.entries))
    throw new Error("Candidate workspace idempotency conflict");
}

function candidateDirectory(paths: CraftPaths, projectRoot: string, candidateId: string): string {
  return join(ensureProjectStorageDirectory(paths, projectRoot), "evolution", "candidates", candidateId);
}

/** Materializes only an immutable Workspace checkpoint. It never copies from the mutable project tree. */
export class EvolutionCandidateWorkspace {
  readonly store: CraftStore;
  readonly paths: CraftPaths;
  readonly copyFile: (source: string, target: string) => void;
  constructor(store: CraftStore, paths: CraftPaths, copyFile: (source: string, target: string) => void = copyFileSync) {
    this.store = store; this.paths = paths; this.copyFile = copyFile;
  }

  create(args: JsonObject): JsonObject {
    const workspace = this.store.get("workspace", requireId(args.workspace_id, "workspace_id"));
    const checkpoint = this.store.get("workspace_checkpoint", requireId(args.checkpoint_id, "checkpoint_id"), Number(args.checkpoint_version));
    const candidateId = requireId(args.candidate_id, "candidate_id");
    if (checkpoint.workspace_id !== workspace.id || workspace.latest_checkpoint_id !== checkpoint.id)
      throw new Error("Candidate workspace requires the latest checkpoint for its Workspace");
    const projectRoot = realpathSync(String(workspace.root_path));
    const projectDirectory = ensureProjectStorageDirectory(this.paths, projectRoot);
    const sourceRoot = resolve(String(checkpoint.snapshot_root));
    const expectedSource = resolve(projectDirectory, "codebase", "snapshots", String(workspace.id), String(checkpoint.id));
    if (sourceRoot !== expectedSource) throw new Error("Candidate checkpoint snapshot is outside its project Codebase storage");
    let checked = this.paths.root;
    const sourceRelative = relative(checked, sourceRoot);
    for (const segment of sourceRelative.split(/[\\/]+/u)) {
      checked = join(checked, segment);
      const stat = lstatSync(checked);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("Candidate checkpoint path is unsafe");
    }
    const rawEntries = checkpoint.entries;
    if (!Array.isArray(rawEntries)) throw new Error("Candidate checkpoint entries are invalid");
    const entries: CandidateEntry[] = [];
    for (const raw of rawEntries as JsonObject[]) {
      const path = safeRelative(raw.path), digest = String(raw.digest ?? "");
      if (!/^[a-f0-9]{64}$/u.test(digest)) throw new Error("Candidate checkpoint entry digest is invalid");
      const source = readNested(sourceRoot, path), stat = lstatSync(source);
      const actualDigest = createHash("sha256").update(readFileSync(source)).digest("hex");
      if (actualDigest !== digest || (raw.size_bytes !== undefined && Number(raw.size_bytes) !== stat.size))
        throw new Error("Candidate checkpoint content failed digest verification");
      entries.push({ path, digest, ...(raw.size_bytes === undefined ? {} : { size_bytes: Number(raw.size_bytes) }) });
    }
    if (new Set(entries.map(entry => entry.path)).size !== entries.length) throw new Error("Candidate checkpoint contains duplicate paths");
    entries.sort((left, right) => left.path.localeCompare(right.path));
    const sourceDigest = stableDigest(entries.map(entry => [entry.path, entry.digest]));
    const manifest: CandidateManifest = { schema: "craft.evolution-candidate.v1", candidate_id: candidateId,
      workspace_id: String(workspace.id), checkpoint_id: String(checkpoint.id), checkpoint_version: Number(checkpoint.version),
      source_digest: sourceDigest, entries };
    const destination = candidateDirectory(this.paths, projectRoot, candidateId), parent = dirname(destination);
    ensureDirectory(dirname(parent)); ensureDirectory(parent);
    const manifestPath = join(destination, "manifest.json");
    if (existsSync(destination)) {
      const stat = lstatSync(destination);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("Candidate workspace destination is unsafe");
      verifyManifest(manifestPath, manifest);
      verifyWorkspaceDirectory(join(destination, "workspace"));
      return { candidate_id: candidateId, path: join(destination, "workspace"), manifest, status: "ready", idempotent: true };
    }
    const stage = mkdtempSync(join(parent, `.${candidateId}.staging-`));
    try {
      const workRoot = join(stage, "workspace"); ensureDirectory(workRoot);
      for (const entry of entries) {
        const source = join(sourceRoot, ...entry.path.split("/"));
        const target = ensureNested(workRoot, entry.path);
        this.copyFile(source, target);
      }
      writeFileSync(join(stage, "manifest.json"), JSON.stringify(manifest), { flag: "wx", mode: 0o600 });
      renameSync(stage, destination);
      return { candidate_id: candidateId, path: join(destination, "workspace"), manifest, status: "ready", idempotent: false };
    } catch (error) {
      if (existsSync(stage)) rmSync(stage, { recursive: true, force: true });
      throw error;
    }
  }

  get(args: JsonObject): JsonObject {
    const workspace = this.store.get("workspace", requireId(args.workspace_id, "workspace_id"));
    const checkpoint = this.store.get("workspace_checkpoint", requireId(args.checkpoint_id, "checkpoint_id"), Number(args.checkpoint_version));
    const candidateId = requireId(args.candidate_id, "candidate_id");
    const projectRoot = realpathSync(String(workspace.root_path)), destination = candidateDirectory(this.paths, projectRoot, candidateId);
    const destinationStat = lstatSync(destination);
    if (destinationStat.isSymbolicLink() || !destinationStat.isDirectory()) throw new Error("Candidate workspace destination is unsafe");
    const manifestPath = join(destination, "manifest.json");
    if (lstatSync(manifestPath).isSymbolicLink() || !lstatSync(manifestPath).isFile()) throw new Error("Candidate manifest is unsafe");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as CandidateManifest;
    if (manifest.candidate_id !== candidateId || manifest.workspace_id !== workspace.id || manifest.checkpoint_id !== checkpoint.id
      || manifest.checkpoint_version !== Number(checkpoint.version)) throw new Error("Candidate workspace binding is stale or corrupt");
    if (!Array.isArray(checkpoint.entries)) throw new Error("Candidate checkpoint entries are invalid");
    const entries = (checkpoint.entries as JsonObject[]).map(raw => {
      const path = safeRelative(raw.path), entryDigest = String(raw.digest ?? "");
      if (!/^[a-f0-9]{64}$/u.test(entryDigest)) throw new Error("Candidate checkpoint entry digest is invalid");
      return { path, digest: entryDigest, ...(raw.size_bytes === undefined ? {} : { size_bytes: Number(raw.size_bytes) }) };
    }).sort((left, right) => left.path.localeCompare(right.path));
    const expected: CandidateManifest = { schema: "craft.evolution-candidate.v1", candidate_id: candidateId, workspace_id: String(workspace.id),
      checkpoint_id: String(checkpoint.id), checkpoint_version: Number(checkpoint.version),
      source_digest: stableDigest(entries.map(entry => [entry.path, entry.digest])), entries };
    verifyManifest(manifestPath, expected);
    verifyWorkspaceDirectory(join(destination, "workspace"));
    return { candidate_id: candidateId, path: join(destination, "workspace"), manifest, status: "ready" };
  }

  /** Validates the complete candidate tree and freezes its digest for evaluation. */
  validateChanges(args: JsonObject): JsonObject {
    const opened = this.get(args), candidateRoot = String(opened.path), manifest = opened.manifest as CandidateManifest;
    const rawAllowed = args.allowed_paths;
    if (!Array.isArray(rawAllowed) || rawAllowed.length > 100) throw new Error("allowed_paths must contain at most 100 relative paths");
    const allowed = rawAllowed.map((value, index) => safeRelative(value).replace(/\/$/u, ""));
    if (new Set(allowed).size !== allowed.length) throw new Error("allowed_paths must be unique");
    const files = new Map<string, string>();
    const visit = (directory: string, prefix: string): void => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = prefix ? `${prefix}/${entry.name}` : entry.name;
        const absolute = join(directory, entry.name), stat = lstatSync(absolute);
        if (stat.isSymbolicLink()) throw new Error("Candidate workspace contains a symlink");
        if (stat.isDirectory()) visit(absolute, path);
        else if (stat.isFile()) {
          if (files.size >= 10_000) throw new Error("Candidate workspace exceeds the file limit");
          files.set(path, createHash("sha256").update(readFileSync(absolute)).digest("hex"));
        } else throw new Error("Candidate workspace contains a non-regular entry");
      }
    };
    visit(candidateRoot, "");
    const baseline = new Map(manifest.entries.map(entry => [entry.path, entry.digest]));
    const allPaths = new Set([...baseline.keys(), ...files.keys()]), changed: string[] = [];
    for (const path of [...allPaths].sort()) {
      if (baseline.get(path) === files.get(path)) continue;
      if (!allowed.some(root => path === root || path.startsWith(`${root}/`)))
        throw new Error(`Candidate changed a path outside allowed_paths: ${path}`);
      changed.push(path);
      if (changed.length > MAX_CANDIDATE_CHANGED_PATHS)
        throw new Error(`Candidate exceeds the changed-path limit (${MAX_CANDIDATE_CHANGED_PATHS})`);
    }
    return { candidate_id: manifest.candidate_id, changed_paths: changed, candidate_digest: stableDigest([...files].sort(([left], [right]) => left.localeCompare(right))) };
  }
}
