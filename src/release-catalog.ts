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
  readonly name: "craft" | "craft-knowledge" | "craft-memory" | "craft-experience";
  readonly surface: "full" | "component-knowledge-daily" | "component-memory-daily" | "component-experience-daily";
  readonly hookMember?: "knowledge" | "memory" | "experience";
  readonly category: "Productivity" | "Developer Tools";
};

export const RELEASE_PRODUCTS: readonly ReleaseProduct[] = [
  { name: "craft", surface: "full", category: "Productivity" },
  { name: "craft-knowledge", surface: "component-knowledge-daily", hookMember: "knowledge", category: "Productivity" },
  { name: "craft-memory", surface: "component-memory-daily", hookMember: "memory", category: "Productivity" },
  { name: "craft-experience", surface: "component-experience-daily", hookMember: "experience", category: "Developer Tools" },
];

/** Compatibility data may be migrated once, but is never an installable product. */
export const RETIRED_PUBLIC_PRODUCTS = ["craft-context", "craft-quality", "craft-capability", "craft-skill-quality"] as const;
export const RETIRED_MCP_PREFIXES = ["craft_workflow_evolution_", "craft_workflow_dag_"] as const;

export function releaseProduct(name: string): ReleaseProduct | undefined {
  return RELEASE_PRODUCTS.find((product) => product.name === name);
}

export function releaseProductNames(): string[] { return RELEASE_PRODUCTS.map((product) => product.name); }

export function releaseManifest(): { version: string; plugins: Array<Record<string, unknown>> } {
  return {
    version: CRAFT_RELEASE_VERSION,
    plugins: RELEASE_PRODUCTS.map((product) => ({
      name: product.name,
      source: { source: "local", path: `./plugins/${product.name}` },
      policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
      category: product.category,
    })),
  };
}
