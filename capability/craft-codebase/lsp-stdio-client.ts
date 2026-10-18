import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { relative, resolve, isAbsolute, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { JsonObject } from "../../common/craft-common-store-local/src/store.ts";
import { MAX_LSP_DOCUMENTS, MAX_RELATION_SYMBOLS } from "./lsp-config.ts";
import { cacheLspDocumentSymbols, lspDocumentSymbolsDigest, normalizeLspSymbols } from "./lsp-adapter.ts";
import { collectLspRelations, selectLspRelationSymbols } from "./lsp-relations.ts";

export type LspSnapshotDocument = { readonly path: string; readonly language: string; readonly content: string; readonly source_digest: string;
  readonly cached_symbols?: readonly JsonObject[]; readonly cached_symbols_digest?: string };
export type LspRelationKind = "references" | "calls" | "implementations" | "type_definitions" | "definitions" | "type_hierarchy";
export type LspStdioRequest = { readonly command: string; readonly args?: readonly string[]; readonly cwd: string; readonly analyzer: string; readonly analyzer_version: string; readonly documents: readonly LspSnapshotDocument[]; readonly relations?: readonly LspRelationKind[]; readonly relation_symbol_limit?: number; readonly request_timeout_ms?: number; readonly diagnostics_only?: boolean };

const MAX_DOCUMENT_BYTES = 2_000_000;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_SYMBOL_CACHE_BYTES = 32 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 64 * 1024 * 1024;
const MAX_TYPE_HIERARCHY_ITEMS = 50;
const MAX_DEFINITION_REFERENCES_PER_SYMBOL = 20;
const MAX_DEFINITION_LOOKUPS = 500;
const MAX_DIAGNOSTICS_PER_DOCUMENT = 500;
const MAX_DIAGNOSTICS_TOTAL = 2_000;
const MAX_DIAGNOSTIC_MESSAGE_LENGTH = 2000;
const TYPE_HIERARCHY_SYMBOL_KINDS = new Set([5, 10, 11, 23, 26]);
const CALL_HIERARCHY_SYMBOL_KINDS = new Set([6, 9, 12]);
const GO_IMPLEMENTATION_SYMBOL_KINDS = new Set([6, 11, 12]);
const GO_TYPE_DEFINITION_SYMBOL_KINDS = new Set([5, 10, 11, 13, 23, 26]);
const LSP_REQUEST_CONCURRENCY = 8;
const DEFAULT_TIMEOUT_MS = 10_000;

type Pending = { method: string; resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> };
type JsonRpc = { readonly id?: number | string; readonly method?: string; readonly result?: unknown; readonly error?: { readonly message?: string; readonly code?: number }; readonly params?: JsonObject };

/** The child close handler reports the stable process exit and pending method. */
export function ignoreLspStdinError(_error: Error): void {}

/**
 * Explicitly launch one configured LSP executable against supplied checkpoint
 * documents. No shell is used, and this adapter is never invoked by automatic
 * repository indexing. The caller owns the server trust decision and snapshot.
 */
export async function analyzeLspSnapshot(input: LspStdioRequest, timeoutMs = input.request_timeout_ms ?? DEFAULT_TIMEOUT_MS): Promise<JsonObject> {
  validateRequest(input, timeoutMs);
  const cwd = realpathSync(resolve(input.cwd));
  const child = spawn(input.command, [...(input.args ?? [])], { cwd, shell: false, stdio: ["pipe", "pipe", "pipe"] });
  const pending = new Map<number | string, Pending>();
  let nextId = 0;
  let buffer = Buffer.alloc(0);
  let closed: Error | undefined;
  let stderrBytes = 0;
  const publishedDiagnostics = new Map<string, unknown[]>();
  const diagnosticWaiters = new Set<() => void>();
  const activeWorkDoneProgress = new Set<string | number>();
  const workDoneProgressWaiters = new Set<() => void>();
  let workDoneProgressEvents = 0;

  const failPending = (error: Error) => {
    closed = error;
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(error); }
    pending.clear();
  };
  child.on("error", () => failPending(new Error("Unable to start configured language server")));
  // A language server may exit before Node flushes the initialize frame. In
  // that case the pipe reports EPIPE before the child's close event; handling
  // it here lets close() provide the stable exit code and pending LSP method.
  child.stdin.on("error", ignoreLspStdinError);
  child.on("close", (code, signal) => {
    if (!closed) {
      const method = pending.values().next().value?.method ?? "unknown request";
      failPending(new Error(`Language server exited before completion during ${method} (code ${String(code)}, signal ${signal ?? "none"})`));
    }
  });
  child.stderr.on("data", (chunk: Buffer) => { stderrBytes = Math.min(64 * 1024, stderrBytes + chunk.length); });

  const write = (message: JsonRpc): void => {
    if (closed) throw closed;
    const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", ...message }));
    child.stdin.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]));
  };
  const answerServerRequest = (message: JsonRpc): void => {
    const result = message.method === "workspace/configuration" ? []
      : message.method === "workspace/workspaceFolders" ? [{ uri: pathToFileURL(cwd).href, name: "checkpoint" }]
      : null;
    write({ id: message.id!, result });
  };
  const receive = (chunk: Buffer): void => {
    buffer = Buffer.concat([buffer, chunk]);
    if (buffer.length > MAX_RESPONSE_BYTES + 4096) { failPending(new Error("Language server response exceeds budget")); child.kill(); return; }
    while (true) {
      const headerEnd = buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;
      const header = buffer.subarray(0, headerEnd).toString("ascii");
      const match = /(?:^|\r\n)Content-Length:\s*(\d+)\s*(?:\r\n|$)/iu.exec(header);
      if (!match) { failPending(new Error("Malformed language server frame")); child.kill(); return; }
      const length = Number(match[1]);
      if (!Number.isSafeInteger(length) || length < 0 || length > MAX_RESPONSE_BYTES) { failPending(new Error("Language server response exceeds budget")); child.kill(); return; }
      const end = headerEnd + 4 + length;
      if (buffer.length < end) return;
      let decoded: unknown;
      try { decoded = JSON.parse(buffer.subarray(headerEnd + 4, end).toString("utf8")) as unknown; }
      catch { failPending(new Error("Malformed language server JSON response")); child.kill(); return; }
      if (!decoded || typeof decoded !== "object" || Array.isArray(decoded) || (decoded as { jsonrpc?: unknown }).jsonrpc !== "2.0") {
        failPending(new Error("Malformed language server JSON-RPC message")); child.kill(); return;
      }
      const message = decoded as JsonRpc;
      buffer = buffer.subarray(end);
      if (message.method && message.id !== undefined) { answerServerRequest(message); continue; }
      if (message.method === "textDocument/publishDiagnostics" && message.id === undefined) {
        const params = asRecord(message.params);
        if (typeof params?.uri === "string" && Array.isArray(params.diagnostics)) {
          publishedDiagnostics.set(params.uri, params.diagnostics);
          for (const waiter of [...diagnosticWaiters]) waiter();
        }
        continue;
      }
      if (message.method === "$/progress" && message.id === undefined) {
        const params = asRecord(message.params), token = params?.token, value = asRecord(params?.value);
        if ((typeof token === "string" || typeof token === "number") && value) {
          if (value.kind === "begin") activeWorkDoneProgress.add(token);
          else if (value.kind === "end") activeWorkDoneProgress.delete(token);
          workDoneProgressEvents++;
          for (const waiter of [...workDoneProgressWaiters]) waiter();
        }
        continue;
      }
      if (message.id === undefined) continue;
      const item = pending.get(message.id);
      if (!item) continue;
      clearTimeout(item.timer); pending.delete(message.id);
      if (message.error) item.reject(new Error(`Language server request failed during ${item.method} (${String(message.error.code ?? "unknown")})`));
      else item.resolve(message.result);
    }
  };
  child.stdout.on("data", receive);

  const request = (method: string, params: JsonObject | null): Promise<unknown> => {
    const id = ++nextId;
    return new Promise((resolveRequest, rejectRequest) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        rejectRequest(new Error(`Language server request timed out: ${method}`));
        child.kill();
      }, timeoutMs);
      pending.set(id, { method, resolve: resolveRequest, reject: rejectRequest, timer });
      try { write({ id, method, ...(params === null ? {} : { params }) }); }
      catch (error) { clearTimeout(timer); pending.delete(id); rejectRequest(error as Error); }
    });
  };
  const notify = (method: string, params: JsonObject): void => write({ method, params });

  try {
    const initializeResult = await request("initialize", { processId: process.pid, rootUri: pathToFileURL(cwd).href, rootPath: cwd,
      capabilities: { window: { workDoneProgress: true }, textDocument: { publishDiagnostics: { relatedInformation: true, versionSupport: true, codeDescriptionSupport: true, dataSupport: true }, diagnostic: { dynamicRegistration: false },
        documentSymbol: { hierarchicalDocumentSymbolSupport: true }, references: { dynamicRegistration: false }, definition: { dynamicRegistration: false, linkSupport: true }, callHierarchy: { dynamicRegistration: false },
        implementation: { dynamicRegistration: false, linkSupport: true }, typeDefinition: { dynamicRegistration: false, linkSupport: true },
        typeHierarchy: { dynamicRegistration: false } }, workspace: { workspaceFolders: true } },
      workspaceFolders: [{ uri: pathToFileURL(cwd).href, name: "checkpoint" }] });
    const serverCapabilities = asRecord(asRecord(initializeResult)?.capabilities);
    notify("initialized", {});
    const openedDocuments = input.documents.map(document => {
      const filePath = resolve(cwd, document.path);
      const uri = pathToFileURL(filePath).href;
      notify("textDocument/didOpen", { textDocument: { uri, languageId: document.language, version: 1, text: document.content } });
      return { document, uri };
    });
    if (input.diagnostics_only) {
      const diagnosticProvider = supportsProvider(serverCapabilities?.diagnosticProvider);
      let queryFailures = 0, omitted = 0;
      if (diagnosticProvider) {
        for (let index = 0; index < openedDocuments.length; index += LSP_REQUEST_CONCURRENCY) {
          await Promise.all(openedDocuments.slice(index, index + LSP_REQUEST_CONCURRENCY).map(async ({ uri }) => {
            try {
              const report = asRecord(await request("textDocument/diagnostic", { textDocument: { uri } }));
              if (report?.kind === "full" && Array.isArray(report.items)) publishedDiagnostics.set(uri, report.items);
              else queryFailures++;
            } catch { queryFailures++; }
          }));
        }
      } else {
        await waitForDiagnosticPublications(openedDocuments.map(item => item.uri), publishedDiagnostics, diagnosticWaiters, timeoutMs);
      }
      const items: JsonObject[] = [];
      const unpublished: string[] = [];
      for (const { document, uri } of openedDocuments) {
        const raw = publishedDiagnostics.get(uri);
        if (raw === undefined) { unpublished.push(document.path); continue; }
        if (raw.length > MAX_DIAGNOSTICS_PER_DOCUMENT) omitted += raw.length - MAX_DIAGNOSTICS_PER_DOCUMENT;
        const perDocument = raw.slice(0, MAX_DIAGNOSTICS_PER_DOCUMENT);
        const remaining = Math.max(0, MAX_DIAGNOSTICS_TOTAL - items.length);
        if (perDocument.length > remaining) omitted += perDocument.length - remaining;
        const normalized = normalizePublishedDiagnostics(document, perDocument.slice(0, remaining));
        items.push(...normalized.items);
        omitted += normalized.omitted;
      }
      const status = queryFailures || unpublished.length || omitted ? "partial" : "complete";
      await request("shutdown", null);
      notify("exit", {});
      child.stdin.end();
      await waitForClose(child, timeoutMs);
      return { format: "craft-lsp-diagnostics-v1", analyzer: input.analyzer, analyzer_version: input.analyzer_version,
        language_diagnostics: items, diagnostics: { status, mode: diagnosticProvider ? "pull" : "push", query_failures: queryFailures,
          unpublished_paths: unpublished, omitted_count: omitted, diagnostic_count: items.length } };
    }
    const documents: JsonObject[] = [];
    let symbolCacheHits = 0, symbolCacheMisses = 0;
    for (let index = 0; index < openedDocuments.length; index += LSP_REQUEST_CONCURRENCY) {
      const batch = await Promise.all(openedDocuments.slice(index, index + LSP_REQUEST_CONCURRENCY).map(async ({ document, uri }) => {
        const cachedSymbols = cachedDocumentSymbols(input, document);
        const symbols = cachedSymbols === undefined
          ? await request("textDocument/documentSymbol", { textDocument: { uri } })
          : cachedSymbols;
        if (cachedSymbols === undefined) symbolCacheMisses++; else symbolCacheHits++;
        if (symbols !== null && !Array.isArray(symbols)) throw new Error("Language server returned invalid DocumentSymbol data");
        return { ...document, symbols: symbols ?? [] };
      }));
      documents.push(...batch);
    }
    const progressWait = activeWorkDoneProgress.size > 0 ? await waitForWorkDoneProgress(activeWorkDoneProgress, workDoneProgressWaiters, timeoutMs) : false;
    const workDoneProgressWaited = progressWait || workDoneProgressEvents > 0;
    const symbolAnalysis = normalizeLspSymbols({ analyzer: input.analyzer, analyzer_version: input.analyzer_version, documents });
    const documentSymbolCache: JsonObject[] = [];
    let symbolCacheBytes = 0, symbolCacheOmittedDocuments = 0;
    if ((symbolAnalysis.diagnostics as JsonObject).budget_limited !== true) for (const document of documents) {
      const symbols = cacheLspDocumentSymbols(document.symbols as unknown[]);
      const bytes = Buffer.byteLength(JSON.stringify(symbols), "utf8");
      if (symbolCacheBytes + bytes > MAX_SYMBOL_CACHE_BYTES) { symbolCacheOmittedDocuments++; continue; }
      symbolCacheBytes += bytes;
      documentSymbolCache.push({ path: document.path, language: document.language, source_digest: document.source_digest, symbols,
        cached_symbols_digest: lspDocumentSymbolsDigest({ analyzer: input.analyzer, analyzer_version: input.analyzer_version,
          path: String(document.path), language: String(document.language), source_digest: String(document.source_digest), symbols }) });
    } else symbolCacheOmittedDocuments = documents.length;
    const requestedRelations = [...(input.relations ?? [])];
    const goAnalyzer = input.analyzer === "lsp-go";
    const referencesAvailable = requestedRelations.includes("references") && supportsProvider(serverCapabilities?.referencesProvider);
    const callsAvailable = requestedRelations.includes("calls") && supportsProvider(serverCapabilities?.callHierarchyProvider);
    const implementationsAvailable = requestedRelations.includes("implementations") && supportsProvider(serverCapabilities?.implementationProvider);
    const typeDefinitionsAvailable = requestedRelations.includes("type_definitions") && supportsProvider(serverCapabilities?.typeDefinitionProvider);
    const definitionsAvailable = requestedRelations.includes("definitions") && supportsProvider(serverCapabilities?.definitionProvider)
      && supportsProvider(serverCapabilities?.referencesProvider);
    const typeHierarchyAvailable = requestedRelations.includes("type_hierarchy") && supportsProvider(serverCapabilities?.typeHierarchyProvider);
    const relationReferences: JsonObject[] = [], relationCalls: JsonObject[] = [], relationImplementations: JsonObject[] = [], relationTypeDefinitions: JsonObject[] = [], relationDefinitions: JsonObject[] = [];
    const relationTypeHierarchy: JsonObject[] = [];
    let relationQueryFailures = 0;
    let relationQueryOmissions = 0;
    let outgoingCallHierarchyAvailable = callsAvailable;
    const relationCapabilityNotes = new Map<string, number>();
    let definitionLookups = 0;
    const seenDefinitionLocations = new Set<string>();
    const relationFailureStages = new Map<string, number>();
    const failRelation = (stage: string): void => { relationQueryFailures++; relationFailureStages.set(stage, (relationFailureStages.get(stage) ?? 0) + 1); };
    const symbols = (symbolAnalysis.nodes as JsonObject[]).filter(node => node.kind === "symbol");
    const relationLimit = input.relation_symbol_limit ?? 100;
    const otherRelationsRequested = requestedRelations.some(kind => kind !== "type_hierarchy");
    const ordinaryRelationSymbols = otherRelationsRequested ? selectLspRelationSymbols(symbols, relationLimit, callsAvailable) : [];
    const hierarchyCandidates = typeHierarchyAvailable ? symbols.filter(symbol => TYPE_HIERARCHY_SYMBOL_KINDS.has(Number(symbol.symbol_kind))) : [];
    const hierarchySymbols = hierarchyCandidates.slice(0, relationLimit);
    const hierarchySymbolIds = new Set(hierarchySymbols.map(symbol => String(symbol.id)));
    const relationSymbols = [...new Map([...ordinaryRelationSymbols, ...hierarchySymbols].map(symbol => [String(symbol.id), symbol])).values()];
    const hierarchySymbolOmissions = Math.max(0, hierarchyCandidates.length - hierarchySymbols.length);
    relationQueryOmissions += hierarchySymbolOmissions;
    const ordinaryRelationOmissions = otherRelationsRequested ? Math.max(0, symbols.length - ordinaryRelationSymbols.length) : 0;
    for (let index = 0; index < relationSymbols.length; index += LSP_REQUEST_CONCURRENCY) {
      await Promise.all(relationSymbols.slice(index, index + LSP_REQUEST_CONCURRENCY).map(async symbol => {
        const { document, selection } = resolveLspSymbolPosition(input.documents, symbol);
        const uri = pathToFileURL(resolve(cwd, document.path)).href;
        if (referencesAvailable) {
          try {
            const result = await request("textDocument/references", { textDocument: { uri }, position: selection, context: { includeDeclaration: false } });
            if (result === null) relationReferences.push({ symbol_id: symbol.id, locations: [] });
            else if (Array.isArray(result)) relationReferences.push({ symbol_id: symbol.id, locations: result as JsonObject[] });
            else failRelation("references_invalid_result");
          } catch { failRelation("references_request_failed"); }
        }
        if (callsAvailable && CALL_HIERARCHY_SYMBOL_KINDS.has(Number(symbol.symbol_kind))) {
          let prepared: unknown, prepareSucceeded = false;
          try {
            prepared = await request("textDocument/prepareCallHierarchy", { textDocument: { uri }, position: selection });
            prepareSucceeded = true;
          } catch (error) { failRelation(`call_hierarchy_prepare_failed_${safeFailureCode(error)}`); }
          if (prepareSucceeded && prepared !== null) {
            if (!Array.isArray(prepared)) failRelation("call_hierarchy_invalid_prepare_result");
            else {
              const incomingCalls: JsonObject[] = [], outgoingCalls: JsonObject[] = [];
              for (const item of prepared.slice(0, 10)) {
                try {
                  const result = await request("callHierarchy/incomingCalls", { item: item as JsonObject });
                  if (result !== null) {
                    if (!Array.isArray(result)) failRelation("call_hierarchy_invalid_incoming_result");
                    else incomingCalls.push(...result as JsonObject[]);
                  }
                } catch (error) { failRelation(`call_hierarchy_incoming_failed_${safeFailureCode(error)}`); }
                if (outgoingCallHierarchyAvailable) {
                  try {
                    const result = await request("callHierarchy/outgoingCalls", { item: item as JsonObject });
                    if (result !== null) {
                      if (!Array.isArray(result)) failRelation("call_hierarchy_invalid_outgoing_result");
                      else outgoingCalls.push(...result as JsonObject[]);
                    }
                  } catch (error) {
                    const failureCode = safeFailureCode(error);
                    if (failureCode === "-32601") {
                      relationCapabilityNotes.set("outgoing_call_hierarchy_unavailable", (relationCapabilityNotes.get("outgoing_call_hierarchy_unavailable") ?? 0) + 1);
                      outgoingCallHierarchyAvailable = false;
                    } else failRelation(`call_hierarchy_outgoing_failed_${failureCode}`);
                  }
                }
              }
              relationCalls.push({ symbol_id: symbol.id, incoming_calls: incomingCalls, outgoing_calls: outgoingCalls });
            }
          }
        }
        if (typeDefinitionsAvailable && (!goAnalyzer || GO_TYPE_DEFINITION_SYMBOL_KINDS.has(Number(symbol.symbol_kind)))) {
          try {
            const result = await request("textDocument/typeDefinition", { textDocument: { uri }, position: selection });
            const locations = normalizeLocations(result);
            if (locations) relationTypeDefinitions.push({ symbol_id: symbol.id, locations });
            else failRelation("type_definition_invalid_result");
          } catch (error) { failRelation(`type_definition_request_failed_${safeFailureCode(error)}`); }
        } else if (typeDefinitionsAvailable) {
          relationCapabilityNotes.set("go_type_definition_ineligible_symbol_skipped", (relationCapabilityNotes.get("go_type_definition_ineligible_symbol_skipped") ?? 0) + 1);
        }
        if (definitionsAvailable) {
          try {
            const result = await request("textDocument/references", { textDocument: { uri }, position: selection, context: { includeDeclaration: true } });
            if (result !== null && !Array.isArray(result)) { failRelation("definition_references_invalid_result"); return; }
            const locations = (result ?? []) as JsonObject[];
            if (locations.length > MAX_DEFINITION_REFERENCES_PER_SYMBOL) relationQueryOmissions += locations.length - MAX_DEFINITION_REFERENCES_PER_SYMBOL;
            const selectedLocations = locations.slice(0, MAX_DEFINITION_REFERENCES_PER_SYMBOL);
            for (let locationIndex = 0; locationIndex < selectedLocations.length; locationIndex++) {
              const rawLocation = selectedLocations[locationIndex]!;
              const location = normalizeLocations(rawLocation)?.[0];
              if (!location || typeof location.uri !== "string" || !isCheckpointUri(location.uri, cwd, input.documents)) { failRelation("definition_reference_unmapped"); continue; }
              const range = asRecord(location.range), start = asRecord(range?.start);
              if (typeof start?.line !== "number" || !Number.isInteger(start.line) || typeof start.character !== "number" || !Number.isInteger(start.character)) { failRelation("definition_reference_invalid_range"); continue; }
              const key = `${location.uri}\0${start.line}\0${start.character}`;
              if (seenDefinitionLocations.has(key)) continue;
              seenDefinitionLocations.add(key);
              if (definitionLookups >= MAX_DEFINITION_LOOKUPS) {
                relationQueryOmissions += selectedLocations.length - locationIndex;
                break;
              }
              definitionLookups++;
              try {
                const definitions = normalizeLocations(await request("textDocument/definition", { textDocument: { uri: location.uri }, position: start as JsonObject }));
                if (definitions) relationDefinitions.push({ reference: location, locations: definitions });
                else failRelation("definition_invalid_result");
              } catch (error) { failRelation(`definition_request_failed_${safeFailureCode(error)}`); }
            }
          } catch (error) { failRelation(`definition_references_request_failed_${safeFailureCode(error)}`); }
        }
        if (typeHierarchyAvailable && hierarchySymbolIds.has(String(symbol.id))) {
          let prepared: unknown;
          try { prepared = await request("textDocument/prepareTypeHierarchy", { textDocument: { uri }, position: selection }); }
          catch (error) { failRelation(`type_hierarchy_prepare_failed_${safeFailureCode(error)}`); return; }
          if (prepared === null) return;
          if (!Array.isArray(prepared)) { failRelation("type_hierarchy_invalid_prepare_result"); return; }
          if (prepared.length > 10) relationQueryOmissions += prepared.length - 10;
          const supertypes: JsonObject[] = [], subtypes: JsonObject[] = [];
          for (const item of prepared.slice(0, 10)) {
            if (!isTypeHierarchyItem(item)) { failRelation("type_hierarchy_invalid_item"); continue; }
            for (const [method, destination, stage] of [
              ["typeHierarchy/supertypes", supertypes, "supertypes"], ["typeHierarchy/subtypes", subtypes, "subtypes"],
            ] as const) {
              try {
                const result = await request(method, { item });
                if (result === null) continue;
                if (!Array.isArray(result) || result.some(candidate => !isTypeHierarchyItem(candidate))) { failRelation(`type_hierarchy_invalid_${stage}_result`); continue; }
                if (result.length > MAX_TYPE_HIERARCHY_ITEMS) relationQueryOmissions += result.length - MAX_TYPE_HIERARCHY_ITEMS;
                destination.push(...result.slice(0, MAX_TYPE_HIERARCHY_ITEMS) as JsonObject[]);
              } catch (error) { failRelation(`type_hierarchy_${stage}_failed_${safeFailureCode(error)}`); }
            }
          }
          relationTypeHierarchy.push({ symbol_id: symbol.id, supertypes, subtypes });
        }
      }));
    }
    if (implementationsAvailable) for (const symbol of ordinaryRelationSymbols) {
      if (goAnalyzer && !GO_IMPLEMENTATION_SYMBOL_KINDS.has(Number(symbol.symbol_kind))) {
        relationCapabilityNotes.set("go_implementation_ineligible_symbol_skipped", (relationCapabilityNotes.get("go_implementation_ineligible_symbol_skipped") ?? 0) + 1);
        continue;
      }
      const positionSymbol = goAnalyzer && Number(symbol.symbol_kind) === 12 && symbol.declaration_span && typeof symbol.declaration_span === "object"
        ? { ...symbol, span: { start_offset: (symbol.declaration_span as JsonObject).start_offset } }
        : symbol;
      const { document, selection } = resolveLspSymbolPosition(input.documents, positionSymbol);
      const uri = pathToFileURL(resolve(cwd, document.path)).href;
      try {
        const result = await request("textDocument/implementation", { textDocument: { uri }, position: selection });
        const locations = normalizeLocations(result);
        if (locations) relationImplementations.push({ symbol_id: symbol.id, locations });
        else failRelation("implementation_invalid_result");
      } catch (error) { failRelation(`implementation_request_failed_${safeFailureCode(error)}`); }
    }
    const collected = collectLspRelations({ cwd, documents: documents.map(document => ({ ...document, uri: pathToFileURL(resolve(cwd, String(document.path))).href })),
      nodes: symbolAnalysis.nodes, references: relationReferences, calls: relationCalls, implementations: relationImplementations, type_definitions: relationTypeDefinitions,
      definitions: relationDefinitions,
      type_hierarchy: relationTypeHierarchy });
    const relations = collected.relations as JsonObject[];
    const analysis = normalizeLspSymbols({ analyzer: input.analyzer, analyzer_version: input.analyzer_version, documents, relations });
    const availability: Record<LspRelationKind, boolean> = { references: referencesAvailable, calls: callsAvailable,
      implementations: implementationsAvailable, type_definitions: typeDefinitionsAvailable, definitions: definitionsAvailable, type_hierarchy: typeHierarchyAvailable };
    const requestedSupported = requestedRelations.filter(kind => availability[kind]);
    const unsupportedRelations = requestedRelations.filter(kind => !requestedSupported.includes(kind));
    const relationOmittedCount = requestedRelations.length ? Number(collected.omitted_relation_count) + relationQueryOmissions + ordinaryRelationOmissions : 0;
    const diagnosticReports = openedDocuments.map(item => publishedDiagnostics.get(item.uri)).filter((items): items is unknown[] => items !== undefined);
    const diagnosticItems = diagnosticReports.flat();
    const languageErrorCount = diagnosticItems.filter(item => asRecord(item)?.severity === 1).length;
    const languageWarningCount = diagnosticItems.filter(item => asRecord(item)?.severity === 2).length;
    const relationStatus = !requestedRelations.length ? "not_requested"
      : unsupportedRelations.length > 0 || relationQueryFailures > 0 || relationOmittedCount > 0 || languageErrorCount > 0 || progressWait ? "partial" : "analyzed";
    await request("shutdown", null);
    notify("exit", {});
    child.stdin.end();
    await waitForClose(child, timeoutMs);
    return { ...analysis, document_symbol_cache: documentSymbolCache, diagnostics: { ...(analysis.diagnostics as JsonObject), symbol_cache_hits: symbolCacheHits,
      symbol_cache_misses: symbolCacheMisses, symbol_cache_omitted_documents: symbolCacheOmittedDocuments, relations: relationStatus, requested_relations: requestedRelations, supported_relations: requestedSupported, unsupported_relations: unsupportedRelations,
      relation_candidate_symbol_count: requestedRelations.length ? symbols.length : 0, relation_symbol_count: relationSymbols.length,
      relation_query_omitted_count: ordinaryRelationOmissions + hierarchySymbolOmissions,
      relation_response_omitted_count: relationQueryOmissions - hierarchySymbolOmissions,
      relation_collection_omitted_count: Number(collected.omitted_relation_count),
      relation_omitted_count: relationOmittedCount, relation_query_failures: relationQueryFailures,
      relation_omitted_stages: collected.omitted_relation_stages,
      relation_failure_stages: [...relationFailureStages].map(([stage, count]) => ({ stage, count })),
      relation_capability_notes: [...relationCapabilityNotes].map(([stage, count]) => ({ stage, count })),
      ...(workDoneProgressEvents ? { work_done_progress_waited: workDoneProgressWaited, work_done_progress_timed_out: progressWait } : {}),
      language_diagnostics: { observed_document_count: diagnosticReports.length, item_count: diagnosticItems.length,
        error_count: languageErrorCount, warning_count: languageWarningCount },
      stderr_bytes_observed: stderrBytes } };
  } catch (error) {
    failPending(error as Error);
    child.kill();
    throw error;
  }
}

