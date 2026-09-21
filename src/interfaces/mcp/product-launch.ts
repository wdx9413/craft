/**
 * Public product names are deliberately smaller and more stable than the
 * internal MCP surface registry.  Plugins, CLI users and other MCP Hosts use
 * this module; the registry remains the implementation detail that selects
 * the canonical tool catalog.
 */
export const MCP_PRODUCT_SURFACES = {
  full: "syscall",
  knowledge: "component-knowledge-daily",
  memory: "component-memory-daily",
  experience: "component-experience-daily",
} as const;

export type McpProduct = keyof typeof MCP_PRODUCT_SURFACES;
export const MCP_PRODUCT_NAMES: readonly McpProduct[] = Object.keys(MCP_PRODUCT_SURFACES) as McpProduct[];

export function productSurfaceOf(product: string): string {
  const surface = MCP_PRODUCT_SURFACES[product as McpProduct];
  if (!surface) throw new Error(`Unknown Craft MCP product: ${product}`);
  return surface;
}

type Environment = Readonly<Record<string, string | undefined>>;

function option(argv: readonly string[], name: string): string | undefined {
  const values: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] !== name) continue;
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
    values.push(value); index += 1;
  }
  if (values.length > 1) throw new Error(`${name} may be supplied only once`);
  return values[0];
}

function resolve(product: string | undefined, surface: string | undefined): string {
  const productSurface = product ? productSurfaceOf(product) : undefined;
  if (productSurface && surface && productSurface !== surface) {
    throw new Error(`Craft MCP product and surface conflict: ${product} maps to ${productSurface}, not ${surface}`);
  }
  return productSurface ?? surface ?? "syscall";
}

/**
 * Explicit CLI selection wins over inherited environment configuration.
 * When either source supplies both a product and a raw surface, they must
 * agree, so a bounded product can never be silently widened.
 */
export function resolveMcpProductMode(argv: readonly string[], environment: Environment): string {
  const cliProduct = option(argv, "--product");
  const cliSurface = option(argv, "--surface");
  if (cliProduct || cliSurface) return resolve(cliProduct, cliSurface);
  return resolve(environment.CRAFT_MCP_PRODUCT, environment.CRAFT_MCP_SURFACE);
}
