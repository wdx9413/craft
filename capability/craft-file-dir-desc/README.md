# @craft/capability-file-dir-desc

A self-evolving registry that maps directories to human-readable semantic descriptions and back.

Part of the [Craft](https://github.com/wdx9413/craft) agent work runtime. This package is consumed by the Craft core and can also be used standalone.

## Usage

```ts
import { FileDirDescRegistry } from "@craft/capability-file-dir-desc";
import { CraftStore } from "craft-common-store-local";

const store = await new CraftStore(craftPaths()).open();
const registry = new FileDirDescRegistry(store);

// Record a directory with a description
registry.record({ path: "/home/user/projects/billing", description: "billing service monorepo" });

// Resolve a description back to a path
const result = registry.resolve({ description: "billing service" });
```

## License

MIT