function validateRequest(input: LspStdioRequest, timeoutMs: number): void {
  if (!input || typeof input.command !== "string" || !input.command.trim() || !Array.isArray(input.args ?? [])
    || (input.args ?? []).some(argument => typeof argument !== "string")
    || typeof input.cwd !== "string" || !isAbsolute(input.cwd) || typeof input.analyzer !== "string" || !input.analyzer
    || typeof input.analyzer_version !== "string" || !input.analyzer_version || !Array.isArray(input.documents)
    || (input.diagnostics_only !== undefined && typeof input.diagnostics_only !== "boolean")
    || !input.documents.length || input.documents.length > MAX_LSP_DOCUMENTS
      || (input.relations !== undefined && (!Array.isArray(input.relations) || input.relations.some(kind => !["references", "calls", "implementations", "type_definitions", "definitions", "type_hierarchy"].includes(kind))
      || new Set(input.relations).size !== input.relations.length))
    || (input.relation_symbol_limit !== undefined && (!Number.isSafeInteger(input.relation_symbol_limit) || input.relation_symbol_limit < 1 || input.relation_symbol_limit > MAX_RELATION_SYMBOLS))) throw new Error("Invalid or over-budget LSP request");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) throw new Error("LSP timeout is outside budget");
  const cwd = resolve(input.cwd); let totalBytes = 0, cacheBytes = 0; const paths = new Set<string>();
  for (const document of input.documents) {
    if (!document || typeof document.path !== "string" || !document.path || isAbsolute(document.path) || document.path.split(/[\\/]+/u).includes("..")
      || paths.has(document.path) || typeof document.language !== "string" || !document.language || typeof document.content !== "string"
      || typeof document.source_digest !== "string" || !document.source_digest) throw new Error("Invalid or duplicate LSP snapshot document");
    const fullPath = resolve(cwd, document.path), relativePath = relative(cwd, fullPath);
    if (!relativePath) throw new Error("LSP document must resolve to a file below the checkpoint root");
    const bytes = Buffer.byteLength(document.content, "utf8");
    if (bytes > MAX_DOCUMENT_BYTES) throw new Error("LSP document exceeds byte budget");
    totalBytes += bytes;
    if (totalBytes > MAX_TOTAL_BYTES) throw new Error("LSP checkpoint exceeds byte budget");
    if (createHash("sha256").update(document.content).digest("hex") !== document.source_digest) throw new Error("LSP snapshot digest mismatch");
    if (document.cached_symbols !== undefined) {
      if (!Array.isArray(document.cached_symbols)) throw new Error("Invalid LSP cached symbols");
      cacheBytes += Buffer.byteLength(JSON.stringify(document.cached_symbols), "utf8");
      if (cacheBytes > MAX_SYMBOL_CACHE_BYTES) throw new Error("LSP symbol cache exceeds byte budget");
    }
    paths.add(document.path);
  }
}

