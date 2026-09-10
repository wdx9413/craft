---
name: craft-clarify
description: "Resolve material ambiguity before consequential work by proposing a bounded working contract; do not interrogate users for routine choices."
---

# Craft Clarify

Use this skill only when an unanswered choice could materially change the deliverable, its audience, an external effect, or the acceptance rule. Do not use it for a short answer, a reversible local edit, or details that can be safely inferred.

## Minimal clarification loop

1. State the inferred goal, deliverable, constraints, and acceptance check in two to four lines.
2. Inspect supplied files, selected Sources, and prior task state before asking anything. Do not ask for information already available there.
3. Ask at most three concrete, decision-changing questions at once. Offer a safe default when one exists.
4. If the user does not answer but work can continue safely, record the assumption in the Task Checkpoint and proceed with the smallest reversible step.
5. Before an irreversible or external action, restate the specific effect, target, and acceptance condition and use the host's approval path.

## Output contract

Keep the result structured and brief:

```text
Working contract
- Goal:
- Deliverable:
- Constraints:
- Acceptance:
- Assumptions / decisions needed:
```

Questions are not a quality signal by themselves. A good clarification reduces rework; it does not turn an otherwise clear request into a questionnaire.
