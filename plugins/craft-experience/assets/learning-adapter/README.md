# Experience learning adapter

`adapter.example.json` is the deployment contract for a Host-side distillation/evaluation worker. It intentionally contains no credentials, real reviewer, held-out dataset, or remote endpoint. Replace the two `REPLACE_...` references before enabling a worker; provide provider secrets through its environment.

The worker polls the MCP surface for learning requests, reads only the pinned sanitized observations, submits a schema-valid Workflow/Graph candidate, and then polls the candidate's next evaluation dispatch. It must run the exact dispatched procedure version in an isolated shadow workspace, use a separately controlled held-out set, obtain reviewer approval for Signoff, and run Canary against the pinned current version. For every result it records confirmed program Evidence with the dispatch-bound metadata listed in the config, then calls `craft_experience_learning_evaluation_result`. Craft queues the next stage and changes `current` only after a passing Canary.

This repository provides the stable MCP protocol, gate enforcement, deployment contract, and local acceptance test. A deployment still needs a Host-specific runner that can execute procedures and issue trustworthy Evidence; the config does not pretend Craft can execute an arbitrary external Host. A model profile must be explicitly enabled for `workflow_evolution`. No worker should treat a queued ticket as an executed model call.

Run the local protocol acceptance with:

```sh
./scripts/experience/acceptance.sh
```
