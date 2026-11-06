import assert from "node:assert/strict";
const name = process.argv[2];
const { normalize } = await import(`./lib/${name}.mjs`);
assert.equal(normalize("a  b"), "a  b");
