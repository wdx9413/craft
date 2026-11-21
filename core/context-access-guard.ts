import {
  ContextReadGuard as LocalContextReadGuard,
  assertContextReadCurrent as assertLocalContextReadCurrent,
  type ContextReadRef,
} from "craft-common-store-local/context-access-guard";
import type { CraftStore, JsonObject } from "./infrastructure/store.ts";

export { ContextAccessChangedError } from "craft-common-store-local/context-access-guard";
export type { ContextReadRef } from "craft-common-store-local/context-access-guard";

export type ContextOwnerStores = ReadonlyMap<string, CraftStore>;

function referenceOwner(ref: ContextReadRef): string | undefined {
  return (ref as ContextReadRef & { owner?: string }).owner ?? ownerForKind(ref.kind);
}

function ownerForKind(kind: string): string | undefined {
  if (kind.startsWith("knowledge_")) return "knowledge";
  if (kind === "memory_ledger") return "memory";
  if (kind === "experience_procedure" || kind === "experience_release") return "experience";
  return undefined;
}

/** Keep authorization fences in the same owner's snapshot as the material. */
export class ContextReadGuard {
  private readonly local: LocalContextReadGuard;
  private readonly owned: boolean;
  private readonly owners = new Map<string, LocalContextReadGuard>();

  constructor(store: CraftStore, refs?: readonly ContextReadRef[], scopes?: readonly { kind: string; id: string }[],
    sourceIds: readonly string[] = [], stores: ContextOwnerStores = new Map()) {
    this.owned = store.ownerRecords;
    for (const ref of refs ?? []) if ((ref as ContextReadRef & { owner?: string }).owner && !stores.has(referenceOwner(ref)!)) throw new Error("Referenced owner is unavailable");
    const localRefs = refs?.filter(ref => !stores.has(referenceOwner(ref) ?? ""));
    this.local = new LocalContextReadGuard(store, localRefs, scopes, sourceIds);
    for (const [owner, target] of stores) {
      const ownerRefs = refs?.filter(ref => referenceOwner(ref) === owner);
      this.owners.set(owner, new LocalContextReadGuard(target, ownerRefs, scopes, sourceIds));
    }
  }

  track(kind: string, id: string, expectedVersion?: number, owner?: string): void {
    const target = owner ?? ownerForKind(kind);
    if (this.owned && target && !this.owners.has(target)) throw new Error(`${target} owner is unavailable`);
    (this.owners.get(target ?? "") ?? this.local).track(kind, id, expectedVersion);
  }

  contribution(member: string, item: JsonObject): void {
    if (this.owned && ["knowledge", "memory", "experience"].includes(member) && !this.owners.has(member)) throw new Error(`${member} owner is unavailable`);
    (this.owners.get(member) ?? this.local).contribution(member, item);
  }

  refs(): ContextReadRef[] {
    return [...this.local.refs(), ...[...this.owners].flatMap(([owner, guard]) => guard.refs().map(ref => ({ ...ref, owner })))]
      .sort((a, b) => `${a.kind}:${a.id}`.localeCompare(`${b.kind}:${b.id}`));
  }

  assertCurrent(): void {
    this.local.assertCurrent();
    for (const guard of this.owners.values()) guard.assertCurrent();
  }
}

export function assertContextReadCurrent(store: CraftStore, receipt: JsonObject | null | undefined,
  owners: ContextOwnerStores = new Map()): void {
  const refs = (receipt?.read_refs ?? []) as ContextReadRef[];
  for (const ref of refs) if ((ref as ContextReadRef & { owner?: string }).owner && !owners.has(referenceOwner(ref)!)) throw new Error("Referenced owner is unavailable");
  assertLocalContextReadCurrent(store, { read_refs: refs.filter(ref => !owners.has(referenceOwner(ref) ?? "")) });
  for (const [owner, target] of owners)
    assertLocalContextReadCurrent(target, { read_refs: refs.filter(ref => referenceOwner(ref) === owner) });
}