/** @internal Exported for deterministic push-notification wait verification. */
export async function waitForDiagnosticPublications(uris: readonly string[], published: ReadonlyMap<string, unknown[]>, waiters: Set<() => void>, timeoutMs: number): Promise<void> {
  if (uris.every(uri => published.has(uri))) return;
  await new Promise<void>(resolveWait => {
    let wake: () => void;
    const finish = (): void => { clearTimeout(timer); waiters.delete(wake); resolveWait(); };
    const timer = setTimeout(finish, Math.min(timeoutMs, 5_000));
    wake = () => { if (uris.every(uri => published.has(uri))) finish(); };
    waiters.add(wake);
  });
}

async function waitForWorkDoneProgress(active: ReadonlySet<string | number>, waiters: Set<() => void>, timeoutMs: number): Promise<boolean> {
  return new Promise(resolveWait => {
    const check = (): void => { if (!active.size) finish(false); };
    const finish = (timedOut: boolean): void => {
      clearTimeout(timer);
      waiters.delete(check);
      resolveWait(timedOut);
    };
    const timer = setTimeout(() => finish(true), timeoutMs);
    waiters.add(check);
    check();
  });
}

function normalizePublishedDiagnostics(document: LspSnapshotDocument, raw: readonly unknown[]): { items: JsonObject[]; omitted: number } {
  const items: JsonObject[] = [];
  let omitted = 0;
  const lines = document.content.split("\n");
  for (const value of raw) {
    const diagnostic = asRecord(value), range = asRecord(diagnostic?.range);
    const start = asRecord(range?.start), end = asRecord(range?.end);
    const validPosition = (position: Record<string, unknown> | undefined): position is Record<string, number> => {
      if (!position || !Number.isInteger(position.line) || !Number.isInteger(position.character)) return false;
      const line = Number(position.line), character = Number(position.character);
      return line >= 0 && line < lines.length && character >= 0 && character <= lines[line]!.replace(/\r$/u, "").length;
    };
    if (!diagnostic || !validPosition(start) || !validPosition(end)
      || (Number(end.line) < Number(start.line) || (end.line === start.line && Number(end.character) < Number(start.character)))
      || typeof diagnostic.message !== "string") { omitted++; continue; }
    const severity = diagnostic.severity;
    if (severity !== undefined && (!Number.isInteger(severity) || Number(severity) < 1 || Number(severity) > 4)) { omitted++; continue; }
    const code = typeof diagnostic.code === "string" || typeof diagnostic.code === "number" ? String(diagnostic.code).slice(0, 80) : undefined;
    const source = typeof diagnostic.source === "string" ? diagnostic.source.slice(0, 80) : undefined;
    items.push({ path: document.path, range: { start, end }, ...(severity === undefined ? {} : { severity }),
      ...(code === undefined ? {} : { code }), ...(source === undefined ? {} : { source }), message: diagnostic.message.slice(0, MAX_DIAGNOSTIC_MESSAGE_LENGTH) });
  }
  return { items, omitted };
}

