let buffer = Buffer.alloc(0);
const documents = new Map();

function send(message) {
  const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", ...message }));
  process.stdout.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]));
}

function functionsIn(content) {
  return content.split("\n").flatMap((line, index) => {
    const match = /\bfunc\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/u.exec(line);
    if (!match) return [];
    const start = match.index + match[0].indexOf(match[1]);
    return [{ name: match[1], line: index, start, end: start + match[1].length, text: line }];
  });
}

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
    const params = message.params ?? {};
    if (message.method === "initialize") {
      send({ id: message.id, result: { capabilities: { documentSymbolProvider: true, referencesProvider: true,
        definitionProvider: true, callHierarchyProvider: true, implementationProvider: true, typeDefinitionProvider: true,
        typeHierarchyProvider: true } } });
    } else if (message.method === "textDocument/didOpen") {
      documents.set(params.textDocument.uri, params.textDocument.text);
    } else if (message.method === "textDocument/documentSymbol") {
      const uri = params.textDocument.uri, content = documents.get(uri) ?? "";
      send({ id: message.id, result: functionsIn(content).map(fn => ({ name: fn.name, kind: 12,
        range: { start: { line: fn.line, character: 0 }, end: { line: fn.line, character: fn.text.length } },
        selectionRange: { start: { line: fn.line, character: fn.start }, end: { line: fn.line, character: fn.end } } })) });
    } else if (message.method === "textDocument/prepareCallHierarchy") {
      const uri = params.textDocument.uri, content = documents.get(uri) ?? "", fn = functionsIn(content).find(item => item.line === params.position.line);
      send({ id: message.id, result: fn ? [{ name: fn.name, kind: 12, uri,
        range: { start: { line: fn.line, character: 0 }, end: { line: fn.line, character: fn.text.length } },
        selectionRange: { start: { line: fn.line, character: fn.start }, end: { line: fn.line, character: fn.end } } }] : null });
    } else if (message.method === "callHierarchy/incomingCalls") {
      const item = params.item, uri = item.uri, content = documents.get(uri) ?? "";
      const caller = functionsIn(content).find(fn => fn.name !== item.name && fn.text.includes(`${item.name}()`));
      if (item.name === "goAgentTarget" && caller) {
        const targetLine = caller.line, start = caller.text.indexOf(item.name);
        send({ id: message.id, result: [{ from: { name: caller.name, kind: 12, uri,
          range: { start: { line: caller.line, character: 0 }, end: { line: caller.line, character: caller.text.length } },
          selectionRange: { start: { line: caller.line, character: caller.start }, end: { line: caller.line, character: caller.end } } },
          fromRanges: [{ start: { line: targetLine, character: start }, end: { line: targetLine, character: start + item.name.length } }] }] });
      } else send({ id: message.id, result: [] });
    } else if (message.method === "shutdown") send({ id: message.id, result: null });
    else if (message.method === "exit") process.exit(0);
    else if (message.method === "textDocument/references" || message.method === "textDocument/implementation"
      || message.method === "textDocument/typeDefinition" || message.method === "textDocument/definition"
      || message.method === "textDocument/prepareTypeHierarchy") send({ id: message.id, result: [] });
    else if (message.id !== undefined) send({ id: message.id, result: null });
  }
});
