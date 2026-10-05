# craft-common-base

Runtime-neutral capability registry, context contribution contracts, validation, digest, scope, retrieval, and workflow helpers. This package exists because the four independently shipped capabilities need shared interfaces that do not belong to logging or persistence. It imports the `JsonObject` type from `craft-common-store-local`; no storage implementation is loaded by that type import. The root harness imports these interfaces; capabilities never import the harness.
