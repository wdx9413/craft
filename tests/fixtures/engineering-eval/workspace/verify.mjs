import assert from "node:assert/strict";
const name = process.argv[2];
const { normalize } = await import(`./lib/${name}.mjs`);
assert.equal(normalize("  alpha beta  "), "alpha beta");
assert.equal(normalize("gamma   delta"), "gamma   delta");
