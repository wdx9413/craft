# craft-common-base

Runtime-neutral capability registry, context contribution contracts, validation, digest, scope, retrieval, and workflow helpers. This package exists because the four independently shipped capabilities need shared interfaces that do not belong to logging or persistence. It imports the `JsonObject` type from `craft-common-store-local`; no storage implementation is loaded by that type import. The root harness imports these interfaces; capabilities never import the harness.


Retrieval callers can use focused subpaths: `retrieval-contract` defines the interface, `keyword-retrieval` provides local BM25, and `memory-temporal-policy` selects eligible Memory revisions. These modules load neither HTTP providers nor SQLite. `embedding-retrieval` owns the optional OpenAI-compatible provider and its SQLite cache. The existing `retrieval-port` and root exports remain compatibility entries and therefore also load the optional provider implementation. Knowledge and Memory contributions use the local subpaths.
