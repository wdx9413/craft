import { createHash } from "node:crypto";
const DEFAULT_TIMEOUT_MS = 5_000;
function endpoint(baseUrl) {
    return `${baseUrl.replace(/\/$/, "")}/embeddings`;
}
function failureReason(error) {
    if (error instanceof DOMException && ["TimeoutError", "AbortError"].includes(error.name))
        return "timeout";
    const message = error instanceof Error ? error.message : "";
    if (/^HTTP (401|403)\b/.test(message))
        return "authentication";
    if (/invalid embedding response|embedding dimensions/i.test(message))
        return "invalid_response";
    return "provider_error";
}
function validateVectors(value, expected) {
    if (!Array.isArray(value) || value.length !== expected)
        throw new Error("Invalid embedding response");
    const vectors = value.map((vector) => {
        if (!Array.isArray(vector) || !vector.length || vector.some((number) => typeof number !== "number" || !Number.isFinite(number))) {
            throw new Error("Invalid embedding response");
        }
        return vector;
    });
    if (new Set(vectors.map((vector) => vector.length)).size !== 1)
        throw new Error("Embedding dimensions differ");
    return vectors;
}
export function embeddingFingerprint(config) {
    return createHash("sha256").update(JSON.stringify({ protocol: config.protocol, baseUrl: config.baseUrl, model: config.model }))
        .digest("hex").slice(0, 24);
}
export function semanticFailureReason(error) { return failureReason(error); }
export class OpenAiCompatibleEmbeddingProvider {
    fingerprint;
    label;
    config;
    constructor(config) {
        this.config = config;
        this.fingerprint = embeddingFingerprint(config);
        this.label = { name: config.name, model: config.model };
    }
    async embed(texts) {
        if (!texts.length)
            return [];
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.config.timeoutMs ?? DEFAULT_TIMEOUT_MS);
        try {
            const key = this.config.apiKeyEnv ? process.env[this.config.apiKeyEnv] : undefined;
            const response = await fetch(endpoint(this.config.baseUrl), {
                method: "POST", signal: controller.signal,
                headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
                body: JSON.stringify({ model: this.config.model, input: texts }),
            });
            if (!response.ok)
                throw new Error(`HTTP ${response.status}`);
            const payload = await response.json();
            const data = payload && typeof payload === "object" && !Array.isArray(payload)
                ? payload.data : undefined;
            if (!Array.isArray(data))
                throw new Error("Invalid embedding response");
            const ordered = [...data].sort((left, right) => Number(left.index) - Number(right.index))
                .map((item) => item && typeof item === "object" && !Array.isArray(item) ? item.embedding : undefined);
            return validateVectors(ordered, texts.length);
        }
        finally {
            clearTimeout(timer);
        }
    }
}
export function sanitizeEmbeddingText(value) {
    return value.replace(/(?:api[_-]?key|authorization|cookie|password|secret|token)\s*[:=]\s*[^\s]+/giu, "[redacted]");
}
export function cosine(left, right) {
    if (left.length !== right.length || !left.length)
        throw new Error("Embedding dimensions differ");
    let dot = 0;
    let leftNorm = 0;
    let rightNorm = 0;
    for (let index = 0; index < left.length; index += 1) {
        dot += left[index] * right[index];
        leftNorm += left[index] ** 2;
        rightNorm += right[index] ** 2;
    }
    if (!leftNorm || !rightNorm)
        return 0;
    return dot / Math.sqrt(leftNorm * rightNorm);
}
//# sourceMappingURL=semantic.js.map