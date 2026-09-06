# Multi-Agent runtime

An Agent Profile is versioned host/model metadata. A Plan node references one or more Profile IDs in fallback order and declares `id`, `role`, `objective`, `depends_on`, and `side_effect`.

Plans must be acyclic. Dispatch returns leases only for pending nodes whose dependencies passed and only within requested capacity. Submit `passed`, `failed`, or `blocked` with provenance. A failed node advances to its next Profile when available; a terminal failure blocks dependent pending nodes.

The host remains responsible for launching its native Agent and enforcing permissions. Craft coordinates and records; it does not impersonate Codex, Claude, or another runtime.
