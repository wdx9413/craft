import type { CraftStore, JsonObject } from "./infrastructure/store.ts";

const ARTIFACT_TYPES = ["text", "image", "video", "slides"] as const;
const MODALITIES = ["text", "visual", "video", "mixed"] as const;
const USER_CHOICES = ["accepted", "rejected", "branch"] as const;
const RELIABILITY_FLOOR = 0.4;
const MAX_LINEAGE_RECORDS = 100;

type ArtifactType = (typeof ARTIFACT_TYPES)[number];
type Modality = (typeof MODALITIES)[number];
type UserChoice = (typeof USER_CHOICES)[number];

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function object(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

function isArtifactType(value: string): value is ArtifactType {
  return (ARTIFACT_TYPES as readonly string[]).includes(value);
}

function isModality(value: string): value is Modality {
  return (MODALITIES as readonly string[]).includes(value);
}

function isUserChoice(value: string): value is UserChoice {
  return (USER_CHOICES as readonly string[]).includes(value);
}

function scopeKey(scope: JsonObject): string {
  const kind = text(scope.scope_kind);
  const id = text(scope.scope_id);
  if (!kind || !id) throw new Error("scope must declare scope_kind and scope_id");
  return `${kind}:${id}`;
}

function recordScope(record: JsonObject): JsonObject {
  return object(record.scope);
}

function scopeMatches(left: JsonObject, right: JsonObject): boolean {
  return text(left.scope_kind) === text(right.scope_kind) && text(left.scope_id) === text(right.scope_id);
}

function containsPrompt(record: JsonObject, prompt: string): boolean {
  if (!prompt) return true;
  return [record.prompt, record.evaluation, ...(Array.isArray(record.source_refs) ? record.source_refs : [])]
    .some((value) => typeof value === "string" && value.toLowerCase().includes(prompt));
}

/** Thin creation-domain adapter: validation, routing and metadata lineage only. */
export class CreationAdapter {
  readonly store: CraftStore;
  constructor(store: CraftStore) { this.store = store; }

  static route(args: JsonObject): JsonObject {
    const modality = text(args.modality);
    if (modality) {
      if (!isModality(modality)) throw new Error("unsupported modality");
      return { route: "modality", modality, artifact_type: text(args.artifact_type) || null };
    }
    const artifactType = text(args.artifact_type);
    if (!artifactType) throw new Error("artifact_type or modality is required");
    if (!isArtifactType(artifactType)) throw new Error("unsupported artifact type");
    return { route: "artifact_type", artifact_type: artifactType, modality: text(args.modality) || null };
  }

  private static defaultModality(artifactType: ArtifactType): Modality {
    if (artifactType === "text") return "text";
    if (artifactType === "video") return "video";
    return "visual";
  }

  private denyOtherDomain(domain: string): boolean {
    return Boolean(domain && domain !== "creation");
  }

  private normalizeScope(value: unknown): JsonObject {
    const scope = object(value);
    if (!Object.keys(scope).length) return { scope_kind: "global", scope_id: "creation" };
    scopeKey(scope);
    return scope;
  }

  private lineageId(value: unknown): string {
    const id = text(value);
    if (!id) throw new Error("id is required");
    return id.startsWith("artifact_lineage_") ? id : `artifact_lineage_${id}`;
  }

  write(args: JsonObject): JsonObject {
    if (this.denyOtherDomain(text(args.domain))) return { status: "denied", reason: "domain isolation" };
    const route = CreationAdapter.route(args);
    const artifactType = route.artifact_type as ArtifactType;
    const id = this.lineageId(args.id || `creation_${Date.now()}`);
    const version = 1;
    const userChoice = text(args.user_choice);
    if (userChoice && !isUserChoice(userChoice)) throw new Error("unsupported user choice");
    const reliability = Number(args.reliability ?? 0.5);
    if (!Number.isFinite(reliability) || reliability < 0 || reliability > 1) throw new Error("reliability must be between 0 and 1");
    const scope = this.normalizeScope(args.scope);
    const modality = text(args.modality) || CreationAdapter.defaultModality(artifactType);
    const requestedVersion = Number(args.version ?? 1);
    if (!Number.isSafeInteger(requestedVersion) || requestedVersion < 1) throw new Error("version must be a positive integer");
    const signature: JsonObject = { artifact_type: artifactType, source_refs: Array.isArray(args.source_refs) ? args.source_refs : [],
      parameters: object(args.parameters), tool: args.tool === undefined ? null : text(args.tool),
      user_choice: userChoice || null, evaluation: args.evaluation === undefined ? null : text(args.evaluation) };
    const stableSignature = JSON.stringify(signature, Object.keys(signature).sort());
    const record: JsonObject = {
      id, artifact_type: artifactType, modality,
      source_refs: Array.isArray(args.source_refs) ? args.source_refs.filter((item): item is string => typeof item === "string" && Boolean(item.trim())).slice(0, 50) : [],
      prompt: args.prompt === undefined ? null : text(args.prompt),
      parameters: object(args.parameters), tool: args.tool === undefined ? null : text(args.tool), version,
      user_choice: userChoice || null, evaluation: args.evaluation === undefined ? null : text(args.evaluation),
      reliability, scope, requested_version: requestedVersion, signature_digest: stableSignature,
    };
    this.store.save("artifact_lineage", id, record);
    return { ...record, route: route.route };
  }

  recall(args: JsonObject): JsonObject {
    if (this.denyOtherDomain(text(args.domain))) return { status: "denied", reason: "domain isolation", items: [] };
    const route = CreationAdapter.route(args);
    const scope = args.scope === undefined ? null : this.normalizeScope(args.scope);
    const prompt = text(args.prompt).toLowerCase();
    const targetType = text(args.artifact_type);
    const records = this.store.list("artifact_lineage", MAX_LINEAGE_RECORDS, (item) => {
      if (scope && !scopeMatches(recordScope(item), scope)) return false;
      if (route.route === "artifact_type" && item.artifact_type !== targetType) return false;
      if (route.route === "modality" && item.modality !== route.modality) return false;
      return containsPrompt(item, prompt);
    }, false);
    const weak = records.filter((item) => Number(item.reliability) < RELIABILITY_FLOOR);
    const candidates = records.filter((item) => Number(item.reliability) >= RELIABILITY_FLOOR);
    const signatures = new Set(candidates.map((item) => String(item.signature_digest)));
    if (candidates.length > 1 && signatures.size > 1 && !signatures.has("")) {
      return { route: route.route, abstain: true, reason: "conflicting_lineage", downweighted: candidates.map((item) => String(item.id)), items: [] };
    }
    if (!candidates.length && weak.length) {
      return { route: route.route, abstain: true, reason: "low_reliability", downweighted: weak.map((item) => String(item.id)), items: [] };
    }
    const items = candidates.sort((left, right) => Number(right.reliability) - Number(left.reliability));
    return { route: route.route, abstain: false, scope, items };
  }

  apply(args: JsonObject): JsonObject {
    if (this.denyOtherDomain(text(args.domain))) return { status: "denied", reason: "domain isolation" };
    const id = this.lineageId(args.id);
    const scope = this.normalizeScope(args.scope);
    const record = this.store.find("artifact_lineage", id);
    if (!record || !scopeMatches(recordScope(record), scope)) throw new Error("artifact lineage is not in scope");
    return { status: "applied", domain: "creation", id, artifact_type: record.artifact_type, version: record.version };
  }

  forget(args: JsonObject): JsonObject {
    if (this.denyOtherDomain(text(args.domain))) return { status: "denied", reason: "domain isolation" };
    const id = this.lineageId(args.id);
    const scope = this.normalizeScope(args.scope);
    const record = this.store.find("artifact_lineage", id);
    if (!record || !scopeMatches(recordScope(record), scope)) throw new Error("artifact lineage is not in scope");
    this.store.save("artifact_lineage", id, { ...record, reliability: 0, source_refs: [], prompt: null, parameters: {}, evaluation: null });
    return { status: "forgotten", domain: "creation", id };
  }
}
