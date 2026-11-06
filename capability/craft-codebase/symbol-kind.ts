const LSP_SYMBOL_KINDS: readonly (string | undefined)[] = [
  undefined, "file", "module", "namespace", "package", "class", "method", "property", "field", "constructor", "enum", "interface",
  "function", "variable", "constant", "string", "number", "boolean", "array", "object", "key", "null", "enum_member", "struct",
  "event", "operator", "type_parameter",
];

/** Convert the LSP SymbolKind enum to Craft's portable declaration category. */
export function lspDeclarationKind(value: unknown): string | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value < LSP_SYMBOL_KINDS.length
    ? LSP_SYMBOL_KINDS[value]
    : undefined;
}
