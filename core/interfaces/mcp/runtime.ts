import { existsSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { KnowledgeContribution } from "@craft/capability-knowledge/contribution";
import { MemoryContribution } from "@craft/capability-memory/contribution";
import { ExperienceContribution } from "@craft/capability-experience/contribution";
import { McpServer } from "../../mcp.ts";
import { routeOwnedService } from "../../application/owner-service.ts";
import { CraftService } from "../../application/craft-service.ts";
import { craftPaths, dataRoot } from "../../infrastructure/paths.ts";
import { CraftStore } from "../../infrastructure/store.ts";
import { assertStorageAvailable, ensureOwnedLayoutFence, initializeOwnedCatalog, presentStorageOwners, STORAGE_OWNERS, type StorageOwner } from "../../infrastructure/owned-catalog.ts";
import type { ContextContributionProvider } from "../../capability-protocol.ts";
import { mcpStorageLaunch } from "./owned-storage.ts";
import { MCP_PRODUCT_SURFACES, productSurfaceOf } from "./product-launch.ts";

export const DEFAULT_RUNTIME_MEMBERS = STORAGE_OWNERS.filter(owner => owner !== "runtime").join(",");
export const DEFAULT_CONTEXT_MEMBERS = STORAGE_OWNERS.filter(owner => owner !== "context").join(",");

export async function openCapabilityService(owner: string, environment = process.env): Promise<{ service: CraftService; store: CraftStore; mode: string; close: () => void }> {
  return openServiceRuntime(productSurfaceOf(owner), { ...environment, CRAFT_STORAGE_OWNER: owner });
}

async function openServiceRuntime(mode: string, environment = process.env): Promise<{ service: CraftService; store: CraftStore; mode: string; close: () => void }> {
  const paths = craftPaths(dataRoot(environment));
  assertStorageAvailable(paths.root);
  const contextComposition = ["component-context-agent", "component-context-daily", "component-context-complete", "component-context-owned"].includes(mode);
  const product = mode === "syscall" || mode === "full" ? "runtime" : contextComposition ? "context"
    : Object.entries(MCP_PRODUCT_SURFACES).find(([name, surface]) => name !== "full" && surface === mode)?.[0];
  const productOwner = STORAGE_OWNERS.find(owner => owner === product);
  const hasSharedDatabase = lstatSync(paths.databaseFile, { throwIfNoEntry: false })?.isFile()
    || lstatSync(paths.legacyDatabaseFile, { throwIfNoEntry: false })?.isFile();
  const existingOwners = presentStorageOwners(paths.root);
  if (!environment.CRAFT_STORAGE_OWNER && productOwner
    && (existingOwners.includes(productOwner) || !hasSharedDatabase)) environment = { ...environment, CRAFT_STORAGE_OWNER: productOwner };
  if (environment.CRAFT_STORAGE_OWNER && existsSync(join(paths.root, ".craft-storage-layout.json"))) ensureOwnedLayoutFence(paths.root);
  const launch = mcpStorageLaunch(paths, mode, environment.CRAFT_STORAGE_OWNER);
  if (launch.initializeOwner) initializeOwnedCatalog(launch.paths.root, launch.initializeOwner);
  const store = await new CraftStore(launch.paths).open({ fileRecords: environment.CRAFT_STORAGE_OWNER === undefined ? undefined : true, ownerRecords: environment.CRAFT_STORAGE_OWNER === undefined ? undefined : true });
  const stores = new Map<string, CraftStore>();
  try {
    const contributors: ContextContributionProvider[] = [];
    const services = new Map<string, CraftService>();
    const primaryOwner = STORAGE_OWNERS.find(owner => owner === environment.CRAFT_STORAGE_OWNER);
    if ((primaryOwner === "context" || primaryOwner === "runtime") && environment.CRAFT_CONTEXT_MEMBERS) {
      const members = environment.CRAFT_CONTEXT_MEMBERS.split(",");
      const allowed = STORAGE_OWNERS.filter(owner => owner !== primaryOwner) as readonly string[];
      if (new Set(members).size !== members.length || members.some(member => !allowed.includes(member))) throw new Error("Context members must name unique owned capabilities");
      for (const member of members) if (!presentStorageOwners(paths.root).includes(member as never)) {
        const runtime = await openCapabilityService(member, { ...environment, CRAFT_CONTEXT_MEMBERS: "" }); runtime.close();
      }
    }
    const dependencies: Readonly<Record<StorageOwner, readonly StorageOwner[]>> = {
      context: ["knowledge", "memory", "experience", "eval", "notes", "codebase", "runtime"],
      runtime: ["knowledge", "memory", "experience", "eval", "notes", "codebase", "context"],
      knowledge: ["eval", "runtime"], memory: ["runtime"], notes: ["runtime"], codebase: ["runtime"], experience: ["eval", "context", "knowledge", "memory", "runtime"], eval: ["experience", "context", "knowledge", "runtime"],
    };
    if (primaryOwner) {
      for (const owner of presentStorageOwners(paths.root)) {
        if (!dependencies[primaryOwner].includes(owner)) continue;
        const target = mcpStorageLaunch(paths, productSurfaceOf(owner), owner);
        const ownerStore = await new CraftStore(target.paths).open({ fileRecords: true, ownerRecords: true });
        stores.set(owner, ownerStore);
        if (primaryOwner === "context" && (owner === "knowledge" || owner === "memory" || owner === "experience")) contributors.push(owner === "knowledge" ? new KnowledgeContribution(ownerStore)
          : owner === "memory" ? new MemoryContribution(ownerStore) : new ExperienceContribution(ownerStore));
      }
    }
    const peerStores = new Map(stores);
    if (primaryOwner) peerStores.set(primaryOwner, store);
    const contextAliasStore = peerStores.get("context");
    if (contextAliasStore) {
      const experienceStore = peerStores.get("experience");
      if (experienceStore && experienceStore !== contextAliasStore) experienceStore.setProjectAliasSource(contextAliasStore);
    }
    for (const [owner, ownerStore] of stores) {
      const peerContributors: ContextContributionProvider[] = owner === "knowledge" ? [new KnowledgeContribution(ownerStore)]
        : owner === "memory" ? [new MemoryContribution(ownerStore)] : owner === "experience" ? [new ExperienceContribution(ownerStore)] : [];
      if (owner === "context") for (const [member, target] of peerStores) {
        if (member === "knowledge") peerContributors.push(new KnowledgeContribution(target));
        if (member === "memory") peerContributors.push(new MemoryContribution(target));
        if (member === "experience") peerContributors.push(new ExperienceContribution(target));
      }
      services.set(owner, routeOwnedService(await CraftService.open(ownerStore, undefined,
        { contributors: peerContributors, stores: peerStores, services, owner }, environment)));
    }
    const localContributors: ContextContributionProvider[] = primaryOwner === "knowledge" ? [new KnowledgeContribution(store)]
      : primaryOwner === "memory" ? [new MemoryContribution(store)] : primaryOwner === "experience" ? [new ExperienceContribution(store)] : [];
    const service = await CraftService.open(store, undefined,
      environment.CRAFT_STORAGE_OWNER === "context" ? { contributors, stores, services, owner: "context" }
        : primaryOwner ? { contributors: localContributors, stores: peerStores, services, owner: primaryOwner } : undefined, environment);
    const exposed = routeOwnedService(service);
    if (primaryOwner) services.set(primaryOwner, exposed);
    return { service: exposed, store, mode: launch.mode, close: () => {
      for (const ownerStore of stores.values()) ownerStore.close();
      store.close();
    } };
  } catch (error) {
    for (const ownerStore of stores.values()) ownerStore.close();
    store.close();
    throw error;
  }
}

export async function openMcpRuntime(mode: string, environment = process.env): Promise<{ server: McpServer; close: () => void }> {
  const contextComposition = [productSurfaceOf("context"), "component-context-daily", "component-context-complete", "component-context-owned"].includes(mode);
  const configured = contextComposition
    ? { ...environment, CRAFT_CONTEXT_MEMBERS: environment.CRAFT_CONTEXT_MEMBERS ?? DEFAULT_CONTEXT_MEMBERS }
    : mode === "syscall" || mode === "full" ? { ...environment, CRAFT_CONTEXT_MEMBERS: environment.CRAFT_CONTEXT_MEMBERS ?? DEFAULT_RUNTIME_MEMBERS } : environment;
  const runtime = await openServiceRuntime(mode, configured);
  try { return { server: new McpServer(runtime.service, runtime.mode), close: runtime.close }; }
  catch (error) { runtime.close(); throw error; }
}
