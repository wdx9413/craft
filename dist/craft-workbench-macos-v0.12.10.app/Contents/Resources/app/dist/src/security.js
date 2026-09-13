import { createHash, randomUUID } from "node:crypto";
import { CraftStore } from "./store.js";
function text(value, name) {
    if (typeof value !== "string" || !value.trim())
        throw new Error(`${name} must not be empty`);
    return value.trim();
}
function id(value, name, prefix) {
    const result = value === undefined ? `${prefix}_${randomUUID().replaceAll("-", "")}` : text(value, name);
    if (!/^[a-zA-Z0-9_-]+$/.test(result))
        throw new Error(`${name} must contain only letters, numbers, _ or -`);
    return result;
}
function strings(value, name) {
    if (!Array.isArray(value) || !value.length)
        throw new Error(`${name} must be a non-empty array`);
    const result = value.map((item) => text(item, name));
    if (new Set(result).size !== result.length)
        throw new Error(`${name} must contain unique values`);
    return result;
}
function optionalStrings(value, name) {
    if (value === undefined)
        return [];
    if (!Array.isArray(value))
        throw new Error(`${name} must be an array`);
    const result = value.map((item) => text(item, name));
    if (new Set(result).size !== result.length)
        throw new Error(`${name} must contain unique values`);
    return result;
}
function object(value, name) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error(`${name} must be an object`);
    return value;
}
function containsSensitiveField(value) {
    if (Array.isArray(value))
        return value.some(containsSensitiveField);
    if (!value || typeof value !== "object")
        return false;
    return Object.entries(value).some(([key, child]) => /^(?:api[_-]?key|authorization|cookie|password|secret|token)$/iu.test(key) || containsSensitiveField(child));
}
function payload(record) {
    const { id: _id, version: _version, created_at: _created, updated_at: _updated, ...rest } = record;
    return rest;
}
function digest(value) { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
export class SecurityBrokerKernel {
    store;
    constructor(store) { this.store = store; }
    handleRegister(args) {
        const secretRef = text(args.secret_ref, "secret_ref");
        if (!/^env:[A-Z_][A-Z0-9_]*$/u.test(secretRef))
            throw new Error("secret_ref must be an env:VARIABLE handle, never a literal secret");
        const headerName = args.header_name === undefined ? "authorization" : text(args.header_name, "header_name").toLowerCase();
        if (!/^[a-z0-9-]+$/u.test(headerName))
            throw new Error("header_name must be a valid HTTP header name");
        const prefix = args.prefix === undefined ? "Bearer " : String(args.prefix);
        if (/\r|\n/u.test(prefix))
            throw new Error("prefix must not contain line breaks");
        const handle = this.store.create("credential_handle", id(args.handle_id, "handle_id", "credential"), {
            provider: text(args.provider, "provider"), secret_ref: secretRef, status: "active",
            header_name: headerName, prefix, description: args.description ?? null
        });
        const { secret_ref: _secretRef, ...publicHandle } = handle;
        return { handle: publicHandle };
    }
    leaseIssue(args) {
        const task = this.store.get("task", text(args.task_id, "task_id"));
        const handle = this.store.get("credential_handle", text(args.handle_id, "handle_id"));
        if (handle.status !== "active")
            throw new Error("Credential handle is not active");
        const hosts = strings(args.allowed_hosts, "allowed_hosts").map((host) => host.toLowerCase());
        if (hosts.some((host) => !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(host))) {
            throw new Error("allowed_hosts must contain exact DNS hostnames without wildcards");
        }
        const actions = strings(args.allowed_actions, "allowed_actions");
        const approvalRequired = args.approval_required_actions === undefined ? [] : strings(args.approval_required_actions, "approval_required_actions");
        if (approvalRequired.some((action) => !actions.includes(action)))
            throw new Error("Approval-required actions must also be allowed");
        const now = args.now === undefined ? Date.now() : Date.parse(text(args.now, "now"));
        if (Number.isNaN(now))
            throw new Error("now must be an ISO timestamp");
        const ttl = Number(args.ttl_seconds ?? 900);
        if (!Number.isInteger(ttl) || ttl < 1 || ttl > 3600)
            throw new Error("ttl_seconds must be an integer between 1 and 3600");
        const lease = this.store.create("credential_lease", id(args.lease_id, "lease_id", "credential_lease"), {
            task_id: task.id, handle_id: handle.id, allowed_hosts: hosts, allowed_actions: actions,
            approval_required_actions: approvalRequired, issued_at: new Date(now).toISOString(),
            expires_at: new Date(now + ttl * 1000).toISOString(), status: "active"
        });
        return { lease };
    }
    egressAuthorize(args) {
        const lease = this.store.get("credential_lease", text(args.lease_id, "lease_id"));
        if (lease.status !== "active")
            throw new Error("Credential lease is not active");
        const now = args.now === undefined ? Date.now() : Date.parse(text(args.now, "now"));
        if (Number.isNaN(now))
            throw new Error("now must be an ISO timestamp");
        if (now >= Date.parse(String(lease.expires_at)))
            throw new Error("Credential lease has expired");
        const target = new URL(text(args.url, "url"));
        if (target.protocol !== "https:" || target.username || target.password)
            throw new Error("Egress target must be an HTTPS URL without embedded credentials");
        const host = target.hostname.toLowerCase();
        const action = text(args.action, "action");
        if (!lease.allowed_hosts.includes(host))
            throw new Error("Egress host is not allowed by the credential lease");
        if (!lease.allowed_actions.includes(action))
            throw new Error("Egress action is not allowed by the credential lease");
        if (lease.approval_required_actions.includes(action) && !args.approval_ref)
            throw new Error("Egress action requires an approval reference");
        const requestDigest = text(args.request_digest, "request_digest");
        const receiptId = id(args.receipt_id, "receipt_id", "egress");
        const requestFingerprint = digest({ lease_id: lease.id, url: target.toString(), action, request_digest: requestDigest,
            approval_ref: args.approval_ref ?? null });
        const existing = this.store.find("egress_authorization", receiptId);
        if (existing) {
            if (existing.request_fingerprint !== requestFingerprint)
                throw new Error("Egress authorization idempotency conflict");
            return { authorization: existing, broker_instruction: { handle_id: lease.handle_id }, idempotent: true };
        }
        const authorization = this.store.create("egress_authorization", receiptId, { task_id: lease.task_id, lease_id: lease.id,
            handle_id: lease.handle_id, host, url: target.toString(), action, request_digest: requestDigest,
            request_fingerprint: requestFingerprint, approval_ref: args.approval_ref ?? null, status: "authorized",
            authorized_at: new Date(now).toISOString(), untrusted_input: args.untrusted_input === true });
        return { authorization, broker_instruction: { handle_id: lease.handle_id }, idempotent: false };
    }
    leaseRevoke(args) {
        const lease = this.store.get("credential_lease", text(args.lease_id, "lease_id"));
        if (lease.status === "revoked")
            return { lease, idempotent: true };
        return { lease: this.store.save("credential_lease", String(lease.id), { ...payload(lease), status: "revoked",
                revoked_reason: text(args.reason, "reason") }), idempotent: false };
    }
    contentRegister(args) {
        const task = this.store.get("task", text(args.task_id, "task_id"));
        const envelope = this.store.create("untrusted_content", id(args.content_id, "content_id", "untrusted"), {
            task_id: task.id, source_type: text(args.source_type, "source_type"), locator: text(args.locator, "locator"),
            content_digest: text(args.content_digest, "content_digest"), media_type: args.media_type ?? null,
            trust: "untrusted", raw_content_stored: false, status: "pending_extraction"
        });
        return { content: envelope };
    }
    extractionRecord(args) {
        const envelope = this.store.get("untrusted_content", text(args.content_id, "content_id"));
        const structuredData = object(args.structured_data, "structured_data");
        if (containsSensitiveField(structuredData)) {
            throw new Error("structured_data contains a possible secret assignment");
        }
        const detectedInstructions = optionalStrings(args.detected_instructions, "detected_instructions");
        const citations = optionalStrings(args.citations, "citations");
        const suppliedSources = args.field_sources === undefined ? {} : object(args.field_sources, "field_sources");
        if (Object.keys(suppliedSources).some((field) => !Object.hasOwn(structuredData, field))) {
            throw new Error("field_sources must reference existing top-level structured fields");
        }
        const fieldSources = Object.fromEntries(Object.keys(structuredData).map((field) => {
            const supplied = suppliedSources[field];
            if (supplied === undefined)
                return [field, { selector: null, citations }];
            const source = object(supplied, `field_sources.${field}`);
            return [field, { selector: text(source.selector, `field_sources.${field}.selector`),
                    citations: optionalStrings(source.citations, `field_sources.${field}.citations`) }];
        }));
        const extraction = this.store.create("untrusted_extraction", id(args.extraction_id, "extraction_id", "extraction"), {
            content_id: envelope.id, task_id: envelope.task_id, extractor: text(args.extractor, "extractor"),
            schema_id: text(args.schema_id, "schema_id"), structured_data: structuredData, detected_instructions: detectedInstructions,
            citations, field_sources: fieldSources, parser_mode: "untrusted_data_only", execution_authority: false,
            status: detectedInstructions.length ? "quarantined" : "ready_for_review"
        });
        return { extraction };
    }
    projectionRelease(args) {
        const extraction = this.store.get("untrusted_extraction", text(args.extraction_id, "extraction_id"));
        const reviewerType = text(args.reviewer_type, "reviewer_type");
        if (!new Set(["program", "human"]).has(reviewerType))
            throw new Error("reviewer_type must be program or human");
        if (String(args.verdict) !== "safe")
            throw new Error("Only a safe review can release a decision projection");
        if (extraction.status === "quarantined" && (reviewerType !== "human" || !args.approval_ref)) {
            throw new Error("Quarantined content requires human approval");
        }
        const fields = strings(args.allowed_fields, "allowed_fields");
        const source = extraction.structured_data;
        if (fields.some((field) => field.includes(".") || field.includes("/") || !Object.hasOwn(source, field))) {
            throw new Error("allowed_fields must name existing top-level structured fields");
        }
        const data = Object.fromEntries(fields.map((field) => [field, source[field]]));
        const extractionSources = extraction.field_sources;
        const fieldLineage = Object.fromEntries(fields.map((field) => [field, extractionSources[field]]));
        const projection = this.store.create("decision_projection", id(args.projection_id, "projection_id", "projection"), {
            task_id: extraction.task_id, content_id: extraction.content_id, extraction_id: extraction.id,
            allowed_fields: fields, data, field_lineage: fieldLineage, reviewer_type: reviewerType, reviewer_id: text(args.reviewer_id, "reviewer_id"),
            approval_ref: args.approval_ref ?? null, trust: "reviewed_projection", execution_authority: false,
            provenance: { content_id: extraction.content_id, extraction_id: extraction.id }, status: "released"
        });
        return { projection };
    }
    projectionExplain(args) {
        const projection = this.store.get("decision_projection", text(args.projection_id, "projection_id"));
        const extraction = this.store.get("untrusted_extraction", String(projection.extraction_id));
        const content = this.store.get("untrusted_content", String(projection.content_id));
        const requestedField = args.field === undefined ? undefined : text(args.field, "field");
        const allowedFields = projection.allowed_fields;
        if (requestedField !== undefined && !allowedFields.includes(requestedField))
            throw new Error("field is not present in the released projection");
        const selectedFields = requestedField === undefined ? allowedFields : [requestedField];
        const data = projection.data;
        const lineage = projection.field_lineage;
        return { projection_id: projection.id, trust: projection.trust, execution_authority: false,
            content: { id: content.id, source_type: content.source_type, locator: content.locator,
                content_digest: content.content_digest, media_type: content.media_type },
            extraction: { id: extraction.id, extractor: extraction.extractor, schema_id: extraction.schema_id,
                parser_mode: extraction.parser_mode, citations: extraction.citations },
            review: { reviewer_type: projection.reviewer_type, reviewer_id: projection.reviewer_id,
                approval_ref: projection.approval_ref },
            fields: Object.fromEntries(selectedFields.map((field) => [field, { value: data[field], source: lineage[field] }])) };
    }
}
//# sourceMappingURL=security.js.map