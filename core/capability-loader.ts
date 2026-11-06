import type { CraftStore } from "./infrastructure/store.ts";

/**
 * Lazy capability loader (kernel lazy-loading plan).
 *
 * Optional product capabilities (Knowledge, Memory, Experience, Codebase, Eval,
 * Datasec) are described up front but their modules are imported only when a
 * product surface or plugin page actually asks. The core boots knowing the
 * descriptors and nothing else, so a page that is never opened never pulls its
 * module onto the startup path.
 */
export type CapabilityDescriptor = {
  id: string;
  label: string;
  load: () => Promise<unknown>;
};

export class CapabilityLoader {
  private readonly descriptors = new Map<string, CapabilityDescriptor>();
  private readonly loaded = new Map<string, unknown>();
  private readonly loading = new Map<string, Promise<unknown>>();
  readonly store: CraftStore;

  constructor(store: CraftStore) { this.store = store; }

  /** Register a descriptor. Never triggers the module import. */
  describe(descriptor: CapabilityDescriptor): void {
    if (!descriptor || typeof descriptor.id !== "string" || !descriptor.id.trim()) throw new Error("capability descriptor id is required");
    if (typeof descriptor.load !== "function") throw new Error("capability descriptor load must be a function");
    if (this.descriptors.has(descriptor.id)) throw new Error(`capability already described: ${descriptor.id}`);
    this.descriptors.set(descriptor.id, descriptor);
  }

  /** Descriptors available without loading anything. */
  catalog(): Array<{ id: string; label: string; loaded: boolean }> {
    return [...this.descriptors.values()].map((item) => ({ id: item.id, label: item.label, loaded: this.loaded.has(item.id) }));
  }

  /** Whether a module has been pulled in (for the startup zero-load assertion). */
  isLoaded(id: string): boolean { return this.loaded.has(id); }

  loadedCount(): number { return this.loaded.size; }

  /** Import the module on demand; concurrent callers share one load. */
  async ensureLoaded(id: string): Promise<unknown> {
    const descriptor = this.descriptors.get(id);
    if (!descriptor) throw new Error(`unknown capability: ${id}`);
    if (this.loaded.has(id)) return this.loaded.get(id);
    const inFlight = this.loading.get(id);
    if (inFlight) return inFlight;
    const promise = Promise.resolve().then(() => descriptor.load())
      .then((module) => { this.loaded.set(id, module); this.loading.delete(id); return module; })
      .catch((error) => { this.loading.delete(id); throw error; });
    this.loading.set(id, promise);
    return promise;
  }
}
