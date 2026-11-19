# Craft Learning

Craft Learning turns scoped, independently supported facts and verified work outcomes into revisable assets. Knowledge, Memory and Experience keep separate ownership and storage while sharing stable project identity and Context receipts.

## Experience language

**Experience Procedure**:
A versioned, scope-bound method for completing a recurring task; it becomes routeable only after its independent evidence and evaluation gates pass.
_Avoid_: Runbook file, unverified instruction

**Experience Procedure Candidate**:
A non-routeable Experience Procedure version that can be recalled as clearly labeled provisional guidance.
_Avoid_: Verified procedure, executable workflow

**Experience Runbook**:
The readable view of an Experience Procedure Candidate or Procedure, focused on non-obvious pitfalls, the corrected method, verification, recovery and provenance.
_Avoid_: Project `docs/runbooks/` file, transcript

## Scenario language

**Scenario**:
A recurring situation with a recognizable goal, inputs and expected outcome. A Scenario has a stable identity within one project and one learning capability.
_Avoid_: Folder name, free-text category

**Coarse Scenario**:
A parent grouping for related Scenarios that share a goal or acceptance boundary but differ in their specific task or verifier.
_Avoid_: Catch-all category

**Fine Scenario**:
A repeatable task with sufficiently specific inputs, outcome and verification evidence to compare independent runs.
_Avoid_: One-off task, command-only bucket

**Scenario Catalog**:
A versioned, project-scoped map of proposed and active Coarse and Fine Scenarios, their aliases, evidence and parent relationships.
_Avoid_: Global taxonomy, directory tree

**Scenario Proposal**:
A model-suggested change to a catalog, backed by source or outcome references and awaiting its evidence threshold.
_Avoid_: Active Scenario

**Project-scoped correction**:
An explicit user correction that immediately applies to relevant work in one project, can be inspected and revoked, and does not silently become a global preference.
_Avoid_: Global personalization

**Minimal Sufficient Context**:
A bounded projection that preserves verifiable references, versions, digests, constraints and omission reasons first, then expands source bodies on demand.
_Avoid_: Full-text recall, global prompt, maximal context

**Governed Learning Loop**:
The evidence-gated chain from scoped, sanitized observations to independently evaluated task effects under a pre-bound Evaluation Contract, staged activation, automatic rollback and user revocation.
_Avoid_: Self-modifying Agent, automatic publication

**Evolution Value Gate**:
A versioned decision step that routes a task observation to a durable asset candidate, review, or discard with an auditable reason; it does not verify truth or grant authority.
_Avoid_: Truth validator, scenario allowlist

**Cross-project generalization**:
Promotion of a project-scoped candidate into user-level reuse after de-identification, independent evidence from multiple projects and evaluation under a pre-bound contract.
_Avoid_: Global tag, automatic sharing

**Readiness Doctor**:
A content-free readiness projection that separates configured state from observed Host execution, worker state, Context usage and learning outcomes.
_Avoid_: Health check, installation proof

**Verification Receipt**:
A recognized test or verification command paired with its explicit terminal result after the latest edit; it supports a Host outcome observation but does not itself promote an Experience asset.
_Avoid_: Test command alone, promotion proof

**Verification Gap**:
A Hook state in which an edit was observed but no supported verification receipt was recognized; this does not mean prior Knowledge or Memory was lost, nor that an unverified Experience observation was stored.
_Avoid_: Runtime error, unverified observation

## Extension language

**Mod**:
A versioned executable runtime module that registers Hooks, commands, or interface contributions at Craft extension points.
_Avoid_: Rule, prompt overlay, Hook

**Hook**:
A handler registered by a Mod for a named runtime event, with a declared input, permitted result, ordering, scope, and failure policy.
_Avoid_: Mod, settings file

**Rule**:
A textual instruction that shapes Agent reasoning without executing code or registering runtime event handlers.
_Avoid_: Mod, runtime module

**Mod trust**:
User authorization for an exact Mod code and permission version to run; a changed code or permission declaration requires renewed review.
_Avoid_: Package installation, permanent blanket trust

## Self-evolution language

**Evolution Ontology**:
A versioned semantic model that defines Craft concepts, typed relationships, evidence provenance and the interpretation of durable records across Craft capabilities.
_Avoid_: Knowledge graph, closed list of record tags

**Core Policy**:
The non-self-modifiable rules for approval, trust, permissions, privacy and safety that the Runtime enforces independently of evolving semantic models.
_Avoid_: Ontology, candidate policy

**Evaluation Contract**:
A versioned, predeclared acceptance definition binding a candidate family to frozen evaluation cases and environment, target metrics, regression tolerances and hard safety assertions.
_Avoid_: Candidate-authored benchmark, generic pass score

**Semantic Reclassification**:
An append-only, versioned change to a record's concept assignment that preserves its stable identity, original statement and evidence provenance.
_Avoid_: Rewriting a fact, silent migration

**Ontology Activation Pointer**:
The scope-bound decision that selects which Ontology version and classification projection currently applies to a request.
_Avoid_: Latest classification, Ontology candidate

**Coding Constraint Knowledge**:
A source-backed, scope-bound claim about a project's or organization's technology, architecture, development or security requirements; it guides interpretation but does not itself enforce code changes.
_Avoid_: Prompt rule, executable policy

**Unresolved Classification**:
A classification result whose evidence is insufficient or ambiguous; it is retained pending stronger evidence and does not change the record's retrieval or promotion behavior.
_Avoid_: Best-guess fact, forced label
