# Design a repeated workflow

Use this route when a user describes repeated work but has not supplied independently observed runs. The output is a specification for review, distinct from an Experience Procedure.

1. Read the current scoped specification and available examples. Ask for the most recent concrete instance only when the repository does not supply it. Research observable facts yourself; ask the user about unresolved intent and decisions.
2. Work through the dependency frontier: example → trigger → inputs and missing/duplicate handling → steps and human decisions → outputs and acceptance → effects and budgets → failure, unknown effects, recovery and handoff → normal/empty/duplicate/failure examples. Preserve unresolved answers explicitly.
3. Save progress in Craft's **梳理流程** page using an explicit project/user/task scope. Its versioned design record supports resuming, editing and a Markdown handoff. Without the desktop, write the same scoped specification to a user-authorized repository Markdown file; the saved file is still a design artifact.
4. Before asking for a decision, prepare the deliverables, their links, the remaining question and consequences. Stop before unauthorized effects. A human checkpoint belongs where a decision is needed, not after every step by default.
5. Hand off with scope, examples, acceptance, failure disposition and unresolved questions. `ready_for_review` means all interview fields have text; it does not prove semantic completeness or successful execution. Have the implementer check the examples and unknowns before binding any Task/Policy.

Saving or confirming a design grants no execution permission. Keep `execution_authorized:false`, `acceptance_status:not_evaluated`; do not synthesize Observations to satisfy the two-source Experience gate. Actual independent outcomes may subsequently enter the normal Experience loop.

Recovery must say which operation is reversible. Stopping future recall, restoring a local file and compensating an external action are separate contracts. Reconcile uncertain outcomes before retrying.

For a small paired experiment, the repository's `scripts/eval/completion-contract.ts` supplies a fixed synthetic export-state dataset, prompts and an independent grader. Compare fresh Host outputs under the same model, budget and dataset fingerprint. Retain failures and unchanged results; its verdict never authorizes promotion or establishes production improvement.
