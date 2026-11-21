export * from 'craft-common-store-local/store';
import { CraftStore as LocalCraftStore } from 'craft-common-store-local/store';
import { join } from "node:path";
import { craftPaths } from "./paths.ts";
import { assertStorageAvailable, catalogOwner, presentStorageOwners, STORAGE_OWNERS } from "./owned-catalog.ts";

/** Keep shared Runtime entry points from creating a second publication catalog. */
export class CraftStore extends LocalCraftStore {
  override async open(options?: Parameters<LocalCraftStore["open"]>[0]): Promise<this> {
    assertStorageAvailable(this.paths.root);
    if (this.paths.databaseFile === craftPaths(this.paths.root).databaseFile && (catalogOwner(this.paths.root) || presentStorageOwners(this.paths.root).length || STORAGE_OWNERS.some(owner => catalogOwner(join(this.paths.root, owner))))) {
      throw new Error("This data space is owned by a standalone product");
    }
    return super.open(options);
  }
}