function cachedDocumentSymbols(input: LspStdioRequest, document: LspSnapshotDocument): JsonObject[] | undefined {
  if (!Array.isArray(document.cached_symbols) || typeof document.cached_symbols_digest !== "string") return undefined;
  return document.cached_symbols_digest === lspDocumentSymbolsDigest({ analyzer: input.analyzer, analyzer_version: input.analyzer_version,
    path: document.path, language: document.language, source_digest: document.source_digest, symbols: document.cached_symbols })
    ? [...document.cached_symbols] : undefined;
}

function supportsProvider(value: unknown): boolean { return value === true || (typeof value === "object" && value !== null); }
function isCheckpointUri(uri: string, cwd: string, documents: readonly LspSnapshotDocument[]): boolean {
  try {
    const url = new URL(uri);
    if (url.protocol !== "file:") return false;
    const path = resolve(fileURLToPath(url));
    const relativePath = relative(cwd, path);
    if (relativePath === ".." || relativePath.startsWith(`..${sep}`)) return false;
    for (const document of documents) if (resolve(cwd, document.path) === path) return true;
    return false;
  } catch { return false; }
}
function asRecord(value: unknown): Record<string, unknown> | undefined { return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined; }
function normalizeLocations(result: unknown): JsonObject[] | undefined {
  if (result === null) return [];
  const locations = Array.isArray(result) ? result : [result];
  const normalized: JsonObject[] = [];
  for (const raw of locations) {
    const location = asRecord(raw);
    const uri = typeof location?.uri === "string" ? location.uri : typeof location?.targetUri === "string" ? location.targetUri : undefined;
    const range = asRecord(location?.range) ?? asRecord(location?.targetSelectionRange);
    if (!uri || !range) return undefined;
    normalized.push({ uri, range });
  }
  return normalized;
}
function isTypeHierarchyItem(value: unknown): value is JsonObject {
  const item = asRecord(value), range = asRecord(item?.selectionRange);
  return typeof item?.uri === "string" && Boolean(range?.start && range.end);
}
/** @internal Exported to verify redacted error classification without exposing server text. */
export function safeFailureCode(error: unknown): string {
  const match = error instanceof Error ? /\((-?\d+|unknown)\)/u.exec(error.message) : null;
  return match?.[1] ?? "transport";
}
/** @internal Resolves only symbol locations whose source is present in the supplied snapshot. */
export function resolveLspSymbolPosition(documents: readonly LspSnapshotDocument[], symbol: JsonObject): { document: LspSnapshotDocument; selection: JsonObject } {
  const document = documents.find(candidate => candidate.path === symbol.path);
  if (!document) throw new Error("LSP normalized symbol has no source document");
  const selection = positionAtOffset(document.content, Number((symbol.span as JsonObject)?.start_offset));
  if (!selection) throw new Error("LSP normalized symbol position is outside its source document");
  return { document, selection };
}
function positionAtOffset(content: string, offset: number): JsonObject | undefined {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > content.length) return undefined;
  const prefix = content.slice(0, offset), line = (prefix.match(/\n/gu) ?? []).length;
  return { line, character: prefix.length - prefix.lastIndexOf("\n") - 1 };
}

/** @internal Exported for process-exit race verification; callers should use analyzeLspSnapshot. */
export function waitForClose(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null) return child.exitCode === 0 ? Promise.resolve() : Promise.reject(new Error(`Language server exited unsuccessfully (${String(child.exitCode)})`));
  return new Promise((resolveClose, rejectClose) => {
    const timer = setTimeout(() => { child.kill(); rejectClose(new Error("Language server did not exit after shutdown")); }, timeoutMs);
    child.once("close", (code, signal) => { clearTimeout(timer); if (code === 0) resolveClose(); else rejectClose(new Error(`Language server exited unsuccessfully (code ${String(code)}, signal ${signal ?? "none"})`)); });
  });
}
