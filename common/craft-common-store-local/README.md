# craft-common-store-local

Local versioned SQLite records, migrations, Craft-compatible data paths, and Markdown content storage. `CraftStore` lives here; `core/infrastructure/*` are compatibility exports. Opening an existing Craft data directory retains the schema and migration backup behavior. Node >=23 is required for `node:sqlite`.

```ts
import { CraftStore, craftPaths } from "craft-common-store-local";
const store = await new CraftStore(craftPaths("/path/to/data")).open();
try { store.create("external_record", "id", { status: "candidate" }); } finally { store.close(); }
```
