let buffer = Buffer.alloc(0);
let opened = new Map();
let workspaceRequestSent = false;
let activeDocumentSymbols = 0;
let peakDocumentSymbols = 0;
let completedDocumentSymbols = 0;
let progressEnded = false;
let activeImplementations = 0;
const mode = process.argv[2] ?? "ok";
const relationMode = mode.startsWith("relations");
const semanticMode = mode.startsWith("relations-semantic");
const goMode = mode.startsWith("relations-go");

if (mode === "close-stdin") {
  process.stdin.destroy();
  setTimeout(() => process.exit(4), 10);
}

function send(message) {
  const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", ...message }));
  process.stdout.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]));
}

function encode(message) {
  const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", ...message }));
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]);
}

function sendRaw(text) { process.stdout.write(text); }

process.stdin.on("data", chunk => {
  buffer = Buffer.concat([buffer, chunk]);
  while (true) {
    const headerEnd = buffer.indexOf("\r\n\r\n");
    if (headerEnd < 0) return;
    const match = /Content-Length:\s*(\d+)/iu.exec(buffer.subarray(0, headerEnd).toString("ascii"));
    if (!match) process.exit(3);
    const length = Number(match[1]), end = headerEnd + 4 + length;
    if (buffer.length < end) return;
    const message = JSON.parse(buffer.subarray(headerEnd + 4, end).toString("utf8"));
    buffer = buffer.subarray(end);
    if (message.id === "workspace-config") continue;
    if (message.method === "initialize") {
      if (mode === "bad-frame") { sendRaw("Content-Length: no\r\n\r\n"); continue; }
      if (mode === "bad-json") { sendRaw("Content-Length: 1\r\n\r\n{"); continue; }
      if (mode === "bad-shape") { sendRaw("Content-Length: 4\r\n\r\nnull"); continue; }
      if (mode === "bad-array") { sendRaw("Content-Length: 2\r\n\r\n[]"); continue; }
      if (mode === "bad-version") { send({ jsonrpc: "1.0", id: message.id, result: {} }); continue; }
      if (mode === "oversized") { sendRaw("Content-Length: 67108865\r\n\r\n"); continue; }
      if (mode === "overflow-buffer") { sendRaw("x".repeat(64 * 1024 * 1024 + 8192)); continue; }
      if (mode === "split-frame") { sendRaw("Content-Length: 36\r\n\r\n{"); setTimeout(() => sendRaw("\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{}}"), 5); continue; }
      if (!workspaceRequestSent) { workspaceRequestSent = true; send({ id: "workspace-config", method: "workspace/configuration", params: { items: [] } }); }
      if (mode === "server-requests") {
        send({ id: "workspace-folders", method: "workspace/workspaceFolders", params: {} });
        send({ id: "custom-request", method: "window/showMessageRequest", params: {} });
        send({ method: "window/logMessage", params: { type: 3, message: "fixture" } });
      }
      if (mode === "notification") send({ method: "window/logMessage", params: { type: 3, message: "no response id" } });
      if (mode === "stderr") process.stderr.write("fixture diagnostic\n");
      send({ id: message.id, result: { capabilities: { documentSymbolProvider: true,
        ...(["diagnostics-pull", "diagnostics-pull-invalid", "diagnostics-pull-unavailable", "diagnostics-pull-error"].includes(mode) ? { diagnosticProvider: { interFileDependencies: false, workspaceDiagnostics: false } } : {}),
        ...(relationMode ? { referencesProvider: mode === "relations-object-provider" ? {} : mode === "relations-definition-no-references" ? false : true, definitionProvider: true, callHierarchyProvider: true, implementationProvider: true, typeDefinitionProvider: true,
          ...(mode.startsWith("relations-hierarchy") ? { typeHierarchyProvider: mode === "relations-hierarchy-unsupported" ? false : true } : {}) } : {}) } } });
    } else if (message.method === "textDocument/didOpen") {
      const { uri, text } = message.params.textDocument;
      opened.set(uri, text);
      if (mode === "relations-progress" || mode === "relations-progress-timeout") {
        send({ method: "$/progress", params: { token: {}, value: { kind: "begin" } } });
        send({ id: "progress-create", method: "window/workDoneProgress/create", params: { token: "workspace-load" } });
        send({ method: "$/progress", params: { token: "workspace-load", value: { kind: "begin", title: "Loading workspace" } } });
        send({ method: "$/progress", params: { token: "workspace-load", value: { kind: "report", percentage: 50 } } });
        if (mode === "relations-progress") setTimeout(() => { progressEnded = true; send({ method: "$/progress", params: { token: "workspace-load", value: { kind: "end" } } }); }, 50);
      }
      if (["diagnostics-push", "diagnostics-push-empty", "diagnostics-push-delayed", "diagnostics-push-malformed", "diagnostics-push-many", "diagnostics-push-optionals", "relations-semantic-diagnostics-push", "relations-semantic-diagnostics-warning"].includes(mode)) {
        const item = { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }, severity: mode.endsWith("-warning") ? 2 : 1, code: "E1", source: "fixture", message: "sample diagnostic" };
        const diagnostics = mode === "diagnostics-push-empty" ? [] : mode === "diagnostics-push-optionals" ? [{ range: item.range, message: "minimal diagnostic" }] : mode === "diagnostics-push-malformed"
          ? [item, { ...item, range: { start: { line: 9, character: 0 }, end: { line: 9, character: 1 } } }, { ...item, severity: 8 }]
          : mode === "diagnostics-push-many" ? Array.from({ length: 501 }, (_, i) => ({ ...item, message: i === 0 ? "x".repeat(2500) : item.message })) : [item];
        const notification = { method: "textDocument/publishDiagnostics", params: { uri, diagnostics } };
        if (mode === "diagnostics-push-delayed") setTimeout(() => send(notification), 20); else send(notification);
      }
    } else if (message.method === "textDocument/diagnostic") {
      if (mode === "diagnostics-pull-invalid") send({ id: message.id, result: { kind: "full", items: [{ message: "missing range" }] } });
      else if (mode === "diagnostics-pull-unavailable") send({ id: message.id, result: { kind: "unchanged", resultId: "unknown" } });
      else if (mode === "diagnostics-pull-error") send({ id: message.id, error: { code: -32603, message: "redacted diagnostic request failure" } });
      else send({ id: message.id, result: { kind: "full", items: [{ range: { start: { line: 0, character: 1 }, end: { line: 0, character: 2 } }, severity: 2, code: 42, source: "fixture", message: "pull diagnostic" }] } });
    } else if (message.method === "textDocument/documentSymbol") {
      if (mode === "parallel-symbols") {
        activeDocumentSymbols++;
        peakDocumentSymbols = Math.max(peakDocumentSymbols, activeDocumentSymbols);
        const uri = message.params.textDocument.uri;
        const content = opened.get(uri) ?? "";
        const found = /class\s+([A-Za-z_][A-Za-z0-9_]*)/u.exec(content);
        const symbol = found ? { name: found[1], kind: 5,
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: content.length } },
          selectionRange: { start: { line: 0, character: 6 }, end: { line: 0, character: 6 + found[1].length } } } : null;
        setTimeout(() => {
          activeDocumentSymbols--;
          completedDocumentSymbols++;
          send({ id: message.id, result: symbol ? [symbol] : [] });
          const expected = Number(process.argv[4]);
          if (completedDocumentSymbols === expected)
            require("node:fs").writeFileSync(process.argv[3], JSON.stringify({ peakDocumentSymbols, allDocumentsOpened: opened.size === expected }));
        }, 10);
        continue;
      }
      if (mode === "many-symbols") {
        const uri = message.params.textDocument.uri;
        const content = opened.get(uri) ?? "";
        const symbols = content.split("\n").map((_, line) => ({ name: `symbol_${line}`, kind: 12,
          range: { start: { line, character: 0 }, end: { line, character: 1 } } }));
        send({ id: message.id, result: symbols });
        continue;
      }
      if (mode === "large-symbol-cache") {
        const content = opened.get(message.params.textDocument.uri) ?? "";
        const symbols = content.split("\n").map((_, line) => ({ name: `${String(line).padStart(5, "0")}_${"x".repeat(506)}`, kind: 12,
          range: { start: { line, character: 0 }, end: { line, character: 1 } } }));
        send({ id: message.id, result: symbols });
        continue;
      }
      if (mode === "malformed") send({ id: message.id, result: { invalid: true } });
      else if (mode === "cache-reject-query") send({ id: message.id, error: { code: -32603, message: "cached document symbol request should not be sent" } });
      else if (mode === "timeout") continue;
      else if (mode === "request-error") send({ id: message.id, error: { code: -32603, message: "fixture failure" } });
      else if (mode === "error-unknown") send({ id: message.id, error: {} });
      else if (mode === "exit-before") process.exit(4);
      else if (mode === "null-symbols") send({ id: message.id, result: null });
      else {
        const content = opened.get(message.params.textDocument.uri) ?? "";
        if (relationMode) {
          const lines = content.split("\n");
          const symbols = lines.flatMap((line, index) => {
            const match = goMode ? /\bfunc\s+(?:\([^)]*\)\s*)?([A-Za-z_$][\w$]*)/u.exec(line)
              : semanticMode || mode.startsWith("relations-hierarchy") || mode === "relations-noncallable-call-error"
              ? /\b(class|interface|function|let|const)\s+([A-Za-z_$][\w$]*)/u.exec(line)
              : /function\s+([A-Za-z_$][\w$]*)/u.exec(line);
            if (!match) return [];
            const name = goMode || !(semanticMode || mode.startsWith("relations-hierarchy") || mode === "relations-noncallable-call-error")
              ? match[1] : match[2];
            const start = match.index + match[0].lastIndexOf(name), end = start + name.length;
            const kind = name === "model" ? 13 : goMode || /\bfunction\s+/u.test(line) ? 12 : 5;
            return [{ name, kind, range: { start: { line: index, character: 0 }, end: { line: index, character: line.length } },
              selectionRange: { start: { line: index, character: start }, end: { line: index, character: end } } }];
          });
          send({ id: message.id, result: symbols });
          continue;
        }
        const found = /class\s+([A-Za-z_][A-Za-z0-9_]*)/u.exec(content);
        const symbol = found ? { name: found[1], kind: 5,
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: content.indexOf("\n") < 0 ? content.length : content.indexOf("\n") } },
          selectionRange: { start: { line: 0, character: 6 }, end: { line: 0, character: 6 + found[1].length } } } : null;
        const response = { id: message.id, result: symbol ? [symbol] : [] };
        if (mode === "close-after-response") process.stdout.write(Buffer.concat([encode(response), Buffer.from("Content-Length: invalid\r\n\r\n")]));
        else send(response);
      }
    } else if (message.method === "textDocument/references") {
      if (mode === "relations-refs-error") { send({ id: message.id, error: { code: -32603, message: "private reference failure" } }); continue; }
      if (mode === "relations-definition-refs-error") { send({ id: message.id, error: { code: -32603, message: "private definition reference failure" } }); continue; }
      if (mode === "relations-refs-null") { send({ id: message.id, result: null }); continue; }
      const uri = message.params.textDocument.uri, position = message.params.position;
      const content = opened.get(uri) ?? "", targetOffset = content.indexOf("function target") + "function ".length;
      const referenceOffset = content.indexOf("target();", content.indexOf("function caller"));
      const declaration = { uri, range: { start: { line: 0, character: targetOffset }, end: { line: 0, character: targetOffset + 6 } } };
      const reference = { uri, range: { start: { line: 1, character: referenceOffset - content.indexOf("\n") - 1 }, end: { line: 1, character: referenceOffset - content.indexOf("\n") - 1 + 6 } } };
      if (mode === "relations-definition-global-many") {
        const line = content.split("\n")[position.line] ?? "", matches = position.line === 0 ? [] : [...line.matchAll(/target\(\)/gu)];
        send({ id: message.id, result: matches.map(match => ({ uri, range: { start: { line: position.line, character: match.index }, end: { line: position.line, character: match.index + "target".length } } })) });
        continue;
      }
      const locations = message.params.context?.includeDeclaration ? [declaration, reference] : [reference];
      send({ id: message.id, result: mode === "relations-invalid" || mode === "relations-definition-refs-invalid" ? { invalid: true }
        : mode === "relations-definition-refs-null" ? null
        : mode === "relations-object-provider" ? [] : mode === "relations-definition-many" ? Array.from({ length: 21 }, () => reference)
        : mode === "relations-definition-http" ? [{ ...reference, uri: "https://example.invalid/outside.js" }]
        : mode === "relations-definition-parent" ? [{ ...reference, uri: new URL("../../", uri).href }]
        : mode === "relations-definition-missing-doc" ? [{ ...reference, uri: new URL("../other.js", uri).href }]
        : mode === "relations-definition-invalid-uri" ? [{ ...reference, uri: "not a uri" }]
        : mode === "relations-definition-outside" ? [{ ...reference, uri: "file:///outside/secret.js" }]
        : mode === "relations-definition-bad-range" ? [{ uri, range: { start: { line: "bad", character: 0 }, end: { line: 1, character: 1 } } }]
        : position.line === 0 && position.character === targetOffset ? locations : [] });
    } else if (message.method === "textDocument/definition") {
      const uri = message.params.textDocument.uri, content = opened.get(uri) ?? "";
      if (mode === "relations-definition-error") { send({ id: message.id, error: { code: -32603, message: "private definition failure" } }); continue; }
      if (mode === "relations-definition-invalid") { send({ id: message.id, result: [{ uri }] }); continue; }
      const targetOffset = content.indexOf("function target") + "function ".length;
      send({ id: message.id, result: [{ targetUri: uri,
        targetRange: { start: { line: 0, character: 0 }, end: { line: 0, character: content.split("\n")[0].length } },
        targetSelectionRange: { start: { line: 0, character: targetOffset }, end: { line: 0, character: targetOffset + "target".length } } }] });
    } else if (message.method === "textDocument/prepareCallHierarchy") {
      if (mode === "relations-prepare-error" || mode === "relations-hierarchy-call-error") { send({ id: message.id, error: { code: -32603, message: "private prepare failure" } }); continue; }
      if (mode === "relations-noncallable-call-error" && (opened.get(message.params.textDocument.uri) ?? "").split("\n")[message.params.position.line]?.startsWith("class ")) {
        send({ id: message.id, error: { code: -32603, message: "class is not callable" } }); continue;
      }
      if (mode === "relations-prepare-null") { send({ id: message.id, result: null }); continue; }
      if (mode === "relations-prepare-invalid") { send({ id: message.id, result: { invalid: true } }); continue; }
      if (mode === "relations-prepare-empty") { send({ id: message.id, result: [] }); continue; }
      const uri = message.params.textDocument.uri, position = message.params.position;
      const content = opened.get(uri) ?? "", lines = content.split("\n"), line = lines[position.line] ?? "";
      const name = (goMode ? /\bfunc\s+(?:\([^)]*\)\s*)?([A-Za-z_$][\w$]*)/u : /function\s+([A-Za-z_$][\w$]*)/u).exec(line)?.[1];
      send({ id: message.id, result: name ? [{ name, kind: 12, uri,
        range: { start: { line: position.line, character: 0 }, end: { line: position.line, character: line.length } },
        selectionRange: { start: { line: position.line, character: position.character }, end: { line: position.line, character: position.character + name.length } } }] : null });
    } else if (message.method === "callHierarchy/incomingCalls") {
      const item = message.params.item, uri = item.uri, content = opened.get(uri) ?? "";
      if (mode === "relations-error") send({ id: message.id, error: { code: -32601, message: "method unavailable" } });
      else if (mode === "relations-incoming-null" || mode === "relations-go-incoming-null") send({ id: message.id, result: null });
      else if (mode === "relations-incoming-invalid") send({ id: message.id, result: { invalid: true } });
      else if (item.name === "target") {
        const offset = content.indexOf("target();", content.indexOf("function caller"));
        const lineStart = content.lastIndexOf("\n", offset) + 1;
        send({ id: message.id, result: [{ from: { name: "caller", kind: 12, uri,
          range: { start: { line: 1, character: 0 }, end: { line: 1, character: content.split("\n")[1].length } },
          selectionRange: { start: { line: 1, character: "function ".length }, end: { line: 1, character: "function ".length + "caller".length } } },
        fromRanges: [{ start: { line: 1, character: offset - lineStart }, end: { line: 1, character: offset - lineStart + "target".length } }] }] });
      } else send({ id: message.id, result: [] });
    } else if (message.method === "callHierarchy/outgoingCalls") {
      const item = message.params.item, uri = item.uri, content = opened.get(uri) ?? "";
      if (mode === "relations-outgoing-unsupported") { send({ id: message.id, error: { code: -32601, message: "method unavailable" } }); continue; }
      if (mode === "relations-outgoing-error") { send({ id: message.id, error: { code: -32603, message: "private outgoing failure" } }); continue; }
      if (mode === "relations-outgoing-invalid") { send({ id: message.id, result: { invalid: true } }); continue; }
      if (mode === "relations-outgoing-null") { send({ id: message.id, result: null }); continue; }
      if (item.name === "caller") {
        const callPattern = goMode ? "target()" : "target();", callerPattern = goMode ? "func caller" : "function caller";
        const offset = content.indexOf(callPattern, content.indexOf(callerPattern));
        const lineStart = content.lastIndexOf("\n", offset) + 1;
        const targetPattern = goMode ? "func target" : "function target";
        const targetStart = content.indexOf(targetPattern), targetOffset = targetStart + targetPattern.length - "target".length;
        const targetLine = content.slice(0, targetStart).split("\n").length - 1;
        const targetLineStart = content.lastIndexOf("\n", targetStart) + 1;
        const callLine = content.slice(0, offset).split("\n").length - 1;
        send({ id: message.id, result: [{ to: { name: "target", kind: 12, uri,
          range: { start: { line: targetLine, character: 0 }, end: { line: targetLine, character: content.split("\n")[targetLine].length } },
          selectionRange: { start: { line: targetLine, character: targetOffset - targetLineStart }, end: { line: targetLine, character: targetOffset - targetLineStart + "target".length } } },
        fromRanges: [{ start: { line: callLine, character: offset - lineStart }, end: { line: callLine, character: offset - lineStart + "target".length } }] }] });
      } else send({ id: message.id, result: [] });
    } else if (message.method === "textDocument/prepareTypeHierarchy") {
      if (mode === "relations-hierarchy-error") { send({ id: message.id, error: { code: -32603, message: "private hierarchy failure" } }); continue; }
      if (mode === "relations-hierarchy-null") { send({ id: message.id, result: null }); continue; }
      if (mode === "relations-hierarchy-invalid") { send({ id: message.id, result: { invalid: true } }); continue; }
      const uri = message.params.textDocument.uri, content = opened.get(uri) ?? "", line = content.split("\n")[message.params.position.line] ?? "";
      const match = /class\s+([A-Za-z_$][\w$]*)/u.exec(line);
      if (!match) { send({ id: message.id, result: [] }); continue; }
      const name = match[1], character = line.indexOf(name);
      const item = { name, kind: 5, uri, range: { start: { line: message.params.position.line, character: 0 }, end: { line: message.params.position.line, character: line.length } },
        selectionRange: { start: { line: message.params.position.line, character }, end: { line: message.params.position.line, character: character + name.length } } };
      send({ id: message.id, result: mode === "relations-hierarchy-many" ? Array(11).fill(item)
        : mode === "relations-hierarchy-invalid-item" ? [item, { name: "malformed" }] : [item] });
    } else if (message.method === "typeHierarchy/supertypes") {
      if (mode === "relations-hierarchy-super-error") { send({ id: message.id, error: { code: -32603, message: "private supertype failure" } }); continue; }
      if (mode === "relations-hierarchy-super-invalid") { send({ id: message.id, result: [{ name: "invalid" }] }); continue; }
      if (mode === "relations-hierarchy-super-null") { send({ id: message.id, result: null }); continue; }
      const item = message.params.item;
      if (item.name === "Concrete") {
        const uri = item.uri, content = opened.get(uri) ?? "", line = 0, character = content.split("\n")[line].indexOf("Contract");
        const result = { name: "Contract", kind: 5, uri, range: { start: { line, character: 0 }, end: { line, character: 20 } },
          selectionRange: { start: { line, character }, end: { line, character: character + "Contract".length } } };
        send({ id: message.id, result: mode === "relations-hierarchy-results-many" ? Array(51).fill(result) : [result] });
      } else send({ id: message.id, result: [] });
    } else if (message.method === "typeHierarchy/subtypes") {
      if (mode === "relations-hierarchy-sub-error") { send({ id: message.id, error: { code: -32603, message: "private subtype failure" } }); continue; }
      if (mode === "relations-hierarchy-sub-invalid") { send({ id: message.id, result: { invalid: true } }); continue; }
      if (mode === "relations-hierarchy-sub-null") { send({ id: message.id, result: null }); continue; }
      send({ id: message.id, result: [] });
    } else if (message.method === "textDocument/implementation") {
      const uri = message.params.textDocument.uri, content = opened.get(uri) ?? "";
      if (mode === "relations-semantic-implementation-order") {
        activeImplementations++;
        if (activeImplementations > 1) { activeImplementations--; send({ id: message.id, error: { code: -32603, message: "implementation requests overlapped" } }); continue; }
        setTimeout(() => { activeImplementations--; send({ id: message.id, result: null }); }, 10);
        continue;
      }
      if (mode === "relations-progress" && !progressEnded) { send({ id: message.id, error: { code: -32603, message: "workspace load is incomplete" } }); continue; }
      if (mode === "relations-semantic-error") { send({ id: message.id, error: { code: -32603, message: "private implementation failure" } }); continue; }
      if (mode === "relations-impl-invalid") send({ id: message.id, result: { invalid: true } });
      else if (semanticMode && content.split("\n")[message.params.position.line]?.includes("class Contract")) {
        const line = 1, start = content.split("\n")[line].indexOf("Concrete");
        send({ id: message.id, result: [{ targetUri: uri, targetRange: { start: { line, character: 0 }, end: { line, character: content.split("\n")[line].length } },
          targetSelectionRange: { start: { line, character: start }, end: { line, character: start + "Concrete".length } } }] });
      } else send({ id: message.id, result: null });
    } else if (message.method === "textDocument/typeDefinition") {
      const uri = message.params.textDocument.uri, content = opened.get(uri) ?? "";
      if (mode === "relations-semantic-error") { send({ id: message.id, error: { code: -32603, message: "private type definition failure" } }); continue; }
      if (mode === "relations-impl-invalid") send({ id: message.id, result: [{ uri }] });
      else if (semanticMode && content.split("\n")[message.params.position.line]?.includes("let model")) {
        const line = 2, start = content.split("\n")[line].indexOf("Model");
        send({ id: message.id, result: { uri, range: { start: { line, character: start }, end: { line, character: start + "Model".length } } } });
      } else send({ id: message.id, result: [] });
    } else if (message.method === "shutdown") {
      if (mode === "shutdown-fast") process.stdout.write(encode({ id: message.id, result: null }), () => process.exit(0));
      else send({ id: message.id, result: null });
      if (mode === "nonzero") process.exitCode = 4;
    } else if (message.method === "exit") {
      if (mode !== "hang-after-shutdown") process.exit(process.exitCode ?? 0);
      else setInterval(() => {}, 1000);
    } else if (message.id !== undefined) send({ id: message.id, result: null });
  }
});
