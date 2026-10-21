import { CRAFT_RELEASE_VERSION } from "./version.ts";

/**
 * The only release-time description of an installable Craft product.
 *
 * Runtime capabilities are deliberately not listed here: a product is a
 * distribution projection, while a Capability becomes a Tool only after it
 * passes activation and Policy.  Keeping the two catalogs separate prevents a
 * new internal kernel from accidentally becoming a public install surface.
 */
export type ReleaseProduct = {
  readonly name: "craft" | "craft-context" | "craft-datasec";
  readonly surface: "full" | "component-context-complete" | "component-context-agent" | "standalone-hooks";
  readonly version?: string;
  readonly hookMember?: "context" | "knowledge" | "memory" | "experience";
  readonly category: "Productivity" | "Developer Tools";
  readonly external_marketplace: boolean;
};

export const RELEASE_PRODUCTS: readonly ReleaseProduct[] = [
  { name: "craft", surface: "full", category: "Productivity", external_marketplace: false },
  { name: "craft-context", surface: "component-context-agent", hookMember: "context", category: "Developer Tools", external_marketplace: true },
];

/** Independent hook-only products never enter the MCP/Context packer or runtime. */
export const INDEPENDENT_HOOK_PRODUCTS: readonly ReleaseProduct[] = [
  { name: "craft-datasec", surface: "standalone-hooks", version: "0.1.1", category: "Developer Tools", external_marketplace: true },
];
export function allReleaseProducts(): readonly ReleaseProduct[] { return [...RELEASE_PRODUCTS, ...INDEPENDENT_HOOK_PRODUCTS]; }

/** Compatibility data may be migrated once, but is never an installable product. */
export const RETIRED_PUBLIC_PRODUCTS = ["craft-quality", "craft-capability", "craft-skill-quality"] as const;
export const RETIRED_MCP_PREFIXES = ["craft_workflow_evolution_", "craft_workflow_dag_"] as const;

export function releaseProduct(name: string): ReleaseProduct | undefined {
  return allReleaseProducts().find((product) => product.name === name);
}

export function releaseProductNames(): string[] { return allReleaseProducts().map((product) => product.name); }
export function externalMarketplaceProducts(): readonly ReleaseProduct[] { return allReleaseProducts().filter((product) => product.external_marketplace); }
export function externalDistributionContract(): { version: string; products: Array<Record<string, unknown>> } {
  return { version: CRAFT_RELEASE_VERSION, products: externalMarketplaceProducts().map((product) => ({ name: product.name, surface: product.surface, hook_member: product.hookMember ?? null, category: product.category, ...(product.version ? { version: product.version } : {}) })) };
}

export function releaseManifest(): { version: string; plugins: Array<Record<string, unknown>> } {
  return {
    version: CRAFT_RELEASE_VERSION,
    plugins: allReleaseProducts().map((product) => ({
      name: product.name,
      source: { source: "local", path: `./plugins/${product.name}` },
      policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
      category: product.category,
    })),
  };
}
