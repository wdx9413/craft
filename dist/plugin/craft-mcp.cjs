#!/usr/bin/env node
"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __commonJS = (cb, mod) => function __require() {
  try {
    return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
  } catch (e) {
    throw mod = 0, e;
  }
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/nodes/identity.js
var require_identity = __commonJS({
  "node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/nodes/identity.js"(exports2) {
    "use strict";
    var ALIAS = /* @__PURE__ */ Symbol.for("yaml.alias");
    var DOC = /* @__PURE__ */ Symbol.for("yaml.document");
    var MAP = /* @__PURE__ */ Symbol.for("yaml.map");
    var PAIR = /* @__PURE__ */ Symbol.for("yaml.pair");
    var SCALAR = /* @__PURE__ */ Symbol.for("yaml.scalar");
    var SEQ = /* @__PURE__ */ Symbol.for("yaml.seq");
    var NODE_TYPE = /* @__PURE__ */ Symbol.for("yaml.node.type");
    var isAlias = (node) => !!node && typeof node === "object" && node[NODE_TYPE] === ALIAS;
    var isDocument = (node) => !!node && typeof node === "object" && node[NODE_TYPE] === DOC;
    var isMap = (node) => !!node && typeof node === "object" && node[NODE_TYPE] === MAP;
    var isPair = (node) => !!node && typeof node === "object" && node[NODE_TYPE] === PAIR;
    var isScalar = (node) => !!node && typeof node === "object" && node[NODE_TYPE] === SCALAR;
    var isSeq = (node) => !!node && typeof node === "object" && node[NODE_TYPE] === SEQ;
    function isCollection(node) {
      if (node && typeof node === "object")
        switch (node[NODE_TYPE]) {
          case MAP:
          case SEQ:
            return true;
        }
      return false;
    }
    function isNode(node) {
      if (node && typeof node === "object")
        switch (node[NODE_TYPE]) {
          case ALIAS:
          case MAP:
          case SCALAR:
          case SEQ:
            return true;
        }
      return false;
    }
    var hasAnchor = (node) => (isScalar(node) || isCollection(node)) && !!node.anchor;
    exports2.ALIAS = ALIAS;
    exports2.DOC = DOC;
    exports2.MAP = MAP;
    exports2.NODE_TYPE = NODE_TYPE;
    exports2.PAIR = PAIR;
    exports2.SCALAR = SCALAR;
    exports2.SEQ = SEQ;
    exports2.hasAnchor = hasAnchor;
    exports2.isAlias = isAlias;
    exports2.isCollection = isCollection;
    exports2.isDocument = isDocument;
    exports2.isMap = isMap;
    exports2.isNode = isNode;
    exports2.isPair = isPair;
    exports2.isScalar = isScalar;
    exports2.isSeq = isSeq;
  }
});

// node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/visit.js
var require_visit = __commonJS({
  "node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/visit.js"(exports2) {
    "use strict";
    var identity = require_identity();
    var BREAK = /* @__PURE__ */ Symbol("break visit");
    var SKIP = /* @__PURE__ */ Symbol("skip children");
    var REMOVE = /* @__PURE__ */ Symbol("remove node");
    function visit(node, visitor) {
      const visitor_ = initVisitor(visitor);
      if (identity.isDocument(node)) {
        const cd = visit_(null, node.contents, visitor_, Object.freeze([node]));
        if (cd === REMOVE)
          node.contents = null;
      } else
        visit_(null, node, visitor_, Object.freeze([]));
    }
    visit.BREAK = BREAK;
    visit.SKIP = SKIP;
    visit.REMOVE = REMOVE;
    function visit_(key, node, visitor, path) {
      const ctrl = callVisitor(key, node, visitor, path);
      if (identity.isNode(ctrl) || identity.isPair(ctrl)) {
        replaceNode(key, path, ctrl);
        return visit_(key, ctrl, visitor, path);
      }
      if (typeof ctrl !== "symbol") {
        if (identity.isCollection(node)) {
          path = Object.freeze(path.concat(node));
          for (let i = 0; i < node.items.length; ++i) {
            const ci = visit_(i, node.items[i], visitor, path);
            if (typeof ci === "number")
              i = ci - 1;
            else if (ci === BREAK)
              return BREAK;
            else if (ci === REMOVE) {
              node.items.splice(i, 1);
              i -= 1;
            }
          }
        } else if (identity.isPair(node)) {
          path = Object.freeze(path.concat(node));
          const ck = visit_("key", node.key, visitor, path);
          if (ck === BREAK)
            return BREAK;
          else if (ck === REMOVE)
            node.key = null;
          const cv = visit_("value", node.value, visitor, path);
          if (cv === BREAK)
            return BREAK;
          else if (cv === REMOVE)
            node.value = null;
        }
      }
      return ctrl;
    }
    async function visitAsync(node, visitor) {
      const visitor_ = initVisitor(visitor);
      if (identity.isDocument(node)) {
        const cd = await visitAsync_(null, node.contents, visitor_, Object.freeze([node]));
        if (cd === REMOVE)
          node.contents = null;
      } else
        await visitAsync_(null, node, visitor_, Object.freeze([]));
    }
    visitAsync.BREAK = BREAK;
    visitAsync.SKIP = SKIP;
    visitAsync.REMOVE = REMOVE;
    async function visitAsync_(key, node, visitor, path) {
      const ctrl = await callVisitor(key, node, visitor, path);
      if (identity.isNode(ctrl) || identity.isPair(ctrl)) {
        replaceNode(key, path, ctrl);
        return visitAsync_(key, ctrl, visitor, path);
      }
      if (typeof ctrl !== "symbol") {
        if (identity.isCollection(node)) {
          path = Object.freeze(path.concat(node));
          for (let i = 0; i < node.items.length; ++i) {
            const ci = await visitAsync_(i, node.items[i], visitor, path);
            if (typeof ci === "number")
              i = ci - 1;
            else if (ci === BREAK)
              return BREAK;
            else if (ci === REMOVE) {
              node.items.splice(i, 1);
              i -= 1;
            }
          }
        } else if (identity.isPair(node)) {
          path = Object.freeze(path.concat(node));
          const ck = await visitAsync_("key", node.key, visitor, path);
          if (ck === BREAK)
            return BREAK;
          else if (ck === REMOVE)
            node.key = null;
          const cv = await visitAsync_("value", node.value, visitor, path);
          if (cv === BREAK)
            return BREAK;
          else if (cv === REMOVE)
            node.value = null;
        }
      }
      return ctrl;
    }
    function initVisitor(visitor) {
      if (typeof visitor === "object" && (visitor.Collection || visitor.Node || visitor.Value)) {
        return Object.assign({
          Alias: visitor.Node,
          Map: visitor.Node,
          Scalar: visitor.Node,
          Seq: visitor.Node
        }, visitor.Value && {
          Map: visitor.Value,
          Scalar: visitor.Value,
          Seq: visitor.Value
        }, visitor.Collection && {
          Map: visitor.Collection,
          Seq: visitor.Collection
        }, visitor);
      }
      return visitor;
    }
    function callVisitor(key, node, visitor, path) {
      if (typeof visitor === "function")
        return visitor(key, node, path);
      if (identity.isMap(node))
        return visitor.Map?.(key, node, path);
      if (identity.isSeq(node))
        return visitor.Seq?.(key, node, path);
      if (identity.isPair(node))
        return visitor.Pair?.(key, node, path);
      if (identity.isScalar(node))
        return visitor.Scalar?.(key, node, path);
      if (identity.isAlias(node))
        return visitor.Alias?.(key, node, path);
      return void 0;
    }
    function replaceNode(key, path, node) {
      const parent = path[path.length - 1];
      if (identity.isCollection(parent)) {
        parent.items[key] = node;
      } else if (identity.isPair(parent)) {
        if (key === "key")
          parent.key = node;
        else
          parent.value = node;
      } else if (identity.isDocument(parent)) {
        parent.contents = node;
      } else {
        const pt = identity.isAlias(parent) ? "alias" : "scalar";
        throw new Error(`Cannot replace node with ${pt} parent`);
      }
    }
    exports2.visit = visit;
    exports2.visitAsync = visitAsync;
  }
});

// node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/doc/directives.js
var require_directives = __commonJS({
  "node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/doc/directives.js"(exports2) {
    "use strict";
    var identity = require_identity();
    var visit = require_visit();
    var escapeChars = {
      "!": "%21",
      ",": "%2C",
      "[": "%5B",
      "]": "%5D",
      "{": "%7B",
      "}": "%7D"
    };
    var escapeTagName = (tn) => tn.replace(/[!,[\]{}]/g, (ch) => escapeChars[ch]);
    var Directives = class _Directives {
      constructor(yaml, tags) {
        this.docStart = null;
        this.docEnd = false;
        this.yaml = Object.assign({}, _Directives.defaultYaml, yaml);
        this.tags = Object.assign({}, _Directives.defaultTags, tags);
      }
      clone() {
        const copy = new _Directives(this.yaml, this.tags);
        copy.docStart = this.docStart;
        return copy;
      }
      /**
       * During parsing, get a Directives instance for the current document and
       * update the stream state according to the current version's spec.
       */
      atDocument() {
        const res = new _Directives(this.yaml, this.tags);
        switch (this.yaml.version) {
          case "1.1":
            this.atNextDocument = true;
            break;
          case "1.2":
            this.atNextDocument = false;
            this.yaml = {
              explicit: _Directives.defaultYaml.explicit,
              version: "1.2"
            };
            this.tags = Object.assign({}, _Directives.defaultTags);
            break;
        }
        return res;
      }
      /**
       * @param onError - May be called even if the action was successful
       * @returns `true` on success
       */
      add(line, onError) {
        if (this.atNextDocument) {
          this.yaml = { explicit: _Directives.defaultYaml.explicit, version: "1.1" };
          this.tags = Object.assign({}, _Directives.defaultTags);
          this.atNextDocument = false;
        }
        const parts = line.trim().split(/[ \t]+/);
        const name = parts.shift();
        switch (name) {
          case "%TAG": {
            if (parts.length !== 2) {
              onError(0, "%TAG directive should contain exactly two parts");
              if (parts.length < 2)
                return false;
            }
            const [handle, prefix] = parts;
            this.tags[handle] = prefix;
            return true;
          }
          case "%YAML": {
            this.yaml.explicit = true;
            if (parts.length !== 1) {
              onError(0, "%YAML directive should contain exactly one part");
              return false;
            }
            const [version] = parts;
            if (version === "1.1" || version === "1.2") {
              this.yaml.version = version;
              return true;
            } else {
              const isValid = /^\d+\.\d+$/.test(version);
              onError(6, `Unsupported YAML version ${version}`, isValid);
              return false;
            }
          }
          default:
            onError(0, `Unknown directive ${name}`, true);
            return false;
        }
      }
      /**
       * Resolves a tag, matching handles to those defined in %TAG directives.
       *
       * @returns Resolved tag, which may also be the non-specific tag `'!'` or a
       *   `'!local'` tag, or `null` if unresolvable.
       */
      tagName(source, onError) {
        if (source === "!")
          return "!";
        if (source[0] !== "!") {
          onError(`Not a valid tag: ${source}`);
          return null;
        }
        if (source[1] === "<") {
          const verbatim = source.slice(2, -1);
          if (verbatim === "!" || verbatim === "!!") {
            onError(`Verbatim tags aren't resolved, so ${source} is invalid.`);
            return null;
          }
          if (source[source.length - 1] !== ">")
            onError("Verbatim tags must end with a >");
          return verbatim;
        }
        const [, handle, suffix] = source.match(/^(.*!)([^!]*)$/s);
        if (!suffix)
          onError(`The ${source} tag has no suffix`);
        const prefix = this.tags[handle];
        if (prefix) {
          try {
            return prefix + decodeURIComponent(suffix);
          } catch (error) {
            onError(String(error));
            return null;
          }
        }
        if (handle === "!")
          return source;
        onError(`Could not resolve tag: ${source}`);
        return null;
      }
      /**
       * Given a fully resolved tag, returns its printable string form,
       * taking into account current tag prefixes and defaults.
       */
      tagString(tag) {
        for (const [handle, prefix] of Object.entries(this.tags)) {
          if (tag.startsWith(prefix))
            return handle + escapeTagName(tag.substring(prefix.length));
        }
        return tag[0] === "!" ? tag : `!<${tag}>`;
      }
      toString(doc) {
        const lines = this.yaml.explicit ? [`%YAML ${this.yaml.version || "1.2"}`] : [];
        const tagEntries = Object.entries(this.tags);
        let tagNames;
        if (doc && tagEntries.length > 0 && identity.isNode(doc.contents)) {
          const tags = {};
          visit.visit(doc.contents, (_key, node) => {
            if (identity.isNode(node) && node.tag)
              tags[node.tag] = true;
          });
          tagNames = Object.keys(tags);
        } else
          tagNames = [];
        for (const [handle, prefix] of tagEntries) {
          if (handle === "!!" && prefix === "tag:yaml.org,2002:")
            continue;
          if (!doc || tagNames.some((tn) => tn.startsWith(prefix)))
            lines.push(`%TAG ${handle} ${prefix}`);
        }
        return lines.join("\n");
      }
    };
    Directives.defaultYaml = { explicit: false, version: "1.2" };
    Directives.defaultTags = { "!!": "tag:yaml.org,2002:" };
    exports2.Directives = Directives;
  }
});

// node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/doc/anchors.js
var require_anchors = __commonJS({
  "node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/doc/anchors.js"(exports2) {
    "use strict";
    var identity = require_identity();
    var visit = require_visit();
    function anchorIsValid(anchor) {
      if (/[\x00-\x19\s,[\]{}]/.test(anchor)) {
        const sa = JSON.stringify(anchor);
        const msg = `Anchor must not contain whitespace or control characters: ${sa}`;
        throw new Error(msg);
      }
      return true;
    }
    function anchorNames(root) {
      const anchors = /* @__PURE__ */ new Set();
      visit.visit(root, {
        Value(_key, node) {
          if (node.anchor)
            anchors.add(node.anchor);
        }
      });
      return anchors;
    }
    function findNewAnchor(prefix, exclude) {
      for (let i = 1; true; ++i) {
        const name = `${prefix}${i}`;
        if (!exclude.has(name))
          return name;
      }
    }
    function createNodeAnchors(doc, prefix) {
      const aliasObjects = [];
      const sourceObjects = /* @__PURE__ */ new Map();
      let prevAnchors = null;
      return {
        onAnchor: (source) => {
          aliasObjects.push(source);
          prevAnchors ?? (prevAnchors = anchorNames(doc));
          const anchor = findNewAnchor(prefix, prevAnchors);
          prevAnchors.add(anchor);
          return anchor;
        },
        /**
         * With circular references, the source node is only resolved after all
         * of its child nodes are. This is why anchors are set only after all of
         * the nodes have been created.
         */
        setAnchors: () => {
          for (const source of aliasObjects) {
            const ref = sourceObjects.get(source);
            if (typeof ref === "object" && ref.anchor && (identity.isScalar(ref.node) || identity.isCollection(ref.node))) {
              ref.node.anchor = ref.anchor;
            } else {
              const error = new Error("Failed to resolve repeated object (this should not happen)");
              error.source = source;
              throw error;
            }
          }
        },
        sourceObjects
      };
    }
    exports2.anchorIsValid = anchorIsValid;
    exports2.anchorNames = anchorNames;
    exports2.createNodeAnchors = createNodeAnchors;
    exports2.findNewAnchor = findNewAnchor;
  }
});

// node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/doc/applyReviver.js
var require_applyReviver = __commonJS({
  "node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/doc/applyReviver.js"(exports2) {
    "use strict";
    function applyReviver(reviver, obj, key, val) {
      if (val && typeof val === "object") {
        if (Array.isArray(val)) {
          for (let i = 0, len = val.length; i < len; ++i) {
            const v0 = val[i];
            const v1 = applyReviver(reviver, val, String(i), v0);
            if (v1 === void 0)
              delete val[i];
            else if (v1 !== v0)
              val[i] = v1;
          }
        } else if (val instanceof Map) {
          for (const k of Array.from(val.keys())) {
            const v0 = val.get(k);
            const v1 = applyReviver(reviver, val, k, v0);
            if (v1 === void 0)
              val.delete(k);
            else if (v1 !== v0)
              val.set(k, v1);
          }
        } else if (val instanceof Set) {
          for (const v0 of Array.from(val)) {
            const v1 = applyReviver(reviver, val, v0, v0);
            if (v1 === void 0)
              val.delete(v0);
            else if (v1 !== v0) {
              val.delete(v0);
              val.add(v1);
            }
          }
        } else {
          for (const [k, v0] of Object.entries(val)) {
            const v1 = applyReviver(reviver, val, k, v0);
            if (v1 === void 0)
              delete val[k];
            else if (v1 !== v0)
              val[k] = v1;
          }
        }
      }
      return reviver.call(obj, key, val);
    }
    exports2.applyReviver = applyReviver;
  }
});

// node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/nodes/toJS.js
var require_toJS = __commonJS({
  "node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/nodes/toJS.js"(exports2) {
    "use strict";
    var identity = require_identity();
    function toJS(value, arg, ctx) {
      if (Array.isArray(value))
        return value.map((v, i) => toJS(v, String(i), ctx));
      if (value && typeof value.toJSON === "function") {
        if (!ctx || !identity.hasAnchor(value))
          return value.toJSON(arg, ctx);
        const data = { aliasCount: 0, count: 1, res: void 0 };
        ctx.anchors.set(value, data);
        ctx.onCreate = (res2) => {
          data.res = res2;
          delete ctx.onCreate;
        };
        const res = value.toJSON(arg, ctx);
        if (ctx.onCreate)
          ctx.onCreate(res);
        return res;
      }
      if (typeof value === "bigint" && !ctx?.keep)
        return Number(value);
      return value;
    }
    exports2.toJS = toJS;
  }
});

// node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/nodes/Node.js
var require_Node = __commonJS({
  "node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/nodes/Node.js"(exports2) {
    "use strict";
    var applyReviver = require_applyReviver();
    var identity = require_identity();
    var toJS = require_toJS();
    var NodeBase = class {
      constructor(type) {
        Object.defineProperty(this, identity.NODE_TYPE, { value: type });
      }
      /** Create a copy of this node.  */
      clone() {
        const copy = Object.create(Object.getPrototypeOf(this), Object.getOwnPropertyDescriptors(this));
        if (this.range)
          copy.range = this.range.slice();
        return copy;
      }
      /** A plain JavaScript representation of this node. */
      toJS(doc, { mapAsMap, maxAliasCount, onAnchor, reviver } = {}) {
        if (!identity.isDocument(doc))
          throw new TypeError("A document argument is required");
        const ctx = {
          anchors: /* @__PURE__ */ new Map(),
          doc,
          keep: true,
          mapAsMap: mapAsMap === true,
          mapKeyWarned: false,
          maxAliasCount: typeof maxAliasCount === "number" ? maxAliasCount : 100
        };
        const res = toJS.toJS(this, "", ctx);
        if (typeof onAnchor === "function")
          for (const { count, res: res2 } of ctx.anchors.values())
            onAnchor(res2, count);
        return typeof reviver === "function" ? applyReviver.applyReviver(reviver, { "": res }, "", res) : res;
      }
    };
    exports2.NodeBase = NodeBase;
  }
});

// node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/nodes/Alias.js
var require_Alias = __commonJS({
  "node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/nodes/Alias.js"(exports2) {
    "use strict";
    var anchors = require_anchors();
    var visit = require_visit();
    var identity = require_identity();
    var Node = require_Node();
    var toJS = require_toJS();
    var Alias = class extends Node.NodeBase {
      constructor(source) {
        super(identity.ALIAS);
        this.source = source;
        Object.defineProperty(this, "tag", {
          set() {
            throw new Error("Alias nodes cannot have tags");
          }
        });
      }
      /**
       * Resolve the value of this alias within `doc`, finding the last
       * instance of the `source` anchor before this node.
       */
      resolve(doc, ctx) {
        if (ctx?.maxAliasCount === 0)
          throw new ReferenceError("Alias resolution is disabled");
        let nodes;
        if (ctx?.aliasResolveCache) {
          nodes = ctx.aliasResolveCache;
        } else {
          nodes = [];
          visit.visit(doc, {
            Node: (_key, node) => {
              if (identity.isAlias(node) || identity.hasAnchor(node))
                nodes.push(node);
            }
          });
          if (ctx)
            ctx.aliasResolveCache = nodes;
        }
        let found = void 0;
        for (const node of nodes) {
          if (node === this)
            break;
          if (node.anchor === this.source)
            found = node;
        }
        return found;
      }
      toJSON(_arg, ctx) {
        if (!ctx)
          return { source: this.source };
        const { anchors: anchors2, doc, maxAliasCount } = ctx;
        const source = this.resolve(doc, ctx);
        if (!source) {
          const msg = `Unresolved alias (the anchor must be set before the alias): ${this.source}`;
          throw new ReferenceError(msg);
        }
        let data = anchors2.get(source);
        if (!data) {
          toJS.toJS(source, null, ctx);
          data = anchors2.get(source);
        }
        if (data?.res === void 0) {
          const msg = "This should not happen: Alias anchor was not resolved?";
          throw new ReferenceError(msg);
        }
        if (maxAliasCount >= 0) {
          data.count += 1;
          if (data.aliasCount === 0)
            data.aliasCount = getAliasCount(doc, source, anchors2);
          if (data.count * data.aliasCount > maxAliasCount) {
            const msg = "Excessive alias count indicates a resource exhaustion attack";
            throw new ReferenceError(msg);
          }
        }
        return data.res;
      }
      toString(ctx, _onComment, _onChompKeep) {
        const src = `*${this.source}`;
        if (ctx) {
          anchors.anchorIsValid(this.source);
          if (ctx.options.verifyAliasOrder && !ctx.anchors.has(this.source)) {
            const msg = `Unresolved alias (the anchor must be set before the alias): ${this.source}`;
            throw new Error(msg);
          }
          if (ctx.implicitKey)
            return `${src} `;
        }
        return src;
      }
    };
    function getAliasCount(doc, node, anchors2) {
      if (identity.isAlias(node)) {
        const source = node.resolve(doc);
        const anchor = anchors2 && source && anchors2.get(source);
        return anchor ? anchor.count * anchor.aliasCount : 0;
      } else if (identity.isCollection(node)) {
        let count = 0;
        for (const item of node.items) {
          const c = getAliasCount(doc, item, anchors2);
          if (c > count)
            count = c;
        }
        return count;
      } else if (identity.isPair(node)) {
        const kc = getAliasCount(doc, node.key, anchors2);
        const vc = getAliasCount(doc, node.value, anchors2);
        return Math.max(kc, vc);
      }
      return 1;
    }
    exports2.Alias = Alias;
  }
});

// node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/nodes/Scalar.js
var require_Scalar = __commonJS({
  "node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/nodes/Scalar.js"(exports2) {
    "use strict";
    var identity = require_identity();
    var Node = require_Node();
    var toJS = require_toJS();
    var isScalarValue = (value) => !value || typeof value !== "function" && typeof value !== "object";
    var Scalar = class extends Node.NodeBase {
      constructor(value) {
        super(identity.SCALAR);
        this.value = value;
      }
      toJSON(arg, ctx) {
        return ctx?.keep ? this.value : toJS.toJS(this.value, arg, ctx);
      }
      toString() {
        return String(this.value);
      }
    };
    Scalar.BLOCK_FOLDED = "BLOCK_FOLDED";
    Scalar.BLOCK_LITERAL = "BLOCK_LITERAL";
    Scalar.PLAIN = "PLAIN";
    Scalar.QUOTE_DOUBLE = "QUOTE_DOUBLE";
    Scalar.QUOTE_SINGLE = "QUOTE_SINGLE";
    exports2.Scalar = Scalar;
    exports2.isScalarValue = isScalarValue;
  }
});

// node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/doc/createNode.js
var require_createNode = __commonJS({
  "node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/doc/createNode.js"(exports2) {
    "use strict";
    var Alias = require_Alias();
    var identity = require_identity();
    var Scalar = require_Scalar();
    var defaultTagPrefix = "tag:yaml.org,2002:";
    function findTagObject(value, tagName, tags) {
      if (tagName) {
        const match = tags.filter((t) => t.tag === tagName);
        const tagObj = match.find((t) => !t.format) ?? match[0];
        if (!tagObj)
          throw new Error(`Tag ${tagName} not found`);
        return tagObj;
      }
      return tags.find((t) => t.identify?.(value) && !t.format);
    }
    function createNode(value, tagName, ctx) {
      if (identity.isDocument(value))
        value = value.contents;
      if (identity.isNode(value))
        return value;
      if (identity.isPair(value)) {
        const map = ctx.schema[identity.MAP].createNode?.(ctx.schema, null, ctx);
        map.items.push(value);
        return map;
      }
      if (value instanceof String || value instanceof Number || value instanceof Boolean || typeof BigInt !== "undefined" && value instanceof BigInt) {
        value = value.valueOf();
      }
      const { aliasDuplicateObjects, onAnchor, onTagObj, schema, sourceObjects } = ctx;
      let ref = void 0;
      if (aliasDuplicateObjects && value && typeof value === "object") {
        ref = sourceObjects.get(value);
        if (ref) {
          ref.anchor ?? (ref.anchor = onAnchor(value));
          return new Alias.Alias(ref.anchor);
        } else {
          ref = { anchor: null, node: null };
          sourceObjects.set(value, ref);
        }
      }
      if (tagName?.startsWith("!!"))
        tagName = defaultTagPrefix + tagName.slice(2);
      let tagObj = findTagObject(value, tagName, schema.tags);
      if (!tagObj) {
        if (value && typeof value.toJSON === "function") {
          value = value.toJSON();
        }
        if (!value || typeof value !== "object") {
          const node2 = new Scalar.Scalar(value);
          if (ref)
            ref.node = node2;
          return node2;
        }
        tagObj = value instanceof Map ? schema[identity.MAP] : Symbol.iterator in Object(value) ? schema[identity.SEQ] : schema[identity.MAP];
      }
      if (onTagObj) {
        onTagObj(tagObj);
        delete ctx.onTagObj;
      }
      const node = tagObj?.createNode ? tagObj.createNode(ctx.schema, value, ctx) : typeof tagObj?.nodeClass?.from === "function" ? tagObj.nodeClass.from(ctx.schema, value, ctx) : new Scalar.Scalar(value);
      if (tagName)
        node.tag = tagName;
      else if (!tagObj.default)
        node.tag = tagObj.tag;
      if (ref)
        ref.node = node;
      return node;
    }
    exports2.createNode = createNode;
  }
});

// node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/nodes/Collection.js
var require_Collection = __commonJS({
  "node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/nodes/Collection.js"(exports2) {
    "use strict";
    var createNode = require_createNode();
    var identity = require_identity();
    var Node = require_Node();
    function collectionFromPath(schema, path, value) {
      let v = value;
      for (let i = path.length - 1; i >= 0; --i) {
        const k = path[i];
        if (typeof k === "number" && Number.isInteger(k) && k >= 0) {
          const a = [];
          a[k] = v;
          v = a;
        } else {
          v = /* @__PURE__ */ new Map([[k, v]]);
        }
      }
      return createNode.createNode(v, void 0, {
        aliasDuplicateObjects: false,
        keepUndefined: false,
        onAnchor: () => {
          throw new Error("This should not happen, please report a bug.");
        },
        schema,
        sourceObjects: /* @__PURE__ */ new Map()
      });
    }
    var isEmptyPath = (path) => path == null || typeof path === "object" && !!path[Symbol.iterator]().next().done;
    var Collection = class extends Node.NodeBase {
      constructor(type, schema) {
        super(type);
        Object.defineProperty(this, "schema", {
          value: schema,
          configurable: true,
          enumerable: false,
          writable: true
        });
      }
      /**
       * Create a copy of this collection.
       *
       * @param schema - If defined, overwrites the original's schema
       */
      clone(schema) {
        const copy = Object.create(Object.getPrototypeOf(this), Object.getOwnPropertyDescriptors(this));
        if (schema)
          copy.schema = schema;
        copy.items = copy.items.map((it) => identity.isNode(it) || identity.isPair(it) ? it.clone(schema) : it);
        if (this.range)
          copy.range = this.range.slice();
        return copy;
      }
      /**
       * Adds a value to the collection. For `!!map` and `!!omap` the value must
       * be a Pair instance or a `{ key, value }` object, which may not have a key
       * that already exists in the map.
       */
      addIn(path, value) {
        if (isEmptyPath(path))
          this.add(value);
        else {
          const [key, ...rest] = path;
          const node = this.get(key, true);
          if (identity.isCollection(node))
            node.addIn(rest, value);
          else if (node === void 0 && this.schema)
            this.set(key, collectionFromPath(this.schema, rest, value));
          else
            throw new Error(`Expected YAML collection at ${key}. Remaining path: ${rest}`);
        }
      }
      /**
       * Removes a value from the collection.
       * @returns `true` if the item was found and removed.
       */
      deleteIn(path) {
        const [key, ...rest] = path;
        if (rest.length === 0)
          return this.delete(key);
        const node = this.get(key, true);
        if (identity.isCollection(node))
          return node.deleteIn(rest);
        else
          throw new Error(`Expected YAML collection at ${key}. Remaining path: ${rest}`);
      }
      /**
       * Returns item at `key`, or `undefined` if not found. By default unwraps
       * scalar values from their surrounding node; to disable set `keepScalar` to
       * `true` (collections are always returned intact).
       */
      getIn(path, keepScalar) {
        const [key, ...rest] = path;
        const node = this.get(key, true);
        if (rest.length === 0)
          return !keepScalar && identity.isScalar(node) ? node.value : node;
        else
          return identity.isCollection(node) ? node.getIn(rest, keepScalar) : void 0;
      }
      hasAllNullValues(allowScalar) {
        return this.items.every((node) => {
          if (!identity.isPair(node))
            return false;
          const n = node.value;
          return n == null || allowScalar && identity.isScalar(n) && n.value == null && !n.commentBefore && !n.comment && !n.tag;
        });
      }
      /**
       * Checks if the collection includes a value with the key `key`.
       */
      hasIn(path) {
        const [key, ...rest] = path;
        if (rest.length === 0)
          return this.has(key);
        const node = this.get(key, true);
        return identity.isCollection(node) ? node.hasIn(rest) : false;
      }
      /**
       * Sets a value in this collection. For `!!set`, `value` needs to be a
       * boolean to add/remove the item from the set.
       */
      setIn(path, value) {
        const [key, ...rest] = path;
        if (rest.length === 0) {
          this.set(key, value);
        } else {
          const node = this.get(key, true);
          if (identity.isCollection(node))
            node.setIn(rest, value);
          else if (node === void 0 && this.schema)
            this.set(key, collectionFromPath(this.schema, rest, value));
          else
            throw new Error(`Expected YAML collection at ${key}. Remaining path: ${rest}`);
        }
      }
    };
    exports2.Collection = Collection;
    exports2.collectionFromPath = collectionFromPath;
    exports2.isEmptyPath = isEmptyPath;
  }
});

// node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/stringify/stringifyComment.js
var require_stringifyComment = __commonJS({
  "node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/stringify/stringifyComment.js"(exports2) {
    "use strict";
    var stringifyComment = (str) => str.replace(/^(?!$)(?: $)?/gm, "#");
    function indentComment(comment, indent) {
      if (/^\n+$/.test(comment))
        return comment.substring(1);
      return indent ? comment.replace(/^(?! *$)/gm, indent) : comment;
    }
    var lineComment = (str, indent, comment) => str.endsWith("\n") ? indentComment(comment, indent) : comment.includes("\n") ? "\n" + indentComment(comment, indent) : (str.endsWith(" ") ? "" : " ") + comment;
    exports2.indentComment = indentComment;
    exports2.lineComment = lineComment;
    exports2.stringifyComment = stringifyComment;
  }
});

// node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/stringify/foldFlowLines.js
var require_foldFlowLines = __commonJS({
  "node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/stringify/foldFlowLines.js"(exports2) {
    "use strict";
    var FOLD_FLOW = "flow";
    var FOLD_BLOCK = "block";
    var FOLD_QUOTED = "quoted";
    function foldFlowLines(text2, indent, mode = "flow", { indentAtStart, lineWidth = 80, minContentWidth = 20, onFold, onOverflow } = {}) {
      if (!lineWidth || lineWidth < 0)
        return text2;
      if (lineWidth < minContentWidth)
        minContentWidth = 0;
      const endStep = Math.max(1 + minContentWidth, 1 + lineWidth - indent.length);
      if (text2.length <= endStep)
        return text2;
      const folds = [];
      const escapedFolds = {};
      let end = lineWidth - indent.length;
      if (typeof indentAtStart === "number") {
        if (indentAtStart > lineWidth - Math.max(2, minContentWidth))
          folds.push(0);
        else
          end = lineWidth - indentAtStart;
      }
      let split = void 0;
      let prev = void 0;
      let overflow = false;
      let i = -1;
      let escStart = -1;
      let escEnd = -1;
      if (mode === FOLD_BLOCK) {
        i = consumeMoreIndentedLines(text2, i, indent.length);
        if (i !== -1)
          end = i + endStep;
      }
      for (let ch; ch = text2[i += 1]; ) {
        if (mode === FOLD_QUOTED && ch === "\\") {
          escStart = i;
          switch (text2[i + 1]) {
            case "x":
              i += 3;
              break;
            case "u":
              i += 5;
              break;
            case "U":
              i += 9;
              break;
            default:
              i += 1;
          }
          escEnd = i;
        }
        if (ch === "\n") {
          if (mode === FOLD_BLOCK)
            i = consumeMoreIndentedLines(text2, i, indent.length);
          end = i + indent.length + endStep;
          split = void 0;
        } else {
          if (ch === " " && prev && prev !== " " && prev !== "\n" && prev !== "	") {
            const next = text2[i + 1];
            if (next && next !== " " && next !== "\n" && next !== "	")
              split = i;
          }
          if (i >= end) {
            if (split) {
              folds.push(split);
              end = split + endStep;
              split = void 0;
            } else if (mode === FOLD_QUOTED) {
              while (prev === " " || prev === "	") {
                prev = ch;
                ch = text2[i += 1];
                overflow = true;
              }
              const j = i > escEnd + 1 ? i - 2 : escStart - 1;
              if (escapedFolds[j])
                return text2;
              folds.push(j);
              escapedFolds[j] = true;
              end = j + endStep;
              split = void 0;
            } else {
              overflow = true;
            }
          }
        }
        prev = ch;
      }
      if (overflow && onOverflow)
        onOverflow();
      if (folds.length === 0)
        return text2;
      if (onFold)
        onFold();
      let res = text2.slice(0, folds[0]);
      for (let i2 = 0; i2 < folds.length; ++i2) {
        const fold = folds[i2];
        const end2 = folds[i2 + 1] || text2.length;
        if (fold === 0)
          res = `
${indent}${text2.slice(0, end2)}`;
        else {
          if (mode === FOLD_QUOTED && escapedFolds[fold])
            res += `${text2[fold]}\\`;
          res += `
${indent}${text2.slice(fold + 1, end2)}`;
        }
      }
      return res;
    }
    function consumeMoreIndentedLines(text2, i, indent) {
      let end = i;
      let start = i + 1;
      let ch = text2[start];
      while (ch === " " || ch === "	") {
        if (i < start + indent) {
          ch = text2[++i];
        } else {
          do {
            ch = text2[++i];
          } while (ch && ch !== "\n");
          end = i;
          start = i + 1;
          ch = text2[start];
        }
      }
      return end;
    }
    exports2.FOLD_BLOCK = FOLD_BLOCK;
    exports2.FOLD_FLOW = FOLD_FLOW;
    exports2.FOLD_QUOTED = FOLD_QUOTED;
    exports2.foldFlowLines = foldFlowLines;
  }
});

// node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/stringify/stringifyString.js
var require_stringifyString = __commonJS({
  "node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/stringify/stringifyString.js"(exports2) {
    "use strict";
    var Scalar = require_Scalar();
    var foldFlowLines = require_foldFlowLines();
    var getFoldOptions = (ctx, isBlock) => ({
      indentAtStart: isBlock ? ctx.indent.length : ctx.indentAtStart,
      lineWidth: ctx.options.lineWidth,
      minContentWidth: ctx.options.minContentWidth
    });
    var containsDocumentMarker = (str) => /^(%|---|\.\.\.)/m.test(str);
    function lineLengthOverLimit(str, lineWidth, indentLength) {
      if (!lineWidth || lineWidth < 0)
        return false;
      const limit = lineWidth - indentLength;
      const strLen = str.length;
      if (strLen <= limit)
        return false;
      for (let i = 0, start = 0; i < strLen; ++i) {
        if (str[i] === "\n") {
          if (i - start > limit)
            return true;
          start = i + 1;
          if (strLen - start <= limit)
            return false;
        }
      }
      return true;
    }
    function doubleQuotedString(value, ctx) {
      const json = JSON.stringify(value);
      if (ctx.options.doubleQuotedAsJSON)
        return json;
      const { implicitKey } = ctx;
      const minMultiLineLength = ctx.options.doubleQuotedMinMultiLineLength;
      const indent = ctx.indent || (containsDocumentMarker(value) ? "  " : "");
      let str = "";
      let start = 0;
      for (let i = 0, ch = json[i]; ch; ch = json[++i]) {
        if (ch === " " && json[i + 1] === "\\" && json[i + 2] === "n") {
          str += json.slice(start, i) + "\\ ";
          i += 1;
          start = i;
          ch = "\\";
        }
        if (ch === "\\")
          switch (json[i + 1]) {
            case "u":
              {
                str += json.slice(start, i);
                const code = json.substr(i + 2, 4);
                switch (code) {
                  case "0000":
                    str += "\\0";
                    break;
                  case "0007":
                    str += "\\a";
                    break;
                  case "000b":
                    str += "\\v";
                    break;
                  case "001b":
                    str += "\\e";
                    break;
                  case "0085":
                    str += "\\N";
                    break;
                  case "00a0":
                    str += "\\_";
                    break;
                  case "2028":
                    str += "\\L";
                    break;
                  case "2029":
                    str += "\\P";
                    break;
                  default:
                    if (code.substr(0, 2) === "00")
                      str += "\\x" + code.substr(2);
                    else
                      str += json.substr(i, 6);
                }
                i += 5;
                start = i + 1;
              }
              break;
            case "n":
              if (implicitKey || json[i + 2] === '"' || json.length < minMultiLineLength) {
                i += 1;
              } else {
                str += json.slice(start, i) + "\n\n";
                while (json[i + 2] === "\\" && json[i + 3] === "n" && json[i + 4] !== '"') {
                  str += "\n";
                  i += 2;
                }
                str += indent;
                if (json[i + 2] === " ")
                  str += "\\";
                i += 1;
                start = i + 1;
              }
              break;
            default:
              i += 1;
          }
      }
      str = start ? str + json.slice(start) : json;
      return implicitKey ? str : foldFlowLines.foldFlowLines(str, indent, foldFlowLines.FOLD_QUOTED, getFoldOptions(ctx, false));
    }
    function singleQuotedString(value, ctx) {
      if (ctx.options.singleQuote === false || ctx.implicitKey && value.includes("\n") || /[ \t]\n|\n[ \t]/.test(value))
        return doubleQuotedString(value, ctx);
      const indent = ctx.indent || (containsDocumentMarker(value) ? "  " : "");
      const res = "'" + value.replace(/'/g, "''").replace(/\n+/g, `$&
${indent}`) + "'";
      return ctx.implicitKey ? res : foldFlowLines.foldFlowLines(res, indent, foldFlowLines.FOLD_FLOW, getFoldOptions(ctx, false));
    }
    function quotedString(value, ctx) {
      const { singleQuote } = ctx.options;
      let qs;
      if (singleQuote === false)
        qs = doubleQuotedString;
      else {
        const hasDouble = value.includes('"');
        const hasSingle = value.includes("'");
        if (hasDouble && !hasSingle)
          qs = singleQuotedString;
        else if (hasSingle && !hasDouble)
          qs = doubleQuotedString;
        else
          qs = singleQuote ? singleQuotedString : doubleQuotedString;
      }
      return qs(value, ctx);
    }
    var blockEndNewlines;
    try {
      blockEndNewlines = new RegExp("(^|(?<!\n))\n+(?!\n|$)", "g");
    } catch {
      blockEndNewlines = /\n+(?!\n|$)/g;
    }
    function blockString({ comment, type, value }, ctx, onComment, onChompKeep) {
      const { blockQuote, commentString, lineWidth } = ctx.options;
      if (!blockQuote || /\n[\t ]+$/.test(value)) {
        return quotedString(value, ctx);
      }
      const indent = ctx.indent || (ctx.forceBlockIndent || containsDocumentMarker(value) ? "  " : "");
      const literal = blockQuote === "literal" ? true : blockQuote === "folded" || type === Scalar.Scalar.BLOCK_FOLDED ? false : type === Scalar.Scalar.BLOCK_LITERAL ? true : !lineLengthOverLimit(value, lineWidth, indent.length);
      if (!value)
        return literal ? "|\n" : ">\n";
      let chomp;
      let endStart;
      for (endStart = value.length; endStart > 0; --endStart) {
        const ch = value[endStart - 1];
        if (ch !== "\n" && ch !== "	" && ch !== " ")
          break;
      }
      let end = value.substring(endStart);
      const endNlPos = end.indexOf("\n");
      if (endNlPos === -1) {
        chomp = "-";
      } else if (value === end || endNlPos !== end.length - 1) {
        chomp = "+";
        if (onChompKeep)
          onChompKeep();
      } else {
        chomp = "";
      }
      if (end) {
        value = value.slice(0, -end.length);
        if (end[end.length - 1] === "\n")
          end = end.slice(0, -1);
        end = end.replace(blockEndNewlines, `$&${indent}`);
      }
      let startWithSpace = false;
      let startEnd;
      let startNlPos = -1;
      for (startEnd = 0; startEnd < value.length; ++startEnd) {
        const ch = value[startEnd];
        if (ch === " ")
          startWithSpace = true;
        else if (ch === "\n")
          startNlPos = startEnd;
        else
          break;
      }
      let start = value.substring(0, startNlPos < startEnd ? startNlPos + 1 : startEnd);
      if (start) {
        value = value.substring(start.length);
        start = start.replace(/\n+/g, `$&${indent}`);
      }
      const indentSize = indent ? "2" : "1";
      let header = (startWithSpace ? indentSize : "") + chomp;
      if (comment) {
        header += " " + commentString(comment.replace(/ ?[\r\n]+/g, " "));
        if (onComment)
          onComment();
      }
      if (!literal) {
        const foldedValue = value.replace(/\n+/g, "\n$&").replace(/(?:^|\n)([\t ].*)(?:([\n\t ]*)\n(?![\n\t ]))?/g, "$1$2").replace(/\n+/g, `$&${indent}`);
        let literalFallback = false;
        const foldOptions = getFoldOptions(ctx, true);
        if (blockQuote !== "folded" && type !== Scalar.Scalar.BLOCK_FOLDED) {
          foldOptions.onOverflow = () => {
            literalFallback = true;
          };
        }
        const body = foldFlowLines.foldFlowLines(`${start}${foldedValue}${end}`, indent, foldFlowLines.FOLD_BLOCK, foldOptions);
        if (!literalFallback)
          return `>${header}
${indent}${body}`;
      }
      value = value.replace(/\n+/g, `$&${indent}`);
      return `|${header}
${indent}${start}${value}${end}`;
    }
    function plainString(item, ctx, onComment, onChompKeep) {
      const { type, value } = item;
      const { actualString, implicitKey, indent, indentStep, inFlow } = ctx;
      if (implicitKey && value.includes("\n") || inFlow && /[[\]{},]/.test(value)) {
        return quotedString(value, ctx);
      }
      if (/^[\n\t ,[\]{}#&*!|>'"%@`]|^[?-]$|^[?-][ \t]|[\n:][ \t]|[ \t]\n|[\n\t ]#|[\n\t :]$/.test(value)) {
        return implicitKey || inFlow || !value.includes("\n") ? quotedString(value, ctx) : blockString(item, ctx, onComment, onChompKeep);
      }
      if (!implicitKey && !inFlow && type !== Scalar.Scalar.PLAIN && value.includes("\n")) {
        return blockString(item, ctx, onComment, onChompKeep);
      }
      if (containsDocumentMarker(value)) {
        if (indent === "") {
          ctx.forceBlockIndent = true;
          return blockString(item, ctx, onComment, onChompKeep);
        } else if (implicitKey && indent === indentStep) {
          return quotedString(value, ctx);
        }
      }
      const str = value.replace(/\n+/g, `$&
${indent}`);
      if (actualString) {
        const test = (tag) => tag.default && tag.tag !== "tag:yaml.org,2002:str" && tag.test?.test(str);
        const { compat, tags } = ctx.doc.schema;
        if (tags.some(test) || compat?.some(test))
          return quotedString(value, ctx);
      }
      return implicitKey ? str : foldFlowLines.foldFlowLines(str, indent, foldFlowLines.FOLD_FLOW, getFoldOptions(ctx, false));
    }
    function stringifyString(item, ctx, onComment, onChompKeep) {
      const { implicitKey, inFlow } = ctx;
      const ss = typeof item.value === "string" ? item : Object.assign({}, item, { value: String(item.value) });
      let { type } = item;
      if (type !== Scalar.Scalar.QUOTE_DOUBLE) {
        if (/[\x00-\x08\x0b-\x1f\x7f-\x9f\u{D800}-\u{DFFF}]/u.test(ss.value))
          type = Scalar.Scalar.QUOTE_DOUBLE;
      }
      const _stringify = (_type) => {
        switch (_type) {
          case Scalar.Scalar.BLOCK_FOLDED:
          case Scalar.Scalar.BLOCK_LITERAL:
            return implicitKey || inFlow ? quotedString(ss.value, ctx) : blockString(ss, ctx, onComment, onChompKeep);
          case Scalar.Scalar.QUOTE_DOUBLE:
            return doubleQuotedString(ss.value, ctx);
          case Scalar.Scalar.QUOTE_SINGLE:
            return singleQuotedString(ss.value, ctx);
          case Scalar.Scalar.PLAIN:
            return plainString(ss, ctx, onComment, onChompKeep);
          default:
            return null;
        }
      };
      let res = _stringify(type);
      if (res === null) {
        const { defaultKeyType, defaultStringType } = ctx.options;
        const t = implicitKey && defaultKeyType || defaultStringType;
        res = _stringify(t);
        if (res === null)
          throw new Error(`Unsupported default string type ${t}`);
      }
      return res;
    }
    exports2.stringifyString = stringifyString;
  }
});

// node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/stringify/stringify.js
var require_stringify = __commonJS({
  "node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/stringify/stringify.js"(exports2) {
    "use strict";
    var anchors = require_anchors();
    var identity = require_identity();
    var stringifyComment = require_stringifyComment();
    var stringifyString = require_stringifyString();
    function createStringifyContext(doc, options) {
      const opt = Object.assign({
        blockQuote: true,
        commentString: stringifyComment.stringifyComment,
        defaultKeyType: null,
        defaultStringType: "PLAIN",
        directives: null,
        doubleQuotedAsJSON: false,
        doubleQuotedMinMultiLineLength: 40,
        falseStr: "false",
        flowCollectionPadding: true,
        indentSeq: true,
        lineWidth: 80,
        minContentWidth: 20,
        nullStr: "null",
        simpleKeys: false,
        singleQuote: null,
        trailingComma: false,
        trueStr: "true",
        verifyAliasOrder: true
      }, doc.schema.toStringOptions, options);
      let inFlow;
      switch (opt.collectionStyle) {
        case "block":
          inFlow = false;
          break;
        case "flow":
          inFlow = true;
          break;
        default:
          inFlow = null;
      }
      return {
        anchors: /* @__PURE__ */ new Set(),
        doc,
        flowCollectionPadding: opt.flowCollectionPadding ? " " : "",
        indent: "",
        indentStep: typeof opt.indent === "number" ? " ".repeat(opt.indent) : "  ",
        inFlow,
        options: opt
      };
    }
    function getTagObject(tags, item) {
      if (item.tag) {
        const match = tags.filter((t) => t.tag === item.tag);
        if (match.length > 0)
          return match.find((t) => t.format === item.format) ?? match[0];
      }
      let tagObj = void 0;
      let obj;
      if (identity.isScalar(item)) {
        obj = item.value;
        let match = tags.filter((t) => t.identify?.(obj));
        if (match.length > 1) {
          const testMatch = match.filter((t) => t.test);
          if (testMatch.length > 0)
            match = testMatch;
        }
        tagObj = match.find((t) => t.format === item.format) ?? match.find((t) => !t.format);
      } else {
        obj = item;
        tagObj = tags.find((t) => t.nodeClass && obj instanceof t.nodeClass);
      }
      if (!tagObj) {
        const name = obj?.constructor?.name ?? (obj === null ? "null" : typeof obj);
        throw new Error(`Tag not resolved for ${name} value`);
      }
      return tagObj;
    }
    function stringifyProps(node, tagObj, { anchors: anchors$1, doc }) {
      if (!doc.directives)
        return "";
      const props = [];
      const anchor = (identity.isScalar(node) || identity.isCollection(node)) && node.anchor;
      if (anchor && anchors.anchorIsValid(anchor)) {
        anchors$1.add(anchor);
        props.push(`&${anchor}`);
      }
      const tag = node.tag ?? (tagObj.default ? null : tagObj.tag);
      if (tag)
        props.push(doc.directives.tagString(tag));
      return props.join(" ");
    }
    function stringify(item, ctx, onComment, onChompKeep) {
      if (identity.isPair(item))
        return item.toString(ctx, onComment, onChompKeep);
      if (identity.isAlias(item)) {
        if (ctx.doc.directives)
          return item.toString(ctx);
        if (ctx.resolvedAliases?.has(item)) {
          throw new TypeError(`Cannot stringify circular structure without alias nodes`);
        } else {
          if (ctx.resolvedAliases)
            ctx.resolvedAliases.add(item);
          else
            ctx.resolvedAliases = /* @__PURE__ */ new Set([item]);
          item = item.resolve(ctx.doc);
        }
      }
      let tagObj = void 0;
      const node = identity.isNode(item) ? item : ctx.doc.createNode(item, { onTagObj: (o) => tagObj = o });
      tagObj ?? (tagObj = getTagObject(ctx.doc.schema.tags, node));
      const props = stringifyProps(node, tagObj, ctx);
      if (props.length > 0)
        ctx.indentAtStart = (ctx.indentAtStart ?? 0) + props.length + 1;
      const str = typeof tagObj.stringify === "function" ? tagObj.stringify(node, ctx, onComment, onChompKeep) : identity.isScalar(node) ? stringifyString.stringifyString(node, ctx, onComment, onChompKeep) : node.toString(ctx, onComment, onChompKeep);
      if (!props)
        return str;
      return identity.isScalar(node) || str[0] === "{" || str[0] === "[" ? `${props} ${str}` : `${props}
${ctx.indent}${str}`;
    }
    exports2.createStringifyContext = createStringifyContext;
    exports2.stringify = stringify;
  }
});

// node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/stringify/stringifyPair.js
var require_stringifyPair = __commonJS({
  "node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/stringify/stringifyPair.js"(exports2) {
    "use strict";
    var identity = require_identity();
    var Scalar = require_Scalar();
    var stringify = require_stringify();
    var stringifyComment = require_stringifyComment();
    function stringifyPair({ key, value }, ctx, onComment, onChompKeep) {
      const { allNullValues, doc, indent, indentStep, options: { commentString, indentSeq, simpleKeys } } = ctx;
      let keyComment = identity.isNode(key) && key.comment || null;
      if (simpleKeys) {
        if (keyComment) {
          throw new Error("With simple keys, key nodes cannot have comments");
        }
        if (identity.isCollection(key) || !identity.isNode(key) && typeof key === "object") {
          const msg = "With simple keys, collection cannot be used as a key value";
          throw new Error(msg);
        }
      }
      let explicitKey = !simpleKeys && (!key || keyComment && value == null && !ctx.inFlow || identity.isCollection(key) || (identity.isScalar(key) ? key.type === Scalar.Scalar.BLOCK_FOLDED || key.type === Scalar.Scalar.BLOCK_LITERAL : typeof key === "object"));
      ctx = Object.assign({}, ctx, {
        allNullValues: false,
        implicitKey: !explicitKey && (simpleKeys || !allNullValues),
        indent: indent + indentStep
      });
      let keyCommentDone = false;
      let chompKeep = false;
      let str = stringify.stringify(key, ctx, () => keyCommentDone = true, () => chompKeep = true);
      if (!explicitKey && !ctx.inFlow && str.length > 1024) {
        if (simpleKeys)
          throw new Error("With simple keys, single line scalar must not span more than 1024 characters");
        explicitKey = true;
      }
      if (ctx.inFlow) {
        if (allNullValues || value == null) {
          if (keyCommentDone && onComment)
            onComment();
          return str === "" ? "?" : explicitKey ? `? ${str}` : str;
        }
      } else if (allNullValues && !simpleKeys || value == null && explicitKey) {
        str = `? ${str}`;
        if (keyComment && !keyCommentDone) {
          str += stringifyComment.lineComment(str, ctx.indent, commentString(keyComment));
        } else if (chompKeep && onChompKeep)
          onChompKeep();
        return str;
      }
      if (keyCommentDone)
        keyComment = null;
      if (explicitKey) {
        if (keyComment)
          str += stringifyComment.lineComment(str, ctx.indent, commentString(keyComment));
        str = `? ${str}
${indent}:`;
      } else {
        str = `${str}:`;
        if (keyComment)
          str += stringifyComment.lineComment(str, ctx.indent, commentString(keyComment));
      }
      let vsb, vcb, valueComment;
      if (identity.isNode(value)) {
        vsb = !!value.spaceBefore;
        vcb = value.commentBefore;
        valueComment = value.comment;
      } else {
        vsb = false;
        vcb = null;
        valueComment = null;
        if (value && typeof value === "object")
          value = doc.createNode(value);
      }
      ctx.implicitKey = false;
      if (!explicitKey && !keyComment && identity.isScalar(value))
        ctx.indentAtStart = str.length + 1;
      chompKeep = false;
      if (!indentSeq && indentStep.length >= 2 && !ctx.inFlow && !explicitKey && identity.isSeq(value) && !value.flow && !value.tag && !value.anchor) {
        ctx.indent = ctx.indent.substring(2);
      }
      let valueCommentDone = false;
      const valueStr = stringify.stringify(value, ctx, () => valueCommentDone = true, () => chompKeep = true);
      let ws = " ";
      if (keyComment || vsb || vcb) {
        ws = vsb ? "\n" : "";
        if (vcb) {
          const cs = commentString(vcb);
          ws += `
${stringifyComment.indentComment(cs, ctx.indent)}`;
        }
        if (valueStr === "" && !ctx.inFlow) {
          if (ws === "\n" && valueComment)
            ws = "\n\n";
        } else {
          ws += `
${ctx.indent}`;
        }
      } else if (!explicitKey && identity.isCollection(value)) {
        const vs0 = valueStr[0];
        const nl0 = valueStr.indexOf("\n");
        const hasNewline = nl0 !== -1;
        const flow = ctx.inFlow ?? value.flow ?? value.items.length === 0;
        if (hasNewline || !flow) {
          let hasPropsLine = false;
          if (hasNewline && (vs0 === "&" || vs0 === "!")) {
            let sp0 = valueStr.indexOf(" ");
            if (vs0 === "&" && sp0 !== -1 && sp0 < nl0 && valueStr[sp0 + 1] === "!") {
              sp0 = valueStr.indexOf(" ", sp0 + 1);
            }
            if (sp0 === -1 || nl0 < sp0)
              hasPropsLine = true;
          }
          if (!hasPropsLine)
            ws = `
${ctx.indent}`;
        }
      } else if (valueStr === "" || valueStr[0] === "\n") {
        ws = "";
      }
      str += ws + valueStr;
      if (ctx.inFlow) {
        if (valueCommentDone && onComment)
          onComment();
      } else if (valueComment && !valueCommentDone) {
        str += stringifyComment.lineComment(str, ctx.indent, commentString(valueComment));
      } else if (chompKeep && onChompKeep) {
        onChompKeep();
      }
      return str;
    }
    exports2.stringifyPair = stringifyPair;
  }
});

// node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/log.js
var require_log = __commonJS({
  "node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/log.js"(exports2) {
    "use strict";
    var node_process = require("process");
    function debug(logLevel, ...messages) {
      if (logLevel === "debug")
        console.log(...messages);
    }
    function warn(logLevel, warning) {
      if (logLevel === "debug" || logLevel === "warn") {
        if (typeof node_process.emitWarning === "function")
          node_process.emitWarning(warning);
        else
          console.warn(warning);
      }
    }
    exports2.debug = debug;
    exports2.warn = warn;
  }
});

// node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/schema/yaml-1.1/merge.js
var require_merge = __commonJS({
  "node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/schema/yaml-1.1/merge.js"(exports2) {
    "use strict";
    var identity = require_identity();
    var Scalar = require_Scalar();
    var MERGE_KEY = "<<";
    var merge = {
      identify: (value) => value === MERGE_KEY || typeof value === "symbol" && value.description === MERGE_KEY,
      default: "key",
      tag: "tag:yaml.org,2002:merge",
      test: /^<<$/,
      resolve: () => Object.assign(new Scalar.Scalar(Symbol(MERGE_KEY)), {
        addToJSMap: addMergeToJSMap
      }),
      stringify: () => MERGE_KEY
    };
    var isMergeKey = (ctx, key) => (merge.identify(key) || identity.isScalar(key) && (!key.type || key.type === Scalar.Scalar.PLAIN) && merge.identify(key.value)) && ctx?.doc.schema.tags.some((tag) => tag.tag === merge.tag && tag.default);
    function addMergeToJSMap(ctx, map, value) {
      const source = resolveAliasValue(ctx, value);
      if (identity.isSeq(source))
        for (const it of source.items)
          mergeValue(ctx, map, it);
      else if (Array.isArray(source))
        for (const it of source)
          mergeValue(ctx, map, it);
      else
        mergeValue(ctx, map, source);
    }
    function mergeValue(ctx, map, value) {
      const source = resolveAliasValue(ctx, value);
      if (!identity.isMap(source))
        throw new Error("Merge sources must be maps or map aliases");
      const srcMap = source.toJSON(null, ctx, Map);
      for (const [key, value2] of srcMap) {
        if (map instanceof Map) {
          if (!map.has(key))
            map.set(key, value2);
        } else if (map instanceof Set) {
          map.add(key);
        } else if (!Object.prototype.hasOwnProperty.call(map, key)) {
          Object.defineProperty(map, key, {
            value: value2,
            writable: true,
            enumerable: true,
            configurable: true
          });
        }
      }
      return map;
    }
    function resolveAliasValue(ctx, value) {
      return ctx && identity.isAlias(value) ? value.resolve(ctx.doc, ctx) : value;
    }
    exports2.addMergeToJSMap = addMergeToJSMap;
    exports2.isMergeKey = isMergeKey;
    exports2.merge = merge;
  }
});

// node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/nodes/addPairToJSMap.js
var require_addPairToJSMap = __commonJS({
  "node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/nodes/addPairToJSMap.js"(exports2) {
    "use strict";
    var log = require_log();
    var merge = require_merge();
    var stringify = require_stringify();
    var identity = require_identity();
    var toJS = require_toJS();
    function addPairToJSMap(ctx, map, { key, value }) {
      if (identity.isNode(key) && key.addToJSMap)
        key.addToJSMap(ctx, map, value);
      else if (merge.isMergeKey(ctx, key))
        merge.addMergeToJSMap(ctx, map, value);
      else {
        const jsKey = toJS.toJS(key, "", ctx);
        if (map instanceof Map) {
          map.set(jsKey, toJS.toJS(value, jsKey, ctx));
        } else if (map instanceof Set) {
          map.add(jsKey);
        } else {
          const stringKey = stringifyKey(key, jsKey, ctx);
          const jsValue = toJS.toJS(value, stringKey, ctx);
          if (stringKey in map)
            Object.defineProperty(map, stringKey, {
              value: jsValue,
              writable: true,
              enumerable: true,
              configurable: true
            });
          else
            map[stringKey] = jsValue;
        }
      }
      return map;
    }
    function stringifyKey(key, jsKey, ctx) {
      if (jsKey === null)
        return "";
      if (typeof jsKey !== "object")
        return String(jsKey);
      if (identity.isNode(key) && ctx?.doc) {
        const strCtx = stringify.createStringifyContext(ctx.doc, {});
        strCtx.anchors = /* @__PURE__ */ new Set();
        for (const node of ctx.anchors.keys())
          strCtx.anchors.add(node.anchor);
        strCtx.inFlow = true;
        strCtx.inStringifyKey = true;
        const strKey = key.toString(strCtx);
        if (!ctx.mapKeyWarned) {
          let jsonStr = JSON.stringify(strKey);
          if (jsonStr.length > 40)
            jsonStr = jsonStr.substring(0, 36) + '..."';
          log.warn(ctx.doc.options.logLevel, `Keys with collection values will be stringified due to JS Object restrictions: ${jsonStr}. Set mapAsMap: true to use object keys.`);
          ctx.mapKeyWarned = true;
        }
        return strKey;
      }
      return JSON.stringify(jsKey);
    }
    exports2.addPairToJSMap = addPairToJSMap;
  }
});

// node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/nodes/Pair.js
var require_Pair = __commonJS({
  "node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/nodes/Pair.js"(exports2) {
    "use strict";
    var createNode = require_createNode();
    var stringifyPair = require_stringifyPair();
    var addPairToJSMap = require_addPairToJSMap();
    var identity = require_identity();
    function createPair(key, value, ctx) {
      const k = createNode.createNode(key, void 0, ctx);
      const v = createNode.createNode(value, void 0, ctx);
      return new Pair(k, v);
    }
    var Pair = class _Pair {
      constructor(key, value = null) {
        Object.defineProperty(this, identity.NODE_TYPE, { value: identity.PAIR });
        this.key = key;
        this.value = value;
      }
      clone(schema) {
        let { key, value } = this;
        if (identity.isNode(key))
          key = key.clone(schema);
        if (identity.isNode(value))
          value = value.clone(schema);
        return new _Pair(key, value);
      }
      toJSON(_, ctx) {
        const pair = ctx?.mapAsMap ? /* @__PURE__ */ new Map() : {};
        return addPairToJSMap.addPairToJSMap(ctx, pair, this);
      }
      toString(ctx, onComment, onChompKeep) {
        return ctx?.doc ? stringifyPair.stringifyPair(this, ctx, onComment, onChompKeep) : JSON.stringify(this);
      }
    };
    exports2.Pair = Pair;
    exports2.createPair = createPair;
  }
});

// node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/stringify/stringifyCollection.js
var require_stringifyCollection = __commonJS({
  "node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/stringify/stringifyCollection.js"(exports2) {
    "use strict";
    var identity = require_identity();
    var stringify = require_stringify();
    var stringifyComment = require_stringifyComment();
    function stringifyCollection(collection, ctx, options) {
      const flow = ctx.inFlow ?? collection.flow;
      const stringify2 = flow ? stringifyFlowCollection : stringifyBlockCollection;
      return stringify2(collection, ctx, options);
    }
    function stringifyBlockCollection({ comment, items }, ctx, { blockItemPrefix, flowChars, itemIndent, onChompKeep, onComment }) {
      const { indent, options: { commentString } } = ctx;
      const itemCtx = Object.assign({}, ctx, { indent: itemIndent, type: null });
      let chompKeep = false;
      const lines = [];
      for (let i = 0; i < items.length; ++i) {
        const item = items[i];
        let comment2 = null;
        if (identity.isNode(item)) {
          if (!chompKeep && item.spaceBefore)
            lines.push("");
          addCommentBefore(ctx, lines, item.commentBefore, chompKeep);
          if (item.comment)
            comment2 = item.comment;
        } else if (identity.isPair(item)) {
          const ik = identity.isNode(item.key) ? item.key : null;
          if (ik) {
            if (!chompKeep && ik.spaceBefore)
              lines.push("");
            addCommentBefore(ctx, lines, ik.commentBefore, chompKeep);
          }
        }
        chompKeep = false;
        let str2 = stringify.stringify(item, itemCtx, () => comment2 = null, () => chompKeep = true);
        if (comment2)
          str2 += stringifyComment.lineComment(str2, itemIndent, commentString(comment2));
        if (chompKeep && comment2)
          chompKeep = false;
        lines.push(blockItemPrefix + str2);
      }
      let str;
      if (lines.length === 0) {
        str = flowChars.start + flowChars.end;
      } else {
        str = lines[0];
        for (let i = 1; i < lines.length; ++i) {
          const line = lines[i];
          str += line ? `
${indent}${line}` : "\n";
        }
      }
      if (comment) {
        str += "\n" + stringifyComment.indentComment(commentString(comment), indent);
        if (onComment)
          onComment();
      } else if (chompKeep && onChompKeep)
        onChompKeep();
      return str;
    }
    function stringifyFlowCollection({ items }, ctx, { flowChars, itemIndent }) {
      const { indent, indentStep, flowCollectionPadding: fcPadding, options: { commentString } } = ctx;
      itemIndent += indentStep;
      const itemCtx = Object.assign({}, ctx, {
        indent: itemIndent,
        inFlow: true,
        type: null
      });
      let reqNewline = false;
      let linesAtValue = 0;
      const lines = [];
      for (let i = 0; i < items.length; ++i) {
        const item = items[i];
        let comment = null;
        if (identity.isNode(item)) {
          if (item.spaceBefore)
            lines.push("");
          addCommentBefore(ctx, lines, item.commentBefore, false);
          if (item.comment)
            comment = item.comment;
        } else if (identity.isPair(item)) {
          const ik = identity.isNode(item.key) ? item.key : null;
          if (ik) {
            if (ik.spaceBefore)
              lines.push("");
            addCommentBefore(ctx, lines, ik.commentBefore, false);
            if (ik.comment)
              reqNewline = true;
          }
          const iv = identity.isNode(item.value) ? item.value : null;
          if (iv) {
            if (iv.comment)
              comment = iv.comment;
            if (iv.commentBefore)
              reqNewline = true;
          } else if (item.value == null && ik?.comment) {
            comment = ik.comment;
          }
        }
        if (comment)
          reqNewline = true;
        let str = stringify.stringify(item, itemCtx, () => comment = null);
        reqNewline || (reqNewline = lines.length > linesAtValue || str.includes("\n"));
        if (i < items.length - 1) {
          str += ",";
        } else if (ctx.options.trailingComma) {
          if (ctx.options.lineWidth > 0) {
            reqNewline || (reqNewline = lines.reduce((sum, line) => sum + line.length + 2, 2) + (str.length + 2) > ctx.options.lineWidth);
          }
          if (reqNewline) {
            str += ",";
          }
        }
        if (comment)
          str += stringifyComment.lineComment(str, itemIndent, commentString(comment));
        lines.push(str);
        linesAtValue = lines.length;
      }
      const { start, end } = flowChars;
      if (lines.length === 0) {
        return start + end;
      } else {
        if (!reqNewline) {
          const len = lines.reduce((sum, line) => sum + line.length + 2, 2);
          reqNewline = ctx.options.lineWidth > 0 && len > ctx.options.lineWidth;
        }
        if (reqNewline) {
          let str = start;
          for (const line of lines)
            str += line ? `
${indentStep}${indent}${line}` : "\n";
          return `${str}
${indent}${end}`;
        } else {
          return `${start}${fcPadding}${lines.join(" ")}${fcPadding}${end}`;
        }
      }
    }
    function addCommentBefore({ indent, options: { commentString } }, lines, comment, chompKeep) {
      if (comment && chompKeep)
        comment = comment.replace(/^\n+/, "");
      if (comment) {
        const ic = stringifyComment.indentComment(commentString(comment), indent);
        lines.push(ic.trimStart());
      }
    }
    exports2.stringifyCollection = stringifyCollection;
  }
});

// node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/nodes/YAMLMap.js
var require_YAMLMap = __commonJS({
  "node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/nodes/YAMLMap.js"(exports2) {
    "use strict";
    var stringifyCollection = require_stringifyCollection();
    var addPairToJSMap = require_addPairToJSMap();
    var Collection = require_Collection();
    var identity = require_identity();
    var Pair = require_Pair();
    var Scalar = require_Scalar();
    function findPair(items, key) {
      const k = identity.isScalar(key) ? key.value : key;
      for (const it of items) {
        if (identity.isPair(it)) {
          if (it.key === key || it.key === k)
            return it;
          if (identity.isScalar(it.key) && it.key.value === k)
            return it;
        }
      }
      return void 0;
    }
    var YAMLMap = class extends Collection.Collection {
      static get tagName() {
        return "tag:yaml.org,2002:map";
      }
      constructor(schema) {
        super(identity.MAP, schema);
        this.items = [];
      }
      /**
       * A generic collection parsing method that can be extended
       * to other node classes that inherit from YAMLMap
       */
      static from(schema, obj, ctx) {
        const { keepUndefined, replacer } = ctx;
        const map = new this(schema);
        const add = (key, value) => {
          if (typeof replacer === "function")
            value = replacer.call(obj, key, value);
          else if (Array.isArray(replacer) && !replacer.includes(key))
            return;
          if (value !== void 0 || keepUndefined)
            map.items.push(Pair.createPair(key, value, ctx));
        };
        if (obj instanceof Map) {
          for (const [key, value] of obj)
            add(key, value);
        } else if (obj && typeof obj === "object") {
          for (const key of Object.keys(obj))
            add(key, obj[key]);
        }
        if (typeof schema.sortMapEntries === "function") {
          map.items.sort(schema.sortMapEntries);
        }
        return map;
      }
      /**
       * Adds a value to the collection.
       *
       * @param overwrite - If not set `true`, using a key that is already in the
       *   collection will throw. Otherwise, overwrites the previous value.
       */
      add(pair, overwrite) {
        let _pair;
        if (identity.isPair(pair))
          _pair = pair;
        else if (!pair || typeof pair !== "object" || !("key" in pair)) {
          _pair = new Pair.Pair(pair, pair?.value);
        } else
          _pair = new Pair.Pair(pair.key, pair.value);
        const prev = findPair(this.items, _pair.key);
        const sortEntries = this.schema?.sortMapEntries;
        if (prev) {
          if (!overwrite)
            throw new Error(`Key ${_pair.key} already set`);
          if (identity.isScalar(prev.value) && Scalar.isScalarValue(_pair.value))
            prev.value.value = _pair.value;
          else
            prev.value = _pair.value;
        } else if (sortEntries) {
          const i = this.items.findIndex((item) => sortEntries(_pair, item) < 0);
          if (i === -1)
            this.items.push(_pair);
          else
            this.items.splice(i, 0, _pair);
        } else {
          this.items.push(_pair);
        }
      }
      delete(key) {
        const it = findPair(this.items, key);
        if (!it)
          return false;
        const del = this.items.splice(this.items.indexOf(it), 1);
        return del.length > 0;
      }
      get(key, keepScalar) {
        const it = findPair(this.items, key);
        const node = it?.value;
        return (!keepScalar && identity.isScalar(node) ? node.value : node) ?? void 0;
      }
      has(key) {
        return !!findPair(this.items, key);
      }
      set(key, value) {
        this.add(new Pair.Pair(key, value), true);
      }
      /**
       * @param ctx - Conversion context, originally set in Document#toJS()
       * @param {Class} Type - If set, forces the returned collection type
       * @returns Instance of Type, Map, or Object
       */
      toJSON(_, ctx, Type) {
        const map = Type ? new Type() : ctx?.mapAsMap ? /* @__PURE__ */ new Map() : {};
        if (ctx?.onCreate)
          ctx.onCreate(map);
        for (const item of this.items)
          addPairToJSMap.addPairToJSMap(ctx, map, item);
        return map;
      }
      toString(ctx, onComment, onChompKeep) {
        if (!ctx)
          return JSON.stringify(this);
        for (const item of this.items) {
          if (!identity.isPair(item))
            throw new Error(`Map items must all be pairs; found ${JSON.stringify(item)} instead`);
        }
        if (!ctx.allNullValues && this.hasAllNullValues(false))
          ctx = Object.assign({}, ctx, { allNullValues: true });
        return stringifyCollection.stringifyCollection(this, ctx, {
          blockItemPrefix: "",
          flowChars: { start: "{", end: "}" },
          itemIndent: ctx.indent || "",
          onChompKeep,
          onComment
        });
      }
    };
    exports2.YAMLMap = YAMLMap;
    exports2.findPair = findPair;
  }
});

// node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/schema/common/map.js
var require_map = __commonJS({
  "node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/schema/common/map.js"(exports2) {
    "use strict";
    var identity = require_identity();
    var YAMLMap = require_YAMLMap();
    var map = {
      collection: "map",
      default: true,
      nodeClass: YAMLMap.YAMLMap,
      tag: "tag:yaml.org,2002:map",
      resolve(map2, onError) {
        if (!identity.isMap(map2))
          onError("Expected a mapping for this tag");
        return map2;
      },
      createNode: (schema, obj, ctx) => YAMLMap.YAMLMap.from(schema, obj, ctx)
    };
    exports2.map = map;
  }
});

// node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/nodes/YAMLSeq.js
var require_YAMLSeq = __commonJS({
  "node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/nodes/YAMLSeq.js"(exports2) {
    "use strict";
    var createNode = require_createNode();
    var stringifyCollection = require_stringifyCollection();
    var Collection = require_Collection();
    var identity = require_identity();
    var Scalar = require_Scalar();
    var toJS = require_toJS();
    var YAMLSeq = class extends Collection.Collection {
      static get tagName() {
        return "tag:yaml.org,2002:seq";
      }
      constructor(schema) {
        super(identity.SEQ, schema);
        this.items = [];
      }
      add(value) {
        this.items.push(value);
      }
      /**
       * Removes a value from the collection.
       *
       * `key` must contain a representation of an integer for this to succeed.
       * It may be wrapped in a `Scalar`.
       *
       * @returns `true` if the item was found and removed.
       */
      delete(key) {
        const idx = asItemIndex(key);
        if (typeof idx !== "number")
          return false;
        const del = this.items.splice(idx, 1);
        return del.length > 0;
      }
      get(key, keepScalar) {
        const idx = asItemIndex(key);
        if (typeof idx !== "number")
          return void 0;
        const it = this.items[idx];
        return !keepScalar && identity.isScalar(it) ? it.value : it;
      }
      /**
       * Checks if the collection includes a value with the key `key`.
       *
       * `key` must contain a representation of an integer for this to succeed.
       * It may be wrapped in a `Scalar`.
       */
      has(key) {
        const idx = asItemIndex(key);
        return typeof idx === "number" && idx < this.items.length;
      }
      /**
       * Sets a value in this collection. For `!!set`, `value` needs to be a
       * boolean to add/remove the item from the set.
       *
       * If `key` does not contain a representation of an integer, this will throw.
       * It may be wrapped in a `Scalar`.
       */
      set(key, value) {
        const idx = asItemIndex(key);
        if (typeof idx !== "number")
          throw new Error(`Expected a valid index, not ${key}.`);
        const prev = this.items[idx];
        if (identity.isScalar(prev) && Scalar.isScalarValue(value))
          prev.value = value;
        else
          this.items[idx] = value;
      }
      toJSON(_, ctx) {
        const seq = [];
        if (ctx?.onCreate)
          ctx.onCreate(seq);
        let i = 0;
        for (const item of this.items)
          seq.push(toJS.toJS(item, String(i++), ctx));
        return seq;
      }
      toString(ctx, onComment, onChompKeep) {
        if (!ctx)
          return JSON.stringify(this);
        return stringifyCollection.stringifyCollection(this, ctx, {
          blockItemPrefix: "- ",
          flowChars: { start: "[", end: "]" },
          itemIndent: (ctx.indent || "") + "  ",
          onChompKeep,
          onComment
        });
      }
      static from(schema, obj, ctx) {
        const { replacer } = ctx;
        const seq = new this(schema);
        if (obj && Symbol.iterator in Object(obj)) {
          let i = 0;
          for (let it of obj) {
            if (typeof replacer === "function") {
              const key = obj instanceof Set ? it : String(i++);
              it = replacer.call(obj, key, it);
            }
            seq.items.push(createNode.createNode(it, void 0, ctx));
          }
        }
        return seq;
      }
    };
    function asItemIndex(key) {
      let idx = identity.isScalar(key) ? key.value : key;
      if (idx && typeof idx === "string")
        idx = Number(idx);
      return typeof idx === "number" && Number.isInteger(idx) && idx >= 0 ? idx : null;
    }
    exports2.YAMLSeq = YAMLSeq;
  }
});

// node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/schema/common/seq.js
var require_seq = __commonJS({
  "node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/schema/common/seq.js"(exports2) {
    "use strict";
    var identity = require_identity();
    var YAMLSeq = require_YAMLSeq();
    var seq = {
      collection: "seq",
      default: true,
      nodeClass: YAMLSeq.YAMLSeq,
      tag: "tag:yaml.org,2002:seq",
      resolve(seq2, onError) {
        if (!identity.isSeq(seq2))
          onError("Expected a sequence for this tag");
        return seq2;
      },
      createNode: (schema, obj, ctx) => YAMLSeq.YAMLSeq.from(schema, obj, ctx)
    };
    exports2.seq = seq;
  }
});

// node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/schema/common/string.js
var require_string = __commonJS({
  "node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/schema/common/string.js"(exports2) {
    "use strict";
    var stringifyString = require_stringifyString();
    var string = {
      identify: (value) => typeof value === "string",
      default: true,
      tag: "tag:yaml.org,2002:str",
      resolve: (str) => str,
      stringify(item, ctx, onComment, onChompKeep) {
        ctx = Object.assign({ actualString: true }, ctx);
        return stringifyString.stringifyString(item, ctx, onComment, onChompKeep);
      }
    };
    exports2.string = string;
  }
});

// node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/schema/common/null.js
var require_null = __commonJS({
  "node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/schema/common/null.js"(exports2) {
    "use strict";
    var Scalar = require_Scalar();
    var nullTag = {
      identify: (value) => value == null,
      createNode: () => new Scalar.Scalar(null),
      default: true,
      tag: "tag:yaml.org,2002:null",
      test: /^(?:~|[Nn]ull|NULL)?$/,
      resolve: () => new Scalar.Scalar(null),
      stringify: ({ source }, ctx) => typeof source === "string" && nullTag.test.test(source) ? source : ctx.options.nullStr
    };
    exports2.nullTag = nullTag;
  }
});

// node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/schema/core/bool.js
var require_bool = __commonJS({
  "node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/schema/core/bool.js"(exports2) {
    "use strict";
    var Scalar = require_Scalar();
    var boolTag = {
      identify: (value) => typeof value === "boolean",
      default: true,
      tag: "tag:yaml.org,2002:bool",
      test: /^(?:[Tt]rue|TRUE|[Ff]alse|FALSE)$/,
      resolve: (str) => new Scalar.Scalar(str[0] === "t" || str[0] === "T"),
      stringify({ source, value }, ctx) {
        if (source && boolTag.test.test(source)) {
          const sv = source[0] === "t" || source[0] === "T";
          if (value === sv)
            return source;
        }
        return value ? ctx.options.trueStr : ctx.options.falseStr;
      }
    };
    exports2.boolTag = boolTag;
  }
});

// node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/stringify/stringifyNumber.js
var require_stringifyNumber = __commonJS({
  "node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/stringify/stringifyNumber.js"(exports2) {
    "use strict";
    function stringifyNumber({ format, minFractionDigits, tag, value }) {
      if (typeof value === "bigint")
        return String(value);
      const num = typeof value === "number" ? value : Number(value);
      if (!isFinite(num))
        return isNaN(num) ? ".nan" : num < 0 ? "-.inf" : ".inf";
      let n = Object.is(value, -0) ? "-0" : JSON.stringify(value);
      if (!format && minFractionDigits && (!tag || tag === "tag:yaml.org,2002:float") && /^-?\d/.test(n) && !n.includes("e")) {
        let i = n.indexOf(".");
        if (i < 0) {
          i = n.length;
          n += ".";
        }
        let d = minFractionDigits - (n.length - i - 1);
        while (d-- > 0)
          n += "0";
      }
      return n;
    }
    exports2.stringifyNumber = stringifyNumber;
  }
});

// node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/schema/core/float.js
var require_float = __commonJS({
  "node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/schema/core/float.js"(exports2) {
    "use strict";
    var Scalar = require_Scalar();
    var stringifyNumber = require_stringifyNumber();
    var floatNaN = {
      identify: (value) => typeof value === "number",
      default: true,
      tag: "tag:yaml.org,2002:float",
      test: /^(?:[-+]?\.(?:inf|Inf|INF)|\.nan|\.NaN|\.NAN)$/,
      resolve: (str) => str.slice(-3).toLowerCase() === "nan" ? NaN : str[0] === "-" ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY,
      stringify: stringifyNumber.stringifyNumber
    };
    var floatExp = {
      identify: (value) => typeof value === "number",
      default: true,
      tag: "tag:yaml.org,2002:float",
      format: "EXP",
      test: /^[-+]?(?:\.[0-9]+|[0-9]+(?:\.[0-9]*)?)[eE][-+]?[0-9]+$/,
      resolve: (str) => parseFloat(str),
      stringify(node) {
        const num = Number(node.value);
        return isFinite(num) ? num.toExponential() : stringifyNumber.stringifyNumber(node);
      }
    };
    var float = {
      identify: (value) => typeof value === "number",
      default: true,
      tag: "tag:yaml.org,2002:float",
      test: /^[-+]?(?:\.[0-9]+|[0-9]+\.[0-9]*)$/,
      resolve(str) {
        const node = new Scalar.Scalar(parseFloat(str));
        const dot = str.indexOf(".");
        if (dot !== -1 && str[str.length - 1] === "0")
          node.minFractionDigits = str.length - dot - 1;
        return node;
      },
      stringify: stringifyNumber.stringifyNumber
    };
    exports2.float = float;
    exports2.floatExp = floatExp;
    exports2.floatNaN = floatNaN;
  }
});

// node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/schema/core/int.js
var require_int = __commonJS({
  "node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/schema/core/int.js"(exports2) {
    "use strict";
    var stringifyNumber = require_stringifyNumber();
    var intIdentify = (value) => typeof value === "bigint" || Number.isInteger(value);
    var intResolve = (str, offset, radix, { intAsBigInt }) => intAsBigInt ? BigInt(str) : parseInt(str.substring(offset), radix);
    function intStringify(node, radix, prefix) {
      const { value } = node;
      if (intIdentify(value) && value >= 0)
        return prefix + value.toString(radix);
      return stringifyNumber.stringifyNumber(node);
    }
    var intOct = {
      identify: (value) => intIdentify(value) && value >= 0,
      default: true,
      tag: "tag:yaml.org,2002:int",
      format: "OCT",
      test: /^0o[0-7]+$/,
      resolve: (str, _onError, opt) => intResolve(str, 2, 8, opt),
      stringify: (node) => intStringify(node, 8, "0o")
    };
    var int = {
      identify: intIdentify,
      default: true,
      tag: "tag:yaml.org,2002:int",
      test: /^[-+]?[0-9]+$/,
      resolve: (str, _onError, opt) => intResolve(str, 0, 10, opt),
      stringify: stringifyNumber.stringifyNumber
    };
    var intHex = {
      identify: (value) => intIdentify(value) && value >= 0,
      default: true,
      tag: "tag:yaml.org,2002:int",
      format: "HEX",
      test: /^0x[0-9a-fA-F]+$/,
      resolve: (str, _onError, opt) => intResolve(str, 2, 16, opt),
      stringify: (node) => intStringify(node, 16, "0x")
    };
    exports2.int = int;
    exports2.intHex = intHex;
    exports2.intOct = intOct;
  }
});

// node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/schema/core/schema.js
var require_schema = __commonJS({
  "node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/schema/core/schema.js"(exports2) {
    "use strict";
    var map = require_map();
    var _null = require_null();
    var seq = require_seq();
    var string = require_string();
    var bool = require_bool();
    var float = require_float();
    var int = require_int();
    var schema = [
      map.map,
      seq.seq,
      string.string,
      _null.nullTag,
      bool.boolTag,
      int.intOct,
      int.int,
      int.intHex,
      float.floatNaN,
      float.floatExp,
      float.float
    ];
    exports2.schema = schema;
  }
});

// node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/schema/json/schema.js
var require_schema2 = __commonJS({
  "node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/schema/json/schema.js"(exports2) {
    "use strict";
    var Scalar = require_Scalar();
    var map = require_map();
    var seq = require_seq();
    function intIdentify(value) {
      return typeof value === "bigint" || Number.isInteger(value);
    }
    var stringifyJSON = ({ value }) => JSON.stringify(value);
    var jsonScalars = [
      {
        identify: (value) => typeof value === "string",
        default: true,
        tag: "tag:yaml.org,2002:str",
        resolve: (str) => str,
        stringify: stringifyJSON
      },
      {
        identify: (value) => value == null,
        createNode: () => new Scalar.Scalar(null),
        default: true,
        tag: "tag:yaml.org,2002:null",
        test: /^null$/,
        resolve: () => null,
        stringify: stringifyJSON
      },
      {
        identify: (value) => typeof value === "boolean",
        default: true,
        tag: "tag:yaml.org,2002:bool",
        test: /^true$|^false$/,
        resolve: (str) => str === "true",
        stringify: stringifyJSON
      },
      {
        identify: intIdentify,
        default: true,
        tag: "tag:yaml.org,2002:int",
        test: /^-?(?:0|[1-9][0-9]*)$/,
        resolve: (str, _onError, { intAsBigInt }) => intAsBigInt ? BigInt(str) : parseInt(str, 10),
        stringify: ({ value }) => intIdentify(value) ? value.toString() : JSON.stringify(value)
      },
      {
        identify: (value) => typeof value === "number",
        default: true,
        tag: "tag:yaml.org,2002:float",
        test: /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]*)?(?:[eE][-+]?[0-9]+)?$/,
        resolve: (str) => parseFloat(str),
        stringify: stringifyJSON
      }
    ];
    var jsonError = {
      default: true,
      tag: "",
      test: /^/,
      resolve(str, onError) {
        onError(`Unresolved plain scalar ${JSON.stringify(str)}`);
        return str;
      }
    };
    var schema = [map.map, seq.seq].concat(jsonScalars, jsonError);
    exports2.schema = schema;
  }
});

// node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/schema/yaml-1.1/binary.js
var require_binary = __commonJS({
  "node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/schema/yaml-1.1/binary.js"(exports2) {
    "use strict";
    var node_buffer = require("buffer");
    var Scalar = require_Scalar();
    var stringifyString = require_stringifyString();
    var binary = {
      identify: (value) => value instanceof Uint8Array,
      // Buffer inherits from Uint8Array
      default: false,
      tag: "tag:yaml.org,2002:binary",
      /**
       * Returns a Buffer in node and an Uint8Array in browsers
       *
       * To use the resulting buffer as an image, you'll want to do something like:
       *
       *   const blob = new Blob([buffer], { type: 'image/jpeg' })
       *   document.querySelector('#photo').src = URL.createObjectURL(blob)
       */
      resolve(src, onError) {
        if (typeof node_buffer.Buffer === "function") {
          return node_buffer.Buffer.from(src, "base64");
        } else if (typeof atob === "function") {
          const str = atob(src.replace(/[\n\r]/g, ""));
          const buffer = new Uint8Array(str.length);
          for (let i = 0; i < str.length; ++i)
            buffer[i] = str.charCodeAt(i);
          return buffer;
        } else {
          onError("This environment does not support reading binary tags; either Buffer or atob is required");
          return src;
        }
      },
      stringify({ comment, type, value }, ctx, onComment, onChompKeep) {
        if (!value)
          return "";
        const buf = value;
        let str;
        if (typeof node_buffer.Buffer === "function") {
          str = buf instanceof node_buffer.Buffer ? buf.toString("base64") : node_buffer.Buffer.from(buf.buffer).toString("base64");
        } else if (typeof btoa === "function") {
          let s = "";
          for (let i = 0; i < buf.length; ++i)
            s += String.fromCharCode(buf[i]);
          str = btoa(s);
        } else {
          throw new Error("This environment does not support writing binary tags; either Buffer or btoa is required");
        }
        type ?? (type = Scalar.Scalar.BLOCK_LITERAL);
        if (type !== Scalar.Scalar.QUOTE_DOUBLE) {
          const lineWidth = Math.max(ctx.options.lineWidth - ctx.indent.length, ctx.options.minContentWidth);
          const n = Math.ceil(str.length / lineWidth);
          const lines = new Array(n);
          for (let i = 0, o = 0; i < n; ++i, o += lineWidth) {
            lines[i] = str.substr(o, lineWidth);
          }
          str = lines.join(type === Scalar.Scalar.BLOCK_LITERAL ? "\n" : " ");
        }
        return stringifyString.stringifyString({ comment, type, value: str }, ctx, onComment, onChompKeep);
      }
    };
    exports2.binary = binary;
  }
});

// node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/schema/yaml-1.1/pairs.js
var require_pairs = __commonJS({
  "node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/schema/yaml-1.1/pairs.js"(exports2) {
    "use strict";
    var identity = require_identity();
    var Pair = require_Pair();
    var Scalar = require_Scalar();
    var YAMLSeq = require_YAMLSeq();
    function resolvePairs(seq, onError) {
      if (identity.isSeq(seq)) {
        for (let i = 0; i < seq.items.length; ++i) {
          let item = seq.items[i];
          if (identity.isPair(item))
            continue;
          else if (identity.isMap(item)) {
            if (item.items.length > 1)
              onError("Each pair must have its own sequence indicator");
            const pair = item.items[0] || new Pair.Pair(new Scalar.Scalar(null));
            if (item.commentBefore)
              pair.key.commentBefore = pair.key.commentBefore ? `${item.commentBefore}
${pair.key.commentBefore}` : item.commentBefore;
            if (item.comment) {
              const cn = pair.value ?? pair.key;
              cn.comment = cn.comment ? `${item.comment}
${cn.comment}` : item.comment;
            }
            item = pair;
          }
          seq.items[i] = identity.isPair(item) ? item : new Pair.Pair(item);
        }
      } else
        onError("Expected a sequence for this tag");
      return seq;
    }
    function createPairs(schema, iterable, ctx) {
      const { replacer } = ctx;
      const pairs2 = new YAMLSeq.YAMLSeq(schema);
      pairs2.tag = "tag:yaml.org,2002:pairs";
      let i = 0;
      if (iterable && Symbol.iterator in Object(iterable))
        for (let it of iterable) {
          if (typeof replacer === "function")
            it = replacer.call(iterable, String(i++), it);
          let key, value;
          if (Array.isArray(it)) {
            if (it.length === 2) {
              key = it[0];
              value = it[1];
            } else
              throw new TypeError(`Expected [key, value] tuple: ${it}`);
          } else if (it && it instanceof Object) {
            const keys = Object.keys(it);
            if (keys.length === 1) {
              key = keys[0];
              value = it[key];
            } else {
              throw new TypeError(`Expected tuple with one key, not ${keys.length} keys`);
            }
          } else {
            key = it;
          }
          pairs2.items.push(Pair.createPair(key, value, ctx));
        }
      return pairs2;
    }
    var pairs = {
      collection: "seq",
      default: false,
      tag: "tag:yaml.org,2002:pairs",
      resolve: resolvePairs,
      createNode: createPairs
    };
    exports2.createPairs = createPairs;
    exports2.pairs = pairs;
    exports2.resolvePairs = resolvePairs;
  }
});

// node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/schema/yaml-1.1/omap.js
var require_omap = __commonJS({
  "node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/schema/yaml-1.1/omap.js"(exports2) {
    "use strict";
    var identity = require_identity();
    var toJS = require_toJS();
    var YAMLMap = require_YAMLMap();
    var YAMLSeq = require_YAMLSeq();
    var pairs = require_pairs();
    var YAMLOMap = class _YAMLOMap extends YAMLSeq.YAMLSeq {
      constructor() {
        super();
        this.add = YAMLMap.YAMLMap.prototype.add.bind(this);
        this.delete = YAMLMap.YAMLMap.prototype.delete.bind(this);
        this.get = YAMLMap.YAMLMap.prototype.get.bind(this);
        this.has = YAMLMap.YAMLMap.prototype.has.bind(this);
        this.set = YAMLMap.YAMLMap.prototype.set.bind(this);
        this.tag = _YAMLOMap.tag;
      }
      /**
       * If `ctx` is given, the return type is actually `Map<unknown, unknown>`,
       * but TypeScript won't allow widening the signature of a child method.
       */
      toJSON(_, ctx) {
        if (!ctx)
          return super.toJSON(_);
        const map = /* @__PURE__ */ new Map();
        if (ctx?.onCreate)
          ctx.onCreate(map);
        for (const pair of this.items) {
          let key, value;
          if (identity.isPair(pair)) {
            key = toJS.toJS(pair.key, "", ctx);
            value = toJS.toJS(pair.value, key, ctx);
          } else {
            key = toJS.toJS(pair, "", ctx);
          }
          if (map.has(key))
            throw new Error("Ordered maps must not include duplicate keys");
          map.set(key, value);
        }
        return map;
      }
      static from(schema, iterable, ctx) {
        const pairs$1 = pairs.createPairs(schema, iterable, ctx);
        const omap2 = new this();
        omap2.items = pairs$1.items;
        return omap2;
      }
    };
    YAMLOMap.tag = "tag:yaml.org,2002:omap";
    var omap = {
      collection: "seq",
      identify: (value) => value instanceof Map,
      nodeClass: YAMLOMap,
      default: false,
      tag: "tag:yaml.org,2002:omap",
      resolve(seq, onError) {
        const pairs$1 = pairs.resolvePairs(seq, onError);
        const seenKeys = [];
        for (const { key } of pairs$1.items) {
          if (identity.isScalar(key)) {
            if (seenKeys.includes(key.value)) {
              onError(`Ordered maps must not include duplicate keys: ${key.value}`);
            } else {
              seenKeys.push(key.value);
            }
          }
        }
        return Object.assign(new YAMLOMap(), pairs$1);
      },
      createNode: (schema, iterable, ctx) => YAMLOMap.from(schema, iterable, ctx)
    };
    exports2.YAMLOMap = YAMLOMap;
    exports2.omap = omap;
  }
});

// node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/schema/yaml-1.1/bool.js
var require_bool2 = __commonJS({
  "node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/schema/yaml-1.1/bool.js"(exports2) {
    "use strict";
    var Scalar = require_Scalar();
    function boolStringify({ value, source }, ctx) {
      const boolObj = value ? trueTag : falseTag;
      if (source && boolObj.test.test(source))
        return source;
      return value ? ctx.options.trueStr : ctx.options.falseStr;
    }
    var trueTag = {
      identify: (value) => value === true,
      default: true,
      tag: "tag:yaml.org,2002:bool",
      test: /^(?:Y|y|[Yy]es|YES|[Tt]rue|TRUE|[Oo]n|ON)$/,
      resolve: () => new Scalar.Scalar(true),
      stringify: boolStringify
    };
    var falseTag = {
      identify: (value) => value === false,
      default: true,
      tag: "tag:yaml.org,2002:bool",
      test: /^(?:N|n|[Nn]o|NO|[Ff]alse|FALSE|[Oo]ff|OFF)$/,
      resolve: () => new Scalar.Scalar(false),
      stringify: boolStringify
    };
    exports2.falseTag = falseTag;
    exports2.trueTag = trueTag;
  }
});

// node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/schema/yaml-1.1/float.js
var require_float2 = __commonJS({
  "node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/schema/yaml-1.1/float.js"(exports2) {
    "use strict";
    var Scalar = require_Scalar();
    var stringifyNumber = require_stringifyNumber();
    var floatNaN = {
      identify: (value) => typeof value === "number",
      default: true,
      tag: "tag:yaml.org,2002:float",
      test: /^(?:[-+]?\.(?:inf|Inf|INF)|\.nan|\.NaN|\.NAN)$/,
      resolve: (str) => str.slice(-3).toLowerCase() === "nan" ? NaN : str[0] === "-" ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY,
      stringify: stringifyNumber.stringifyNumber
    };
    var floatExp = {
      identify: (value) => typeof value === "number",
      default: true,
      tag: "tag:yaml.org,2002:float",
      format: "EXP",
      test: /^[-+]?(?:[0-9][0-9_]*)?(?:\.[0-9_]*)?[eE][-+]?[0-9]+$/,
      resolve: (str) => parseFloat(str.replace(/_/g, "")),
      stringify(node) {
        const num = Number(node.value);
        return isFinite(num) ? num.toExponential() : stringifyNumber.stringifyNumber(node);
      }
    };
    var float = {
      identify: (value) => typeof value === "number",
      default: true,
      tag: "tag:yaml.org,2002:float",
      test: /^[-+]?(?:[0-9][0-9_]*)?\.[0-9_]*$/,
      resolve(str) {
        const node = new Scalar.Scalar(parseFloat(str.replace(/_/g, "")));
        const dot = str.indexOf(".");
        if (dot !== -1) {
          const f = str.substring(dot + 1).replace(/_/g, "");
          if (f[f.length - 1] === "0")
            node.minFractionDigits = f.length;
        }
        return node;
      },
      stringify: stringifyNumber.stringifyNumber
    };
    exports2.float = float;
    exports2.floatExp = floatExp;
    exports2.floatNaN = floatNaN;
  }
});

// node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/schema/yaml-1.1/int.js
var require_int2 = __commonJS({
  "node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/schema/yaml-1.1/int.js"(exports2) {
    "use strict";
    var stringifyNumber = require_stringifyNumber();
    var intIdentify = (value) => typeof value === "bigint" || Number.isInteger(value);
    function intResolve(str, offset, radix, { intAsBigInt }) {
      const sign = str[0];
      if (sign === "-" || sign === "+")
        offset += 1;
      str = str.substring(offset).replace(/_/g, "");
      if (intAsBigInt) {
        switch (radix) {
          case 2:
            str = `0b${str}`;
            break;
          case 8:
            str = `0o${str}`;
            break;
          case 16:
            str = `0x${str}`;
            break;
        }
        const n2 = BigInt(str);
        return sign === "-" ? BigInt(-1) * n2 : n2;
      }
      const n = parseInt(str, radix);
      return sign === "-" ? -1 * n : n;
    }
    function intStringify(node, radix, prefix) {
      const { value } = node;
      if (intIdentify(value)) {
        const str = value.toString(radix);
        return value < 0 ? "-" + prefix + str.substr(1) : prefix + str;
      }
      return stringifyNumber.stringifyNumber(node);
    }
    var intBin = {
      identify: intIdentify,
      default: true,
      tag: "tag:yaml.org,2002:int",
      format: "BIN",
      test: /^[-+]?0b[0-1_]+$/,
      resolve: (str, _onError, opt) => intResolve(str, 2, 2, opt),
      stringify: (node) => intStringify(node, 2, "0b")
    };
    var intOct = {
      identify: intIdentify,
      default: true,
      tag: "tag:yaml.org,2002:int",
      format: "OCT",
      test: /^[-+]?0[0-7_]+$/,
      resolve: (str, _onError, opt) => intResolve(str, 1, 8, opt),
      stringify: (node) => intStringify(node, 8, "0")
    };
    var int = {
      identify: intIdentify,
      default: true,
      tag: "tag:yaml.org,2002:int",
      test: /^[-+]?[0-9][0-9_]*$/,
      resolve: (str, _onError, opt) => intResolve(str, 0, 10, opt),
      stringify: stringifyNumber.stringifyNumber
    };
    var intHex = {
      identify: intIdentify,
      default: true,
      tag: "tag:yaml.org,2002:int",
      format: "HEX",
      test: /^[-+]?0x[0-9a-fA-F_]+$/,
      resolve: (str, _onError, opt) => intResolve(str, 2, 16, opt),
      stringify: (node) => intStringify(node, 16, "0x")
    };
    exports2.int = int;
    exports2.intBin = intBin;
    exports2.intHex = intHex;
    exports2.intOct = intOct;
  }
});

// node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/schema/yaml-1.1/set.js
var require_set = __commonJS({
  "node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/schema/yaml-1.1/set.js"(exports2) {
    "use strict";
    var identity = require_identity();
    var Pair = require_Pair();
    var YAMLMap = require_YAMLMap();
    var YAMLSet = class _YAMLSet extends YAMLMap.YAMLMap {
      constructor(schema) {
        super(schema);
        this.tag = _YAMLSet.tag;
      }
      add(key) {
        let pair;
        if (identity.isPair(key))
          pair = key;
        else if (key && typeof key === "object" && "key" in key && "value" in key && key.value === null)
          pair = new Pair.Pair(key.key, null);
        else
          pair = new Pair.Pair(key, null);
        const prev = YAMLMap.findPair(this.items, pair.key);
        if (!prev)
          this.items.push(pair);
      }
      /**
       * If `keepPair` is `true`, returns the Pair matching `key`.
       * Otherwise, returns the value of that Pair's key.
       */
      get(key, keepPair) {
        const pair = YAMLMap.findPair(this.items, key);
        return !keepPair && identity.isPair(pair) ? identity.isScalar(pair.key) ? pair.key.value : pair.key : pair;
      }
      set(key, value) {
        if (typeof value !== "boolean")
          throw new Error(`Expected boolean value for set(key, value) in a YAML set, not ${typeof value}`);
        const prev = YAMLMap.findPair(this.items, key);
        if (prev && !value) {
          this.items.splice(this.items.indexOf(prev), 1);
        } else if (!prev && value) {
          this.items.push(new Pair.Pair(key));
        }
      }
      toJSON(_, ctx) {
        return super.toJSON(_, ctx, Set);
      }
      toString(ctx, onComment, onChompKeep) {
        if (!ctx)
          return JSON.stringify(this);
        if (this.hasAllNullValues(true))
          return super.toString(Object.assign({}, ctx, { allNullValues: true }), onComment, onChompKeep);
        else
          throw new Error("Set items must all have null values");
      }
      static from(schema, iterable, ctx) {
        const { replacer } = ctx;
        const set2 = new this(schema);
        if (iterable && Symbol.iterator in Object(iterable))
          for (let value of iterable) {
            if (typeof replacer === "function")
              value = replacer.call(iterable, value, value);
            set2.items.push(Pair.createPair(value, null, ctx));
          }
        return set2;
      }
    };
    YAMLSet.tag = "tag:yaml.org,2002:set";
    var set = {
      collection: "map",
      identify: (value) => value instanceof Set,
      nodeClass: YAMLSet,
      default: false,
      tag: "tag:yaml.org,2002:set",
      createNode: (schema, iterable, ctx) => YAMLSet.from(schema, iterable, ctx),
      resolve(map, onError) {
        if (identity.isMap(map)) {
          if (map.hasAllNullValues(true))
            return Object.assign(new YAMLSet(), map);
          else
            onError("Set items must all have null values");
        } else
          onError("Expected a mapping for this tag");
        return map;
      }
    };
    exports2.YAMLSet = YAMLSet;
    exports2.set = set;
  }
});

// node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/schema/yaml-1.1/timestamp.js
var require_timestamp = __commonJS({
  "node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/schema/yaml-1.1/timestamp.js"(exports2) {
    "use strict";
    var stringifyNumber = require_stringifyNumber();
    function parseSexagesimal(str, asBigInt) {
      const sign = str[0];
      const parts = sign === "-" || sign === "+" ? str.substring(1) : str;
      const num = (n) => asBigInt ? BigInt(n) : Number(n);
      const res = parts.replace(/_/g, "").split(":").reduce((res2, p) => res2 * num(60) + num(p), num(0));
      return sign === "-" ? num(-1) * res : res;
    }
    function stringifySexagesimal(node) {
      let { value } = node;
      let num = (n) => n;
      if (typeof value === "bigint")
        num = (n) => BigInt(n);
      else if (isNaN(value) || !isFinite(value))
        return stringifyNumber.stringifyNumber(node);
      let sign = "";
      if (value < 0) {
        sign = "-";
        value *= num(-1);
      }
      const _60 = num(60);
      const parts = [value % _60];
      if (value < 60) {
        parts.unshift(0);
      } else {
        value = (value - parts[0]) / _60;
        parts.unshift(value % _60);
        if (value >= 60) {
          value = (value - parts[0]) / _60;
          parts.unshift(value);
        }
      }
      return sign + parts.map((n) => String(n).padStart(2, "0")).join(":").replace(/000000\d*$/, "");
    }
    var intTime = {
      identify: (value) => typeof value === "bigint" || Number.isInteger(value),
      default: true,
      tag: "tag:yaml.org,2002:int",
      format: "TIME",
      test: /^[-+]?[0-9][0-9_]*(?::[0-5]?[0-9])+$/,
      resolve: (str, _onError, { intAsBigInt }) => parseSexagesimal(str, intAsBigInt),
      stringify: stringifySexagesimal
    };
    var floatTime = {
      identify: (value) => typeof value === "number",
      default: true,
      tag: "tag:yaml.org,2002:float",
      format: "TIME",
      test: /^[-+]?[0-9][0-9_]*(?::[0-5]?[0-9])+\.[0-9_]*$/,
      resolve: (str) => parseSexagesimal(str, false),
      stringify: stringifySexagesimal
    };
    var timestamp = {
      identify: (value) => value instanceof Date,
      default: true,
      tag: "tag:yaml.org,2002:timestamp",
      // If the time zone is omitted, the timestamp is assumed to be specified in UTC. The time part
      // may be omitted altogether, resulting in a date format. In such a case, the time part is
      // assumed to be 00:00:00Z (start of day, UTC).
      test: RegExp("^([0-9]{4})-([0-9]{1,2})-([0-9]{1,2})(?:(?:t|T|[ \\t]+)([0-9]{1,2}):([0-9]{1,2}):([0-9]{1,2}(\\.[0-9]+)?)(?:[ \\t]*(Z|[-+][012]?[0-9](?::[0-9]{2})?))?)?$"),
      resolve(str) {
        const match = str.match(timestamp.test);
        if (!match)
          throw new Error("!!timestamp expects a date, starting with yyyy-mm-dd");
        const [, year, month, day, hour, minute, second] = match.map(Number);
        const millisec = match[7] ? Number((match[7] + "00").substr(1, 3)) : 0;
        let date = Date.UTC(year, month - 1, day, hour || 0, minute || 0, second || 0, millisec);
        const tz = match[8];
        if (tz && tz !== "Z") {
          let d = parseSexagesimal(tz, false);
          if (Math.abs(d) < 30)
            d *= 60;
          date -= 6e4 * d;
        }
        return new Date(date);
      },
      stringify: ({ value }) => value?.toISOString().replace(/(T00:00:00)?\.000Z$/, "") ?? ""
    };
    exports2.floatTime = floatTime;
    exports2.intTime = intTime;
    exports2.timestamp = timestamp;
  }
});

// node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/schema/yaml-1.1/schema.js
var require_schema3 = __commonJS({
  "node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/schema/yaml-1.1/schema.js"(exports2) {
    "use strict";
    var map = require_map();
    var _null = require_null();
    var seq = require_seq();
    var string = require_string();
    var binary = require_binary();
    var bool = require_bool2();
    var float = require_float2();
    var int = require_int2();
    var merge = require_merge();
    var omap = require_omap();
    var pairs = require_pairs();
    var set = require_set();
    var timestamp = require_timestamp();
    var schema = [
      map.map,
      seq.seq,
      string.string,
      _null.nullTag,
      bool.trueTag,
      bool.falseTag,
      int.intBin,
      int.intOct,
      int.int,
      int.intHex,
      float.floatNaN,
      float.floatExp,
      float.float,
      binary.binary,
      merge.merge,
      omap.omap,
      pairs.pairs,
      set.set,
      timestamp.intTime,
      timestamp.floatTime,
      timestamp.timestamp
    ];
    exports2.schema = schema;
  }
});

// node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/schema/tags.js
var require_tags = __commonJS({
  "node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/schema/tags.js"(exports2) {
    "use strict";
    var map = require_map();
    var _null = require_null();
    var seq = require_seq();
    var string = require_string();
    var bool = require_bool();
    var float = require_float();
    var int = require_int();
    var schema = require_schema();
    var schema$1 = require_schema2();
    var binary = require_binary();
    var merge = require_merge();
    var omap = require_omap();
    var pairs = require_pairs();
    var schema$2 = require_schema3();
    var set = require_set();
    var timestamp = require_timestamp();
    var schemas = /* @__PURE__ */ new Map([
      ["core", schema.schema],
      ["failsafe", [map.map, seq.seq, string.string]],
      ["json", schema$1.schema],
      ["yaml11", schema$2.schema],
      ["yaml-1.1", schema$2.schema]
    ]);
    var tagsByName = {
      binary: binary.binary,
      bool: bool.boolTag,
      float: float.float,
      floatExp: float.floatExp,
      floatNaN: float.floatNaN,
      floatTime: timestamp.floatTime,
      int: int.int,
      intHex: int.intHex,
      intOct: int.intOct,
      intTime: timestamp.intTime,
      map: map.map,
      merge: merge.merge,
      null: _null.nullTag,
      omap: omap.omap,
      pairs: pairs.pairs,
      seq: seq.seq,
      set: set.set,
      timestamp: timestamp.timestamp
    };
    var coreKnownTags = {
      "tag:yaml.org,2002:binary": binary.binary,
      "tag:yaml.org,2002:merge": merge.merge,
      "tag:yaml.org,2002:omap": omap.omap,
      "tag:yaml.org,2002:pairs": pairs.pairs,
      "tag:yaml.org,2002:set": set.set,
      "tag:yaml.org,2002:timestamp": timestamp.timestamp
    };
    function getTags(customTags, schemaName, addMergeTag) {
      const schemaTags = schemas.get(schemaName);
      if (schemaTags && !customTags) {
        return addMergeTag && !schemaTags.includes(merge.merge) ? schemaTags.concat(merge.merge) : schemaTags.slice();
      }
      let tags = schemaTags;
      if (!tags) {
        if (Array.isArray(customTags))
          tags = [];
        else {
          const keys = Array.from(schemas.keys()).filter((key) => key !== "yaml11").map((key) => JSON.stringify(key)).join(", ");
          throw new Error(`Unknown schema "${schemaName}"; use one of ${keys} or define customTags array`);
        }
      }
      if (Array.isArray(customTags)) {
        for (const tag of customTags)
          tags = tags.concat(tag);
      } else if (typeof customTags === "function") {
        tags = customTags(tags.slice());
      }
      if (addMergeTag)
        tags = tags.concat(merge.merge);
      return tags.reduce((tags2, tag) => {
        const tagObj = typeof tag === "string" ? tagsByName[tag] : tag;
        if (!tagObj) {
          const tagName = JSON.stringify(tag);
          const keys = Object.keys(tagsByName).map((key) => JSON.stringify(key)).join(", ");
          throw new Error(`Unknown custom tag ${tagName}; use one of ${keys}`);
        }
        if (!tags2.includes(tagObj))
          tags2.push(tagObj);
        return tags2;
      }, []);
    }
    exports2.coreKnownTags = coreKnownTags;
    exports2.getTags = getTags;
  }
});

// node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/schema/Schema.js
var require_Schema = __commonJS({
  "node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/schema/Schema.js"(exports2) {
    "use strict";
    var identity = require_identity();
    var map = require_map();
    var seq = require_seq();
    var string = require_string();
    var tags = require_tags();
    var sortMapEntriesByKey = (a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
    var Schema = class _Schema {
      constructor({ compat, customTags, merge, resolveKnownTags, schema, sortMapEntries, toStringDefaults }) {
        this.compat = Array.isArray(compat) ? tags.getTags(compat, "compat") : compat ? tags.getTags(null, compat) : null;
        this.name = typeof schema === "string" && schema || "core";
        this.knownTags = resolveKnownTags ? tags.coreKnownTags : {};
        this.tags = tags.getTags(customTags, this.name, merge);
        this.toStringOptions = toStringDefaults ?? null;
        Object.defineProperty(this, identity.MAP, { value: map.map });
        Object.defineProperty(this, identity.SCALAR, { value: string.string });
        Object.defineProperty(this, identity.SEQ, { value: seq.seq });
        this.sortMapEntries = typeof sortMapEntries === "function" ? sortMapEntries : sortMapEntries === true ? sortMapEntriesByKey : null;
      }
      clone() {
        const copy = Object.create(_Schema.prototype, Object.getOwnPropertyDescriptors(this));
        copy.tags = this.tags.slice();
        return copy;
      }
    };
    exports2.Schema = Schema;
  }
});

// node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/stringify/stringifyDocument.js
var require_stringifyDocument = __commonJS({
  "node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/stringify/stringifyDocument.js"(exports2) {
    "use strict";
    var identity = require_identity();
    var stringify = require_stringify();
    var stringifyComment = require_stringifyComment();
    function stringifyDocument(doc, options) {
      const lines = [];
      let hasDirectives = options.directives === true;
      if (options.directives !== false && doc.directives) {
        const dir = doc.directives.toString(doc);
        if (dir) {
          lines.push(dir);
          hasDirectives = true;
        } else if (doc.directives.docStart)
          hasDirectives = true;
      }
      if (hasDirectives)
        lines.push("---");
      const ctx = stringify.createStringifyContext(doc, options);
      const { commentString } = ctx.options;
      if (doc.commentBefore) {
        if (lines.length !== 1)
          lines.unshift("");
        const cs = commentString(doc.commentBefore);
        lines.unshift(stringifyComment.indentComment(cs, ""));
      }
      let chompKeep = false;
      let contentComment = null;
      if (doc.contents) {
        if (identity.isNode(doc.contents)) {
          if (doc.contents.spaceBefore && hasDirectives)
            lines.push("");
          if (doc.contents.commentBefore) {
            const cs = commentString(doc.contents.commentBefore);
            lines.push(stringifyComment.indentComment(cs, ""));
          }
          ctx.forceBlockIndent = !!doc.comment;
          contentComment = doc.contents.comment;
        }
        const onChompKeep = contentComment ? void 0 : () => chompKeep = true;
        let body = stringify.stringify(doc.contents, ctx, () => contentComment = null, onChompKeep);
        if (contentComment)
          body += stringifyComment.lineComment(body, "", commentString(contentComment));
        if ((body[0] === "|" || body[0] === ">") && lines[lines.length - 1] === "---") {
          lines[lines.length - 1] = `--- ${body}`;
        } else
          lines.push(body);
      } else {
        lines.push(stringify.stringify(doc.contents, ctx));
      }
      if (doc.directives?.docEnd) {
        if (doc.comment) {
          const cs = commentString(doc.comment);
          if (cs.includes("\n")) {
            lines.push("...");
            lines.push(stringifyComment.indentComment(cs, ""));
          } else {
            lines.push(`... ${cs}`);
          }
        } else {
          lines.push("...");
        }
      } else {
        let dc = doc.comment;
        if (dc && chompKeep)
          dc = dc.replace(/^\n+/, "");
        if (dc) {
          if ((!chompKeep || contentComment) && lines[lines.length - 1] !== "")
            lines.push("");
          lines.push(stringifyComment.indentComment(commentString(dc), ""));
        }
      }
      return lines.join("\n") + "\n";
    }
    exports2.stringifyDocument = stringifyDocument;
  }
});

// node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/doc/Document.js
var require_Document = __commonJS({
  "node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/doc/Document.js"(exports2) {
    "use strict";
    var Alias = require_Alias();
    var Collection = require_Collection();
    var identity = require_identity();
    var Pair = require_Pair();
    var toJS = require_toJS();
    var Schema = require_Schema();
    var stringifyDocument = require_stringifyDocument();
    var anchors = require_anchors();
    var applyReviver = require_applyReviver();
    var createNode = require_createNode();
    var directives = require_directives();
    var Document = class _Document {
      constructor(value, replacer, options) {
        this.commentBefore = null;
        this.comment = null;
        this.errors = [];
        this.warnings = [];
        Object.defineProperty(this, identity.NODE_TYPE, { value: identity.DOC });
        let _replacer = null;
        if (typeof replacer === "function" || Array.isArray(replacer)) {
          _replacer = replacer;
        } else if (options === void 0 && replacer) {
          options = replacer;
          replacer = void 0;
        }
        const opt = Object.assign({
          intAsBigInt: false,
          keepSourceTokens: false,
          logLevel: "warn",
          prettyErrors: true,
          strict: true,
          stringKeys: false,
          uniqueKeys: true,
          version: "1.2"
        }, options);
        this.options = opt;
        let { version } = opt;
        if (options?._directives) {
          this.directives = options._directives.atDocument();
          if (this.directives.yaml.explicit)
            version = this.directives.yaml.version;
        } else
          this.directives = new directives.Directives({ version });
        this.setSchema(version, options);
        this.contents = value === void 0 ? null : this.createNode(value, _replacer, options);
      }
      /**
       * Create a deep copy of this Document and its contents.
       *
       * Custom Node values that inherit from `Object` still refer to their original instances.
       */
      clone() {
        const copy = Object.create(_Document.prototype, {
          [identity.NODE_TYPE]: { value: identity.DOC }
        });
        copy.commentBefore = this.commentBefore;
        copy.comment = this.comment;
        copy.errors = this.errors.slice();
        copy.warnings = this.warnings.slice();
        copy.options = Object.assign({}, this.options);
        if (this.directives)
          copy.directives = this.directives.clone();
        copy.schema = this.schema.clone();
        copy.contents = identity.isNode(this.contents) ? this.contents.clone(copy.schema) : this.contents;
        if (this.range)
          copy.range = this.range.slice();
        return copy;
      }
      /** Adds a value to the document. */
      add(value) {
        if (assertCollection(this.contents))
          this.contents.add(value);
      }
      /** Adds a value to the document. */
      addIn(path, value) {
        if (assertCollection(this.contents))
          this.contents.addIn(path, value);
      }
      /**
       * Create a new `Alias` node, ensuring that the target `node` has the required anchor.
       *
       * If `node` already has an anchor, `name` is ignored.
       * Otherwise, the `node.anchor` value will be set to `name`,
       * or if an anchor with that name is already present in the document,
       * `name` will be used as a prefix for a new unique anchor.
       * If `name` is undefined, the generated anchor will use 'a' as a prefix.
       */
      createAlias(node, name) {
        if (!node.anchor) {
          const prev = anchors.anchorNames(this);
          node.anchor = // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
          !name || prev.has(name) ? anchors.findNewAnchor(name || "a", prev) : name;
        }
        return new Alias.Alias(node.anchor);
      }
      createNode(value, replacer, options) {
        let _replacer = void 0;
        if (typeof replacer === "function") {
          value = replacer.call({ "": value }, "", value);
          _replacer = replacer;
        } else if (Array.isArray(replacer)) {
          const keyToStr = (v) => typeof v === "number" || v instanceof String || v instanceof Number;
          const asStr = replacer.filter(keyToStr).map(String);
          if (asStr.length > 0)
            replacer = replacer.concat(asStr);
          _replacer = replacer;
        } else if (options === void 0 && replacer) {
          options = replacer;
          replacer = void 0;
        }
        const { aliasDuplicateObjects, anchorPrefix, flow, keepUndefined, onTagObj, tag } = options ?? {};
        const { onAnchor, setAnchors, sourceObjects } = anchors.createNodeAnchors(
          this,
          // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
          anchorPrefix || "a"
        );
        const ctx = {
          aliasDuplicateObjects: aliasDuplicateObjects ?? true,
          keepUndefined: keepUndefined ?? false,
          onAnchor,
          onTagObj,
          replacer: _replacer,
          schema: this.schema,
          sourceObjects
        };
        const node = createNode.createNode(value, tag, ctx);
        if (flow && identity.isCollection(node))
          node.flow = true;
        setAnchors();
        return node;
      }
      /**
       * Convert a key and a value into a `Pair` using the current schema,
       * recursively wrapping all values as `Scalar` or `Collection` nodes.
       */
      createPair(key, value, options = {}) {
        const k = this.createNode(key, null, options);
        const v = this.createNode(value, null, options);
        return new Pair.Pair(k, v);
      }
      /**
       * Removes a value from the document.
       * @returns `true` if the item was found and removed.
       */
      delete(key) {
        return assertCollection(this.contents) ? this.contents.delete(key) : false;
      }
      /**
       * Removes a value from the document.
       * @returns `true` if the item was found and removed.
       */
      deleteIn(path) {
        if (Collection.isEmptyPath(path)) {
          if (this.contents == null)
            return false;
          this.contents = null;
          return true;
        }
        return assertCollection(this.contents) ? this.contents.deleteIn(path) : false;
      }
      /**
       * Returns item at `key`, or `undefined` if not found. By default unwraps
       * scalar values from their surrounding node; to disable set `keepScalar` to
       * `true` (collections are always returned intact).
       */
      get(key, keepScalar) {
        return identity.isCollection(this.contents) ? this.contents.get(key, keepScalar) : void 0;
      }
      /**
       * Returns item at `path`, or `undefined` if not found. By default unwraps
       * scalar values from their surrounding node; to disable set `keepScalar` to
       * `true` (collections are always returned intact).
       */
      getIn(path, keepScalar) {
        if (Collection.isEmptyPath(path))
          return !keepScalar && identity.isScalar(this.contents) ? this.contents.value : this.contents;
        return identity.isCollection(this.contents) ? this.contents.getIn(path, keepScalar) : void 0;
      }
      /**
       * Checks if the document includes a value with the key `key`.
       */
      has(key) {
        return identity.isCollection(this.contents) ? this.contents.has(key) : false;
      }
      /**
       * Checks if the document includes a value at `path`.
       */
      hasIn(path) {
        if (Collection.isEmptyPath(path))
          return this.contents !== void 0;
        return identity.isCollection(this.contents) ? this.contents.hasIn(path) : false;
      }
      /**
       * Sets a value in this document. For `!!set`, `value` needs to be a
       * boolean to add/remove the item from the set.
       */
      set(key, value) {
        if (this.contents == null) {
          this.contents = Collection.collectionFromPath(this.schema, [key], value);
        } else if (assertCollection(this.contents)) {
          this.contents.set(key, value);
        }
      }
      /**
       * Sets a value in this document. For `!!set`, `value` needs to be a
       * boolean to add/remove the item from the set.
       */
      setIn(path, value) {
        if (Collection.isEmptyPath(path)) {
          this.contents = value;
        } else if (this.contents == null) {
          this.contents = Collection.collectionFromPath(this.schema, Array.from(path), value);
        } else if (assertCollection(this.contents)) {
          this.contents.setIn(path, value);
        }
      }
      /**
       * Change the YAML version and schema used by the document.
       * A `null` version disables support for directives, explicit tags, anchors, and aliases.
       * It also requires the `schema` option to be given as a `Schema` instance value.
       *
       * Overrides all previously set schema options.
       */
      setSchema(version, options = {}) {
        if (typeof version === "number")
          version = String(version);
        let opt;
        switch (version) {
          case "1.1":
            if (this.directives)
              this.directives.yaml.version = "1.1";
            else
              this.directives = new directives.Directives({ version: "1.1" });
            opt = { resolveKnownTags: false, schema: "yaml-1.1" };
            break;
          case "1.2":
          case "next":
            if (this.directives)
              this.directives.yaml.version = version;
            else
              this.directives = new directives.Directives({ version });
            opt = { resolveKnownTags: true, schema: "core" };
            break;
          case null:
            if (this.directives)
              delete this.directives;
            opt = null;
            break;
          default: {
            const sv = JSON.stringify(version);
            throw new Error(`Expected '1.1', '1.2' or null as first argument, but found: ${sv}`);
          }
        }
        if (options.schema instanceof Object)
          this.schema = options.schema;
        else if (opt)
          this.schema = new Schema.Schema(Object.assign(opt, options));
        else
          throw new Error(`With a null YAML version, the { schema: Schema } option is required`);
      }
      // json & jsonArg are only used from toJSON()
      toJS({ json, jsonArg, mapAsMap, maxAliasCount, onAnchor, reviver } = {}) {
        const ctx = {
          anchors: /* @__PURE__ */ new Map(),
          doc: this,
          keep: !json,
          mapAsMap: mapAsMap === true,
          mapKeyWarned: false,
          maxAliasCount: typeof maxAliasCount === "number" ? maxAliasCount : 100
        };
        const res = toJS.toJS(this.contents, jsonArg ?? "", ctx);
        if (typeof onAnchor === "function")
          for (const { count, res: res2 } of ctx.anchors.values())
            onAnchor(res2, count);
        return typeof reviver === "function" ? applyReviver.applyReviver(reviver, { "": res }, "", res) : res;
      }
      /**
       * A JSON representation of the document `contents`.
       *
       * @param jsonArg Used by `JSON.stringify` to indicate the array index or
       *   property name.
       */
      toJSON(jsonArg, onAnchor) {
        return this.toJS({ json: true, jsonArg, mapAsMap: false, onAnchor });
      }
      /** A YAML representation of the document. */
      toString(options = {}) {
        if (this.errors.length > 0)
          throw new Error("Document with errors cannot be stringified");
        if ("indent" in options && (!Number.isInteger(options.indent) || Number(options.indent) <= 0)) {
          const s = JSON.stringify(options.indent);
          throw new Error(`"indent" option must be a positive integer, not ${s}`);
        }
        return stringifyDocument.stringifyDocument(this, options);
      }
    };
    function assertCollection(contents) {
      if (identity.isCollection(contents))
        return true;
      throw new Error("Expected a YAML collection as document contents");
    }
    exports2.Document = Document;
  }
});

// node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/errors.js
var require_errors = __commonJS({
  "node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/errors.js"(exports2) {
    "use strict";
    var YAMLError = class extends Error {
      constructor(name, pos, code, message) {
        super();
        this.name = name;
        this.code = code;
        this.message = message;
        this.pos = pos;
      }
    };
    var YAMLParseError = class extends YAMLError {
      constructor(pos, code, message) {
        super("YAMLParseError", pos, code, message);
      }
    };
    var YAMLWarning = class extends YAMLError {
      constructor(pos, code, message) {
        super("YAMLWarning", pos, code, message);
      }
    };
    var prettifyError = (src, lc) => (error) => {
      if (error.pos[0] === -1)
        return;
      error.linePos = error.pos.map((pos) => lc.linePos(pos));
      const { line, col } = error.linePos[0];
      error.message += ` at line ${line}, column ${col}`;
      let ci = col - 1;
      let lineStr = src.substring(lc.lineStarts[line - 1], lc.lineStarts[line]).replace(/[\n\r]+$/, "");
      if (ci >= 60 && lineStr.length > 80) {
        const trimStart = Math.min(ci - 39, lineStr.length - 79);
        lineStr = "\u2026" + lineStr.substring(trimStart);
        ci -= trimStart - 1;
      }
      if (lineStr.length > 80)
        lineStr = lineStr.substring(0, 79) + "\u2026";
      if (line > 1 && /^ *$/.test(lineStr.substring(0, ci))) {
        let prev = src.substring(lc.lineStarts[line - 2], lc.lineStarts[line - 1]);
        if (prev.length > 80)
          prev = prev.substring(0, 79) + "\u2026\n";
        lineStr = prev + lineStr;
      }
      if (/[^ ]/.test(lineStr)) {
        let count = 1;
        const end = error.linePos[1];
        if (end?.line === line && end.col > col) {
          count = Math.max(1, Math.min(end.col - col, 80 - ci));
        }
        const pointer = " ".repeat(ci) + "^".repeat(count);
        error.message += `:

${lineStr}
${pointer}
`;
      }
    };
    exports2.YAMLError = YAMLError;
    exports2.YAMLParseError = YAMLParseError;
    exports2.YAMLWarning = YAMLWarning;
    exports2.prettifyError = prettifyError;
  }
});

// node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/compose/resolve-props.js
var require_resolve_props = __commonJS({
  "node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/compose/resolve-props.js"(exports2) {
    "use strict";
    function resolveProps(tokens, { flow, indicator, next, offset, onError, parentIndent, startOnNewline }) {
      let spaceBefore = false;
      let atNewline = startOnNewline;
      let hasSpace = startOnNewline;
      let comment = "";
      let commentSep = "";
      let hasNewline = false;
      let reqSpace = false;
      let tab = null;
      let anchor = null;
      let tag = null;
      let newlineAfterProp = null;
      let comma = null;
      let found = null;
      let start = null;
      for (const token of tokens) {
        if (reqSpace) {
          if (token.type !== "space" && token.type !== "newline" && token.type !== "comma")
            onError(token.offset, "MISSING_CHAR", "Tags and anchors must be separated from the next token by white space");
          reqSpace = false;
        }
        if (tab) {
          if (atNewline && token.type !== "comment" && token.type !== "newline") {
            onError(tab, "TAB_AS_INDENT", "Tabs are not allowed as indentation");
          }
          tab = null;
        }
        switch (token.type) {
          case "space":
            if (!flow && (indicator !== "doc-start" || next?.type !== "flow-collection") && token.source.includes("	")) {
              tab = token;
            }
            hasSpace = true;
            break;
          case "comment": {
            if (!hasSpace)
              onError(token, "MISSING_CHAR", "Comments must be separated from other tokens by white space characters");
            const cb = token.source.substring(1) || " ";
            if (!comment)
              comment = cb;
            else
              comment += commentSep + cb;
            commentSep = "";
            atNewline = false;
            break;
          }
          case "newline":
            if (atNewline) {
              if (comment)
                comment += token.source;
              else if (!found || indicator !== "seq-item-ind")
                spaceBefore = true;
            } else
              commentSep += token.source;
            atNewline = true;
            hasNewline = true;
            if (anchor || tag)
              newlineAfterProp = token;
            hasSpace = true;
            break;
          case "anchor":
            if (anchor)
              onError(token, "MULTIPLE_ANCHORS", "A node can have at most one anchor");
            if (token.source.endsWith(":"))
              onError(token.offset + token.source.length - 1, "BAD_ALIAS", "Anchor ending in : is ambiguous", true);
            anchor = token;
            start ?? (start = token.offset);
            atNewline = false;
            hasSpace = false;
            reqSpace = true;
            break;
          case "tag": {
            if (tag)
              onError(token, "MULTIPLE_TAGS", "A node can have at most one tag");
            tag = token;
            start ?? (start = token.offset);
            atNewline = false;
            hasSpace = false;
            reqSpace = true;
            break;
          }
          case indicator:
            if (anchor || tag)
              onError(token, "BAD_PROP_ORDER", `Anchors and tags must be after the ${token.source} indicator`);
            if (found)
              onError(token, "UNEXPECTED_TOKEN", `Unexpected ${token.source} in ${flow ?? "collection"}`);
            found = token;
            atNewline = indicator === "seq-item-ind" || indicator === "explicit-key-ind";
            hasSpace = false;
            break;
          case "comma":
            if (flow) {
              if (comma)
                onError(token, "UNEXPECTED_TOKEN", `Unexpected , in ${flow}`);
              comma = token;
              atNewline = false;
              hasSpace = false;
              break;
            }
          // else fallthrough
          default:
            onError(token, "UNEXPECTED_TOKEN", `Unexpected ${token.type} token`);
            atNewline = false;
            hasSpace = false;
        }
      }
      const last = tokens[tokens.length - 1];
      const end = last ? last.offset + last.source.length : offset;
      if (reqSpace && next && next.type !== "space" && next.type !== "newline" && next.type !== "comma" && (next.type !== "scalar" || next.source !== "")) {
        onError(next.offset, "MISSING_CHAR", "Tags and anchors must be separated from the next token by white space");
      }
      if (tab && (atNewline && tab.indent <= parentIndent || next?.type === "block-map" || next?.type === "block-seq"))
        onError(tab, "TAB_AS_INDENT", "Tabs are not allowed as indentation");
      return {
        comma,
        found,
        spaceBefore,
        comment,
        hasNewline,
        anchor,
        tag,
        newlineAfterProp,
        end,
        start: start ?? end
      };
    }
    exports2.resolveProps = resolveProps;
  }
});

// node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/compose/util-contains-newline.js
var require_util_contains_newline = __commonJS({
  "node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/compose/util-contains-newline.js"(exports2) {
    "use strict";
    function containsNewline(key) {
      if (!key)
        return null;
      switch (key.type) {
        case "alias":
        case "scalar":
        case "double-quoted-scalar":
        case "single-quoted-scalar":
          if (key.source.includes("\n"))
            return true;
          if (key.end) {
            for (const st of key.end)
              if (st.type === "newline")
                return true;
          }
          return false;
        case "flow-collection":
          for (const it of key.items) {
            for (const st of it.start)
              if (st.type === "newline")
                return true;
            if (it.sep) {
              for (const st of it.sep)
                if (st.type === "newline")
                  return true;
            }
            if (containsNewline(it.key) || containsNewline(it.value))
              return true;
          }
          return false;
        default:
          return true;
      }
    }
    exports2.containsNewline = containsNewline;
  }
});

// node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/compose/util-flow-indent-check.js
var require_util_flow_indent_check = __commonJS({
  "node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/compose/util-flow-indent-check.js"(exports2) {
    "use strict";
    var utilContainsNewline = require_util_contains_newline();
    function flowIndentCheck(indent, fc, onError) {
      if (fc?.type === "flow-collection") {
        const end = fc.end[0];
        if (end.indent === indent && (end.source === "]" || end.source === "}") && utilContainsNewline.containsNewline(fc)) {
          const msg = "Flow end indicator should be more indented than parent";
          onError(end, "BAD_INDENT", msg, true);
        }
      }
    }
    exports2.flowIndentCheck = flowIndentCheck;
  }
});

// node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/compose/util-map-includes.js
var require_util_map_includes = __commonJS({
  "node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/compose/util-map-includes.js"(exports2) {
    "use strict";
    var identity = require_identity();
    function mapIncludes(ctx, items, search) {
      const { uniqueKeys } = ctx.options;
      if (uniqueKeys === false)
        return false;
      const isEqual = typeof uniqueKeys === "function" ? uniqueKeys : (a, b) => a === b || identity.isScalar(a) && identity.isScalar(b) && a.value === b.value;
      return items.some((pair) => isEqual(pair.key, search));
    }
    exports2.mapIncludes = mapIncludes;
  }
});

// node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/compose/resolve-block-map.js
var require_resolve_block_map = __commonJS({
  "node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/compose/resolve-block-map.js"(exports2) {
    "use strict";
    var Pair = require_Pair();
    var YAMLMap = require_YAMLMap();
    var resolveProps = require_resolve_props();
    var utilContainsNewline = require_util_contains_newline();
    var utilFlowIndentCheck = require_util_flow_indent_check();
    var utilMapIncludes = require_util_map_includes();
    var startColMsg = "All mapping items must start at the same column";
    function resolveBlockMap({ composeNode, composeEmptyNode }, ctx, bm, onError, tag) {
      const NodeClass = tag?.nodeClass ?? YAMLMap.YAMLMap;
      const map = new NodeClass(ctx.schema);
      if (ctx.atRoot)
        ctx.atRoot = false;
      let offset = bm.offset;
      let commentEnd = null;
      for (const collItem of bm.items) {
        const { start, key, sep: sep2, value } = collItem;
        const keyProps = resolveProps.resolveProps(start, {
          indicator: "explicit-key-ind",
          next: key ?? sep2?.[0],
          offset,
          onError,
          parentIndent: bm.indent,
          startOnNewline: true
        });
        const implicitKey = !keyProps.found;
        if (implicitKey) {
          if (key) {
            if (key.type === "block-seq")
              onError(offset, "BLOCK_AS_IMPLICIT_KEY", "A block sequence may not be used as an implicit map key");
            else if ("indent" in key && key.indent !== bm.indent)
              onError(offset, "BAD_INDENT", startColMsg);
          }
          if (!keyProps.anchor && !keyProps.tag && !sep2) {
            commentEnd = keyProps.end;
            if (keyProps.comment) {
              if (map.comment)
                map.comment += "\n" + keyProps.comment;
              else
                map.comment = keyProps.comment;
            }
            continue;
          }
          if (keyProps.newlineAfterProp || utilContainsNewline.containsNewline(key)) {
            onError(key ?? start[start.length - 1], "MULTILINE_IMPLICIT_KEY", "Implicit keys need to be on a single line");
          }
        } else if (keyProps.found?.indent !== bm.indent) {
          onError(offset, "BAD_INDENT", startColMsg);
        }
        ctx.atKey = true;
        const keyStart = keyProps.end;
        const keyNode = key ? composeNode(ctx, key, keyProps, onError) : composeEmptyNode(ctx, keyStart, start, null, keyProps, onError);
        if (ctx.schema.compat)
          utilFlowIndentCheck.flowIndentCheck(bm.indent, key, onError);
        ctx.atKey = false;
        if (utilMapIncludes.mapIncludes(ctx, map.items, keyNode))
          onError(keyStart, "DUPLICATE_KEY", "Map keys must be unique");
        const valueProps = resolveProps.resolveProps(sep2 ?? [], {
          indicator: "map-value-ind",
          next: value,
          offset: keyNode.range[2],
          onError,
          parentIndent: bm.indent,
          startOnNewline: !key || key.type === "block-scalar"
        });
        offset = valueProps.end;
        if (valueProps.found) {
          if (implicitKey) {
            if (value?.type === "block-map" && !valueProps.hasNewline)
              onError(offset, "BLOCK_AS_IMPLICIT_KEY", "Nested mappings are not allowed in compact mappings");
            if (ctx.options.strict && keyProps.start < valueProps.found.offset - 1024)
              onError(keyNode.range, "KEY_OVER_1024_CHARS", "The : indicator must be at most 1024 chars after the start of an implicit block mapping key");
          }
          const valueNode = value ? composeNode(ctx, value, valueProps, onError) : composeEmptyNode(ctx, offset, sep2, null, valueProps, onError);
          if (ctx.schema.compat)
            utilFlowIndentCheck.flowIndentCheck(bm.indent, value, onError);
          offset = valueNode.range[2];
          const pair = new Pair.Pair(keyNode, valueNode);
          if (ctx.options.keepSourceTokens)
            pair.srcToken = collItem;
          map.items.push(pair);
        } else {
          if (implicitKey)
            onError(keyNode.range, "MISSING_CHAR", "Implicit map keys need to be followed by map values");
          if (valueProps.comment) {
            if (keyNode.comment)
              keyNode.comment += "\n" + valueProps.comment;
            else
              keyNode.comment = valueProps.comment;
          }
          const pair = new Pair.Pair(keyNode);
          if (ctx.options.keepSourceTokens)
            pair.srcToken = collItem;
          map.items.push(pair);
        }
      }
      if (commentEnd && commentEnd < offset)
        onError(commentEnd, "IMPOSSIBLE", "Map comment with trailing content");
      map.range = [bm.offset, offset, commentEnd ?? offset];
      return map;
    }
    exports2.resolveBlockMap = resolveBlockMap;
  }
});

// node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/compose/resolve-block-seq.js
var require_resolve_block_seq = __commonJS({
  "node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/compose/resolve-block-seq.js"(exports2) {
    "use strict";
    var YAMLSeq = require_YAMLSeq();
    var resolveProps = require_resolve_props();
    var utilFlowIndentCheck = require_util_flow_indent_check();
    function resolveBlockSeq({ composeNode, composeEmptyNode }, ctx, bs, onError, tag) {
      const NodeClass = tag?.nodeClass ?? YAMLSeq.YAMLSeq;
      const seq = new NodeClass(ctx.schema);
      if (ctx.atRoot)
        ctx.atRoot = false;
      if (ctx.atKey)
        ctx.atKey = false;
      let offset = bs.offset;
      let commentEnd = null;
      for (const { start, value } of bs.items) {
        const props = resolveProps.resolveProps(start, {
          indicator: "seq-item-ind",
          next: value,
          offset,
          onError,
          parentIndent: bs.indent,
          startOnNewline: true
        });
        if (!props.found) {
          if (props.anchor || props.tag || value) {
            if (value?.type === "block-seq")
              onError(props.end, "BAD_INDENT", "All sequence items must start at the same column");
            else
              onError(offset, "MISSING_CHAR", "Sequence item without - indicator");
          } else {
            commentEnd = props.end;
            if (props.comment)
              seq.comment = props.comment;
            continue;
          }
        }
        const node = value ? composeNode(ctx, value, props, onError) : composeEmptyNode(ctx, props.end, start, null, props, onError);
        if (ctx.schema.compat)
          utilFlowIndentCheck.flowIndentCheck(bs.indent, value, onError);
        offset = node.range[2];
        seq.items.push(node);
      }
      seq.range = [bs.offset, offset, commentEnd ?? offset];
      return seq;
    }
    exports2.resolveBlockSeq = resolveBlockSeq;
  }
});

// node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/compose/resolve-end.js
var require_resolve_end = __commonJS({
  "node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/compose/resolve-end.js"(exports2) {
    "use strict";
    function resolveEnd(end, offset, reqSpace, onError) {
      let comment = "";
      if (end) {
        let hasSpace = false;
        let sep2 = "";
        for (const token of end) {
          const { source, type } = token;
          switch (type) {
            case "space":
              hasSpace = true;
              break;
            case "comment": {
              if (reqSpace && !hasSpace)
                onError(token, "MISSING_CHAR", "Comments must be separated from other tokens by white space characters");
              const cb = source.substring(1) || " ";
              if (!comment)
                comment = cb;
              else
                comment += sep2 + cb;
              sep2 = "";
              break;
            }
            case "newline":
              if (comment)
                sep2 += source;
              hasSpace = true;
              break;
            default:
              onError(token, "UNEXPECTED_TOKEN", `Unexpected ${type} at node end`);
          }
          offset += source.length;
        }
      }
      return { comment, offset };
    }
    exports2.resolveEnd = resolveEnd;
  }
});

// node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/compose/resolve-flow-collection.js
var require_resolve_flow_collection = __commonJS({
  "node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/compose/resolve-flow-collection.js"(exports2) {
    "use strict";
    var identity = require_identity();
    var Pair = require_Pair();
    var YAMLMap = require_YAMLMap();
    var YAMLSeq = require_YAMLSeq();
    var resolveEnd = require_resolve_end();
    var resolveProps = require_resolve_props();
    var utilContainsNewline = require_util_contains_newline();
    var utilMapIncludes = require_util_map_includes();
    var blockMsg = "Block collections are not allowed within flow collections";
    var isBlock = (token) => token && (token.type === "block-map" || token.type === "block-seq");
    function resolveFlowCollection({ composeNode, composeEmptyNode }, ctx, fc, onError, tag) {
      const isMap = fc.start.source === "{";
      const fcName = isMap ? "flow map" : "flow sequence";
      const NodeClass = tag?.nodeClass ?? (isMap ? YAMLMap.YAMLMap : YAMLSeq.YAMLSeq);
      const coll = new NodeClass(ctx.schema);
      coll.flow = true;
      const atRoot = ctx.atRoot;
      if (atRoot)
        ctx.atRoot = false;
      if (ctx.atKey)
        ctx.atKey = false;
      let offset = fc.offset + fc.start.source.length;
      for (let i = 0; i < fc.items.length; ++i) {
        const collItem = fc.items[i];
        const { start, key, sep: sep2, value } = collItem;
        const props = resolveProps.resolveProps(start, {
          flow: fcName,
          indicator: "explicit-key-ind",
          next: key ?? sep2?.[0],
          offset,
          onError,
          parentIndent: fc.indent,
          startOnNewline: false
        });
        if (!props.found) {
          if (!props.anchor && !props.tag && !sep2 && !value) {
            if (i === 0 && props.comma)
              onError(props.comma, "UNEXPECTED_TOKEN", `Unexpected , in ${fcName}`);
            else if (i < fc.items.length - 1)
              onError(props.start, "UNEXPECTED_TOKEN", `Unexpected empty item in ${fcName}`);
            if (props.comment) {
              if (coll.comment)
                coll.comment += "\n" + props.comment;
              else
                coll.comment = props.comment;
            }
            offset = props.end;
            continue;
          }
          if (!isMap && ctx.options.strict && utilContainsNewline.containsNewline(key))
            onError(
              key,
              // checked by containsNewline()
              "MULTILINE_IMPLICIT_KEY",
              "Implicit keys of flow sequence pairs need to be on a single line"
            );
        }
        if (i === 0) {
          if (props.comma)
            onError(props.comma, "UNEXPECTED_TOKEN", `Unexpected , in ${fcName}`);
        } else {
          if (!props.comma)
            onError(props.start, "MISSING_CHAR", `Missing , between ${fcName} items`);
          if (props.comment) {
            let prevItemComment = "";
            loop: for (const st of start) {
              switch (st.type) {
                case "comma":
                case "space":
                  break;
                case "comment":
                  prevItemComment = st.source.substring(1);
                  break loop;
                default:
                  break loop;
              }
            }
            if (prevItemComment) {
              let prev = coll.items[coll.items.length - 1];
              if (identity.isPair(prev))
                prev = prev.value ?? prev.key;
              if (prev.comment)
                prev.comment += "\n" + prevItemComment;
              else
                prev.comment = prevItemComment;
              props.comment = props.comment.substring(prevItemComment.length + 1);
            }
          }
        }
        if (!isMap && !sep2 && !props.found) {
          const valueNode = value ? composeNode(ctx, value, props, onError) : composeEmptyNode(ctx, props.end, sep2, null, props, onError);
          coll.items.push(valueNode);
          offset = valueNode.range[2];
          if (isBlock(value))
            onError(valueNode.range, "BLOCK_IN_FLOW", blockMsg);
        } else {
          ctx.atKey = true;
          const keyStart = props.end;
          const keyNode = key ? composeNode(ctx, key, props, onError) : composeEmptyNode(ctx, keyStart, start, null, props, onError);
          if (isBlock(key))
            onError(keyNode.range, "BLOCK_IN_FLOW", blockMsg);
          ctx.atKey = false;
          const valueProps = resolveProps.resolveProps(sep2 ?? [], {
            flow: fcName,
            indicator: "map-value-ind",
            next: value,
            offset: keyNode.range[2],
            onError,
            parentIndent: fc.indent,
            startOnNewline: false
          });
          if (valueProps.found) {
            if (!isMap && !props.found && ctx.options.strict) {
              if (sep2)
                for (const st of sep2) {
                  if (st === valueProps.found)
                    break;
                  if (st.type === "newline") {
                    onError(st, "MULTILINE_IMPLICIT_KEY", "Implicit keys of flow sequence pairs need to be on a single line");
                    break;
                  }
                }
              if (props.start < valueProps.found.offset - 1024)
                onError(valueProps.found, "KEY_OVER_1024_CHARS", "The : indicator must be at most 1024 chars after the start of an implicit flow sequence key");
            }
          } else if (value) {
            if ("source" in value && value.source?.[0] === ":")
              onError(value, "MISSING_CHAR", `Missing space after : in ${fcName}`);
            else
              onError(valueProps.start, "MISSING_CHAR", `Missing , or : between ${fcName} items`);
          }
          const valueNode = value ? composeNode(ctx, value, valueProps, onError) : valueProps.found ? composeEmptyNode(ctx, valueProps.end, sep2, null, valueProps, onError) : null;
          if (valueNode) {
            if (isBlock(value))
              onError(valueNode.range, "BLOCK_IN_FLOW", blockMsg);
          } else if (valueProps.comment) {
            if (keyNode.comment)
              keyNode.comment += "\n" + valueProps.comment;
            else
              keyNode.comment = valueProps.comment;
          }
          const pair = new Pair.Pair(keyNode, valueNode);
          if (ctx.options.keepSourceTokens)
            pair.srcToken = collItem;
          if (isMap) {
            const map = coll;
            if (utilMapIncludes.mapIncludes(ctx, map.items, keyNode))
              onError(keyStart, "DUPLICATE_KEY", "Map keys must be unique");
            map.items.push(pair);
          } else {
            const map = new YAMLMap.YAMLMap(ctx.schema);
            map.flow = true;
            map.items.push(pair);
            const endRange = (valueNode ?? keyNode).range;
            map.range = [keyNode.range[0], endRange[1], endRange[2]];
            coll.items.push(map);
          }
          offset = valueNode ? valueNode.range[2] : valueProps.end;
        }
      }
      const expectedEnd = isMap ? "}" : "]";
      const [ce, ...ee] = fc.end;
      let cePos = offset;
      if (ce?.source === expectedEnd)
        cePos = ce.offset + ce.source.length;
      else {
        const name = fcName[0].toUpperCase() + fcName.substring(1);
        const msg = atRoot ? `${name} must end with a ${expectedEnd}` : `${name} in block collection must be sufficiently indented and end with a ${expectedEnd}`;
        onError(offset, atRoot ? "MISSING_CHAR" : "BAD_INDENT", msg);
        if (ce && ce.source.length !== 1)
          ee.unshift(ce);
      }
      if (ee.length > 0) {
        const end = resolveEnd.resolveEnd(ee, cePos, ctx.options.strict, onError);
        if (end.comment) {
          if (coll.comment)
            coll.comment += "\n" + end.comment;
          else
            coll.comment = end.comment;
        }
        coll.range = [fc.offset, cePos, end.offset];
      } else {
        coll.range = [fc.offset, cePos, cePos];
      }
      return coll;
    }
    exports2.resolveFlowCollection = resolveFlowCollection;
  }
});

// node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/compose/compose-collection.js
var require_compose_collection = __commonJS({
  "node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/compose/compose-collection.js"(exports2) {
    "use strict";
    var identity = require_identity();
    var Scalar = require_Scalar();
    var YAMLMap = require_YAMLMap();
    var YAMLSeq = require_YAMLSeq();
    var resolveBlockMap = require_resolve_block_map();
    var resolveBlockSeq = require_resolve_block_seq();
    var resolveFlowCollection = require_resolve_flow_collection();
    function resolveCollection(CN, ctx, token, onError, tagName, tag) {
      const coll = token.type === "block-map" ? resolveBlockMap.resolveBlockMap(CN, ctx, token, onError, tag) : token.type === "block-seq" ? resolveBlockSeq.resolveBlockSeq(CN, ctx, token, onError, tag) : resolveFlowCollection.resolveFlowCollection(CN, ctx, token, onError, tag);
      const Coll = coll.constructor;
      if (tagName === "!" || tagName === Coll.tagName) {
        coll.tag = Coll.tagName;
        return coll;
      }
      if (tagName)
        coll.tag = tagName;
      return coll;
    }
    function composeCollection(CN, ctx, token, props, onError) {
      const tagToken = props.tag;
      const tagName = !tagToken ? null : ctx.directives.tagName(tagToken.source, (msg) => onError(tagToken, "TAG_RESOLVE_FAILED", msg));
      if (token.type === "block-seq") {
        const { anchor, newlineAfterProp: nl } = props;
        const lastProp = anchor && tagToken ? anchor.offset > tagToken.offset ? anchor : tagToken : anchor ?? tagToken;
        if (lastProp && (!nl || nl.offset < lastProp.offset)) {
          const message = "Missing newline after block sequence props";
          onError(lastProp, "MISSING_CHAR", message);
        }
      }
      const expType = token.type === "block-map" ? "map" : token.type === "block-seq" ? "seq" : token.start.source === "{" ? "map" : "seq";
      if (!tagToken || !tagName || tagName === "!" || tagName === YAMLMap.YAMLMap.tagName && expType === "map" || tagName === YAMLSeq.YAMLSeq.tagName && expType === "seq") {
        return resolveCollection(CN, ctx, token, onError, tagName);
      }
      let tag = ctx.schema.tags.find((t) => t.tag === tagName && t.collection === expType);
      if (!tag) {
        const kt = ctx.schema.knownTags[tagName];
        if (kt?.collection === expType) {
          ctx.schema.tags.push(Object.assign({}, kt, { default: false }));
          tag = kt;
        } else {
          if (kt) {
            onError(tagToken, "BAD_COLLECTION_TYPE", `${kt.tag} used for ${expType} collection, but expects ${kt.collection ?? "scalar"}`, true);
          } else {
            onError(tagToken, "TAG_RESOLVE_FAILED", `Unresolved tag: ${tagName}`, true);
          }
          return resolveCollection(CN, ctx, token, onError, tagName);
        }
      }
      const coll = resolveCollection(CN, ctx, token, onError, tagName, tag);
      const res = tag.resolve?.(coll, (msg) => onError(tagToken, "TAG_RESOLVE_FAILED", msg), ctx.options) ?? coll;
      const node = identity.isNode(res) ? res : new Scalar.Scalar(res);
      node.range = coll.range;
      node.tag = tagName;
      if (tag?.format)
        node.format = tag.format;
      return node;
    }
    exports2.composeCollection = composeCollection;
  }
});

// node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/compose/resolve-block-scalar.js
var require_resolve_block_scalar = __commonJS({
  "node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/compose/resolve-block-scalar.js"(exports2) {
    "use strict";
    var Scalar = require_Scalar();
    function resolveBlockScalar(ctx, scalar, onError) {
      const start = scalar.offset;
      const header = parseBlockScalarHeader(scalar, ctx.options.strict, onError);
      if (!header)
        return { value: "", type: null, comment: "", range: [start, start, start] };
      const type = header.mode === ">" ? Scalar.Scalar.BLOCK_FOLDED : Scalar.Scalar.BLOCK_LITERAL;
      const lines = scalar.source ? splitLines(scalar.source) : [];
      let chompStart = lines.length;
      for (let i = lines.length - 1; i >= 0; --i) {
        const content = lines[i][1];
        if (content === "" || content === "\r")
          chompStart = i;
        else
          break;
      }
      if (chompStart === 0) {
        const value2 = header.chomp === "+" && lines.length > 0 ? "\n".repeat(Math.max(1, lines.length - 1)) : "";
        let end2 = start + header.length;
        if (scalar.source)
          end2 += scalar.source.length;
        return { value: value2, type, comment: header.comment, range: [start, end2, end2] };
      }
      let trimIndent = scalar.indent + header.indent;
      let offset = scalar.offset + header.length;
      let contentStart = 0;
      for (let i = 0; i < chompStart; ++i) {
        const [indent, content] = lines[i];
        if (content === "" || content === "\r") {
          if (header.indent === 0 && indent.length > trimIndent)
            trimIndent = indent.length;
        } else {
          if (indent.length < trimIndent) {
            const message = "Block scalars with more-indented leading empty lines must use an explicit indentation indicator";
            onError(offset + indent.length, "MISSING_CHAR", message);
          }
          if (header.indent === 0)
            trimIndent = indent.length;
          contentStart = i;
          if (trimIndent === 0 && !ctx.atRoot) {
            const message = "Block scalar values in collections must be indented";
            onError(offset, "BAD_INDENT", message);
          }
          break;
        }
        offset += indent.length + content.length + 1;
      }
      for (let i = lines.length - 1; i >= chompStart; --i) {
        if (lines[i][0].length > trimIndent)
          chompStart = i + 1;
      }
      let value = "";
      let sep2 = "";
      let prevMoreIndented = false;
      for (let i = 0; i < contentStart; ++i)
        value += lines[i][0].slice(trimIndent) + "\n";
      for (let i = contentStart; i < chompStart; ++i) {
        let [indent, content] = lines[i];
        offset += indent.length + content.length + 1;
        const crlf = content[content.length - 1] === "\r";
        if (crlf)
          content = content.slice(0, -1);
        if (content && indent.length < trimIndent) {
          const src = header.indent ? "explicit indentation indicator" : "first line";
          const message = `Block scalar lines must not be less indented than their ${src}`;
          onError(offset - content.length - (crlf ? 2 : 1), "BAD_INDENT", message);
          indent = "";
        }
        if (type === Scalar.Scalar.BLOCK_LITERAL) {
          value += sep2 + indent.slice(trimIndent) + content;
          sep2 = "\n";
        } else if (indent.length > trimIndent || content[0] === "	") {
          if (sep2 === " ")
            sep2 = "\n";
          else if (!prevMoreIndented && sep2 === "\n")
            sep2 = "\n\n";
          value += sep2 + indent.slice(trimIndent) + content;
          sep2 = "\n";
          prevMoreIndented = true;
        } else if (content === "") {
          if (sep2 === "\n")
            value += "\n";
          else
            sep2 = "\n";
        } else {
          value += sep2 + content;
          sep2 = " ";
          prevMoreIndented = false;
        }
      }
      switch (header.chomp) {
        case "-":
          break;
        case "+":
          for (let i = chompStart; i < lines.length; ++i)
            value += "\n" + lines[i][0].slice(trimIndent);
          if (value[value.length - 1] !== "\n")
            value += "\n";
          break;
        default:
          value += "\n";
      }
      const end = start + header.length + scalar.source.length;
      return { value, type, comment: header.comment, range: [start, end, end] };
    }
    function parseBlockScalarHeader({ offset, props }, strict, onError) {
      if (props[0].type !== "block-scalar-header") {
        onError(props[0], "IMPOSSIBLE", "Block scalar header not found");
        return null;
      }
      const { source } = props[0];
      const mode = source[0];
      let indent = 0;
      let chomp = "";
      let error = -1;
      for (let i = 1; i < source.length; ++i) {
        const ch = source[i];
        if (!chomp && (ch === "-" || ch === "+"))
          chomp = ch;
        else {
          const n = Number(ch);
          if (!indent && n)
            indent = n;
          else if (error === -1)
            error = offset + i;
        }
      }
      if (error !== -1)
        onError(error, "UNEXPECTED_TOKEN", `Block scalar header includes extra characters: ${source}`);
      let hasSpace = false;
      let comment = "";
      let length = source.length;
      for (let i = 1; i < props.length; ++i) {
        const token = props[i];
        switch (token.type) {
          case "space":
            hasSpace = true;
          // fallthrough
          case "newline":
            length += token.source.length;
            break;
          case "comment":
            if (strict && !hasSpace) {
              const message = "Comments must be separated from other tokens by white space characters";
              onError(token, "MISSING_CHAR", message);
            }
            length += token.source.length;
            comment = token.source.substring(1);
            break;
          case "error":
            onError(token, "UNEXPECTED_TOKEN", token.message);
            length += token.source.length;
            break;
          /* istanbul ignore next should not happen */
          default: {
            const message = `Unexpected token in block scalar header: ${token.type}`;
            onError(token, "UNEXPECTED_TOKEN", message);
            const ts = token.source;
            if (ts && typeof ts === "string")
              length += ts.length;
          }
        }
      }
      return { mode, indent, chomp, comment, length };
    }
    function splitLines(source) {
      const split = source.split(/\n( *)/);
      const first = split[0];
      const m = first.match(/^( *)/);
      const line0 = m?.[1] ? [m[1], first.slice(m[1].length)] : ["", first];
      const lines = [line0];
      for (let i = 1; i < split.length; i += 2)
        lines.push([split[i], split[i + 1]]);
      return lines;
    }
    exports2.resolveBlockScalar = resolveBlockScalar;
  }
});

// node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/compose/resolve-flow-scalar.js
var require_resolve_flow_scalar = __commonJS({
  "node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/compose/resolve-flow-scalar.js"(exports2) {
    "use strict";
    var Scalar = require_Scalar();
    var resolveEnd = require_resolve_end();
    function resolveFlowScalar(scalar, strict, onError) {
      const { offset, type, source, end } = scalar;
      let _type;
      let value;
      const _onError = (rel, code, msg) => onError(offset + rel, code, msg);
      switch (type) {
        case "scalar":
          _type = Scalar.Scalar.PLAIN;
          value = plainValue(source, _onError);
          break;
        case "single-quoted-scalar":
          _type = Scalar.Scalar.QUOTE_SINGLE;
          value = singleQuotedValue(source, _onError);
          break;
        case "double-quoted-scalar":
          _type = Scalar.Scalar.QUOTE_DOUBLE;
          value = doubleQuotedValue(source, _onError);
          break;
        /* istanbul ignore next should not happen */
        default:
          onError(scalar, "UNEXPECTED_TOKEN", `Expected a flow scalar value, but found: ${type}`);
          return {
            value: "",
            type: null,
            comment: "",
            range: [offset, offset + source.length, offset + source.length]
          };
      }
      const valueEnd = offset + source.length;
      const re = resolveEnd.resolveEnd(end, valueEnd, strict, onError);
      return {
        value,
        type: _type,
        comment: re.comment,
        range: [offset, valueEnd, re.offset]
      };
    }
    function plainValue(source, onError) {
      let badChar = "";
      switch (source[0]) {
        /* istanbul ignore next should not happen */
        case "	":
          badChar = "a tab character";
          break;
        case ",":
          badChar = "flow indicator character ,";
          break;
        case "%":
          badChar = "directive indicator character %";
          break;
        case "|":
        case ">": {
          badChar = `block scalar indicator ${source[0]}`;
          break;
        }
        case "@":
        case "`": {
          badChar = `reserved character ${source[0]}`;
          break;
        }
      }
      if (badChar)
        onError(0, "BAD_SCALAR_START", `Plain value cannot start with ${badChar}`);
      return foldLines(source);
    }
    function singleQuotedValue(source, onError) {
      if (source[source.length - 1] !== "'" || source.length === 1)
        onError(source.length, "MISSING_CHAR", "Missing closing 'quote");
      return foldLines(source.slice(1, -1)).replace(/''/g, "'");
    }
    function foldLines(source) {
      let first, line;
      try {
        first = new RegExp("(.*?)(?<![ 	])[ 	]*\r?\n", "sy");
        line = new RegExp("[ 	]*(.*?)(?:(?<![ 	])[ 	]*)?\r?\n", "sy");
      } catch {
        first = /(.*?)[ \t]*\r?\n/sy;
        line = /[ \t]*(.*?)[ \t]*\r?\n/sy;
      }
      let match = first.exec(source);
      if (!match)
        return source;
      let res = match[1];
      let sep2 = " ";
      let pos = first.lastIndex;
      line.lastIndex = pos;
      while (match = line.exec(source)) {
        if (match[1] === "") {
          if (sep2 === "\n")
            res += sep2;
          else
            sep2 = "\n";
        } else {
          res += sep2 + match[1];
          sep2 = " ";
        }
        pos = line.lastIndex;
      }
      const last = /[ \t]*(.*)/sy;
      last.lastIndex = pos;
      match = last.exec(source);
      return res + sep2 + (match?.[1] ?? "");
    }
    function doubleQuotedValue(source, onError) {
      let res = "";
      for (let i = 1; i < source.length - 1; ++i) {
        const ch = source[i];
        if (ch === "\r" && source[i + 1] === "\n")
          continue;
        if (ch === "\n") {
          const { fold, offset } = foldNewline(source, i);
          res += fold;
          i = offset;
        } else if (ch === "\\") {
          let next = source[++i];
          const cc = escapeCodes[next];
          if (cc)
            res += cc;
          else if (next === "\n") {
            next = source[i + 1];
            while (next === " " || next === "	")
              next = source[++i + 1];
          } else if (next === "\r" && source[i + 1] === "\n") {
            next = source[++i + 1];
            while (next === " " || next === "	")
              next = source[++i + 1];
          } else if (next === "x" || next === "u" || next === "U") {
            const length = next === "x" ? 2 : next === "u" ? 4 : 8;
            res += parseCharCode(source, i + 1, length, onError);
            i += length;
          } else {
            const raw = source.substr(i - 1, 2);
            onError(i - 1, "BAD_DQ_ESCAPE", `Invalid escape sequence ${raw}`);
            res += raw;
          }
        } else if (ch === " " || ch === "	") {
          const wsStart = i;
          let next = source[i + 1];
          while (next === " " || next === "	")
            next = source[++i + 1];
          if (next !== "\n" && !(next === "\r" && source[i + 2] === "\n"))
            res += i > wsStart ? source.slice(wsStart, i + 1) : ch;
        } else {
          res += ch;
        }
      }
      if (source[source.length - 1] !== '"' || source.length === 1)
        onError(source.length, "MISSING_CHAR", 'Missing closing "quote');
      return res;
    }
    function foldNewline(source, offset) {
      let fold = "";
      let ch = source[offset + 1];
      while (ch === " " || ch === "	" || ch === "\n" || ch === "\r") {
        if (ch === "\r" && source[offset + 2] !== "\n")
          break;
        if (ch === "\n")
          fold += "\n";
        offset += 1;
        ch = source[offset + 1];
      }
      if (!fold)
        fold = " ";
      return { fold, offset };
    }
    var escapeCodes = {
      "0": "\0",
      // null character
      a: "\x07",
      // bell character
      b: "\b",
      // backspace
      e: "\x1B",
      // escape character
      f: "\f",
      // form feed
      n: "\n",
      // line feed
      r: "\r",
      // carriage return
      t: "	",
      // horizontal tab
      v: "\v",
      // vertical tab
      N: "\x85",
      // Unicode next line
      _: "\xA0",
      // Unicode non-breaking space
      L: "\u2028",
      // Unicode line separator
      P: "\u2029",
      // Unicode paragraph separator
      " ": " ",
      '"': '"',
      "/": "/",
      "\\": "\\",
      "	": "	"
    };
    function parseCharCode(source, offset, length, onError) {
      const cc = source.substr(offset, length);
      const ok = cc.length === length && /^[0-9a-fA-F]+$/.test(cc);
      const code = ok ? parseInt(cc, 16) : NaN;
      try {
        return String.fromCodePoint(code);
      } catch {
        const raw = source.substr(offset - 2, length + 2);
        onError(offset - 2, "BAD_DQ_ESCAPE", `Invalid escape sequence ${raw}`);
        return raw;
      }
    }
    exports2.resolveFlowScalar = resolveFlowScalar;
  }
});

// node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/compose/compose-scalar.js
var require_compose_scalar = __commonJS({
  "node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/compose/compose-scalar.js"(exports2) {
    "use strict";
    var identity = require_identity();
    var Scalar = require_Scalar();
    var resolveBlockScalar = require_resolve_block_scalar();
    var resolveFlowScalar = require_resolve_flow_scalar();
    function composeScalar(ctx, token, tagToken, onError) {
      const { value, type, comment, range } = token.type === "block-scalar" ? resolveBlockScalar.resolveBlockScalar(ctx, token, onError) : resolveFlowScalar.resolveFlowScalar(token, ctx.options.strict, onError);
      const tagName = tagToken ? ctx.directives.tagName(tagToken.source, (msg) => onError(tagToken, "TAG_RESOLVE_FAILED", msg)) : null;
      let tag;
      if (ctx.options.stringKeys && ctx.atKey) {
        tag = ctx.schema[identity.SCALAR];
      } else if (tagName)
        tag = findScalarTagByName(ctx.schema, value, tagName, tagToken, onError);
      else if (token.type === "scalar")
        tag = findScalarTagByTest(ctx, value, token, onError);
      else
        tag = ctx.schema[identity.SCALAR];
      let scalar;
      try {
        const res = tag.resolve(value, (msg) => onError(tagToken ?? token, "TAG_RESOLVE_FAILED", msg), ctx.options);
        scalar = identity.isScalar(res) ? res : new Scalar.Scalar(res);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        onError(tagToken ?? token, "TAG_RESOLVE_FAILED", msg);
        scalar = new Scalar.Scalar(value);
      }
      scalar.range = range;
      scalar.source = value;
      if (type)
        scalar.type = type;
      if (tagName)
        scalar.tag = tagName;
      if (tag.format)
        scalar.format = tag.format;
      if (comment)
        scalar.comment = comment;
      return scalar;
    }
    function findScalarTagByName(schema, value, tagName, tagToken, onError) {
      if (tagName === "!")
        return schema[identity.SCALAR];
      const matchWithTest = [];
      for (const tag of schema.tags) {
        if (!tag.collection && tag.tag === tagName) {
          if (tag.default && tag.test)
            matchWithTest.push(tag);
          else
            return tag;
        }
      }
      for (const tag of matchWithTest)
        if (tag.test?.test(value))
          return tag;
      const kt = schema.knownTags[tagName];
      if (kt && !kt.collection) {
        schema.tags.push(Object.assign({}, kt, { default: false, test: void 0 }));
        return kt;
      }
      onError(tagToken, "TAG_RESOLVE_FAILED", `Unresolved tag: ${tagName}`, tagName !== "tag:yaml.org,2002:str");
      return schema[identity.SCALAR];
    }
    function findScalarTagByTest({ atKey, directives, schema }, value, token, onError) {
      const tag = schema.tags.find((tag2) => (tag2.default === true || atKey && tag2.default === "key") && tag2.test?.test(value)) || schema[identity.SCALAR];
      if (schema.compat) {
        const compat = schema.compat.find((tag2) => tag2.default && tag2.test?.test(value)) ?? schema[identity.SCALAR];
        if (tag.tag !== compat.tag) {
          const ts = directives.tagString(tag.tag);
          const cs = directives.tagString(compat.tag);
          const msg = `Value may be parsed as either ${ts} or ${cs}`;
          onError(token, "TAG_RESOLVE_FAILED", msg, true);
        }
      }
      return tag;
    }
    exports2.composeScalar = composeScalar;
  }
});

// node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/compose/util-empty-scalar-position.js
var require_util_empty_scalar_position = __commonJS({
  "node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/compose/util-empty-scalar-position.js"(exports2) {
    "use strict";
    function emptyScalarPosition(offset, before, pos) {
      if (before) {
        pos ?? (pos = before.length);
        for (let i = pos - 1; i >= 0; --i) {
          let st = before[i];
          switch (st.type) {
            case "space":
            case "comment":
            case "newline":
              offset -= st.source.length;
              continue;
          }
          st = before[++i];
          while (st?.type === "space") {
            offset += st.source.length;
            st = before[++i];
          }
          break;
        }
      }
      return offset;
    }
    exports2.emptyScalarPosition = emptyScalarPosition;
  }
});

// node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/compose/compose-node.js
var require_compose_node = __commonJS({
  "node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/compose/compose-node.js"(exports2) {
    "use strict";
    var Alias = require_Alias();
    var identity = require_identity();
    var composeCollection = require_compose_collection();
    var composeScalar = require_compose_scalar();
    var resolveEnd = require_resolve_end();
    var utilEmptyScalarPosition = require_util_empty_scalar_position();
    var CN = { composeNode, composeEmptyNode };
    function composeNode(ctx, token, props, onError) {
      const atKey = ctx.atKey;
      const { spaceBefore, comment, anchor, tag } = props;
      let node;
      let isSrcToken = true;
      switch (token.type) {
        case "alias":
          node = composeAlias(ctx, token, onError);
          if (anchor || tag)
            onError(token, "ALIAS_PROPS", "An alias node must not specify any properties");
          break;
        case "scalar":
        case "single-quoted-scalar":
        case "double-quoted-scalar":
        case "block-scalar":
          node = composeScalar.composeScalar(ctx, token, tag, onError);
          if (anchor)
            node.anchor = anchor.source.substring(1);
          break;
        case "block-map":
        case "block-seq":
        case "flow-collection":
          try {
            node = composeCollection.composeCollection(CN, ctx, token, props, onError);
            if (anchor)
              node.anchor = anchor.source.substring(1);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            onError(token, "RESOURCE_EXHAUSTION", message);
          }
          break;
        default: {
          const message = token.type === "error" ? token.message : `Unsupported token (type: ${token.type})`;
          onError(token, "UNEXPECTED_TOKEN", message);
          isSrcToken = false;
        }
      }
      node ?? (node = composeEmptyNode(ctx, token.offset, void 0, null, props, onError));
      if (anchor && node.anchor === "")
        onError(anchor, "BAD_ALIAS", "Anchor cannot be an empty string");
      if (atKey && ctx.options.stringKeys && (!identity.isScalar(node) || typeof node.value !== "string" || node.tag && node.tag !== "tag:yaml.org,2002:str")) {
        const msg = "With stringKeys, all keys must be strings";
        onError(tag ?? token, "NON_STRING_KEY", msg);
      }
      if (spaceBefore)
        node.spaceBefore = true;
      if (comment) {
        if (token.type === "scalar" && token.source === "")
          node.comment = comment;
        else
          node.commentBefore = comment;
      }
      if (ctx.options.keepSourceTokens && isSrcToken)
        node.srcToken = token;
      return node;
    }
    function composeEmptyNode(ctx, offset, before, pos, { spaceBefore, comment, anchor, tag, end }, onError) {
      const token = {
        type: "scalar",
        offset: utilEmptyScalarPosition.emptyScalarPosition(offset, before, pos),
        indent: -1,
        source: ""
      };
      const node = composeScalar.composeScalar(ctx, token, tag, onError);
      if (anchor) {
        node.anchor = anchor.source.substring(1);
        if (node.anchor === "")
          onError(anchor, "BAD_ALIAS", "Anchor cannot be an empty string");
      }
      if (spaceBefore)
        node.spaceBefore = true;
      if (comment) {
        node.comment = comment;
        node.range[2] = end;
      }
      return node;
    }
    function composeAlias({ options }, { offset, source, end }, onError) {
      const alias = new Alias.Alias(source.substring(1));
      if (alias.source === "")
        onError(offset, "BAD_ALIAS", "Alias cannot be an empty string");
      if (alias.source.endsWith(":"))
        onError(offset + source.length - 1, "BAD_ALIAS", "Alias ending in : is ambiguous", true);
      const valueEnd = offset + source.length;
      const re = resolveEnd.resolveEnd(end, valueEnd, options.strict, onError);
      alias.range = [offset, valueEnd, re.offset];
      if (re.comment)
        alias.comment = re.comment;
      return alias;
    }
    exports2.composeEmptyNode = composeEmptyNode;
    exports2.composeNode = composeNode;
  }
});

// node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/compose/compose-doc.js
var require_compose_doc = __commonJS({
  "node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/compose/compose-doc.js"(exports2) {
    "use strict";
    var Document = require_Document();
    var composeNode = require_compose_node();
    var resolveEnd = require_resolve_end();
    var resolveProps = require_resolve_props();
    function composeDoc(options, directives, { offset, start, value, end }, onError) {
      const opts = Object.assign({ _directives: directives }, options);
      const doc = new Document.Document(void 0, opts);
      const ctx = {
        atKey: false,
        atRoot: true,
        directives: doc.directives,
        options: doc.options,
        schema: doc.schema
      };
      const props = resolveProps.resolveProps(start, {
        indicator: "doc-start",
        next: value ?? end?.[0],
        offset,
        onError,
        parentIndent: 0,
        startOnNewline: true
      });
      if (props.found) {
        doc.directives.docStart = true;
        if (value && (value.type === "block-map" || value.type === "block-seq") && !props.hasNewline)
          onError(props.end, "MISSING_CHAR", "Block collection cannot start on same line with directives-end marker");
      }
      doc.contents = value ? composeNode.composeNode(ctx, value, props, onError) : composeNode.composeEmptyNode(ctx, props.end, start, null, props, onError);
      const contentEnd = doc.contents.range[2];
      const re = resolveEnd.resolveEnd(end, contentEnd, false, onError);
      if (re.comment)
        doc.comment = re.comment;
      doc.range = [offset, contentEnd, re.offset];
      return doc;
    }
    exports2.composeDoc = composeDoc;
  }
});

// node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/compose/composer.js
var require_composer = __commonJS({
  "node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/compose/composer.js"(exports2) {
    "use strict";
    var node_process = require("process");
    var directives = require_directives();
    var Document = require_Document();
    var errors = require_errors();
    var identity = require_identity();
    var composeDoc = require_compose_doc();
    var resolveEnd = require_resolve_end();
    function getErrorPos(src) {
      if (typeof src === "number")
        return [src, src + 1];
      if (Array.isArray(src))
        return src.length === 2 ? src : [src[0], src[1]];
      const { offset, source } = src;
      return [offset, offset + (typeof source === "string" ? source.length : 1)];
    }
    function parsePrelude(prelude) {
      let comment = "";
      let atComment = false;
      let afterEmptyLine = false;
      for (let i = 0; i < prelude.length; ++i) {
        const source = prelude[i];
        switch (source[0]) {
          case "#":
            comment += (comment === "" ? "" : afterEmptyLine ? "\n\n" : "\n") + (source.substring(1) || " ");
            atComment = true;
            afterEmptyLine = false;
            break;
          case "%":
            if (prelude[i + 1]?.[0] !== "#")
              i += 1;
            atComment = false;
            break;
          default:
            if (!atComment)
              afterEmptyLine = true;
            atComment = false;
        }
      }
      return { comment, afterEmptyLine };
    }
    var Composer = class {
      constructor(options = {}) {
        this.doc = null;
        this.atDirectives = false;
        this.prelude = [];
        this.errors = [];
        this.warnings = [];
        this.onError = (source, code, message, warning) => {
          const pos = getErrorPos(source);
          if (warning)
            this.warnings.push(new errors.YAMLWarning(pos, code, message));
          else
            this.errors.push(new errors.YAMLParseError(pos, code, message));
        };
        this.directives = new directives.Directives({ version: options.version || "1.2" });
        this.options = options;
      }
      decorate(doc, afterDoc) {
        const { comment, afterEmptyLine } = parsePrelude(this.prelude);
        if (comment) {
          const dc = doc.contents;
          if (afterDoc) {
            doc.comment = doc.comment ? `${doc.comment}
${comment}` : comment;
          } else if (afterEmptyLine || doc.directives.docStart || !dc) {
            doc.commentBefore = comment;
          } else if (identity.isCollection(dc) && !dc.flow && dc.items.length > 0) {
            let it = dc.items[0];
            if (identity.isPair(it))
              it = it.key;
            const cb = it.commentBefore;
            it.commentBefore = cb ? `${comment}
${cb}` : comment;
          } else {
            const cb = dc.commentBefore;
            dc.commentBefore = cb ? `${comment}
${cb}` : comment;
          }
        }
        if (afterDoc) {
          for (let i = 0; i < this.errors.length; ++i)
            doc.errors.push(this.errors[i]);
          for (let i = 0; i < this.warnings.length; ++i)
            doc.warnings.push(this.warnings[i]);
        } else {
          doc.errors = this.errors;
          doc.warnings = this.warnings;
        }
        this.prelude = [];
        this.errors = [];
        this.warnings = [];
      }
      /**
       * Current stream status information.
       *
       * Mostly useful at the end of input for an empty stream.
       */
      streamInfo() {
        return {
          comment: parsePrelude(this.prelude).comment,
          directives: this.directives,
          errors: this.errors,
          warnings: this.warnings
        };
      }
      /**
       * Compose tokens into documents.
       *
       * @param forceDoc - If the stream contains no document, still emit a final document including any comments and directives that would be applied to a subsequent document.
       * @param endOffset - Should be set if `forceDoc` is also set, to set the document range end and to indicate errors correctly.
       */
      *compose(tokens, forceDoc = false, endOffset = -1) {
        for (const token of tokens)
          yield* this.next(token);
        yield* this.end(forceDoc, endOffset);
      }
      /** Advance the composer by one CST token. */
      *next(token) {
        if (node_process.env.LOG_STREAM)
          console.dir(token, { depth: null });
        switch (token.type) {
          case "directive":
            this.directives.add(token.source, (offset, message, warning) => {
              const pos = getErrorPos(token);
              pos[0] += offset;
              this.onError(pos, "BAD_DIRECTIVE", message, warning);
            });
            this.prelude.push(token.source);
            this.atDirectives = true;
            break;
          case "document": {
            const doc = composeDoc.composeDoc(this.options, this.directives, token, this.onError);
            if (this.atDirectives && !doc.directives.docStart)
              this.onError(token, "MISSING_CHAR", "Missing directives-end/doc-start indicator line");
            this.decorate(doc, false);
            if (this.doc)
              yield this.doc;
            this.doc = doc;
            this.atDirectives = false;
            break;
          }
          case "byte-order-mark":
          case "space":
            break;
          case "comment":
          case "newline":
            this.prelude.push(token.source);
            break;
          case "error": {
            const msg = token.source ? `${token.message}: ${JSON.stringify(token.source)}` : token.message;
            const error = new errors.YAMLParseError(getErrorPos(token), "UNEXPECTED_TOKEN", msg);
            if (this.atDirectives || !this.doc)
              this.errors.push(error);
            else
              this.doc.errors.push(error);
            break;
          }
          case "doc-end": {
            if (!this.doc) {
              const msg = "Unexpected doc-end without preceding document";
              this.errors.push(new errors.YAMLParseError(getErrorPos(token), "UNEXPECTED_TOKEN", msg));
              break;
            }
            this.doc.directives.docEnd = true;
            const end = resolveEnd.resolveEnd(token.end, token.offset + token.source.length, this.doc.options.strict, this.onError);
            this.decorate(this.doc, true);
            if (end.comment) {
              const dc = this.doc.comment;
              this.doc.comment = dc ? `${dc}
${end.comment}` : end.comment;
            }
            this.doc.range[2] = end.offset;
            break;
          }
          default:
            this.errors.push(new errors.YAMLParseError(getErrorPos(token), "UNEXPECTED_TOKEN", `Unsupported token ${token.type}`));
        }
      }
      /**
       * Call at end of input to yield any remaining document.
       *
       * @param forceDoc - If the stream contains no document, still emit a final document including any comments and directives that would be applied to a subsequent document.
       * @param endOffset - Should be set if `forceDoc` is also set, to set the document range end and to indicate errors correctly.
       */
      *end(forceDoc = false, endOffset = -1) {
        if (this.doc) {
          this.decorate(this.doc, true);
          yield this.doc;
          this.doc = null;
        } else if (forceDoc) {
          const opts = Object.assign({ _directives: this.directives }, this.options);
          const doc = new Document.Document(void 0, opts);
          if (this.atDirectives)
            this.onError(endOffset, "MISSING_CHAR", "Missing directives-end indicator line");
          doc.range = [0, endOffset, endOffset];
          this.decorate(doc, false);
          yield doc;
        }
      }
    };
    exports2.Composer = Composer;
  }
});

// node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/parse/cst-scalar.js
var require_cst_scalar = __commonJS({
  "node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/parse/cst-scalar.js"(exports2) {
    "use strict";
    var resolveBlockScalar = require_resolve_block_scalar();
    var resolveFlowScalar = require_resolve_flow_scalar();
    var errors = require_errors();
    var stringifyString = require_stringifyString();
    function resolveAsScalar(token, strict = true, onError) {
      if (token) {
        const _onError = (pos, code, message) => {
          const offset = typeof pos === "number" ? pos : Array.isArray(pos) ? pos[0] : pos.offset;
          if (onError)
            onError(offset, code, message);
          else
            throw new errors.YAMLParseError([offset, offset + 1], code, message);
        };
        switch (token.type) {
          case "scalar":
          case "single-quoted-scalar":
          case "double-quoted-scalar":
            return resolveFlowScalar.resolveFlowScalar(token, strict, _onError);
          case "block-scalar":
            return resolveBlockScalar.resolveBlockScalar({ options: { strict } }, token, _onError);
        }
      }
      return null;
    }
    function createScalarToken(value, context) {
      const { implicitKey = false, indent, inFlow = false, offset = -1, type = "PLAIN" } = context;
      const source = stringifyString.stringifyString({ type, value }, {
        implicitKey,
        indent: indent > 0 ? " ".repeat(indent) : "",
        inFlow,
        options: { blockQuote: true, lineWidth: -1 }
      });
      const end = context.end ?? [
        { type: "newline", offset: -1, indent, source: "\n" }
      ];
      switch (source[0]) {
        case "|":
        case ">": {
          const he = source.indexOf("\n");
          const head = source.substring(0, he);
          const body = source.substring(he + 1) + "\n";
          const props = [
            { type: "block-scalar-header", offset, indent, source: head }
          ];
          if (!addEndtoBlockProps(props, end))
            props.push({ type: "newline", offset: -1, indent, source: "\n" });
          return { type: "block-scalar", offset, indent, props, source: body };
        }
        case '"':
          return { type: "double-quoted-scalar", offset, indent, source, end };
        case "'":
          return { type: "single-quoted-scalar", offset, indent, source, end };
        default:
          return { type: "scalar", offset, indent, source, end };
      }
    }
    function setScalarValue(token, value, context = {}) {
      let { afterKey = false, implicitKey = false, inFlow = false, type } = context;
      let indent = "indent" in token ? token.indent : null;
      if (afterKey && typeof indent === "number")
        indent += 2;
      if (!type)
        switch (token.type) {
          case "single-quoted-scalar":
            type = "QUOTE_SINGLE";
            break;
          case "double-quoted-scalar":
            type = "QUOTE_DOUBLE";
            break;
          case "block-scalar": {
            const header = token.props[0];
            if (header.type !== "block-scalar-header")
              throw new Error("Invalid block scalar header");
            type = header.source[0] === ">" ? "BLOCK_FOLDED" : "BLOCK_LITERAL";
            break;
          }
          default:
            type = "PLAIN";
        }
      const source = stringifyString.stringifyString({ type, value }, {
        implicitKey: implicitKey || indent === null,
        indent: indent !== null && indent > 0 ? " ".repeat(indent) : "",
        inFlow,
        options: { blockQuote: true, lineWidth: -1 }
      });
      switch (source[0]) {
        case "|":
        case ">":
          setBlockScalarValue(token, source);
          break;
        case '"':
          setFlowScalarValue(token, source, "double-quoted-scalar");
          break;
        case "'":
          setFlowScalarValue(token, source, "single-quoted-scalar");
          break;
        default:
          setFlowScalarValue(token, source, "scalar");
      }
    }
    function setBlockScalarValue(token, source) {
      const he = source.indexOf("\n");
      const head = source.substring(0, he);
      const body = source.substring(he + 1) + "\n";
      if (token.type === "block-scalar") {
        const header = token.props[0];
        if (header.type !== "block-scalar-header")
          throw new Error("Invalid block scalar header");
        header.source = head;
        token.source = body;
      } else {
        const { offset } = token;
        const indent = "indent" in token ? token.indent : -1;
        const props = [
          { type: "block-scalar-header", offset, indent, source: head }
        ];
        if (!addEndtoBlockProps(props, "end" in token ? token.end : void 0))
          props.push({ type: "newline", offset: -1, indent, source: "\n" });
        for (const key of Object.keys(token))
          if (key !== "type" && key !== "offset")
            delete token[key];
        Object.assign(token, { type: "block-scalar", indent, props, source: body });
      }
    }
    function addEndtoBlockProps(props, end) {
      if (end)
        for (const st of end)
          switch (st.type) {
            case "space":
            case "comment":
              props.push(st);
              break;
            case "newline":
              props.push(st);
              return true;
          }
      return false;
    }
    function setFlowScalarValue(token, source, type) {
      switch (token.type) {
        case "scalar":
        case "double-quoted-scalar":
        case "single-quoted-scalar":
          token.type = type;
          token.source = source;
          break;
        case "block-scalar": {
          const end = token.props.slice(1);
          let oa = source.length;
          if (token.props[0].type === "block-scalar-header")
            oa -= token.props[0].source.length;
          for (const tok of end)
            tok.offset += oa;
          delete token.props;
          Object.assign(token, { type, source, end });
          break;
        }
        case "block-map":
        case "block-seq": {
          const offset = token.offset + source.length;
          const nl = { type: "newline", offset, indent: token.indent, source: "\n" };
          delete token.items;
          Object.assign(token, { type, source, end: [nl] });
          break;
        }
        default: {
          const indent = "indent" in token ? token.indent : -1;
          const end = "end" in token && Array.isArray(token.end) ? token.end.filter((st) => st.type === "space" || st.type === "comment" || st.type === "newline") : [];
          for (const key of Object.keys(token))
            if (key !== "type" && key !== "offset")
              delete token[key];
          Object.assign(token, { type, indent, source, end });
        }
      }
    }
    exports2.createScalarToken = createScalarToken;
    exports2.resolveAsScalar = resolveAsScalar;
    exports2.setScalarValue = setScalarValue;
  }
});

// node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/parse/cst-stringify.js
var require_cst_stringify = __commonJS({
  "node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/parse/cst-stringify.js"(exports2) {
    "use strict";
    var stringify = (cst) => "type" in cst ? stringifyToken(cst) : stringifyItem(cst);
    function stringifyToken(token) {
      switch (token.type) {
        case "block-scalar": {
          let res = "";
          for (const tok of token.props)
            res += stringifyToken(tok);
          return res + token.source;
        }
        case "block-map":
        case "block-seq": {
          let res = "";
          for (const item of token.items)
            res += stringifyItem(item);
          return res;
        }
        case "flow-collection": {
          let res = token.start.source;
          for (const item of token.items)
            res += stringifyItem(item);
          for (const st of token.end)
            res += st.source;
          return res;
        }
        case "document": {
          let res = stringifyItem(token);
          if (token.end)
            for (const st of token.end)
              res += st.source;
          return res;
        }
        default: {
          let res = token.source;
          if ("end" in token && token.end)
            for (const st of token.end)
              res += st.source;
          return res;
        }
      }
    }
    function stringifyItem({ start, key, sep: sep2, value }) {
      let res = "";
      for (const st of start)
        res += st.source;
      if (key)
        res += stringifyToken(key);
      if (sep2)
        for (const st of sep2)
          res += st.source;
      if (value)
        res += stringifyToken(value);
      return res;
    }
    exports2.stringify = stringify;
  }
});

// node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/parse/cst-visit.js
var require_cst_visit = __commonJS({
  "node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/parse/cst-visit.js"(exports2) {
    "use strict";
    var BREAK = /* @__PURE__ */ Symbol("break visit");
    var SKIP = /* @__PURE__ */ Symbol("skip children");
    var REMOVE = /* @__PURE__ */ Symbol("remove item");
    function visit(cst, visitor) {
      if ("type" in cst && cst.type === "document")
        cst = { start: cst.start, value: cst.value };
      _visit(Object.freeze([]), cst, visitor);
    }
    visit.BREAK = BREAK;
    visit.SKIP = SKIP;
    visit.REMOVE = REMOVE;
    visit.itemAtPath = (cst, path) => {
      let item = cst;
      for (const [field, index] of path) {
        const tok = item?.[field];
        if (tok && "items" in tok) {
          item = tok.items[index];
        } else
          return void 0;
      }
      return item;
    };
    visit.parentCollection = (cst, path) => {
      const parent = visit.itemAtPath(cst, path.slice(0, -1));
      const field = path[path.length - 1][0];
      const coll = parent?.[field];
      if (coll && "items" in coll)
        return coll;
      throw new Error("Parent collection not found");
    };
    function _visit(path, item, visitor) {
      let ctrl = visitor(item, path);
      if (typeof ctrl === "symbol")
        return ctrl;
      for (const field of ["key", "value"]) {
        const token = item[field];
        if (token && "items" in token) {
          for (let i = 0; i < token.items.length; ++i) {
            const ci = _visit(Object.freeze(path.concat([[field, i]])), token.items[i], visitor);
            if (typeof ci === "number")
              i = ci - 1;
            else if (ci === BREAK)
              return BREAK;
            else if (ci === REMOVE) {
              token.items.splice(i, 1);
              i -= 1;
            }
          }
          if (typeof ctrl === "function" && field === "key")
            ctrl = ctrl(item, path);
        }
      }
      return typeof ctrl === "function" ? ctrl(item, path) : ctrl;
    }
    exports2.visit = visit;
  }
});

// node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/parse/cst.js
var require_cst = __commonJS({
  "node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/parse/cst.js"(exports2) {
    "use strict";
    var cstScalar = require_cst_scalar();
    var cstStringify = require_cst_stringify();
    var cstVisit = require_cst_visit();
    var BOM = "\uFEFF";
    var DOCUMENT = "";
    var FLOW_END = "";
    var SCALAR = "";
    var isCollection = (token) => !!token && "items" in token;
    var isScalar = (token) => !!token && (token.type === "scalar" || token.type === "single-quoted-scalar" || token.type === "double-quoted-scalar" || token.type === "block-scalar");
    function prettyToken(token) {
      switch (token) {
        case BOM:
          return "<BOM>";
        case DOCUMENT:
          return "<DOC>";
        case FLOW_END:
          return "<FLOW_END>";
        case SCALAR:
          return "<SCALAR>";
        default:
          return JSON.stringify(token);
      }
    }
    function tokenType(source) {
      switch (source) {
        case BOM:
          return "byte-order-mark";
        case DOCUMENT:
          return "doc-mode";
        case FLOW_END:
          return "flow-error-end";
        case SCALAR:
          return "scalar";
        case "---":
          return "doc-start";
        case "...":
          return "doc-end";
        case "":
        case "\n":
        case "\r\n":
          return "newline";
        case "-":
          return "seq-item-ind";
        case "?":
          return "explicit-key-ind";
        case ":":
          return "map-value-ind";
        case "{":
          return "flow-map-start";
        case "}":
          return "flow-map-end";
        case "[":
          return "flow-seq-start";
        case "]":
          return "flow-seq-end";
        case ",":
          return "comma";
      }
      switch (source[0]) {
        case " ":
        case "	":
          return "space";
        case "#":
          return "comment";
        case "%":
          return "directive-line";
        case "*":
          return "alias";
        case "&":
          return "anchor";
        case "!":
          return "tag";
        case "'":
          return "single-quoted-scalar";
        case '"':
          return "double-quoted-scalar";
        case "|":
        case ">":
          return "block-scalar-header";
      }
      return null;
    }
    exports2.createScalarToken = cstScalar.createScalarToken;
    exports2.resolveAsScalar = cstScalar.resolveAsScalar;
    exports2.setScalarValue = cstScalar.setScalarValue;
    exports2.stringify = cstStringify.stringify;
    exports2.visit = cstVisit.visit;
    exports2.BOM = BOM;
    exports2.DOCUMENT = DOCUMENT;
    exports2.FLOW_END = FLOW_END;
    exports2.SCALAR = SCALAR;
    exports2.isCollection = isCollection;
    exports2.isScalar = isScalar;
    exports2.prettyToken = prettyToken;
    exports2.tokenType = tokenType;
  }
});

// node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/parse/lexer.js
var require_lexer = __commonJS({
  "node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/parse/lexer.js"(exports2) {
    "use strict";
    var cst = require_cst();
    function isEmpty(ch) {
      switch (ch) {
        case void 0:
        case " ":
        case "\n":
        case "\r":
        case "	":
          return true;
        default:
          return false;
      }
    }
    var hexDigits = new Set("0123456789ABCDEFabcdef");
    var tagChars = new Set("0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-#;/?:@&=+$_.!~*'()");
    var flowIndicatorChars = new Set(",[]{}");
    var invalidAnchorChars = new Set(" ,[]{}\n\r	");
    var isNotAnchorChar = (ch) => !ch || invalidAnchorChars.has(ch);
    var Lexer = class {
      constructor() {
        this.atEnd = false;
        this.blockScalarIndent = -1;
        this.blockScalarKeep = false;
        this.buffer = "";
        this.flowKey = false;
        this.flowLevel = 0;
        this.indentNext = 0;
        this.indentValue = 0;
        this.lineEndPos = null;
        this.next = null;
        this.pos = 0;
      }
      /**
       * Generate YAML tokens from the `source` string. If `incomplete`,
       * a part of the last line may be left as a buffer for the next call.
       *
       * @returns A generator of lexical tokens
       */
      *lex(source, incomplete = false) {
        if (source) {
          if (typeof source !== "string")
            throw TypeError("source is not a string");
          this.buffer = this.buffer ? this.buffer + source : source;
          this.lineEndPos = null;
        }
        this.atEnd = !incomplete;
        let next = this.next ?? "stream";
        while (next && (incomplete || this.hasChars(1)))
          next = yield* this.parseNext(next);
      }
      atLineEnd() {
        let i = this.pos;
        let ch = this.buffer[i];
        while (ch === " " || ch === "	")
          ch = this.buffer[++i];
        if (!ch || ch === "#" || ch === "\n")
          return true;
        if (ch === "\r")
          return this.buffer[i + 1] === "\n";
        return false;
      }
      charAt(n) {
        return this.buffer[this.pos + n];
      }
      continueScalar(offset) {
        let ch = this.buffer[offset];
        if (this.indentNext > 0) {
          let indent = 0;
          while (ch === " ")
            ch = this.buffer[++indent + offset];
          if (ch === "\r") {
            const next = this.buffer[indent + offset + 1];
            if (next === "\n" || !next && !this.atEnd)
              return offset + indent + 1;
          }
          return ch === "\n" || indent >= this.indentNext || !ch && !this.atEnd ? offset + indent : -1;
        }
        if (ch === "-" || ch === ".") {
          const dt = this.buffer.substr(offset, 3);
          if ((dt === "---" || dt === "...") && isEmpty(this.buffer[offset + 3]))
            return -1;
        }
        return offset;
      }
      getLine() {
        let end = this.lineEndPos;
        if (typeof end !== "number" || end !== -1 && end < this.pos) {
          end = this.buffer.indexOf("\n", this.pos);
          this.lineEndPos = end;
        }
        if (end === -1)
          return this.atEnd ? this.buffer.substring(this.pos) : null;
        if (this.buffer[end - 1] === "\r")
          end -= 1;
        return this.buffer.substring(this.pos, end);
      }
      hasChars(n) {
        return this.pos + n <= this.buffer.length;
      }
      setNext(state) {
        this.buffer = this.buffer.substring(this.pos);
        this.pos = 0;
        this.lineEndPos = null;
        this.next = state;
        return null;
      }
      peek(n) {
        return this.buffer.substr(this.pos, n);
      }
      *parseNext(next) {
        switch (next) {
          case "stream":
            return yield* this.parseStream();
          case "line-start":
            return yield* this.parseLineStart();
          case "block-start":
            return yield* this.parseBlockStart();
          case "doc":
            return yield* this.parseDocument();
          case "flow":
            return yield* this.parseFlowCollection();
          case "quoted-scalar":
            return yield* this.parseQuotedScalar();
          case "block-scalar":
            return yield* this.parseBlockScalar();
          case "plain-scalar":
            return yield* this.parsePlainScalar();
        }
      }
      *parseStream() {
        let line = this.getLine();
        if (line === null)
          return this.setNext("stream");
        if (line[0] === cst.BOM) {
          yield* this.pushCount(1);
          line = line.substring(1);
        }
        if (line[0] === "%") {
          let dirEnd = line.length;
          let cs = line.indexOf("#");
          while (cs !== -1) {
            const ch = line[cs - 1];
            if (ch === " " || ch === "	") {
              dirEnd = cs - 1;
              break;
            } else {
              cs = line.indexOf("#", cs + 1);
            }
          }
          while (true) {
            const ch = line[dirEnd - 1];
            if (ch === " " || ch === "	")
              dirEnd -= 1;
            else
              break;
          }
          const n = (yield* this.pushCount(dirEnd)) + (yield* this.pushSpaces(true));
          yield* this.pushCount(line.length - n);
          this.pushNewline();
          return "stream";
        }
        if (this.atLineEnd()) {
          const sp = yield* this.pushSpaces(true);
          yield* this.pushCount(line.length - sp);
          yield* this.pushNewline();
          return "stream";
        }
        yield cst.DOCUMENT;
        return yield* this.parseLineStart();
      }
      *parseLineStart() {
        const ch = this.charAt(0);
        if (!ch && !this.atEnd)
          return this.setNext("line-start");
        if (ch === "-" || ch === ".") {
          if (!this.atEnd && !this.hasChars(4))
            return this.setNext("line-start");
          const s = this.peek(3);
          if ((s === "---" || s === "...") && isEmpty(this.charAt(3))) {
            yield* this.pushCount(3);
            this.indentValue = 0;
            this.indentNext = 0;
            return s === "---" ? "doc" : "stream";
          }
        }
        this.indentValue = yield* this.pushSpaces(false);
        if (this.indentNext > this.indentValue && !isEmpty(this.charAt(1)))
          this.indentNext = this.indentValue;
        return yield* this.parseBlockStart();
      }
      *parseBlockStart() {
        const [ch0, ch1] = this.peek(2);
        if (!ch1 && !this.atEnd)
          return this.setNext("block-start");
        if ((ch0 === "-" || ch0 === "?" || ch0 === ":") && isEmpty(ch1)) {
          const n = (yield* this.pushCount(1)) + (yield* this.pushSpaces(true));
          this.indentNext = this.indentValue + 1;
          this.indentValue += n;
          return "block-start";
        }
        return "doc";
      }
      *parseDocument() {
        yield* this.pushSpaces(true);
        const line = this.getLine();
        if (line === null)
          return this.setNext("doc");
        let n = yield* this.pushIndicators();
        switch (line[n]) {
          case "#":
            yield* this.pushCount(line.length - n);
          // fallthrough
          case void 0:
            yield* this.pushNewline();
            return yield* this.parseLineStart();
          case "{":
          case "[":
            yield* this.pushCount(1);
            this.flowKey = false;
            this.flowLevel = 1;
            return "flow";
          case "}":
          case "]":
            yield* this.pushCount(1);
            return "doc";
          case "*":
            yield* this.pushUntil(isNotAnchorChar);
            return "doc";
          case '"':
          case "'":
            return yield* this.parseQuotedScalar();
          case "|":
          case ">":
            n += yield* this.parseBlockScalarHeader();
            n += yield* this.pushSpaces(true);
            yield* this.pushCount(line.length - n);
            yield* this.pushNewline();
            return yield* this.parseBlockScalar();
          default:
            return yield* this.parsePlainScalar();
        }
      }
      *parseFlowCollection() {
        let nl, sp;
        let indent = -1;
        do {
          nl = yield* this.pushNewline();
          if (nl > 0) {
            sp = yield* this.pushSpaces(false);
            this.indentValue = indent = sp;
          } else {
            sp = 0;
          }
          sp += yield* this.pushSpaces(true);
        } while (nl + sp > 0);
        const line = this.getLine();
        if (line === null)
          return this.setNext("flow");
        if (indent !== -1 && indent < this.indentNext && line[0] !== "#" || indent === 0 && (line.startsWith("---") || line.startsWith("...")) && isEmpty(line[3])) {
          const atFlowEndMarker = indent === this.indentNext - 1 && this.flowLevel === 1 && (line[0] === "]" || line[0] === "}");
          if (!atFlowEndMarker) {
            this.flowLevel = 0;
            yield cst.FLOW_END;
            return yield* this.parseLineStart();
          }
        }
        let n = 0;
        while (line[n] === ",") {
          n += yield* this.pushCount(1);
          n += yield* this.pushSpaces(true);
          this.flowKey = false;
        }
        n += yield* this.pushIndicators();
        switch (line[n]) {
          case void 0:
            return "flow";
          case "#":
            yield* this.pushCount(line.length - n);
            return "flow";
          case "{":
          case "[":
            yield* this.pushCount(1);
            this.flowKey = false;
            this.flowLevel += 1;
            return "flow";
          case "}":
          case "]":
            yield* this.pushCount(1);
            this.flowKey = true;
            this.flowLevel -= 1;
            return this.flowLevel ? "flow" : "doc";
          case "*":
            yield* this.pushUntil(isNotAnchorChar);
            return "flow";
          case '"':
          case "'":
            this.flowKey = true;
            return yield* this.parseQuotedScalar();
          case ":": {
            const next = this.charAt(1);
            if (this.flowKey || isEmpty(next) || next === ",") {
              this.flowKey = false;
              yield* this.pushCount(1);
              yield* this.pushSpaces(true);
              return "flow";
            }
          }
          // fallthrough
          default:
            this.flowKey = false;
            return yield* this.parsePlainScalar();
        }
      }
      *parseQuotedScalar() {
        const quote = this.charAt(0);
        let end = this.buffer.indexOf(quote, this.pos + 1);
        if (quote === "'") {
          while (end !== -1 && this.buffer[end + 1] === "'")
            end = this.buffer.indexOf("'", end + 2);
        } else {
          while (end !== -1) {
            let n = 0;
            while (this.buffer[end - 1 - n] === "\\")
              n += 1;
            if (n % 2 === 0)
              break;
            end = this.buffer.indexOf('"', end + 1);
          }
        }
        const qb = this.buffer.substring(0, end);
        let nl = qb.indexOf("\n", this.pos);
        if (nl !== -1) {
          while (nl !== -1) {
            const cs = this.continueScalar(nl + 1);
            if (cs === -1)
              break;
            nl = qb.indexOf("\n", cs);
          }
          if (nl !== -1) {
            end = nl - (qb[nl - 1] === "\r" ? 2 : 1);
          }
        }
        if (end === -1) {
          if (!this.atEnd)
            return this.setNext("quoted-scalar");
          end = this.buffer.length;
        }
        yield* this.pushToIndex(end + 1, false);
        return this.flowLevel ? "flow" : "doc";
      }
      *parseBlockScalarHeader() {
        this.blockScalarIndent = -1;
        this.blockScalarKeep = false;
        let i = this.pos;
        while (true) {
          const ch = this.buffer[++i];
          if (ch === "+")
            this.blockScalarKeep = true;
          else if (ch > "0" && ch <= "9")
            this.blockScalarIndent = Number(ch) - 1;
          else if (ch !== "-")
            break;
        }
        return yield* this.pushUntil((ch) => isEmpty(ch) || ch === "#");
      }
      *parseBlockScalar() {
        let nl = this.pos - 1;
        let indent = 0;
        let ch;
        loop: for (let i2 = this.pos; ch = this.buffer[i2]; ++i2) {
          switch (ch) {
            case " ":
              indent += 1;
              break;
            case "\n":
              nl = i2;
              indent = 0;
              break;
            case "\r": {
              const next = this.buffer[i2 + 1];
              if (!next && !this.atEnd)
                return this.setNext("block-scalar");
              if (next === "\n")
                break;
            }
            // fallthrough
            default:
              break loop;
          }
        }
        if (!ch && !this.atEnd)
          return this.setNext("block-scalar");
        if (indent >= this.indentNext) {
          if (this.blockScalarIndent === -1)
            this.indentNext = indent;
          else {
            this.indentNext = this.blockScalarIndent + (this.indentNext === 0 ? 1 : this.indentNext);
          }
          do {
            const cs = this.continueScalar(nl + 1);
            if (cs === -1)
              break;
            nl = this.buffer.indexOf("\n", cs);
          } while (nl !== -1);
          if (nl === -1) {
            if (!this.atEnd)
              return this.setNext("block-scalar");
            nl = this.buffer.length;
          }
        }
        let i = nl + 1;
        ch = this.buffer[i];
        while (ch === " ")
          ch = this.buffer[++i];
        if (ch === "	") {
          while (ch === "	" || ch === " " || ch === "\r" || ch === "\n")
            ch = this.buffer[++i];
          nl = i - 1;
        } else if (!this.blockScalarKeep) {
          do {
            let i2 = nl - 1;
            let ch2 = this.buffer[i2];
            if (ch2 === "\r")
              ch2 = this.buffer[--i2];
            const lastChar = i2;
            while (ch2 === " ")
              ch2 = this.buffer[--i2];
            if (ch2 === "\n" && i2 >= this.pos && i2 + 1 + indent > lastChar)
              nl = i2;
            else
              break;
          } while (true);
        }
        yield cst.SCALAR;
        yield* this.pushToIndex(nl + 1, true);
        return yield* this.parseLineStart();
      }
      *parsePlainScalar() {
        const inFlow = this.flowLevel > 0;
        let end = this.pos - 1;
        let i = this.pos - 1;
        let ch;
        while (ch = this.buffer[++i]) {
          if (ch === ":") {
            const next = this.buffer[i + 1];
            if (isEmpty(next) || inFlow && flowIndicatorChars.has(next))
              break;
            end = i;
          } else if (isEmpty(ch)) {
            let next = this.buffer[i + 1];
            if (ch === "\r") {
              if (next === "\n") {
                i += 1;
                ch = "\n";
                next = this.buffer[i + 1];
              } else
                end = i;
            }
            if (next === "#" || inFlow && flowIndicatorChars.has(next))
              break;
            if (ch === "\n") {
              const cs = this.continueScalar(i + 1);
              if (cs === -1)
                break;
              i = Math.max(i, cs - 2);
            }
          } else {
            if (inFlow && flowIndicatorChars.has(ch))
              break;
            end = i;
          }
        }
        if (!ch && !this.atEnd)
          return this.setNext("plain-scalar");
        yield cst.SCALAR;
        yield* this.pushToIndex(end + 1, true);
        return inFlow ? "flow" : "doc";
      }
      *pushCount(n) {
        if (n > 0) {
          yield this.buffer.substr(this.pos, n);
          this.pos += n;
          return n;
        }
        return 0;
      }
      *pushToIndex(i, allowEmpty) {
        const s = this.buffer.slice(this.pos, i);
        if (s) {
          yield s;
          this.pos += s.length;
          return s.length;
        } else if (allowEmpty)
          yield "";
        return 0;
      }
      *pushIndicators() {
        let n = 0;
        loop: while (true) {
          switch (this.charAt(0)) {
            case "!":
              n += yield* this.pushTag();
              n += yield* this.pushSpaces(true);
              continue loop;
            case "&":
              n += yield* this.pushUntil(isNotAnchorChar);
              n += yield* this.pushSpaces(true);
              continue loop;
            case "-":
            // this is an error
            case "?":
            // this is an error outside flow collections
            case ":": {
              const inFlow = this.flowLevel > 0;
              const ch1 = this.charAt(1);
              if (isEmpty(ch1) || inFlow && flowIndicatorChars.has(ch1)) {
                if (!inFlow)
                  this.indentNext = this.indentValue + 1;
                else if (this.flowKey)
                  this.flowKey = false;
                n += yield* this.pushCount(1);
                n += yield* this.pushSpaces(true);
                continue loop;
              }
            }
          }
          break loop;
        }
        return n;
      }
      *pushTag() {
        if (this.charAt(1) === "<") {
          let i = this.pos + 2;
          let ch = this.buffer[i];
          while (!isEmpty(ch) && ch !== ">")
            ch = this.buffer[++i];
          return yield* this.pushToIndex(ch === ">" ? i + 1 : i, false);
        } else {
          let i = this.pos + 1;
          let ch = this.buffer[i];
          while (ch) {
            if (tagChars.has(ch))
              ch = this.buffer[++i];
            else if (ch === "%" && hexDigits.has(this.buffer[i + 1]) && hexDigits.has(this.buffer[i + 2])) {
              ch = this.buffer[i += 3];
            } else
              break;
          }
          return yield* this.pushToIndex(i, false);
        }
      }
      *pushNewline() {
        const ch = this.buffer[this.pos];
        if (ch === "\n")
          return yield* this.pushCount(1);
        else if (ch === "\r" && this.charAt(1) === "\n")
          return yield* this.pushCount(2);
        else
          return 0;
      }
      *pushSpaces(allowTabs) {
        let i = this.pos - 1;
        let ch;
        do {
          ch = this.buffer[++i];
        } while (ch === " " || allowTabs && ch === "	");
        const n = i - this.pos;
        if (n > 0) {
          yield this.buffer.substr(this.pos, n);
          this.pos = i;
        }
        return n;
      }
      *pushUntil(test) {
        let i = this.pos;
        let ch = this.buffer[i];
        while (!test(ch))
          ch = this.buffer[++i];
        return yield* this.pushToIndex(i, false);
      }
    };
    exports2.Lexer = Lexer;
  }
});

// node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/parse/line-counter.js
var require_line_counter = __commonJS({
  "node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/parse/line-counter.js"(exports2) {
    "use strict";
    var LineCounter = class {
      constructor() {
        this.lineStarts = [];
        this.addNewLine = (offset) => this.lineStarts.push(offset);
        this.linePos = (offset) => {
          let low = 0;
          let high = this.lineStarts.length;
          while (low < high) {
            const mid = low + high >> 1;
            if (this.lineStarts[mid] < offset)
              low = mid + 1;
            else
              high = mid;
          }
          if (this.lineStarts[low] === offset)
            return { line: low + 1, col: 1 };
          if (low === 0)
            return { line: 0, col: offset };
          const start = this.lineStarts[low - 1];
          return { line: low, col: offset - start + 1 };
        };
      }
    };
    exports2.LineCounter = LineCounter;
  }
});

// node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/parse/parser.js
var require_parser = __commonJS({
  "node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/parse/parser.js"(exports2) {
    "use strict";
    var node_process = require("process");
    var cst = require_cst();
    var lexer = require_lexer();
    function includesToken(list, type) {
      for (let i = 0; i < list.length; ++i)
        if (list[i].type === type)
          return true;
      return false;
    }
    function findNonEmptyIndex(list) {
      for (let i = 0; i < list.length; ++i) {
        switch (list[i].type) {
          case "space":
          case "comment":
          case "newline":
            break;
          default:
            return i;
        }
      }
      return -1;
    }
    function isFlowToken(token) {
      switch (token?.type) {
        case "alias":
        case "scalar":
        case "single-quoted-scalar":
        case "double-quoted-scalar":
        case "flow-collection":
          return true;
        default:
          return false;
      }
    }
    function getPrevProps(parent) {
      switch (parent.type) {
        case "document":
          return parent.start;
        case "block-map": {
          const it = parent.items[parent.items.length - 1];
          return it.sep ?? it.start;
        }
        case "block-seq":
          return parent.items[parent.items.length - 1].start;
        /* istanbul ignore next should not happen */
        default:
          return [];
      }
    }
    function getFirstKeyStartProps(prev) {
      if (prev.length === 0)
        return [];
      let i = prev.length;
      loop: while (--i >= 0) {
        switch (prev[i].type) {
          case "doc-start":
          case "explicit-key-ind":
          case "map-value-ind":
          case "seq-item-ind":
          case "newline":
            break loop;
        }
      }
      while (prev[++i]?.type === "space") {
      }
      return prev.splice(i, prev.length);
    }
    function arrayPushArray(target, source) {
      if (source.length < 1e5)
        Array.prototype.push.apply(target, source);
      else
        for (let i = 0; i < source.length; ++i)
          target.push(source[i]);
    }
    function fixFlowSeqItems(fc) {
      if (fc.start.type === "flow-seq-start") {
        for (const it of fc.items) {
          if (it.sep && !it.value && !includesToken(it.start, "explicit-key-ind") && !includesToken(it.sep, "map-value-ind")) {
            if (it.key)
              it.value = it.key;
            delete it.key;
            if (isFlowToken(it.value)) {
              if (it.value.end)
                arrayPushArray(it.value.end, it.sep);
              else
                it.value.end = it.sep;
            } else
              arrayPushArray(it.start, it.sep);
            delete it.sep;
          }
        }
      }
    }
    var Parser = class {
      /**
       * @param onNewLine - If defined, called separately with the start position of
       *   each new line (in `parse()`, including the start of input).
       */
      constructor(onNewLine) {
        this.atNewLine = true;
        this.atScalar = false;
        this.indent = 0;
        this.offset = 0;
        this.onKeyLine = false;
        this.stack = [];
        this.source = "";
        this.type = "";
        this.lexer = new lexer.Lexer();
        this.onNewLine = onNewLine;
      }
      /**
       * Parse `source` as a YAML stream.
       * If `incomplete`, a part of the last line may be left as a buffer for the next call.
       *
       * Errors are not thrown, but yielded as `{ type: 'error', message }` tokens.
       *
       * @returns A generator of tokens representing each directive, document, and other structure.
       */
      *parse(source, incomplete = false) {
        if (this.onNewLine && this.offset === 0)
          this.onNewLine(0);
        for (const lexeme of this.lexer.lex(source, incomplete))
          yield* this.next(lexeme);
        if (!incomplete)
          yield* this.end();
      }
      /**
       * Advance the parser by the `source` of one lexical token.
       */
      *next(source) {
        this.source = source;
        if (node_process.env.LOG_TOKENS)
          console.log("|", cst.prettyToken(source));
        if (this.atScalar) {
          this.atScalar = false;
          yield* this.step();
          this.offset += source.length;
          return;
        }
        const type = cst.tokenType(source);
        if (!type) {
          const message = `Not a YAML token: ${source}`;
          yield* this.pop({ type: "error", offset: this.offset, message, source });
          this.offset += source.length;
        } else if (type === "scalar") {
          this.atNewLine = false;
          this.atScalar = true;
          this.type = "scalar";
        } else {
          this.type = type;
          yield* this.step();
          switch (type) {
            case "newline":
              this.atNewLine = true;
              this.indent = 0;
              if (this.onNewLine)
                this.onNewLine(this.offset + source.length);
              break;
            case "space":
              if (this.atNewLine && source[0] === " ")
                this.indent += source.length;
              break;
            case "explicit-key-ind":
            case "map-value-ind":
            case "seq-item-ind":
              if (this.atNewLine)
                this.indent += source.length;
              break;
            case "doc-mode":
            case "flow-error-end":
              return;
            default:
              this.atNewLine = false;
          }
          this.offset += source.length;
        }
      }
      /** Call at end of input to push out any remaining constructions */
      *end() {
        while (this.stack.length > 0)
          yield* this.pop();
      }
      get sourceToken() {
        const st = {
          type: this.type,
          offset: this.offset,
          indent: this.indent,
          source: this.source
        };
        return st;
      }
      *step() {
        const top = this.peek(1);
        if (this.type === "doc-end" && top?.type !== "doc-end") {
          while (this.stack.length > 0)
            yield* this.pop();
          this.stack.push({
            type: "doc-end",
            offset: this.offset,
            source: this.source
          });
          return;
        }
        if (!top)
          return yield* this.stream();
        switch (top.type) {
          case "document":
            return yield* this.document(top);
          case "alias":
          case "scalar":
          case "single-quoted-scalar":
          case "double-quoted-scalar":
            return yield* this.scalar(top);
          case "block-scalar":
            return yield* this.blockScalar(top);
          case "block-map":
            return yield* this.blockMap(top);
          case "block-seq":
            return yield* this.blockSequence(top);
          case "flow-collection":
            return yield* this.flowCollection(top);
          case "doc-end":
            return yield* this.documentEnd(top);
        }
        yield* this.pop();
      }
      peek(n) {
        return this.stack[this.stack.length - n];
      }
      *pop(error) {
        const token = error ?? this.stack.pop();
        if (!token) {
          const message = "Tried to pop an empty stack";
          yield { type: "error", offset: this.offset, source: "", message };
        } else if (this.stack.length === 0) {
          yield token;
        } else {
          const top = this.peek(1);
          if (token.type === "block-scalar") {
            token.indent = "indent" in top ? top.indent : 0;
          } else if (token.type === "flow-collection" && top.type === "document") {
            token.indent = 0;
          }
          if (token.type === "flow-collection")
            fixFlowSeqItems(token);
          switch (top.type) {
            case "document":
              top.value = token;
              break;
            case "block-scalar":
              top.props.push(token);
              break;
            case "block-map": {
              const it = top.items[top.items.length - 1];
              if (it.value) {
                top.items.push({ start: [], key: token, sep: [] });
                this.onKeyLine = true;
                return;
              } else if (it.sep) {
                it.value = token;
              } else {
                Object.assign(it, { key: token, sep: [] });
                this.onKeyLine = !it.explicitKey;
                return;
              }
              break;
            }
            case "block-seq": {
              const it = top.items[top.items.length - 1];
              if (it.value)
                top.items.push({ start: [], value: token });
              else
                it.value = token;
              break;
            }
            case "flow-collection": {
              const it = top.items[top.items.length - 1];
              if (!it || it.value)
                top.items.push({ start: [], key: token, sep: [] });
              else if (it.sep)
                it.value = token;
              else
                Object.assign(it, { key: token, sep: [] });
              return;
            }
            /* istanbul ignore next should not happen */
            default:
              yield* this.pop();
              yield* this.pop(token);
          }
          if ((top.type === "document" || top.type === "block-map" || top.type === "block-seq") && (token.type === "block-map" || token.type === "block-seq")) {
            const last = token.items[token.items.length - 1];
            if (last && !last.sep && !last.value && last.start.length > 0 && findNonEmptyIndex(last.start) === -1 && (token.indent === 0 || last.start.every((st) => st.type !== "comment" || st.indent < token.indent))) {
              if (top.type === "document")
                top.end = last.start;
              else
                top.items.push({ start: last.start });
              token.items.splice(-1, 1);
            }
          }
        }
      }
      *stream() {
        switch (this.type) {
          case "directive-line":
            yield { type: "directive", offset: this.offset, source: this.source };
            return;
          case "byte-order-mark":
          case "space":
          case "comment":
          case "newline":
            yield this.sourceToken;
            return;
          case "doc-mode":
          case "doc-start": {
            const doc = {
              type: "document",
              offset: this.offset,
              start: []
            };
            if (this.type === "doc-start")
              doc.start.push(this.sourceToken);
            this.stack.push(doc);
            return;
          }
        }
        yield {
          type: "error",
          offset: this.offset,
          message: `Unexpected ${this.type} token in YAML stream`,
          source: this.source
        };
      }
      *document(doc) {
        if (doc.value)
          return yield* this.lineEnd(doc);
        switch (this.type) {
          case "doc-start": {
            if (findNonEmptyIndex(doc.start) !== -1) {
              yield* this.pop();
              yield* this.step();
            } else
              doc.start.push(this.sourceToken);
            return;
          }
          case "anchor":
          case "tag":
          case "space":
          case "comment":
          case "newline":
            doc.start.push(this.sourceToken);
            return;
        }
        const bv = this.startBlockValue(doc);
        if (bv)
          this.stack.push(bv);
        else {
          yield {
            type: "error",
            offset: this.offset,
            message: `Unexpected ${this.type} token in YAML document`,
            source: this.source
          };
        }
      }
      *scalar(scalar) {
        if (this.type === "map-value-ind") {
          const prev = getPrevProps(this.peek(2));
          const start = getFirstKeyStartProps(prev);
          let sep2;
          if (scalar.end) {
            sep2 = scalar.end;
            sep2.push(this.sourceToken);
            delete scalar.end;
          } else
            sep2 = [this.sourceToken];
          const map = {
            type: "block-map",
            offset: scalar.offset,
            indent: scalar.indent,
            items: [{ start, key: scalar, sep: sep2 }]
          };
          this.onKeyLine = true;
          this.stack[this.stack.length - 1] = map;
        } else
          yield* this.lineEnd(scalar);
      }
      *blockScalar(scalar) {
        switch (this.type) {
          case "space":
          case "comment":
          case "newline":
            scalar.props.push(this.sourceToken);
            return;
          case "scalar":
            scalar.source = this.source;
            this.atNewLine = true;
            this.indent = 0;
            if (this.onNewLine) {
              let nl = this.source.indexOf("\n") + 1;
              while (nl !== 0) {
                this.onNewLine(this.offset + nl);
                nl = this.source.indexOf("\n", nl) + 1;
              }
            }
            yield* this.pop();
            break;
          /* istanbul ignore next should not happen */
          default:
            yield* this.pop();
            yield* this.step();
        }
      }
      *blockMap(map) {
        const it = map.items[map.items.length - 1];
        switch (this.type) {
          case "newline":
            this.onKeyLine = false;
            if (it.value) {
              const end = "end" in it.value ? it.value.end : void 0;
              const last = Array.isArray(end) ? end[end.length - 1] : void 0;
              if (last?.type === "comment")
                end?.push(this.sourceToken);
              else
                map.items.push({ start: [this.sourceToken] });
            } else if (it.sep) {
              it.sep.push(this.sourceToken);
            } else {
              it.start.push(this.sourceToken);
            }
            return;
          case "space":
          case "comment":
            if (it.value) {
              map.items.push({ start: [this.sourceToken] });
            } else if (it.sep) {
              it.sep.push(this.sourceToken);
            } else {
              if (this.atIndentedComment(it.start, map.indent)) {
                const prev = map.items[map.items.length - 2];
                const end = prev?.value?.end;
                if (Array.isArray(end)) {
                  arrayPushArray(end, it.start);
                  end.push(this.sourceToken);
                  map.items.pop();
                  return;
                }
              }
              it.start.push(this.sourceToken);
            }
            return;
        }
        if (this.indent >= map.indent) {
          const atMapIndent = !this.onKeyLine && this.indent === map.indent;
          const atNextItem = atMapIndent && (it.sep || it.explicitKey) && this.type !== "seq-item-ind";
          let start = [];
          if (atNextItem && it.sep && !it.value) {
            const nl = [];
            for (let i = 0; i < it.sep.length; ++i) {
              const st = it.sep[i];
              switch (st.type) {
                case "newline":
                  nl.push(i);
                  break;
                case "space":
                  break;
                case "comment":
                  if (st.indent > map.indent)
                    nl.length = 0;
                  break;
                default:
                  nl.length = 0;
              }
            }
            if (nl.length >= 2)
              start = it.sep.splice(nl[1]);
          }
          switch (this.type) {
            case "anchor":
            case "tag":
              if (atNextItem || it.value) {
                start.push(this.sourceToken);
                map.items.push({ start });
                this.onKeyLine = true;
              } else if (it.sep) {
                it.sep.push(this.sourceToken);
              } else {
                it.start.push(this.sourceToken);
              }
              return;
            case "explicit-key-ind":
              if (!it.sep && !it.explicitKey) {
                it.start.push(this.sourceToken);
                it.explicitKey = true;
              } else if (atNextItem || it.value) {
                start.push(this.sourceToken);
                map.items.push({ start, explicitKey: true });
              } else {
                this.stack.push({
                  type: "block-map",
                  offset: this.offset,
                  indent: this.indent,
                  items: [{ start: [this.sourceToken], explicitKey: true }]
                });
              }
              this.onKeyLine = true;
              return;
            case "map-value-ind":
              if (it.explicitKey) {
                if (!it.sep) {
                  if (includesToken(it.start, "newline")) {
                    Object.assign(it, { key: null, sep: [this.sourceToken] });
                  } else {
                    const start2 = getFirstKeyStartProps(it.start);
                    this.stack.push({
                      type: "block-map",
                      offset: this.offset,
                      indent: this.indent,
                      items: [{ start: start2, key: null, sep: [this.sourceToken] }]
                    });
                  }
                } else if (it.value) {
                  map.items.push({ start: [], key: null, sep: [this.sourceToken] });
                } else if (includesToken(it.sep, "map-value-ind")) {
                  this.stack.push({
                    type: "block-map",
                    offset: this.offset,
                    indent: this.indent,
                    items: [{ start, key: null, sep: [this.sourceToken] }]
                  });
                } else if (isFlowToken(it.key) && !includesToken(it.sep, "newline")) {
                  const start2 = getFirstKeyStartProps(it.start);
                  const key = it.key;
                  const sep2 = it.sep;
                  sep2.push(this.sourceToken);
                  delete it.key;
                  delete it.sep;
                  this.stack.push({
                    type: "block-map",
                    offset: this.offset,
                    indent: this.indent,
                    items: [{ start: start2, key, sep: sep2 }]
                  });
                } else if (start.length > 0) {
                  it.sep = it.sep.concat(start, this.sourceToken);
                } else {
                  it.sep.push(this.sourceToken);
                }
              } else {
                if (!it.sep) {
                  Object.assign(it, { key: null, sep: [this.sourceToken] });
                } else if (it.value || atNextItem) {
                  map.items.push({ start, key: null, sep: [this.sourceToken] });
                } else if (includesToken(it.sep, "map-value-ind")) {
                  this.stack.push({
                    type: "block-map",
                    offset: this.offset,
                    indent: this.indent,
                    items: [{ start: [], key: null, sep: [this.sourceToken] }]
                  });
                } else {
                  it.sep.push(this.sourceToken);
                }
              }
              this.onKeyLine = true;
              return;
            case "alias":
            case "scalar":
            case "single-quoted-scalar":
            case "double-quoted-scalar": {
              const fs = this.flowScalar(this.type);
              if (atNextItem || it.value) {
                map.items.push({ start, key: fs, sep: [] });
                this.onKeyLine = true;
              } else if (it.sep) {
                this.stack.push(fs);
              } else {
                Object.assign(it, { key: fs, sep: [] });
                this.onKeyLine = true;
              }
              return;
            }
            default: {
              const bv = this.startBlockValue(map);
              if (bv) {
                if (bv.type === "block-seq") {
                  if (!it.explicitKey && it.sep && !includesToken(it.sep, "newline")) {
                    yield* this.pop({
                      type: "error",
                      offset: this.offset,
                      message: "Unexpected block-seq-ind on same line with key",
                      source: this.source
                    });
                    return;
                  }
                } else if (atMapIndent) {
                  map.items.push({ start });
                }
                this.stack.push(bv);
                return;
              }
            }
          }
        }
        yield* this.pop();
        yield* this.step();
      }
      *blockSequence(seq) {
        const it = seq.items[seq.items.length - 1];
        switch (this.type) {
          case "newline":
            if (it.value) {
              const end = "end" in it.value ? it.value.end : void 0;
              const last = Array.isArray(end) ? end[end.length - 1] : void 0;
              if (last?.type === "comment")
                end?.push(this.sourceToken);
              else
                seq.items.push({ start: [this.sourceToken] });
            } else
              it.start.push(this.sourceToken);
            return;
          case "space":
          case "comment":
            if (it.value)
              seq.items.push({ start: [this.sourceToken] });
            else {
              if (this.atIndentedComment(it.start, seq.indent)) {
                const prev = seq.items[seq.items.length - 2];
                const end = prev?.value?.end;
                if (Array.isArray(end)) {
                  arrayPushArray(end, it.start);
                  end.push(this.sourceToken);
                  seq.items.pop();
                  return;
                }
              }
              it.start.push(this.sourceToken);
            }
            return;
          case "anchor":
          case "tag":
            if (it.value || this.indent <= seq.indent)
              break;
            it.start.push(this.sourceToken);
            return;
          case "seq-item-ind":
            if (this.indent !== seq.indent)
              break;
            if (it.value || includesToken(it.start, "seq-item-ind"))
              seq.items.push({ start: [this.sourceToken] });
            else
              it.start.push(this.sourceToken);
            return;
        }
        if (this.indent > seq.indent) {
          const bv = this.startBlockValue(seq);
          if (bv) {
            this.stack.push(bv);
            return;
          }
        }
        yield* this.pop();
        yield* this.step();
      }
      *flowCollection(fc) {
        const it = fc.items[fc.items.length - 1];
        if (this.type === "flow-error-end") {
          let top;
          do {
            yield* this.pop();
            top = this.peek(1);
          } while (top?.type === "flow-collection");
        } else if (fc.end.length === 0) {
          switch (this.type) {
            case "comma":
            case "explicit-key-ind":
              if (!it || it.sep)
                fc.items.push({ start: [this.sourceToken] });
              else
                it.start.push(this.sourceToken);
              return;
            case "map-value-ind":
              if (!it || it.value)
                fc.items.push({ start: [], key: null, sep: [this.sourceToken] });
              else if (it.sep)
                it.sep.push(this.sourceToken);
              else
                Object.assign(it, { key: null, sep: [this.sourceToken] });
              return;
            case "space":
            case "comment":
            case "newline":
            case "anchor":
            case "tag":
              if (!it || it.value)
                fc.items.push({ start: [this.sourceToken] });
              else if (it.sep)
                it.sep.push(this.sourceToken);
              else
                it.start.push(this.sourceToken);
              return;
            case "alias":
            case "scalar":
            case "single-quoted-scalar":
            case "double-quoted-scalar": {
              const fs = this.flowScalar(this.type);
              if (!it || it.value)
                fc.items.push({ start: [], key: fs, sep: [] });
              else if (it.sep)
                this.stack.push(fs);
              else
                Object.assign(it, { key: fs, sep: [] });
              return;
            }
            case "flow-map-end":
            case "flow-seq-end":
              fc.end.push(this.sourceToken);
              return;
          }
          const bv = this.startBlockValue(fc);
          if (bv)
            this.stack.push(bv);
          else {
            yield* this.pop();
            yield* this.step();
          }
        } else {
          const parent = this.peek(2);
          if (parent.type === "block-map" && (this.type === "map-value-ind" && parent.indent === fc.indent || this.type === "newline" && !parent.items[parent.items.length - 1].sep)) {
            yield* this.pop();
            yield* this.step();
          } else if (this.type === "map-value-ind" && parent.type !== "flow-collection") {
            const prev = getPrevProps(parent);
            const start = getFirstKeyStartProps(prev);
            fixFlowSeqItems(fc);
            const sep2 = fc.end.splice(1, fc.end.length);
            sep2.push(this.sourceToken);
            const map = {
              type: "block-map",
              offset: fc.offset,
              indent: fc.indent,
              items: [{ start, key: fc, sep: sep2 }]
            };
            this.onKeyLine = true;
            this.stack[this.stack.length - 1] = map;
          } else {
            yield* this.lineEnd(fc);
          }
        }
      }
      flowScalar(type) {
        if (this.onNewLine) {
          let nl = this.source.indexOf("\n") + 1;
          while (nl !== 0) {
            this.onNewLine(this.offset + nl);
            nl = this.source.indexOf("\n", nl) + 1;
          }
        }
        return {
          type,
          offset: this.offset,
          indent: this.indent,
          source: this.source
        };
      }
      startBlockValue(parent) {
        switch (this.type) {
          case "alias":
          case "scalar":
          case "single-quoted-scalar":
          case "double-quoted-scalar":
            return this.flowScalar(this.type);
          case "block-scalar-header":
            return {
              type: "block-scalar",
              offset: this.offset,
              indent: this.indent,
              props: [this.sourceToken],
              source: ""
            };
          case "flow-map-start":
          case "flow-seq-start":
            return {
              type: "flow-collection",
              offset: this.offset,
              indent: this.indent,
              start: this.sourceToken,
              items: [],
              end: []
            };
          case "seq-item-ind":
            return {
              type: "block-seq",
              offset: this.offset,
              indent: this.indent,
              items: [{ start: [this.sourceToken] }]
            };
          case "explicit-key-ind": {
            this.onKeyLine = true;
            const prev = getPrevProps(parent);
            const start = getFirstKeyStartProps(prev);
            start.push(this.sourceToken);
            return {
              type: "block-map",
              offset: this.offset,
              indent: this.indent,
              items: [{ start, explicitKey: true }]
            };
          }
          case "map-value-ind": {
            this.onKeyLine = true;
            const prev = getPrevProps(parent);
            const start = getFirstKeyStartProps(prev);
            return {
              type: "block-map",
              offset: this.offset,
              indent: this.indent,
              items: [{ start, key: null, sep: [this.sourceToken] }]
            };
          }
        }
        return null;
      }
      atIndentedComment(start, indent) {
        if (this.type !== "comment")
          return false;
        if (this.indent <= indent)
          return false;
        return start.every((st) => st.type === "newline" || st.type === "space");
      }
      *documentEnd(docEnd) {
        if (this.type !== "doc-mode") {
          if (docEnd.end)
            docEnd.end.push(this.sourceToken);
          else
            docEnd.end = [this.sourceToken];
          if (this.type === "newline")
            yield* this.pop();
        }
      }
      *lineEnd(token) {
        switch (this.type) {
          case "comma":
          case "doc-start":
          case "doc-end":
          case "flow-seq-end":
          case "flow-map-end":
          case "map-value-ind":
            yield* this.pop();
            yield* this.step();
            break;
          case "newline":
            this.onKeyLine = false;
          // fallthrough
          case "space":
          case "comment":
          default:
            if (token.end)
              token.end.push(this.sourceToken);
            else
              token.end = [this.sourceToken];
            if (this.type === "newline")
              yield* this.pop();
        }
      }
    };
    exports2.Parser = Parser;
  }
});

// node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/public-api.js
var require_public_api = __commonJS({
  "node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/public-api.js"(exports2) {
    "use strict";
    var composer = require_composer();
    var Document = require_Document();
    var errors = require_errors();
    var log = require_log();
    var identity = require_identity();
    var lineCounter = require_line_counter();
    var parser = require_parser();
    function parseOptions(options) {
      const prettyErrors = options.prettyErrors !== false;
      const lineCounter$1 = options.lineCounter || prettyErrors && new lineCounter.LineCounter() || null;
      return { lineCounter: lineCounter$1, prettyErrors };
    }
    function parseAllDocuments(source, options = {}) {
      const { lineCounter: lineCounter2, prettyErrors } = parseOptions(options);
      const parser$1 = new parser.Parser(lineCounter2?.addNewLine);
      const composer$1 = new composer.Composer(options);
      const docs = Array.from(composer$1.compose(parser$1.parse(source)));
      if (prettyErrors && lineCounter2)
        for (const doc of docs) {
          doc.errors.forEach(errors.prettifyError(source, lineCounter2));
          doc.warnings.forEach(errors.prettifyError(source, lineCounter2));
        }
      if (docs.length > 0)
        return docs;
      return Object.assign([], { empty: true }, composer$1.streamInfo());
    }
    function parseDocument(source, options = {}) {
      const { lineCounter: lineCounter2, prettyErrors } = parseOptions(options);
      const parser$1 = new parser.Parser(lineCounter2?.addNewLine);
      const composer$1 = new composer.Composer(options);
      let doc = null;
      for (const _doc of composer$1.compose(parser$1.parse(source), true, source.length)) {
        if (!doc)
          doc = _doc;
        else if (doc.options.logLevel !== "silent") {
          doc.errors.push(new errors.YAMLParseError(_doc.range.slice(0, 2), "MULTIPLE_DOCS", "Source contains multiple documents; please use YAML.parseAllDocuments()"));
          break;
        }
      }
      if (prettyErrors && lineCounter2) {
        doc.errors.forEach(errors.prettifyError(source, lineCounter2));
        doc.warnings.forEach(errors.prettifyError(source, lineCounter2));
      }
      return doc;
    }
    function parse2(src, reviver, options) {
      let _reviver = void 0;
      if (typeof reviver === "function") {
        _reviver = reviver;
      } else if (options === void 0 && reviver && typeof reviver === "object") {
        options = reviver;
      }
      const doc = parseDocument(src, options);
      if (!doc)
        return null;
      doc.warnings.forEach((warning) => log.warn(doc.options.logLevel, warning));
      if (doc.errors.length > 0) {
        if (doc.options.logLevel !== "silent")
          throw doc.errors[0];
        else
          doc.errors = [];
      }
      return doc.toJS(Object.assign({ reviver: _reviver }, options));
    }
    function stringify(value, replacer, options) {
      let _replacer = null;
      if (typeof replacer === "function" || Array.isArray(replacer)) {
        _replacer = replacer;
      } else if (options === void 0 && replacer) {
        options = replacer;
      }
      if (typeof options === "string")
        options = options.length;
      if (typeof options === "number") {
        const indent = Math.round(options);
        options = indent < 1 ? void 0 : indent > 8 ? { indent: 8 } : { indent };
      }
      if (value === void 0) {
        const { keepUndefined } = options ?? replacer ?? {};
        if (!keepUndefined)
          return void 0;
      }
      if (identity.isDocument(value) && !_replacer)
        return value.toString(options);
      return new Document.Document(value, _replacer, options).toString(options);
    }
    exports2.parse = parse2;
    exports2.parseAllDocuments = parseAllDocuments;
    exports2.parseDocument = parseDocument;
    exports2.stringify = stringify;
  }
});

// node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/index.js
var require_dist = __commonJS({
  "node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/index.js"(exports2) {
    "use strict";
    var composer = require_composer();
    var Document = require_Document();
    var Schema = require_Schema();
    var errors = require_errors();
    var Alias = require_Alias();
    var identity = require_identity();
    var Pair = require_Pair();
    var Scalar = require_Scalar();
    var YAMLMap = require_YAMLMap();
    var YAMLSeq = require_YAMLSeq();
    var cst = require_cst();
    var lexer = require_lexer();
    var lineCounter = require_line_counter();
    var parser = require_parser();
    var publicApi = require_public_api();
    var visit = require_visit();
    exports2.Composer = composer.Composer;
    exports2.Document = Document.Document;
    exports2.Schema = Schema.Schema;
    exports2.YAMLError = errors.YAMLError;
    exports2.YAMLParseError = errors.YAMLParseError;
    exports2.YAMLWarning = errors.YAMLWarning;
    exports2.Alias = Alias.Alias;
    exports2.isAlias = identity.isAlias;
    exports2.isCollection = identity.isCollection;
    exports2.isDocument = identity.isDocument;
    exports2.isMap = identity.isMap;
    exports2.isNode = identity.isNode;
    exports2.isPair = identity.isPair;
    exports2.isScalar = identity.isScalar;
    exports2.isSeq = identity.isSeq;
    exports2.Pair = Pair.Pair;
    exports2.Scalar = Scalar.Scalar;
    exports2.YAMLMap = YAMLMap.YAMLMap;
    exports2.YAMLSeq = YAMLSeq.YAMLSeq;
    exports2.CST = cst;
    exports2.Lexer = lexer.Lexer;
    exports2.LineCounter = lineCounter.LineCounter;
    exports2.Parser = parser.Parser;
    exports2.parse = publicApi.parse;
    exports2.parseAllDocuments = publicApi.parseAllDocuments;
    exports2.parseDocument = publicApi.parseDocument;
    exports2.stringify = publicApi.stringify;
    exports2.visit = visit.visit;
    exports2.visitAsync = visit.visitAsync;
  }
});

// bin/craft-mcp.ts
var import_node_readline = require("node:readline");

// src/service.ts
var import_node_crypto4 = require("node:crypto");

// src/catalog.ts
var import_node_crypto = require("node:crypto");
var import_promises2 = require("node:fs/promises");
var import_node_path2 = require("node:path");
var import_yaml = __toESM(require_dist(), 1);

// src/store.ts
var import_node_fs = require("node:fs");
var import_node_sqlite = require("node:sqlite");

// src/paths.ts
var import_promises = require("node:fs/promises");
var import_node_os = require("node:os");
var import_node_path = require("node:path");
function dataRoot(env = process.env) {
  const configured = env.CRAFT_DATA_DIR?.trim();
  return (0, import_node_path.resolve)(configured || (0, import_node_path.join)((0, import_node_os.homedir)(), ".craft_data"));
}
function craftPaths(root = dataRoot()) {
  const resolved = (0, import_node_path.resolve)(root);
  return {
    root: resolved,
    configDir: (0, import_node_path.join)(resolved, "config"),
    configFile: (0, import_node_path.join)(resolved, "config", "config.json"),
    databaseDir: (0, import_node_path.join)(resolved, "db"),
    databaseFile: (0, import_node_path.join)(resolved, "db", "craft.db"),
    legacyDatabaseFile: (0, import_node_path.join)(resolved, "craft.db"),
    indexDir: (0, import_node_path.join)(resolved, "index"),
    indexFile: (0, import_node_path.join)(resolved, "index", "capabilities.db"),
    logsDir: (0, import_node_path.join)(resolved, "logs"),
    cacheDir: (0, import_node_path.join)(resolved, "cache"),
    backupsDir: (0, import_node_path.join)(resolved, "backups"),
    runtimeDir: (0, import_node_path.join)(resolved, "runtime")
  };
}
async function ensureLayout(paths = craftPaths()) {
  await Promise.all([
    paths.configDir,
    paths.databaseDir,
    paths.indexDir,
    paths.logsDir,
    paths.cacheDir,
    paths.backupsDir,
    paths.runtimeDir
  ].map((path) => (0, import_promises.mkdir)(path, { recursive: true })));
  return paths;
}

// src/store.ts
var SCHEMA_VERSION = 3;
var RESERVED_FIELDS = /* @__PURE__ */ new Set(["id", "version", "created_at", "updated_at"]);
function payloadOnly(payload) {
  return Object.fromEntries(Object.entries(payload).filter(([key]) => !RESERVED_FIELDS.has(key)));
}
function validLimit(limit) {
  if (!Number.isFinite(limit) || !Number.isInteger(limit)) {
    throw new Error("limit must be a finite integer");
  }
  return Math.max(1, limit);
}
var CraftStore = class {
  paths;
  #database = null;
  constructor(paths = craftPaths()) {
    this.paths = paths;
  }
  async open() {
    if (this.#database) return this;
    await ensureLayout(this.paths);
    const database = new import_node_sqlite.DatabaseSync(this.paths.databaseFile);
    database.exec("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=15000;");
    database.exec("BEGIN IMMEDIATE");
    try {
      database.exec(`
      CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS records(
        kind TEXT NOT NULL,id TEXT NOT NULL,version INTEGER NOT NULL,
        payload_json TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,
        PRIMARY KEY(kind,id,version)
      );
      CREATE INDEX IF NOT EXISTS records_latest ON records(kind,id,version DESC);
      CREATE TABLE IF NOT EXISTS events(
        stream TEXT NOT NULL,sequence INTEGER NOT NULL,event_type TEXT NOT NULL,
        payload_json TEXT NOT NULL,created_at TEXT NOT NULL,
        PRIMARY KEY(stream,sequence)
      );
    `);
      const schemaRow = database.prepare("SELECT value FROM meta WHERE key='schema_version'").get();
      const previousVersion = Number(schemaRow?.value ?? 0);
      if (previousVersion > SCHEMA_VERSION) {
        throw new Error(`Craft database schema ${previousVersion} is newer than supported schema ${SCHEMA_VERSION}`);
      }
      database.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES('schema_version',?)").run(String(SCHEMA_VERSION));
      database.exec("COMMIT");
      this.#database = database;
      return this;
    } catch (error) {
      database.exec("ROLLBACK");
      database.close();
      throw error;
    }
  }
  get database() {
    if (!this.#database) throw new Error("CraftStore is not open.");
    return this.#database;
  }
  transaction(operation) {
    const database = this.database;
    database.exec("BEGIN IMMEDIATE");
    try {
      const result = operation(database);
      database.exec("COMMIT");
      return result;
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }
  legacyDatabaseDetected() {
    return (0, import_node_fs.existsSync)(this.paths.legacyDatabaseFile);
  }
  save(kind, id2, payload, version) {
    return this.transaction((database) => this.insert(database, { kind, id: id2, payload, version }));
  }
  create(kind, id2, payload) {
    return this.transaction((database) => {
      const existing = database.prepare("SELECT 1 present FROM records WHERE kind=? AND id=? LIMIT 1").get(kind, id2);
      if (existing) throw new Error(`${kind} already exists: ${id2}`);
      return this.insert(database, { kind, id: id2, payload, version: 1 });
    });
  }
  saveBatch(entries) {
    if (!entries.length) return [];
    return this.transaction((database) => entries.map((entry) => this.insert(database, entry)));
  }
  updateIfVersion(kind, id2, expectedVersion, payload) {
    return this.transaction((database) => {
      const current = Number(database.prepare(
        "SELECT COALESCE(MAX(version),0) AS version FROM records WHERE kind=? AND id=?"
      ).get(kind, id2).version);
      if (current !== expectedVersion) throw new Error(`Concurrent update detected for ${kind}: ${id2}`);
      return this.insert(database, { kind, id: id2, payload, version: current + 1 });
    });
  }
  insert(database, entry) {
    const { kind, id: id2, version } = entry;
    const payload = payloadOnly(entry.payload);
    const now = (/* @__PURE__ */ new Date()).toISOString();
    const next = version ?? Number(database.prepare(
      "SELECT COALESCE(MAX(version),0)+1 AS version FROM records WHERE kind=? AND id=?"
    ).get(kind, id2).version);
    database.prepare(`INSERT INTO records(
        kind,id,version,payload_json,created_at,updated_at) VALUES(?,?,?,?,?,?)`).run(kind, id2, next, JSON.stringify(payload), now, now);
    return { ...payload, id: id2, version: next, created_at: now, updated_at: now };
  }
  find(kind, id2, version) {
    const row = version === void 0 ? this.database.prepare(
      "SELECT * FROM records WHERE kind=? AND id=? ORDER BY version DESC LIMIT 1"
    ).get(kind, id2) : this.database.prepare(
      "SELECT * FROM records WHERE kind=? AND id=? AND version=?"
    ).get(kind, id2, version);
    return row ? this.record(row) : null;
  }
  get(kind, id2, version) {
    const record = this.find(kind, id2, version);
    if (!record) throw new Error(`Unknown ${kind}: ${id2}`);
    return record;
  }
  list(kind, limit = 20, predicate) {
    const bounded = validLimit(limit);
    const rows = this.database.prepare(`SELECT r.* FROM records r JOIN (
      SELECT id,MAX(version) version FROM records WHERE kind=? GROUP BY id
      ) latest ON latest.id=r.id AND latest.version=r.version
      WHERE r.kind=? ORDER BY r.updated_at DESC,r.id DESC ${predicate ? "" : "LIMIT ?"}`).all(...predicate ? [kind, kind] : [kind, kind, bounded]);
    const records = rows.map((row) => this.record(row));
    return (predicate ? records.filter(predicate) : records).slice(0, bounded);
  }
  count(kind) {
    return Number(this.database.prepare(`SELECT COUNT(*) count FROM records r JOIN (
      SELECT id,MAX(version) version FROM records WHERE kind=? GROUP BY id
      ) latest ON latest.id=r.id AND latest.version=r.version WHERE r.kind=?`).get(kind, kind).count);
  }
  searchCapabilities(terms, limit) {
    const bounded = Math.min(validLimit(limit), 20);
    if (!terms.length) return [];
    return this.list("capability", Number.MAX_SAFE_INTEGER).map((item) => {
      const text2 = [item.name, item.description, item.search_text ?? item.body].join(" ").toLowerCase();
      const score = terms.reduce((total, term) => total + Number(text2.includes(term.toLowerCase())), 0);
      return { ...item, score };
    }).filter((item) => Number(item.score) > 0).sort((left, right) => Number(right.score) - Number(left.score)).slice(0, bounded);
  }
  remove(kind, id2) {
    return this.transaction((database) => {
      const changes = Number(database.prepare("DELETE FROM records WHERE kind=? AND id=?").run(kind, id2).changes);
      return changes;
    });
  }
  appendEvent(stream, eventType, payload) {
    return this.transaction((database) => {
      const sequence = Number(database.prepare(
        "SELECT COALESCE(MAX(sequence),0)+1 AS sequence FROM events WHERE stream=?"
      ).get(stream).sequence);
      const created_at = (/* @__PURE__ */ new Date()).toISOString();
      database.prepare(`INSERT INTO events(
        stream,sequence,event_type,payload_json,created_at) VALUES(?,?,?,?,?)`).run(stream, sequence, eventType, JSON.stringify(payload), created_at);
      return { stream, sequence, event_type: eventType, payload, created_at };
    });
  }
  events(stream) {
    return this.database.prepare(
      "SELECT * FROM events WHERE stream=? ORDER BY sequence"
    ).all(stream).map((row) => {
      const item = row;
      return {
        stream: item.stream,
        sequence: item.sequence,
        event_type: item.event_type,
        payload: JSON.parse(String(item.payload_json)),
        created_at: item.created_at
      };
    });
  }
  record(row) {
    return {
      ...JSON.parse(String(row.payload_json)),
      id: row.id,
      version: row.version,
      created_at: row.created_at,
      updated_at: row.updated_at
    };
  }
  close() {
    this.#database?.close();
    this.#database = null;
  }
};

// src/catalog.ts
function stableId(prefix, value) {
  return `${prefix}_${(0, import_node_crypto.createHash)("sha256").update(value).digest("hex").slice(0, 20)}`;
}
function metadataTerms(metadata) {
  const aliases = metadata.aliases;
  if (typeof aliases === "string") return [aliases];
  return Array.isArray(aliases) ? aliases.filter((value) => typeof value === "string") : [];
}
function rerank(query, item) {
  const normalized = query.trim().toLowerCase();
  const terms = normalized.split(/\s+/).filter(Boolean);
  const name = String(item.name).toLowerCase();
  const description = String(item.description).toLowerCase();
  const aliases = metadataTerms(item.metadata).join(" ").toLowerCase();
  const matchedTerms = terms.filter((term) => `${name}
${description}
${aliases}`.includes(term));
  const exactName = name === normalized;
  const exactDescription = description.includes(normalized);
  const aliasMatch = aliases.includes(normalized);
  const lexical = Number(item.score);
  return {
    ...item,
    score: lexical + matchedTerms.length * 10 + Number(exactName) * 100 + Number(exactDescription) * 40 + Number(aliasMatch) * 60,
    match: { matched_terms: matchedTerms, exact_name: exactName, exact_description: exactDescription, alias_match: aliasMatch }
  };
}
function pathKey(path, platform = process.platform) {
  return platform === "win32" ? path.toLowerCase() : path;
}
function parseSkill(text2, fallback) {
  let metadata = {};
  let body = text2;
  if (text2.startsWith("---\n") || text2.startsWith("---\r\n")) {
    const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text2);
    if (match) {
      const parsed = (0, import_yaml.parse)(match[1]);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) metadata = parsed;
      body = text2.slice(match[0].length);
    }
  }
  return {
    name: String(metadata.name || fallback),
    description: String(metadata.description || ""),
    version: String(metadata.version || "unversioned"),
    body,
    metadata
  };
}
async function skillFiles(root, onError) {
  const found = [];
  const visited = /* @__PURE__ */ new Set();
  async function walk(directory) {
    const actual = await (0, import_promises2.realpath)(directory);
    const key = pathKey(actual);
    if (visited.has(key)) return;
    visited.add(key);
    const entries = await (0, import_promises2.readdir)(directory, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const path = (0, import_node_path2.join)(directory, entry.name);
      try {
        const info = await (0, import_promises2.stat)(path);
        if (info.isDirectory()) {
          await walk(path);
        } else if (info.isFile() && entry.name.toLowerCase() === "skill.md") {
          found.push(path);
        }
      } catch (error) {
        onError?.(path, error);
      }
    }
  }
  await walk(root);
  return found.sort();
}
var Catalog = class {
  store;
  constructor(store) {
    this.store = store;
  }
  async addSource(path, label, scan = true) {
    const requested_path = (0, import_node_path2.resolve)(path);
    const root = await (0, import_promises2.realpath)(requested_path);
    if (!(await (0, import_promises2.stat)(root)).isDirectory()) throw new Error("Capability source must be a directory.");
    const duplicate = this.store.list("source", Number.MAX_SAFE_INTEGER).find((item) => pathKey(String(item.real_path)) === pathKey(root));
    if (duplicate) throw new Error(`Capability source already exists: ${duplicate.id}`);
    const id2 = stableId("source", root);
    this.store.save("source", id2, {
      label: label || (0, import_node_path2.basename)(root),
      requested_path,
      real_path: root,
      enabled: true,
      scanned_at: null
    });
    return scan ? this.scanSource(id2) : this.getSource(id2);
  }
  listSources() {
    return this.store.list("source", Number.MAX_SAFE_INTEGER);
  }
  getSource(id2) {
    return this.store.get("source", id2);
  }
  updateSource(id2, enabled, label) {
    const current = this.getSource(id2);
    return this.store.save("source", id2, {
      ...current,
      enabled: enabled ?? current.enabled,
      label: label ?? current.label
    });
  }
  removeSource(id2) {
    this.getSource(id2);
    for (const capability of this.store.list("capability", Number.MAX_SAFE_INTEGER)) {
      if (capability.source_id === id2) this.store.remove("capability", String(capability.id));
    }
    this.store.remove("source", id2);
    return { id: id2, removed: true };
  }
  async scanSource(id2) {
    const source = this.getSource(id2);
    if (!source.enabled) throw new Error(`Capability source is disabled: ${id2}`);
    const issues = [];
    const files = await skillFiles(String(source.real_path), (path, error) => issues.push({
      path,
      error: String(error)
    }));
    const live = /* @__PURE__ */ new Set();
    let added = 0;
    let updated = 0;
    let unchanged = 0;
    for (const path of files) {
      const relative_path = (0, import_node_path2.relative)(String(source.real_path), path).replaceAll("\\", "/");
      const assetId = stableId("cap", `${id2}:${relative_path}`);
      live.add(assetId);
      const fileStat = await (0, import_promises2.stat)(path);
      let previous;
      try {
        previous = this.store.get("capability", assetId);
      } catch {
        previous = void 0;
      }
      if (previous?.size === fileStat.size && previous?.mtime_ms === fileStat.mtimeMs) {
        unchanged += 1;
        continue;
      }
      const text2 = await (0, import_promises2.readFile)(path, "utf8");
      const digest2 = (0, import_node_crypto.createHash)("sha256").update(text2).digest("hex");
      if (previous?.digest === digest2) {
        this.store.save("capability", assetId, { ...previous, size: fileStat.size, mtime_ms: fileStat.mtimeMs });
        unchanged += 1;
        continue;
      }
      const skill = parseSkill(text2, (0, import_node_path2.basename)((0, import_node_path2.resolve)(path, "..")));
      this.store.save("capability", assetId, {
        ...skill,
        kind: "skill",
        source_id: id2,
        search_text: `${skill.body}
${metadataTerms(skill.metadata).join("\n")}`,
        relative_path,
        path: await (0, import_promises2.realpath)(path),
        digest: digest2,
        size: fileStat.size,
        mtime_ms: fileStat.mtimeMs
      });
      if (previous) updated += 1;
      else added += 1;
    }
    let removed = 0;
    for (const item of this.store.list("capability", Number.MAX_SAFE_INTEGER)) {
      if (item.source_id === id2 && !live.has(String(item.id))) {
        this.store.remove("capability", String(item.id));
        removed += 1;
      }
    }
    this.store.save("source", id2, { ...source, scanned_at: (/* @__PURE__ */ new Date()).toISOString() });
    return { ...this.getSource(id2), scan: {
      added,
      updated,
      unchanged,
      removed,
      total: files.length,
      issues
    } };
  }
  async scan(sourceId) {
    if (sourceId) return this.scanSource(sourceId);
    const results = [];
    for (const source of this.listSources().filter((item) => item.enabled)) {
      results.push(await this.scanSource(String(source.id)));
    }
    return { sources: results };
  }
  search(query, limit = 6) {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.length) return [];
    const lexical = this.store.searchCapabilities(terms, 20);
    const aliasFallback = lexical.length ? [] : this.store.list("capability", Number.MAX_SAFE_INTEGER, (item) => {
      const aliases = metadataTerms(item.metadata).join(" ").toLowerCase();
      return terms.every((term) => aliases.includes(term));
    });
    return [...lexical, ...aliasFallback].filter((item, index, values) => values.findIndex((candidate) => candidate.id === item.id) === index).map((item) => rerank(query, item)).sort((left, right) => Number(right.score) - Number(left.score) || String(left.id).localeCompare(String(right.id))).slice(0, Math.min(Math.max(1, limit), 20)).map((item) => {
      const { body: _body, metadata: _metadata, search_text: _searchText, ...summary } = item;
      return summary;
    });
  }
  get(assetId) {
    return this.store.get("capability", assetId);
  }
};

// src/workflow.ts
var import_node_child_process = require("node:child_process");
var import_node_fs2 = require("node:fs");
var import_node_path3 = require("node:path");
var PLACEHOLDER = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;
var SENSITIVE = /((?:authorization\s*:\s*bearer|api[_-]?key|token|password|secret|cookie)\s*[=:]?\s*)\S+/gi;
var SIDE_EFFECTS = /* @__PURE__ */ new Set(["read_only", "local_write", "external_write", "destructive"]);
function resolveInputs(definitions, supplied) {
  const result = { ...supplied };
  for (const [index, definition] of definitions.entries()) {
    if (!definition || typeof definition !== "object" || Array.isArray(definition)) {
      throw new Error(`Workflow input at index ${index} must be an object`);
    }
    const name = definition.name;
    if (typeof name !== "string" || !name) throw new Error("Each workflow input requires a non-empty name");
    if (!(name in result) && "default" in definition) result[name] = definition.default;
    if (definition.required && !(name in result)) throw new Error(`Missing required workflow input: ${name}`);
  }
  return result;
}
function substitute(value, inputs) {
  if (Array.isArray(value)) return value.map((item) => substitute(item, inputs));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, substitute(item, inputs)]));
  if (typeof value !== "string") return value;
  const matches = [...value.matchAll(PLACEHOLDER)];
  if (matches.length === 1 && matches[0][0] === value) {
    const name = matches[0][1];
    if (!(name in inputs)) throw new Error(`Unknown workflow input: ${name}`);
    return inputs[name];
  }
  return value.replace(PLACEHOLDER, (_whole, name) => {
    if (!(name in inputs)) throw new Error(`Unknown workflow input: ${name}`);
    return String(inputs[name]);
  });
}
function safePath(root, child = ".") {
  const base = (0, import_node_fs2.realpathSync)((0, import_node_path3.resolve)(root));
  const candidate = (0, import_node_path3.resolve)(base, child);
  const relation = (0, import_node_path3.relative)(base, candidate);
  if (relation.startsWith("..") || (0, import_node_path3.isAbsolute)(relation)) throw new Error(`Workflow path escapes project root: ${child}`);
  let existing = candidate;
  while (!(0, import_node_fs2.existsSync)(existing)) {
    existing = (0, import_node_path3.dirname)(existing);
  }
  const actual = (0, import_node_fs2.realpathSync)(existing);
  const actualRelation = (0, import_node_path3.relative)(base, actual);
  if (actualRelation.startsWith("..") || (0, import_node_path3.isAbsolute)(actualRelation)) {
    throw new Error(`Workflow path escapes project root through a link: ${child}`);
  }
  return candidate;
}
function redact(value, secrets = []) {
  let result = value.replace(SENSITIVE, "$1[REDACTED]");
  for (const secret of secrets) if (secret.length >= 4) result = result.replaceAll(secret, "[REDACTED]");
  return result;
}
function normalizeSteps(input) {
  const seen = /* @__PURE__ */ new Set();
  return input.map((original, index) => {
    if (!original || typeof original !== "object" || Array.isArray(original)) throw new Error(`Workflow step at index ${index} must be an object`);
    const step = { ...original };
    const stepId = String(step.id ?? `step_${index + 1}`);
    if (seen.has(stepId)) throw new Error(`Duplicate workflow step id: ${stepId}`);
    seen.add(stepId);
    const effect = String(step.side_effect ?? (step.type === "command" ? "local_write" : "read_only"));
    if (!SIDE_EFFECTS.has(effect)) throw new Error(`Unsupported side effect for ${stepId}: ${effect}`);
    return { ...step, id: stepId, side_effect: effect };
  });
}
function approvedEffects(allowExecution, effects = []) {
  const approved = /* @__PURE__ */ new Set(["read_only"]);
  if (allowExecution) approved.add("local_write");
  for (const effect of effects) {
    if (!SIDE_EFFECTS.has(String(effect))) throw new Error(`Unsupported approved side effect: ${effect}`);
    approved.add(String(effect));
  }
  return approved;
}
function runStep(step, root, runtimeEnv = {}, runner = import_node_child_process.spawnSync) {
  const kind = String(step.type);
  if (kind === "command") {
    if (!Array.isArray(step.command) || !step.command.length || !step.command.every((part) => typeof part === "string")) {
      throw new Error("Command steps require a non-empty string array in command");
    }
    const cwd = safePath(root, String(step.cwd ?? "."));
    if (!(0, import_node_fs2.existsSync)(cwd) || !(0, import_node_fs2.statSync)(cwd).isDirectory()) throw new Error(`Workflow command cwd does not exist: ${cwd}`);
    const configured = step.env ?? {};
    if (!configured || typeof configured !== "object" || Array.isArray(configured)) throw new Error("Command step env must be an object");
    const configuredEntries = Object.entries(configured);
    if (configuredEntries.some(([key]) => !key || key.includes("=") || key.includes("\0"))) {
      throw new Error("Command step env contains an invalid environment-variable name");
    }
    const env = { ...process.env, ...runtimeEnv, ...Object.fromEntries(configuredEntries.map(([k, v]) => [k, String(v)])) };
    const secrets = [...Object.entries(runtimeEnv), ...configuredEntries].filter(([key, value]) => value !== void 0 && /token|password|secret|key|cookie/i.test(key)).map(([, value]) => String(value));
    const timeoutSeconds = Number(step.timeout_seconds ?? 300);
    if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
      throw new Error("timeout_seconds must be greater than 0");
    }
    const timeout = Math.min(timeoutSeconds, 3600) * 1e3;
    const result = runner(step.command[0], step.command.slice(1), {
      cwd,
      env,
      encoding: "utf8",
      timeout,
      windowsHide: true,
      shell: false
    });
    const expected = Number(step.expected_exit_code ?? 0);
    if (!Number.isInteger(expected)) throw new Error("expected_exit_code must be an integer");
    return {
      passed: result.status === expected,
      exit_code: result.status,
      expected_exit_code: expected,
      stdout: redact((result.stdout ?? "").slice(-12e3), secrets),
      stderr: redact((result.stderr ?? "").slice(-12e3), secrets),
      ...result.error ? { error: result.error.message } : {}
    };
  }
  if (kind === "assertion") {
    if (step.evaluator === "file_exists") {
      let actual = true;
      try {
        (0, import_node_fs2.statSync)(safePath(root, String(step.path ?? "")));
      } catch {
        actual = false;
      }
      const expected = Boolean(step.expected ?? true);
      return { passed: actual === expected, actual, expected };
    }
    if (step.evaluator === "json_value") {
      let value = JSON.parse((0, import_node_fs2.readFileSync)(safePath(root, String(step.path ?? "")), "utf8"));
      for (const part of String(step.field ?? "").split(".").filter(Boolean)) {
        if (Array.isArray(value)) {
          if (!/^\d+$/.test(part)) {
            value = void 0;
            break;
          }
          value = value[Number(part)];
        } else if (value && typeof value === "object") value = value[part];
        else {
          value = void 0;
          break;
        }
      }
      return { passed: value === step.expected, actual: value, expected: step.expected };
    }
    throw new Error(`Unsupported assertion evaluator: ${step.evaluator}`);
  }
  if (kind === "coverage_gate") {
    const report = JSON.parse((0, import_node_fs2.readFileSync)(safePath(root, String(step.report ?? "coverage-summary.json")), "utf8"));
    const total = report.total ?? report;
    const thresholds = {
      lines: Number(step.line_threshold ?? 100),
      branches: Number(step.branch_threshold ?? 100),
      functions: Number(step.function_threshold ?? 100),
      statements: Number(step.statement_threshold ?? 100)
    };
    const coverage = Object.fromEntries(Object.keys(thresholds).map((key) => [key, Number(total[key]?.pct ?? 0)]));
    if (Object.values(thresholds).some((value) => !Number.isFinite(value) || value < 0 || value > 100)) {
      throw new Error("Coverage thresholds must be finite percentages from 0 to 100");
    }
    if (Object.values(coverage).some((value) => !Number.isFinite(value) || value < 0 || value > 100)) {
      throw new Error("Coverage report contains an invalid percentage");
    }
    return {
      passed: Object.entries(thresholds).every(([key, threshold]) => Number(coverage[key]) >= threshold),
      coverage,
      thresholds
    };
  }
  throw new Error(`Unsupported workflow step type: ${kind}`);
}
function executeSteps(steps, root, approved, executor = runStep) {
  const results = [];
  for (const step of steps) {
    const effect = String(step.side_effect ?? "read_only");
    if (!approved.has(effect)) {
      results.push({ id: step.id, passed: false, error: "side_effect_not_approved", side_effect: effect });
      break;
    }
    try {
      const result = { id: step.id, type: step.type, ...executor(step, root) };
      results.push(result);
      if (!result.passed && step.continue_on_failure !== true) break;
    } catch (error) {
      results.push({
        id: step.id,
        type: step.type,
        passed: false,
        error: error instanceof Error ? error.name : "Error",
        message: error instanceof Error ? error.message : String(error)
      });
      if (step.continue_on_failure !== true) break;
    }
  }
  return results;
}

// src/orchestration.ts
var import_node_crypto2 = require("node:crypto");
var PROVENANCE = /* @__PURE__ */ new Set(["agent_reported", "model_judged", "program_verified", "human_approved", "human_rejected"]);
function addCosts(current, addition) {
  const result = /* @__PURE__ */ new Map();
  for (const [name, value] of [...Object.entries(current), ...Object.entries(addition)]) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      throw new Error(`Cost ${name} must be a non-negative finite number`);
    }
    result.set(name, (result.get(name) ?? 0) + value);
  }
  return Object.fromEntries(result);
}
function orchestrationOutcome(nodes, budgetExceeded2 = false) {
  const counts = (status) => nodes.filter((node) => node.status === status).length;
  const failed = counts("failed");
  const blocked = counts("blocked");
  const passed = counts("passed");
  return {
    verdict: failed || blocked ? "failed" : "passed",
    failure_type: budgetExceeded2 ? "budget_exceeded" : failed ? "node_failed" : blocked ? "node_blocked" : null,
    scores: {
      passed_nodes: passed,
      failed_nodes: failed,
      blocked_nodes: blocked,
      total_nodes: nodes.length,
      route_retries: nodes.reduce((total, node) => total + Number(node.route_index), 0)
    }
  };
}
function normalizeNodes(input) {
  if (!input.length) throw new Error("At least one orchestration node is required");
  const seen = /* @__PURE__ */ new Set();
  const nodes = input.map((original, position) => {
    if (!original || typeof original !== "object" || Array.isArray(original)) throw new Error(`Orchestration node at index ${position} must be an object`);
    const node = original;
    const nodeId = String(node.id ?? "").trim();
    const role = String(node.role ?? "").trim();
    const objective = String(node.objective ?? "").trim();
    if (!nodeId || !role || !objective) throw new Error(`Orchestration node at index ${position} requires id, role, and objective`);
    if (seen.has(nodeId)) throw new Error(`Duplicate orchestration node id: ${nodeId}`);
    seen.add(nodeId);
    const dependencies = node.depends_on ?? [];
    const profiles = node.profile_ids ?? [];
    if (!Array.isArray(dependencies) || !dependencies.every((item) => typeof item === "string")) throw new Error(`Node ${nodeId} depends_on must contain strings`);
    if (!Array.isArray(profiles) || !profiles.length || !profiles.every((item) => typeof item === "string" && item)) throw new Error(`Node ${nodeId} profile_ids must contain at least one profile ID`);
    if (new Set(profiles).size !== profiles.length) throw new Error(`Node ${nodeId} profile_ids must be unique`);
    const effect = String(node.side_effect ?? "read_only");
    if (!SIDE_EFFECTS.has(effect)) throw new Error(`Unsupported side effect for ${nodeId}: ${effect}`);
    return {
      ...node,
      id: nodeId,
      role,
      objective,
      depends_on: dependencies,
      profile_ids: profiles,
      side_effect: effect,
      status: "pending",
      route_index: 0
    };
  });
  for (const node of nodes) for (const dependency of node.depends_on) {
    if (dependency === node.id) throw new Error(`Node ${node.id} cannot depend on itself`);
    if (!seen.has(dependency)) throw new Error(`Node ${node.id} has unknown dependency: ${dependency}`);
  }
  const visiting = /* @__PURE__ */ new Set();
  const visited = /* @__PURE__ */ new Set();
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const visit = (nodeId) => {
    if (visiting.has(nodeId)) throw new Error(`Orchestration plan contains a dependency cycle at: ${nodeId}`);
    if (visited.has(nodeId)) return;
    visiting.add(nodeId);
    for (const dependency of byId.get(nodeId).depends_on) visit(dependency);
    visiting.delete(nodeId);
    visited.add(nodeId);
  };
  for (const node of nodes) visit(node.id);
  return nodes;
}
function planStatus(nodes) {
  if (nodes.every((node) => node.status === "passed")) return "completed";
  if (nodes.some((node) => node.status === "pending" || node.status === "leased")) return "running";
  return "failed";
}
function dispatchNodes(nodes, capacity, owner, leaseTtlSeconds = 300, now = Date.now()) {
  if (!Number.isInteger(capacity) || capacity < 0) throw new Error("capacity must be a non-negative integer");
  if (!Number.isInteger(leaseTtlSeconds) || leaseTtlSeconds < 1 || leaseTtlSeconds > 3600) {
    throw new Error("lease_ttl_seconds must be an integer between 1 and 3600");
  }
  const passed = new Set(nodes.filter((node) => node.status === "passed").map((node) => node.id));
  const active = nodes.filter((node) => node.status === "leased").length;
  const available = Math.max(0, capacity - active);
  const leases = [];
  const updated = nodes.map((node) => {
    if (leases.length >= available || node.status !== "pending" || !node.depends_on.every((dep) => passed.has(dep))) return node;
    const routeIndex = Number(node.route_index);
    if (!Number.isInteger(routeIndex) || routeIndex < 0 || routeIndex >= node.profile_ids.length) {
      throw new Error(`Node ${node.id} has an invalid route_index`);
    }
    const leaseId = `lease_${(0, import_node_crypto2.randomUUID)().replaceAll("-", "")}`;
    const leased = {
      ...node,
      status: "leased",
      lease_id: leaseId,
      claimed_by: owner,
      lease_expires_at: new Date(now + leaseTtlSeconds * 1e3).toISOString()
    };
    leases.push({
      lease_id: leaseId,
      node_id: node.id,
      profile_id: node.profile_ids[routeIndex],
      profile_version: node.profile_versions?.[routeIndex] ?? null,
      role: node.role,
      objective: node.objective,
      side_effect: node.side_effect
    });
    return leased;
  });
  return { nodes: updated, leases };
}
function recoverExpiredLeases(nodes, now = Date.now()) {
  const recovered = [];
  const updated = nodes.map((node) => {
    const expiresAt = Date.parse(String(node.lease_expires_at ?? ""));
    if (node.status !== "leased" || !Number.isFinite(expiresAt) || expiresAt > now) return node;
    recovered.push(String(node.id));
    return {
      ...node,
      status: "pending",
      lease_id: null,
      claimed_by: null,
      lease_expires_at: null,
      last_provenance: "lease_expired"
    };
  });
  return { nodes: updated, recovered };
}
function submitNode(nodes, leaseId, verdict, provenance) {
  if (!PROVENANCE.has(provenance)) throw new Error(`Unsupported provenance: ${provenance}`);
  if (!(/* @__PURE__ */ new Set(["passed", "failed", "blocked"])).has(verdict)) throw new Error(`Unsupported verdict: ${verdict}`);
  let found = false;
  const updated = nodes.map((node) => {
    if (node.lease_id !== leaseId) return node;
    found = true;
    if (node.status !== "leased") throw new Error(`Lease is not active: ${leaseId}`);
    if (verdict === "failed" && Number(node.route_index) + 1 < node.profile_ids.length) {
      return {
        ...node,
        status: "pending",
        route_index: Number(node.route_index) + 1,
        lease_id: null,
        claimed_by: null,
        lease_expires_at: null,
        last_provenance: provenance
      };
    }
    return {
      ...node,
      status: verdict,
      lease_id: null,
      claimed_by: null,
      lease_expires_at: null,
      last_provenance: provenance
    };
  });
  if (!found) throw new Error(`Unknown lease: ${leaseId}`);
  const propagated = updated.map((node) => ({ ...node }));
  const failed = new Set(propagated.filter((node) => node.status === "failed" || node.status === "blocked").map((node) => node.id));
  let changed = true;
  while (changed) {
    changed = false;
    for (const node of propagated) {
      if (node.status === "pending" && node.depends_on.some((dependency) => failed.has(dependency))) {
        node.status = "blocked";
        failed.add(node.id);
        changed = true;
      }
    }
  }
  return propagated;
}

// src/evaluation.ts
function numericValues(records, field) {
  const values = /* @__PURE__ */ new Map();
  for (const record of records) {
    const metrics = record[field];
    for (const [name, value] of Object.entries(metrics)) {
      if (typeof value !== "number" || !Number.isFinite(value)) continue;
      values.set(name, [...values.get(name) ?? [], value]);
    }
  }
  return values;
}
function summarize(records, field, includeSum) {
  return Object.fromEntries([...numericValues(records, field)].sort(([left], [right]) => left.localeCompare(right)).map(([name, values]) => {
    const sum = values.reduce((total, value) => total + value, 0);
    return [name, {
      count: values.length,
      mean: sum / values.length,
      min: Math.min(...values),
      max: Math.max(...values),
      ...includeSum ? { sum } : {}
    }];
  }));
}
function aggregateEvaluation(run, trials, outcomes) {
  const verdictCounts = {};
  const failureTypes = {};
  for (const outcome of outcomes) {
    const verdict = String(outcome.verdict);
    verdictCounts[verdict] = (verdictCounts[verdict] ?? 0) + 1;
    if (verdict !== "passed") {
      const failureType = typeof outcome.failure_type === "string" && outcome.failure_type ? outcome.failure_type : "unspecified";
      failureTypes[failureType] = (failureTypes[failureType] ?? 0) + 1;
    }
  }
  return {
    evaluation_run_id: run.id,
    suite_id: run.suite_id,
    suite_version: run.suite_version,
    split: run.split,
    subject_type: run.subject_type,
    subject_id: run.subject_id,
    subject_version: run.subject_version,
    trial_ids: trials.map((trial) => trial.id),
    case_ids: trials.map((trial) => trial.case_id).sort(),
    total: outcomes.length,
    verdict_counts: verdictCounts,
    pass_rate: outcomes.filter((outcome) => outcome.verdict === "passed").length / outcomes.length,
    scores: summarize(outcomes, "scores", false),
    costs: summarize(outcomes, "costs", true),
    failure_types: failureTypes
  };
}
function metricDeltas(baseline, candidate) {
  const names = [.../* @__PURE__ */ new Set([...Object.keys(baseline), ...Object.keys(candidate)])].sort();
  return Object.fromEntries(names.map((name) => {
    const baselineMean = baseline[name]?.mean;
    const candidateMean = candidate[name]?.mean;
    return [name, {
      baseline: baselineMean ?? null,
      candidate: candidateMean ?? null,
      delta: typeof baselineMean === "number" && typeof candidateMean === "number" ? candidateMean - baselineMean : null
    }];
  }));
}
function countDeltas(baseline, candidate) {
  const names = [.../* @__PURE__ */ new Set([...Object.keys(baseline), ...Object.keys(candidate)])].sort();
  return Object.fromEntries(names.map((name) => {
    const baselineCount = Number(baseline[name] ?? 0);
    const candidateCount = Number(candidate[name] ?? 0);
    return [name, { baseline: baselineCount, candidate: candidateCount, delta: candidateCount - baselineCount }];
  }));
}
function compareEvaluationAggregates(baseline, candidate) {
  const scores = metricDeltas(baseline.scores, candidate.scores);
  const costs = metricDeltas(baseline.costs, candidate.costs);
  const signals = [
    candidate.pass_rate - baseline.pass_rate,
    ...Object.values(scores).map((item) => item.delta).filter((value) => typeof value === "number"),
    ...Object.values(costs).map((item) => item.delta).filter((value) => typeof value === "number").map((value) => -value)
  ];
  const improved = signals.some((value) => value > 0);
  const regressed = signals.some((value) => value < 0);
  const assessment = improved && regressed ? "mixed" : improved ? "improved" : regressed ? "regressed" : "equivalent";
  return {
    pass_rate: {
      baseline: baseline.pass_rate,
      candidate: candidate.pass_rate,
      delta: candidate.pass_rate - baseline.pass_rate
    },
    scores,
    costs,
    verdict_counts: countDeltas(baseline.verdict_counts, candidate.verdict_counts),
    failure_types: countDeltas(baseline.failure_types, candidate.failure_types),
    assessment
  };
}

// src/skill-publisher.ts
var import_node_crypto3 = require("node:crypto");
var import_promises3 = require("node:fs/promises");
var import_node_path4 = require("node:path");
var digest = (value) => (0, import_node_crypto3.createHash)("sha256").update(value).digest("hex");
function targetInsideSource(sourceRoot, targetPath) {
  if ((0, import_node_path4.basename)(targetPath).toLowerCase() !== "skill.md") throw new Error("target_path must name SKILL.md");
  if (!targetPath.startsWith(`${(0, import_node_path4.resolve)(sourceRoot)}${import_node_path4.sep}`)) {
    throw new Error("target_path must be inside the selected capability source");
  }
}
function requireExternalWrite(value) {
  if (value !== true) throw new Error("allow_external_write must be true for Skill publication");
}
async function replaceAtomically(path, content, mode) {
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  await (0, import_promises3.writeFile)(temporary, content, { encoding: "utf8", mode });
  await (0, import_promises3.rename)(temporary, path);
}
async function publishSkill(args) {
  requireExternalWrite(args.allowExternalWrite);
  const targetPath = await (0, import_promises3.realpath)(args.targetPath);
  targetInsideSource(args.sourceRoot, targetPath);
  const previous = await (0, import_promises3.readFile)(targetPath, "utf8");
  const previousDigest = digest(previous);
  if (previousDigest !== args.expectedDigest) throw new Error("target digest mismatch; file changed since it was reviewed");
  const backupPath = (0, import_node_path4.join)(args.backupsDir, "skill-publications", args.proposalId, `${previousDigest}.SKILL.md`);
  await (0, import_promises3.mkdir)((0, import_node_path4.dirname)(backupPath), { recursive: true });
  await (0, import_promises3.writeFile)(backupPath, previous, { encoding: "utf8", mode: 384 });
  if (args.onBeforeFinalCheck) await args.onBeforeFinalCheck();
  const current = await (0, import_promises3.readFile)(targetPath, "utf8");
  if (digest(current) !== args.expectedDigest) throw new Error("target digest mismatch; file changed during publication");
  const mode = (await (0, import_promises3.stat)(targetPath)).mode;
  await replaceAtomically(targetPath, args.content, mode);
  return { target_path: targetPath, previous_digest: previousDigest, published_digest: digest(args.content), backup_path: backupPath };
}
async function rollbackSkillPublication(args) {
  requireExternalWrite(args.allowExternalWrite);
  const targetPath = await (0, import_promises3.realpath)(args.targetPath);
  const current = await (0, import_promises3.readFile)(targetPath, "utf8");
  if (digest(current) !== args.expectedDigest) {
    throw new Error("target digest mismatch; refusing to overwrite a changed Skill");
  }
  if (args.expectedDigest !== args.publishedDigest) {
    throw new Error("target digest mismatch; refusing to overwrite a changed Skill");
  }
  const backup = await (0, import_promises3.readFile)(args.backupPath, "utf8");
  await replaceAtomically(targetPath, backup, (await (0, import_promises3.stat)(targetPath)).mode);
}

// src/service.ts
var VERSION = "0.9.3";
var CONFIDENCE = /* @__PURE__ */ new Set(["confirmed", "bounded", "unverified", "rejected"]);
var TASK_STATUS = /* @__PURE__ */ new Set(["active", "paused", "completed", "cancelled"]);
var VERSIONED_LIFECYCLE = /* @__PURE__ */ new Set(["draft", "candidate", "verified", "deprecated"]);
var TRIAL_VERDICTS = /* @__PURE__ */ new Set(["passed", "failed", "blocked", "cancelled"]);
var EVAL_SPLITS = /* @__PURE__ */ new Set(["search", "development", "held_out"]);
var HARNESS_DIMENSIONS = /* @__PURE__ */ new Set(["context", "tools", "generation", "orchestration", "memory", "output"]);
var GRADER_TYPES = /* @__PURE__ */ new Set(["program", "model", "human", "operational"]);
var GRADE_VERDICTS = /* @__PURE__ */ new Set(["passed", "failed", "inconclusive"]);
function id(prefix) {
  return `${prefix}_${(0, import_node_crypto4.randomUUID)().replaceAll("-", "")}`;
}
function text(value, name) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must not be empty`);
  return value.trim();
}
function document(value, name) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must not be empty`);
  return value;
}
function finiteInteger(value, name, fallback, minimum = 1, maximum = Number.MAX_SAFE_INTEGER) {
  const number = value === void 0 ? fallback : Number(value);
  if (!Number.isFinite(number) || !Number.isInteger(number) || number < minimum || number > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return number;
}
function optionalBoolean(value, name) {
  if (value === void 0) return void 0;
  if (typeof value !== "boolean") throw new Error(`${name} must be a boolean`);
  return value;
}
function optionalScore(value, name) {
  if (value === void 0 || value === null) return null;
  const score = Number(value);
  if (!Number.isFinite(score) || score < 0 || score > 1) throw new Error(`${name} must be between 0 and 1`);
  return score;
}
function array(value, name) {
  if (!Array.isArray(value)) throw new Error(`${name} must be an array`);
  return value;
}
function object(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`);
  return value;
}
function recordPayload(record) {
  const { id: _id, version: _version, created_at: _created, updated_at: _updated, ...payload } = record;
  return payload;
}
function uniqueTextArray(value, name, minimum = 1) {
  const values = array(value, name).map((item) => text(item, name));
  if (values.length < minimum || new Set(values).size !== values.length) {
    throw new Error(`${name} must contain at least ${minimum} unique values`);
  }
  return values;
}
function budgetLimits(value) {
  for (const [key, limit] of Object.entries(value)) {
    if (typeof limit !== "number" || !Number.isFinite(limit) || limit < 0) {
      throw new Error(`budget limit ${key} must be a non-negative finite number`);
    }
  }
  return value;
}
function budgetExceeded(costs, budget) {
  return Object.entries(budget).some(([key, limit]) => Number(costs[key] ?? 0) > Number(limit));
}
var SAFE_INCREMENTAL_STAGES = [
  {
    id: "baseline",
    constraints: "\u5148\u68C0\u67E5 Git \u589E\u91CF\u5E76\u4E3A\u539F\u6709\u903B\u8F91\u8865\u5145\u6216\u8FD0\u884C\u805A\u7126\u5355\u5143\u6D4B\u8BD5\uFF1B\u4E0D\u5F97\u5148\u6539\u4E1A\u52A1\u903B\u8F91\u3002",
    evidence: ["git diff --check", "baseline focused test receipt"]
  },
  {
    id: "minimal_change",
    constraints: "\u53EA\u505A\u6EE1\u8DB3\u76EE\u6807\u7684\u6700\u5C0F\u589E\u91CF\u6539\u52A8\uFF0C\u4FDD\u7559\u65E2\u6709\u63A5\u53E3\u3001\u6570\u636E\u4E0E\u672A\u6D89\u53CA\u8DEF\u5F84\u3002",
    evidence: ["changed files", "decision note"]
  },
  {
    id: "verification",
    constraints: "\u8FD0\u884C\u53D7\u5F71\u54CD\u6D4B\u8BD5\u3001\u8986\u76D6\u7387\u95E8\u7981\u548C\u5FC5\u8981\u9759\u6001\u68C0\u67E5\uFF1B\u589E\u91CF\u8986\u76D6\u7387\u9608\u503C\u7531\u5DF2\u9009 Workflow \u7684\u786E\u5B9A\u6027\u547D\u4EE4\u8BA1\u7B97\u3002",
    evidence: ["test receipt", "coverage report"]
  },
  {
    id: "review",
    constraints: "\u590D\u67E5 Git diff\u3001\u5931\u8D25\u7C7B\u578B\u548C\u672A\u9A8C\u8BC1\u98CE\u9669\uFF1B\u4EC5\u6709\u771F\u5B9E\u8BC1\u636E\u7684\u7ED3\u8BBA\u624D\u80FD\u6C89\u6DC0\u4E3A\u7ECF\u9A8C\u3002",
    evidence: ["git diff --check", "review evidence"]
  }
];
var ROUTE_TERMINAL = /* @__PURE__ */ new Set(["completed", "failed", "cancelled"]);
var ROUTE_RECEIPT_KINDS = /* @__PURE__ */ new Set(["git_diff", "focused_test", "coverage", "static_check", "review"]);
var ROUTE_RECEIPT_STATUS = /* @__PURE__ */ new Set(["passed", "failed", "skipped"]);
var HOST_OPERATIONS = /* @__PURE__ */ new Set(["complete_stage", "execute_verified_workflow"]);
var SECRET_ASSIGNMENT = /(?:api[_-]?key|authorization|cookie|password|secret|token)\s*[:=]\s*[^\s]+/iu;
var DEFAULT_RECEIPT_REQUIREMENTS = {
  baseline: ["git_diff", "focused_test"],
  minimal_change: [],
  verification: ["focused_test", "coverage"],
  review: ["git_diff", "review"]
};
function receiptRequirements(value, name) {
  const requirements = object(value ?? DEFAULT_RECEIPT_REQUIREMENTS, name);
  const normalized = {};
  for (const [stage, kinds] of Object.entries(requirements)) {
    if (!Object.hasOwn(DEFAULT_RECEIPT_REQUIREMENTS, stage)) throw new Error(`Unsupported receipt stage: ${stage}`);
    const values = array(kinds, `${name}.${stage}`).map((kind) => text(kind, `${name}.${stage}`));
    if (values.some((kind) => !ROUTE_RECEIPT_KINDS.has(kind)) || new Set(values).size !== values.length) {
      throw new Error(`${name}.${stage} must contain supported unique receipt kinds`);
    }
    normalized[stage] = values;
  }
  return Object.fromEntries(Object.keys(DEFAULT_RECEIPT_REQUIREMENTS).map((stage) => [stage, normalized[stage] ?? []]));
}
function assertNoSecret(value, name) {
  if (SECRET_ASSIGNMENT.test(value)) throw new Error(`${name} must not contain sensitive assignments`);
  return value;
}
var CraftService = class {
  store;
  catalog;
  constructor(store) {
    this.store = store;
    this.catalog = new Catalog(store);
  }
  info() {
    const kinds = [
      "source",
      "capability",
      "task",
      "checkpoint",
      "feedback",
      "artifact",
      "evidence",
      "workflow",
      "workflow_run",
      "evaluation_suite",
      "evaluation_run",
      "evaluation_comparison",
      "agent_profile",
      "orchestration_plan",
      "harness_configuration",
      "trial",
      "outcome",
      "grader",
      "grade",
      "signoff_policy",
      "signoff",
      "experience_pattern",
      "skill_proposal",
      "skill_publication",
      "budget",
      "model_provider",
      "agent_session",
      "route",
      "route_strategy",
      "project_policy",
      "route_receipt",
      "host_adapter",
      "host_dispatch"
    ];
    return {
      version: VERSION,
      data_root: this.store.paths.root,
      counts: Object.fromEntries(kinds.map((kind) => [kind, this.store.count(kind)]))
    };
  }
  sourceAdd(args) {
    const label = args.label === void 0 ? void 0 : text(args.label, "label");
    return this.catalog.addSource(
      text(args.path, "path"),
      label,
      optionalBoolean(args.scan, "scan") ?? true
    );
  }
  sourceList() {
    return { sources: this.catalog.listSources() };
  }
  sourceUpdate(args) {
    return this.catalog.updateSource(
      text(args.source_id, "source_id"),
      optionalBoolean(args.enabled, "enabled"),
      args.label === void 0 ? void 0 : text(args.label, "label")
    );
  }
  sourceRemove(args) {
    return this.catalog.removeSource(text(args.source_id, "source_id"));
  }
  sourceScan(args) {
    return this.catalog.scan(args.source_id === void 0 ? void 0 : text(args.source_id, "source_id"));
  }
  capabilitySearch(args) {
    return { capabilities: this.catalog.search(text(args.query, "query"), finiteInteger(args.limit, "limit", 6, 1, 20)) };
  }
  capabilityGet(args) {
    return this.catalog.get(text(args.asset_id, "asset_id"));
  }
  projectPolicySave(args) {
    const projectId = text(args.project_id, "project_id");
    const enforcement = String(args.enforcement ?? "required");
    if (!(/* @__PURE__ */ new Set(["required", "advisory"])).has(enforcement)) throw new Error(`Unsupported policy enforcement: ${enforcement}`);
    const policyId = String(args.policy_id ?? `project_policy_${(0, import_node_crypto4.createHash)("sha256").update(projectId).digest("hex").slice(0, 24)}`);
    return this.saveVersioned("project_policy", "policy", {
      ...args,
      policy_id: policyId,
      project_id: projectId,
      enforcement,
      receipt_requirements: receiptRequirements(args.receipt_requirements, "receipt_requirements")
    }, ["name"]);
  }
  projectPolicy(projectId) {
    if (typeof projectId !== "string" || !projectId) return {
      id: null,
      version: null,
      enforcement: "advisory",
      receipt_requirements: receiptRequirements(void 0, "default_receipt_requirements")
    };
    const policies = this.store.list("project_policy", 1e3, (policy) => policy.project_id === projectId).sort((left, right) => Number(right.version) - Number(left.version) || String(right.id).localeCompare(String(left.id)));
    return policies[0] ?? {
      id: null,
      version: null,
      enforcement: "advisory",
      receipt_requirements: receiptRequirements(void 0, "default_receipt_requirements")
    };
  }
  hostAdapterSave(args) {
    const host = text(args.host, "host");
    if (!(/* @__PURE__ */ new Set(["codex", "claude", "generic"])).has(host)) throw new Error(`Unsupported host adapter: ${host}`);
    const operations = uniqueTextArray(args.allowed_operations, "allowed_operations");
    if (operations.some((operation) => !HOST_OPERATIONS.has(operation))) throw new Error("allowed_operations contains an unsupported operation");
    return this.saveVersioned("host_adapter", "host_adapter", { ...args, host, allowed_operations: operations }, ["name", "host"]);
  }
  hostAdapterDispatch(args) {
    const adapter = this.store.get(
      "host_adapter",
      text(args.host_adapter_id, "host_adapter_id"),
      args.host_adapter_version === void 0 ? void 0 : finiteInteger(args.host_adapter_version, "host_adapter_version", 1)
    );
    const route = this.store.get("route", text(args.route_id, "route_id"));
    const action = this.routeNextAction(route);
    const operation = String(action.kind);
    if (!HOST_OPERATIONS.has(operation) || !adapter.allowed_operations.includes(operation)) {
      throw new Error(`Host adapter cannot dispatch route action: ${operation}`);
    }
    const dispatch = this.store.create("host_dispatch", String(args.dispatch_id ?? id("host_dispatch")), {
      host_adapter_id: adapter.id,
      host_adapter_version: adapter.version,
      route_id: route.id,
      action,
      status: "pending"
    });
    if (route.trial_id) this.trialTraceAppend({
      trial_id: String(route.trial_id),
      event_type: "host.dispatch",
      source: "craft",
      data: { dispatch_id: dispatch.id, host_adapter_id: adapter.id, action: operation }
    });
    return { dispatch, action };
  }
  hostAdapterReport(args) {
    const dispatch = this.store.get("host_dispatch", text(args.dispatch_id, "dispatch_id"));
    if (dispatch.status !== "pending") throw new Error("Host dispatch is already terminal");
    const status = text(args.status, "status");
    if (!(/* @__PURE__ */ new Set(["completed", "failed", "cancelled"])).has(status)) throw new Error(`Unsupported host dispatch status: ${status}`);
    const summary = assertNoSecret(text(args.summary, "summary"), "summary");
    const updated = this.store.save("host_dispatch", String(dispatch.id), { ...recordPayload(dispatch), status, summary });
    const route = this.store.get("route", String(dispatch.route_id));
    if (route.trial_id) this.trialTraceAppend({
      trial_id: String(route.trial_id),
      event_type: "host.report",
      source: "host_reported",
      data: { dispatch_id: dispatch.id, status, summary }
    });
    return { dispatch: updated, next_action: this.routeNextAction(route) };
  }
  routeReceiptRecord(args) {
    const route = this.store.get("route", text(args.route_id, "route_id"));
    if (route.workflow_id || ROUTE_TERMINAL.has(String(route.status))) throw new Error("Route receipts require an active safe route");
    const action = this.routeNextAction(route);
    const stageId = text(args.stage_id, "stage_id");
    if (action.kind !== "complete_stage" || action.stage_id !== stageId) throw new Error(`Route next required stage is ${action.stage_id ?? "none"}`);
    const kind = text(args.kind, "kind");
    if (!ROUTE_RECEIPT_KINDS.has(kind)) throw new Error(`Unsupported route receipt kind: ${kind}`);
    const status = text(args.status, "status");
    if (!ROUTE_RECEIPT_STATUS.has(status)) throw new Error(`Unsupported route receipt status: ${status}`);
    const command = assertNoSecret(text(args.command, "command"), "command");
    const summary = assertNoSecret(text(args.summary, "summary"), "summary");
    const receiptId = String(args.receipt_id ?? id("receipt"));
    const artifact = this.artifactRegister({
      artifact_id: `artifact_${receiptId}`,
      kind: "route_receipt",
      name: `${stageId}:${kind}`,
      uri: args.uri === void 0 ? `craft://route-receipt/${receiptId}` : text(args.uri, "uri"),
      producer_type: "host",
      producer_id: args.host_adapter_id ?? null,
      metadata: { route_id: route.id, stage_id: stageId, kind, status, command }
    });
    const evidence = this.evidenceRecord({
      evidence_id: `evidence_${receiptId}`,
      source_type: "program",
      claim: summary,
      confidence: status === "passed" ? "confirmed" : status === "failed" ? "rejected" : "bounded",
      artifact_id: artifact.id,
      metadata: { route_id: route.id, stage_id: stageId, kind, status, command }
    });
    const receipt = this.store.create("route_receipt", receiptId, {
      route_id: route.id,
      stage_id: stageId,
      kind,
      status,
      command,
      summary,
      artifact_id: artifact.id,
      evidence_id: evidence.id
    });
    return { receipt, artifact, evidence };
  }
  defaultRoute(args) {
    const goal = text(args.goal, "goal");
    const title = args.title === void 0 ? goal.slice(0, 120) : text(args.title, "title");
    const mode = String(args.mode ?? "default");
    if (!(/* @__PURE__ */ new Set(["default", "safe_incremental_development"])).has(mode)) {
      throw new Error(`Unsupported route mode: ${mode}`);
    }
    const task = this.taskOpen({ title, goal, project_id: args.project_id ?? null }).task;
    const policy = this.projectPolicy(args.project_id);
    const tokens = goal.toLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? [];
    const workflows = this.store.list("workflow", 1e3, (workflow2) => workflow2.lifecycle === "verified").map((workflow2) => ({ workflow: workflow2, score: tokens.filter((token) => JSON.stringify(workflow2).toLowerCase().includes(token)).length })).filter((candidate) => candidate.score > 0).sort((left, right) => right.score - left.score || String(left.workflow.id).localeCompare(String(right.workflow.id)));
    const workflow = mode === "safe_incremental_development" ? null : workflows[0]?.workflow ?? null;
    const capabilities = this.catalog.search(goal, 6);
    const developmentPlan = workflow === null ? { stages: SAFE_INCREMENTAL_STAGES.map((stage) => ({ ...stage })) } : null;
    const strategyCapabilities = developmentPlan === null ? [] : capabilities.slice(0, 3).map((capability) => String(capability.id));
    const strategyId = strategyCapabilities.length ? `route_strategy_${(0, import_node_crypto4.createHash)("sha256").update(JSON.stringify({ mode: "safe_incremental_development", capability_ids: strategyCapabilities })).digest("hex").slice(0, 24)}` : null;
    const strategy = strategyId === null ? null : this.store.find("route_strategy", strategyId) ?? this.store.create(
      "route_strategy",
      strategyId,
      { mode: "safe_incremental_development", capability_ids: strategyCapabilities }
    );
    let route = this.store.create("route", id("route"), {
      task_id: task.id,
      goal,
      mode,
      workflow_id: workflow?.id ?? null,
      workflow_version: workflow?.version ?? null,
      capability_ids: capabilities.map((capability) => capability.id),
      status: workflow ? "ready" : "awaiting_host",
      development_plan: developmentPlan,
      stage_state: developmentPlan?.stages.map((stage) => ({ id: stage.id, status: "pending" })) ?? [],
      strategy_id: strategy?.id ?? null,
      strategy_version: strategy?.version ?? null,
      trial_id: null,
      policy_id: policy.id,
      policy_version: policy.version,
      policy_enforcement: policy.enforcement,
      receipt_requirements: policy.receipt_requirements
    });
    if (developmentPlan !== null) {
      const subject = strategy ?? route;
      const trial = this.trialStart({
        task_id: route.task_id,
        subject_type: strategy ? "route_strategy" : "route",
        subject_id: subject.id,
        subject_version: subject.version,
        environment: { route_id: route.id }
      });
      this.trialTraceAppend({
        trial_id: trial.id,
        event_type: "route_started",
        source: "craft",
        data: { route_id: route.id, mode, strategy_id: strategy?.id ?? null }
      });
      route = this.store.save("route", String(route.id), { ...recordPayload(route), trial_id: trial.id });
    }
    return {
      route_id: route.id,
      task,
      workflow,
      capabilities,
      development_plan: developmentPlan,
      policy,
      executable: workflow !== null,
      next_action: this.routeNextAction(route)
    };
  }
  defaultRouteResume(args) {
    const taskId = text(args.task_id, "task_id");
    const task = this.taskPack(taskId);
    const route = this.store.list("route", 1e3, (item) => item.task_id === taskId)[0];
    if (!route) throw new Error(`No route exists for task: ${taskId}`);
    const trial = route.trial_id ? this.trialGet({ trial_id: String(route.trial_id) }) : null;
    return { ...task, route, trial, next_action: this.routeNextAction(route) };
  }
  defaultRouteFind(args) {
    const rawQuery = text(args.query, "query").toLowerCase();
    const query = rawQuery.replace(/^(继续|接着|恢复)(上次|之前|刚才|上一个|上回|上轮)?的?[\s,，:：]*/u, "").trim();
    const projectId = args.project_id === void 0 ? void 0 : text(args.project_id, "project_id");
    const tokens = query.match(/[\p{L}\p{N}_-]+/gu) ?? [];
    const candidates = query ? this.store.list("task", 1e3, (task) => {
      if (task.status !== "active" || projectId !== void 0 && task.project_id !== projectId) return false;
      const searchable = `${task.title}
${task.goal}`.toLowerCase();
      return searchable.includes(query) || tokens.some((token) => searchable.includes(token));
    }).map((task) => {
      const searchable = `${task.title}
${task.goal}`.toLowerCase();
      const score = searchable.includes(query) ? 1e3 + query.length : tokens.filter((token) => searchable.includes(token)).length;
      return { task, score };
    }).filter((candidate) => candidate.score > 0) : [];
    const highest = candidates.reduce((score, candidate) => Math.max(score, candidate.score), 0);
    const best = candidates.filter((candidate) => candidate.score === highest).sort((left, right) => String(left.task.id).localeCompare(String(right.task.id)));
    const summaries = best.map((candidate) => ({
      task_id: candidate.task.id,
      title: candidate.task.title,
      goal: candidate.task.goal,
      project_id: candidate.task.project_id,
      score: candidate.score
    }));
    if (!best.length) return { status: "not_found", query, candidates: [] };
    if (best.length > 1) return { status: "ambiguous", query, candidates: summaries };
    return { status: "matched", query, candidates: summaries, ...this.defaultRouteResume({ task_id: best[0].task.id }) };
  }
  routeWorkflowProposalCreate(args) {
    const route = this.store.get("route", text(args.route_id, "route_id"));
    if (route.workflow_id || route.status !== "completed") {
      throw new Error("Workflow proposals require a completed safe route");
    }
    const routeTrialId = text(route.trial_id, "route trial_id");
    const routeOutcome = this.store.get("outcome", `outcome_${routeTrialId}`);
    if (routeOutcome.verdict !== "passed" || !route.strategy_id) {
      throw new Error("Workflow proposals require a passed route with a reusable strategy");
    }
    const strategyId = String(route.strategy_id);
    const strategyVersion = Number(route.strategy_version);
    const candidate = this.experienceCandidateList({}).experience_candidates.find((item) => item.subject_type === "route_strategy" && item.subject_id === strategyId && Number(item.subject_version) === strategyVersion);
    const trialIds = candidate?.passed_trial_ids ?? [];
    if (candidate?.status !== "ready_for_workflow_draft" || trialIds.length < 2) {
      throw new Error("Workflow proposals require two passed distinct routes with confirmed evidence");
    }
    const evidenceIds = [...new Set(trialIds.flatMap((trialId) => this.store.get("outcome", `outcome_${trialId}`).evidence_ids))];
    const duplicate = this.store.list("workflow", 1e3, (workflow2) => {
      const derived = workflow2.derived_from;
      return workflow2.lifecycle !== "deprecated" && derived?.route_strategy_id === strategyId && Number(derived.route_strategy_version) === strategyVersion;
    });
    if (duplicate.length) throw new Error("A non-deprecated Workflow draft already exists for this route strategy");
    const stepsInput = array(args.steps, "steps");
    if (!stepsInput.length) throw new Error("Workflow proposals require at least one step");
    const workflow = this.workflowSave({
      workflow_id: args.workflow_id,
      name: text(args.name, "name"),
      description: args.description === void 0 ? "Evidence-backed draft derived from safe routes." : document(args.description, "description"),
      inputs: array(args.inputs ?? [], "inputs"),
      steps: normalizeSteps(stepsInput),
      derived_from: {
        route_id: route.id,
        route_trial_id: routeTrialId,
        route_strategy_id: strategyId,
        route_strategy_version: strategyVersion,
        trial_ids: trialIds,
        evidence_ids: evidenceIds
      }
    });
    return {
      workflow,
      trial_ids: trialIds,
      evidence_ids: evidenceIds,
      next_action: "Run development and held-out evaluations before promoting this draft Workflow."
    };
  }
  defaultRouteUpdate(args) {
    const route = this.store.get("route", text(args.route_id, "route_id"));
    if (ROUTE_TERMINAL.has(String(route.status))) throw new Error("Route is already terminal");
    if (route.workflow_id) throw new Error("Verified Workflow routes must use craft_default_route_execute");
    const developmentPlan = object(route.development_plan, "route development_plan");
    const stages = array(developmentPlan.stages, "route development_plan stages");
    const states = array(route.stage_state, "route stage_state");
    const index = states.findIndex((state) => state.status !== "completed");
    if (index < 0 || !stages[index]) throw new Error("Route has no pending stage");
    const stageId = text(args.stage_id, "stage_id");
    const summary = text(args.summary, "summary");
    if (stageId !== stages[index].id) throw new Error(`Route next required stage is ${stages[index].id}`);
    const receiptIds = array(args.receipt_ids ?? [], "receipt_ids").map((value) => text(value, "receipt_id"));
    if (new Set(receiptIds).size !== receiptIds.length) throw new Error("receipt_ids must be unique");
    const receipts = receiptIds.map((receiptId) => this.store.get("route_receipt", receiptId));
    if (receipts.some((receipt) => receipt.route_id !== route.id || receipt.stage_id !== stageId)) {
      throw new Error("Route receipts must belong to the current route stage");
    }
    const requiredKinds = array(route.receipt_requirements?.[stageId] ?? [], "receipt requirements").map((kind) => String(kind));
    if (route.policy_enforcement === "required" && requiredKinds.some((kind) => !receipts.some((receipt) => receipt.kind === kind && receipt.status === "passed"))) {
      throw new Error(`Route stage requires required receipts: ${requiredKinds.join(", ")}`);
    }
    const artifactIds = [.../* @__PURE__ */ new Set([
      ...array(args.artifact_ids ?? [], "artifact_ids").map((value) => text(value, "artifact_id")),
      ...receipts.map((receipt) => String(receipt.artifact_id))
    ])];
    const evidenceIds = [.../* @__PURE__ */ new Set([
      ...array(args.evidence_ids ?? [], "evidence_ids").map((value) => text(value, "evidence_id")),
      ...receipts.map((receipt) => String(receipt.evidence_id))
    ])];
    for (const artifactId of artifactIds) this.store.get("artifact", artifactId);
    for (const evidenceId of evidenceIds) this.store.get("evidence", evidenceId);
    const isFinal = index === stages.length - 1;
    const verdict = args.verdict === void 0 ? void 0 : text(args.verdict, "verdict");
    if (!isFinal && verdict !== void 0) throw new Error("verdict is only allowed for the final route stage");
    if (isFinal && verdict === void 0) throw new Error("verdict is required for the final route stage");
    if (verdict !== void 0 && !TRIAL_VERDICTS.has(verdict)) throw new Error(`Unsupported trial verdict: ${verdict}`);
    const updatedStates = states.map((state, stateIndex) => stateIndex === index ? { ...state, status: "completed", summary, artifact_ids: artifactIds, evidence_ids: evidenceIds } : state);
    const taskStatus = verdict === void 0 ? "active" : verdict === "passed" ? "completed" : verdict === "cancelled" ? "cancelled" : "paused";
    const task = this.taskCheckpoint({
      task_id: route.task_id,
      summary,
      status: taskStatus,
      completed: updatedStates.filter((state) => state.status === "completed").map((state) => state.id),
      pending: updatedStates.filter((state) => state.status !== "completed").map((state) => state.id),
      decisions: [`Route ${route.id} completed stage ${stageId}`],
      artifacts: artifactIds,
      source: "craft_route"
    });
    const trialId = text(route.trial_id, "route trial_id");
    this.trialTraceAppend({
      trial_id: trialId,
      event_type: "route_stage_completed",
      source: "host_reported",
      data: { route_id: route.id, stage_id: stageId, summary, receipt_ids: receiptIds },
      artifact_ids: artifactIds,
      evidence_ids: evidenceIds
    });
    const outcome = verdict === void 0 ? null : this.outcomeRecord({
      trial_id: trialId,
      verdict,
      summary,
      evidence_ids: evidenceIds,
      source: "host_reported"
    });
    const updated = this.store.save("route", String(route.id), {
      ...recordPayload(route),
      stage_state: updatedStates,
      status: verdict === void 0 ? "awaiting_host" : verdict === "passed" ? "completed" : verdict
    });
    return {
      route: updated,
      task: task.task,
      checkpoint: task.checkpoints[0],
      outcome,
      trace: this.trialGet({ trial_id: trialId }).trace,
      next_action: this.routeNextAction(updated),
      experience_candidates: verdict === void 0 ? [] : this.experienceCandidateList({}).experience_candidates
    };
  }
  routeNextAction(route) {
    if (ROUTE_TERMINAL.has(String(route.status))) return { kind: "completed", route_id: route.id, status: route.status };
    if (route.workflow_id) return {
      kind: "execute_verified_workflow",
      route_id: route.id,
      workflow_id: route.workflow_id,
      workflow_version: route.workflow_version
    };
    const plan = object(route.development_plan, "route development_plan");
    const stages = array(plan.stages, "route development plan stages");
    const states = array(route.stage_state, "route stage_state");
    const index = states.findIndex((state) => state.status !== "completed");
    if (index < 0 || !stages[index]) return { kind: "complete_route", route_id: route.id };
    return {
      kind: "complete_stage",
      route_id: route.id,
      stage_id: stages[index].id,
      constraints: stages[index].constraints,
      expected_evidence: stages[index].evidence,
      required_receipts: route.receipt_requirements?.[String(stages[index].id)] ?? []
    };
  }
  defaultRouteExecute(args) {
    const route = this.store.get("route", text(args.route_id, "route_id"));
    if (!route.workflow_id) throw new Error("Route has no verified Workflow to execute; complete the host plan first");
    const workflow = this.store.get("workflow", String(route.workflow_id), Number(route.workflow_version));
    if (workflow.lifecycle !== "verified") throw new Error("Route Workflow is no longer verified");
    const result = this.workflowTrialRun({
      ...args,
      task_id: route.task_id,
      workflow_id: route.workflow_id,
      version: route.workflow_version
    });
    const completed = this.store.save("route", String(route.id), {
      ...recordPayload(route),
      status: "completed",
      workflow_run_id: result.workflow_run?.id ?? null,
      trial_id: result.trial.id
    });
    return { route: completed, ...result, experience_candidates: this.experienceCandidateList({}).experience_candidates };
  }
  experienceCandidateList(_args) {
    const groups = /* @__PURE__ */ new Map();
    for (const trial of this.store.list("trial", 1e3)) {
      const outcome = this.store.find("outcome", `outcome_${trial.id}`);
      const evidence = outcome?.evidence_ids;
      if (!outcome || !Array.isArray(evidence) || !evidence.length) continue;
      const key = `${trial.subject_type}:${trial.subject_id}:${trial.subject_version}`;
      const group = groups.get(key) ?? {
        subject_type: String(trial.subject_type),
        subject_id: String(trial.subject_id),
        subject_version: Number(trial.subject_version),
        trial_ids: [],
        passed_trial_ids: [],
        task_ids: [],
        evidence_ids: [],
        confirmed_evidence_ids: []
      };
      const confirmed = evidence.map((evidenceId) => this.store.get("evidence", String(evidenceId))).filter((item) => item.confidence === "confirmed" || item.confidence === "bounded").map((item) => String(item.id));
      group.trial_ids.push(String(trial.id));
      group.task_ids.push(String(trial.task_id));
      if (outcome.verdict === "passed" && confirmed.length) group.passed_trial_ids.push(String(trial.id));
      group.evidence_ids.push(...evidence.map((evidenceId) => String(evidenceId)));
      group.confirmed_evidence_ids.push(...confirmed);
      groups.set(key, group);
    }
    const experienceCandidates = [...groups.values()].filter((group) => group.trial_ids.length >= 2).map((group) => {
      const passedTrialIds = [...group.passed_trial_ids].sort();
      const taskIds = [...new Set(group.task_ids)].sort();
      const ready = passedTrialIds.length >= 2 && taskIds.length >= 2;
      return {
        ...group,
        trial_ids: [...group.trial_ids].sort(),
        passed_trial_ids: passedTrialIds,
        task_ids: taskIds,
        evidence_ids: [...new Set(group.evidence_ids)].sort(),
        confirmed_evidence_ids: [...new Set(group.confirmed_evidence_ids)].sort(),
        pass_rate: passedTrialIds.length / group.trial_ids.length,
        status: ready ? "ready_for_workflow_draft" : "insufficient_confirmed_evidence",
        next_action: ready ? "Review applicability and create an Experience Pattern or draft Workflow." : "Collect independent passed routes with confirmed or bounded evidence."
      };
    });
    return { experience_candidates: experienceCandidates };
  }
  taskOpen(args) {
    if (args.task_id) return this.taskPack(String(args.task_id));
    const taskId = id("task");
    this.store.save("task", taskId, {
      title: text(args.title, "title"),
      goal: text(args.goal, "goal"),
      project_id: args.project_id ?? null,
      status: "active"
    });
    return this.taskPack(taskId);
  }
  taskList(args) {
    const status = args.status;
    if (status !== void 0 && !TASK_STATUS.has(status)) throw new Error(`Unsupported task status: ${status}`);
    return { tasks: this.store.list("task", Number(args.limit ?? 10), (item) => (status === void 0 || item.status === status) && (args.project_id === void 0 || item.project_id === args.project_id)) };
  }
  taskCheckpoint(args) {
    const taskId = text(args.task_id, "task_id");
    const task = this.store.get("task", taskId);
    const status = String(args.status ?? task.status);
    if (!TASK_STATUS.has(status)) throw new Error(`Unsupported task status: ${status}`);
    const checkpointId = id("checkpoint");
    const completed = array(args.completed ?? [], "completed");
    const pending = array(args.pending ?? [], "pending");
    const decisions = array(args.decisions ?? [], "decisions");
    const artifacts = array(args.artifacts ?? [], "artifacts");
    this.store.saveBatch([{ kind: "checkpoint", id: checkpointId, payload: {
      task_id: taskId,
      summary: text(args.summary, "summary"),
      completed,
      pending,
      decisions,
      artifacts,
      source: args.source ?? "agent_reported"
    } }, {
      kind: "task",
      id: taskId,
      payload: { ...task, status, latest_checkpoint_id: checkpointId }
    }]);
    return this.taskPack(taskId);
  }
  taskPack(taskId) {
    return { task: this.store.get("task", taskId), checkpoints: this.store.list(
      "checkpoint",
      100,
      (item) => item.task_id === taskId
    ), feedback: this.store.list(
      "feedback",
      100,
      (item) => item.task_id === taskId
    ) };
  }
  feedbackRecord(args) {
    const scope = String(args.scope ?? "task");
    if (!(/* @__PURE__ */ new Set(["task", "project", "user"])).has(scope)) throw new Error(`Unsupported feedback scope: ${scope}`);
    if (scope === "task" && !args.task_id) throw new Error("task_id is required for task feedback");
    return this.store.save("feedback", id("feedback"), {
      corrected: text(args.corrected, "corrected"),
      original: args.original ?? null,
      kind: args.kind ?? "correction",
      scope,
      task_id: args.task_id ?? null,
      applies_to: args.applies_to ?? null,
      source: args.source ?? "user_explicit"
    });
  }
  artifactRegister(args) {
    return this.store.save("artifact", String(args.artifact_id ?? id("artifact")), {
      kind: text(args.kind, "kind"),
      name: text(args.name, "name"),
      uri: text(args.uri, "uri"),
      media_type: args.media_type ?? null,
      digest: args.digest ?? null,
      size_bytes: args.size_bytes ?? null,
      producer_type: args.producer_type ?? null,
      producer_id: args.producer_id ?? null,
      metadata: args.metadata ?? {}
    });
  }
  evidenceRecord(args) {
    const confidence = String(args.confidence ?? "unverified");
    if (!CONFIDENCE.has(confidence)) throw new Error(`Unsupported confidence: ${confidence}`);
    if (args.artifact_id) this.store.get("artifact", String(args.artifact_id));
    return this.store.save("evidence", String(args.evidence_id ?? id("evidence")), {
      source_type: text(args.source_type, "source_type"),
      claim: text(args.claim, "claim"),
      confidence,
      artifact_id: args.artifact_id ?? null,
      locator: args.locator ?? null,
      observed_at: args.observed_at ?? (/* @__PURE__ */ new Date()).toISOString(),
      metadata: args.metadata ?? {}
    });
  }
  saveVersioned(kind, prefix, args, required) {
    for (const key of required) text(args[key], key);
    const recordId = String(args[`${prefix}_id`] ?? id(prefix));
    const payload = { ...args };
    delete payload[`${prefix}_id`];
    return this.store.save(kind, recordId, payload);
  }
  list(kind, key, args) {
    const query = String(args.query ?? "").toLowerCase();
    return { [key]: this.store.list(kind, finiteInteger(args.limit, "limit", 20, 1, 1e3), (item) => !query || JSON.stringify(item).toLowerCase().includes(query)) };
  }
  get(kind, idKey, args) {
    const version = args.version === void 0 ? void 0 : finiteInteger(args.version, "version", 1);
    return this.store.get(kind, text(args[idKey], idKey), version);
  }
  harnessConfigurationSave(args) {
    const dimensions = object(args.dimensions, "dimensions");
    for (const key of Object.keys(dimensions)) {
      if (!HARNESS_DIMENSIONS.has(key)) throw new Error(`Unsupported harness dimension: ${key}`);
      object(dimensions[key], `dimensions.${key}`);
    }
    return this.saveVersioned("harness_configuration", "configuration", {
      ...args,
      name: text(args.name, "name"),
      dimensions
    }, ["name"]);
  }
  evaluationSuiteSave(args) {
    const cases = array(args.cases ?? [], "cases").map((value, index) => {
      const item = object(value, `cases[${index}]`);
      const caseId = text(item.case_id, `cases[${index}].case_id`);
      const split = String(item.split ?? "development");
      if (!EVAL_SPLITS.has(split)) throw new Error(`Unsupported evaluation split: ${split}`);
      return { ...item, case_id: caseId, split };
    });
    if (new Set(cases.map((item) => item.case_id)).size !== cases.length) {
      throw new Error("Evaluation case_id values must be unique");
    }
    return this.saveVersioned("evaluation_suite", "suite", { ...args, cases }, ["name"]);
  }
  graderSave(args) {
    const graderType = text(args.grader_type, "grader_type");
    if (!GRADER_TYPES.has(graderType)) throw new Error(`Unsupported grader type: ${graderType}`);
    return this.saveVersioned("grader", "grader", {
      ...args,
      grader_type: graderType,
      configuration: object(args.configuration ?? {}, "configuration")
    }, ["name", "grader_type"]);
  }
  gradeRecord(args) {
    const trialId = text(args.trial_id, "trial_id");
    this.store.get("trial", trialId);
    const grader = this.store.get(
      "grader",
      text(args.grader_id, "grader_id"),
      finiteInteger(args.grader_version, "grader_version", 1)
    );
    const verdict = text(args.verdict, "verdict");
    if (!GRADE_VERDICTS.has(verdict)) throw new Error(`Unsupported grade verdict: ${verdict}`);
    const evidenceIds = array(args.evidence_ids ?? [], "evidence_ids").map((value) => text(value, "evidence_id"));
    for (const evidenceId of evidenceIds) this.store.get("evidence", evidenceId);
    const gradeId = `grade_${(0, import_node_crypto4.createHash)("sha256").update(JSON.stringify(
      [trialId, grader.id, grader.version]
    )).digest("hex")}`;
    return this.store.create("grade", gradeId, {
      trial_id: trialId,
      grader_id: grader.id,
      grader_version: grader.version,
      grader_type: grader.grader_type,
      verdict,
      score: optionalScore(args.score, "score"),
      summary: text(args.summary, "summary"),
      evidence_ids: evidenceIds,
      metadata: object(args.metadata ?? {}, "metadata")
    });
  }
  signoffPolicySave(args) {
    const requirements = array(args.requirements ?? [], "requirements").map((value, index) => {
      const requirement = object(value, `requirements[${index}]`);
      const graderType = text(requirement.grader_type, `requirements[${index}].grader_type`);
      if (!GRADER_TYPES.has(graderType)) throw new Error(`Unsupported grader type: ${graderType}`);
      return { grader_type: graderType, minimum_score: optionalScore(
        requirement.minimum_score,
        `requirements[${index}].minimum_score`
      ) };
    });
    if (new Set(requirements.map((item) => item.grader_type)).size !== requirements.length) {
      throw new Error("Signoff grader_type requirements must be unique");
    }
    return this.saveVersioned("signoff_policy", "policy", {
      ...args,
      requirements,
      require_held_out: optionalBoolean(args.require_held_out, "require_held_out") ?? true,
      require_outcome_passed: optionalBoolean(args.require_outcome_passed, "require_outcome_passed") ?? true
    }, ["name"]);
  }
  signoffEvaluate(args) {
    const policy = this.store.get(
      "signoff_policy",
      text(args.policy_id, "policy_id"),
      args.policy_version === void 0 ? void 0 : finiteInteger(args.policy_version, "policy_version", 1)
    );
    const evaluation = this.store.get("evaluation_run", text(args.evaluation_run_id, "evaluation_run_id"));
    const gradeIds = array(args.grade_ids ?? [], "grade_ids").map((value) => text(value, "grade_id"));
    if (new Set(gradeIds).size !== gradeIds.length) throw new Error("grade_ids must be unique");
    const trialIds = evaluation.trial_ids;
    const grades = gradeIds.map((gradeId) => {
      const grade = this.store.get("grade", gradeId);
      if (!trialIds.includes(String(grade.trial_id))) throw new Error(`Grade is outside the evaluation run: ${gradeId}`);
      return grade;
    });
    const checks = [];
    if (policy.require_held_out) checks.push({ check: "held_out", passed: evaluation.split === "held_out" });
    if (policy.require_outcome_passed) checks.push({ check: "outcome", passed: evaluation.verdict === "passed" });
    for (const requirement of policy.requirements) {
      const graderType = String(requirement.grader_type);
      const minimumScore = requirement.minimum_score;
      for (const trialId of trialIds) {
        const matching = grades.filter((grade) => grade.trial_id === trialId && grade.grader_type === graderType);
        checks.push({
          check: "grader",
          trial_id: trialId,
          grader_type: graderType,
          passed: matching.some((grade) => grade.verdict === "passed" && (minimumScore === null || grade.score !== null && Number(grade.score) >= minimumScore)),
          grade_ids: matching.map((grade) => grade.id),
          minimum_score: minimumScore
        });
      }
    }
    const decision = checks.every((check) => check.passed) ? "passed" : "failed";
    return this.store.create("signoff", String(args.signoff_id ?? id("signoff")), {
      policy_id: policy.id,
      policy_version: policy.version,
      evaluation_run_id: evaluation.id,
      subject_type: evaluation.subject_type,
      subject_id: evaluation.subject_id,
      subject_version: evaluation.subject_version,
      grade_ids: gradeIds,
      checks,
      decision
    });
  }
  trialStart(args) {
    const taskId = text(args.task_id, "task_id");
    this.store.get("task", taskId);
    const subjectType = text(args.subject_type, "subject_type");
    const subjectId = text(args.subject_id, "subject_id");
    const subjectVersion = finiteInteger(args.subject_version, "subject_version", 1);
    this.store.get(subjectType, subjectId, subjectVersion);
    let harness;
    if (args.harness_configuration_id !== void 0) {
      harness = this.store.get("harness_configuration", text(
        args.harness_configuration_id,
        "harness_configuration_id"
      ), args.harness_configuration_version === void 0 ? void 0 : finiteInteger(args.harness_configuration_version, "harness_configuration_version", 1));
    }
    return this.store.create("trial", String(args.trial_id ?? id("trial")), {
      task_id: taskId,
      case_id: args.case_id === void 0 ? null : text(args.case_id, "case_id"),
      subject_type: subjectType,
      subject_id: subjectId,
      subject_version: subjectVersion,
      harness_configuration_id: harness?.id ?? null,
      harness_configuration_version: harness?.version ?? null,
      environment: object(args.environment ?? {}, "environment"),
      budget: object(args.budget ?? {}, "budget"),
      status: "started"
    });
  }
  trialTraceAppend(args) {
    const trialId = text(args.trial_id, "trial_id");
    this.store.get("trial", trialId);
    const artifactIds = array(args.artifact_ids ?? [], "artifact_ids").map((value) => text(value, "artifact_id"));
    const evidenceIds = array(args.evidence_ids ?? [], "evidence_ids").map((value) => text(value, "evidence_id"));
    for (const artifactId of artifactIds) this.store.get("artifact", artifactId);
    for (const evidenceId of evidenceIds) this.store.get("evidence", evidenceId);
    return this.store.appendEvent(`trial:${trialId}`, text(args.event_type, "event_type"), {
      trial_id: trialId,
      source: args.source ?? "agent_reported",
      data: object(args.data ?? {}, "data"),
      artifact_ids: artifactIds,
      evidence_ids: evidenceIds
    });
  }
  outcomeRecord(args) {
    const trialId = text(args.trial_id, "trial_id");
    this.store.get("trial", trialId);
    const verdict = String(args.verdict);
    if (!TRIAL_VERDICTS.has(verdict)) throw new Error(`Unsupported trial verdict: ${verdict}`);
    const evidenceIds = array(args.evidence_ids ?? [], "evidence_ids").map((value) => text(value, "evidence_id"));
    for (const evidenceId of evidenceIds) this.store.get("evidence", evidenceId);
    const failureType = args.failure_type === void 0 ? verdict === "passed" ? null : "unspecified" : text(args.failure_type, "failure_type");
    return this.store.create("outcome", `outcome_${trialId}`, {
      trial_id: trialId,
      verdict,
      summary: text(args.summary, "summary"),
      failure_type: failureType,
      scores: object(args.scores ?? {}, "scores"),
      costs: object(args.costs ?? {}, "costs"),
      evidence_ids: evidenceIds,
      source: args.source ?? "program_verified"
    });
  }
  trialGet(args) {
    const trialId = text(args.trial_id, "trial_id");
    const trial = this.store.get("trial", trialId);
    const outcome = this.store.find("outcome", `outcome_${trialId}`);
    return { trial, trace: this.store.events(`trial:${trialId}`), outcome };
  }
  evaluationRunRecord(args) {
    const suite = this.store.get(
      "evaluation_suite",
      text(args.suite_id, "suite_id"),
      args.suite_version === void 0 ? void 0 : finiteInteger(args.suite_version, "suite_version", 1)
    );
    const split = String(args.split);
    if (!EVAL_SPLITS.has(split)) throw new Error(`Unsupported evaluation split: ${split}`);
    const subjectType = text(args.subject_type, "subject_type");
    const subjectId = text(args.subject_id, "subject_id");
    const subjectVersion = finiteInteger(args.subject_version, "subject_version", 1);
    this.store.get(subjectType, subjectId, subjectVersion);
    const trialIds = array(args.trial_ids, "trial_ids").map((value) => text(value, "trial_id"));
    if (!trialIds.length || new Set(trialIds).size !== trialIds.length) {
      throw new Error("trial_ids must contain unique trials");
    }
    const cases = array(suite.cases ?? [], "suite cases");
    const allowedCases = new Set(cases.filter((item) => item.split === split).map((item) => String(item.case_id)));
    const outcomes = trialIds.map((trialId) => {
      const trial = this.store.get("trial", trialId);
      if (trial.subject_type !== subjectType || trial.subject_id !== subjectId || Number(trial.subject_version) !== subjectVersion) throw new Error(`Trial subject mismatch: ${trialId}`);
      if (!trial.case_id || !allowedCases.has(String(trial.case_id))) {
        throw new Error(`Trial case is not in the ${split} suite partition: ${trialId}`);
      }
      const outcome = this.store.find("outcome", `outcome_${trialId}`);
      if (!outcome) throw new Error(`Trial has no outcome: ${trialId}`);
      return outcome;
    });
    const verdict = outcomes.every((outcome) => outcome.verdict === "passed") ? "passed" : "failed";
    return this.store.create("evaluation_run", String(args.run_id ?? id("evalrun")), {
      suite_id: suite.id,
      suite_version: suite.version,
      split,
      subject_type: subjectType,
      subject_id: subjectId,
      subject_version: subjectVersion,
      trial_ids: trialIds,
      verdict,
      metrics: object(args.metrics ?? {}, "metrics")
    });
  }
  evaluationRunAggregate(args) {
    const run = this.store.get("evaluation_run", text(args.run_id, "run_id"));
    const trials = run.trial_ids.map((trialId) => this.store.get("trial", trialId));
    const outcomes = trials.map((trial) => this.store.get("outcome", `outcome_${trial.id}`));
    return aggregateEvaluation(run, trials, outcomes);
  }
  evaluationCompare(args) {
    const baselineId = text(args.baseline_run_id, "baseline_run_id");
    const candidateId = text(args.candidate_run_id, "candidate_run_id");
    if (baselineId === candidateId) throw new Error("Evaluation comparison requires two different runs");
    const baseline = this.evaluationRunAggregate({ run_id: baselineId });
    const candidate = this.evaluationRunAggregate({ run_id: candidateId });
    for (const field of ["suite_id", "suite_version", "split", "subject_type"]) {
      if (baseline[field] !== candidate[field]) throw new Error(`Evaluation runs are not comparable: ${field} differs`);
    }
    if (JSON.stringify(baseline.case_ids) !== JSON.stringify(candidate.case_ids)) {
      throw new Error("Evaluation runs are not comparable: case_ids differ");
    }
    return this.store.create("evaluation_comparison", String(args.comparison_id ?? id("comparison")), {
      baseline_run_id: baselineId,
      candidate_run_id: candidateId,
      suite_id: baseline.suite_id,
      suite_version: baseline.suite_version,
      split: baseline.split,
      subject_type: baseline.subject_type,
      case_ids: baseline.case_ids,
      baseline,
      candidate,
      comparison: compareEvaluationAggregates(baseline, candidate)
    });
  }
  workflowSave(args) {
    return this.saveVersioned("workflow", "workflow", { ...args, lifecycle: "draft" }, ["name"]);
  }
  workflowTransition(args) {
    return this.transitionVersionedSubject("workflow", "workflow_id", "workflow", args);
  }
  verificationGate(subjectType, subject, args) {
    if (args.signoff_id !== void 0) {
      const signoff = this.store.get("signoff", text(args.signoff_id, "signoff_id"));
      const run2 = this.store.get("evaluation_run", String(signoff.evaluation_run_id));
      if (signoff.decision !== "passed" || signoff.subject_type !== subjectType || signoff.subject_id !== subject.id || Number(signoff.subject_version) !== Number(subject.version) || run2.verdict !== "passed" || run2.split !== "held_out") {
        throw new Error(`Verification requires a passed signoff for this exact ${subjectType} version`);
      }
      return { evaluation_run_id: run2.id, signoff_id: signoff.id };
    }
    const run = this.store.get("evaluation_run", text(args.evaluation_run_id, "evaluation_run_id"));
    if (run.verdict !== "passed" || run.split !== "held_out" || run.subject_type !== subjectType || run.subject_id !== subject.id || Number(run.subject_version) !== Number(subject.version)) {
      throw new Error(`Verification requires a passed held-out evaluation for this exact ${subjectType} version`);
    }
    return { evaluation_run_id: run.id, signoff_id: null };
  }
  transitionVersionedSubject(kind, idKey, subjectType, args) {
    const subject = this.store.get(kind, text(args[idKey], idKey));
    const current = String(subject.lifecycle ?? "draft");
    const target = text(args.target, "target");
    if (!VERSIONED_LIFECYCLE.has(target)) throw new Error(`Unsupported ${subjectType} lifecycle: ${target}`);
    const allowed = {
      draft: ["candidate", "deprecated"],
      candidate: ["verified", "deprecated"],
      verified: ["deprecated"],
      deprecated: []
    };
    if (!allowed[current]?.includes(target)) throw new Error(`Invalid ${subjectType} transition: ${current} -> ${target}`);
    const verification = target === "verified" ? this.verificationGate(subjectType, subject, args) : { evaluation_run_id: null, signoff_id: null };
    return this.store.save(kind, String(subject.id), {
      ...recordPayload(subject),
      lifecycle: target,
      previous_version: subject.version,
      transition_reason: text(args.reason, "reason"),
      ...verification
    });
  }
  workflowRollback(args) {
    return this.rollbackVersionedSubject("workflow", "workflow_id", "workflow", args);
  }
  rollbackVersionedSubject(kind, idKey, subjectType, args) {
    const subjectId = text(args[idKey], idKey);
    const current = this.store.get(kind, subjectId);
    const target = this.store.get(kind, subjectId, finiteInteger(args.target_version, "target_version", 1));
    if (target.lifecycle !== "verified") throw new Error(`Rollback target must be a verified ${subjectType} version`);
    return this.store.save(kind, subjectId, {
      ...recordPayload(target),
      lifecycle: "verified",
      rollback_from_version: current.version,
      rollback_to_version: target.version,
      rollback_reason: text(args.reason, "reason")
    });
  }
  experiencePatternCreate(args) {
    const taskId = text(args.task_id, "task_id");
    this.store.get("task", taskId);
    const trialIds = uniqueTextArray(args.trial_ids, "trial_ids", 2);
    const evidenceIds = uniqueTextArray(args.evidence_ids, "evidence_ids");
    for (const evidenceId of evidenceIds) this.store.get("evidence", evidenceId);
    const outcomes = trialIds.map((trialId) => {
      this.store.get("trial", trialId);
      const outcome = this.store.get("outcome", `outcome_${trialId}`);
      return { trial_id: trialId, verdict: outcome.verdict, failure_type: outcome.failure_type };
    });
    return this.saveVersioned("experience_pattern", "pattern", {
      ...args,
      task_id: taskId,
      trial_ids: trialIds,
      evidence_ids: evidenceIds,
      outcomes,
      success_strategy: text(args.success_strategy, "success_strategy"),
      failure_modes: array(args.failure_modes, "failure_modes").map((item) => text(item, "failure_mode")),
      applicability: text(args.applicability, "applicability")
    }, ["summary"]);
  }
  skillProposalCreate(args) {
    const patternIds = uniqueTextArray(args.pattern_ids, "pattern_ids");
    for (const patternId of patternIds) this.store.get("experience_pattern", patternId);
    return this.saveVersioned("skill_proposal", "proposal", {
      ...args,
      lifecycle: "draft",
      pattern_ids: patternIds,
      skill_markdown: document(args.skill_markdown, "skill_markdown")
    }, ["name", "summary"]);
  }
  skillProposalTransition(args) {
    return this.transitionVersionedSubject("skill_proposal", "proposal_id", "skill_proposal", args);
  }
  skillProposalRollback(args) {
    return this.rollbackVersionedSubject("skill_proposal", "proposal_id", "skill_proposal", args);
  }
  async skillProposalPublish(args) {
    const proposal = this.store.get("skill_proposal", text(args.proposal_id, "proposal_id"));
    if (proposal.lifecycle !== "verified") throw new Error("Skill proposal must be verified before publication");
    const source = this.catalog.getSource(text(args.source_id, "source_id"));
    const publication = await publishSkill({
      sourceRoot: String(source.real_path),
      targetPath: text(args.target_path, "target_path"),
      expectedDigest: text(args.expected_digest, "expected_digest"),
      content: String(proposal.skill_markdown),
      backupsDir: this.store.paths.backupsDir,
      proposalId: String(proposal.id),
      allowExternalWrite: args.allow_external_write
    });
    const record = this.store.create("skill_publication", String(args.publication_id ?? id("publication")), {
      proposal_id: proposal.id,
      proposal_version: proposal.version,
      source_id: source.id,
      status: "published",
      ...publication
    });
    await this.catalog.scanSource(String(source.id));
    return record;
  }
  async skillPublicationRollback(args) {
    const publication = this.store.get("skill_publication", text(args.publication_id, "publication_id"));
    if (publication.status !== "published") throw new Error("Only a published Skill publication can be rolled back");
    await rollbackSkillPublication({
      targetPath: String(publication.target_path),
      expectedDigest: text(args.expected_digest, "expected_digest"),
      publishedDigest: String(publication.published_digest),
      backupPath: String(publication.backup_path),
      allowExternalWrite: args.allow_external_write
    });
    const restored = this.store.save("skill_publication", String(publication.id), { ...recordPayload(publication), status: "rolled_back" });
    await this.catalog.scanSource(String(publication.source_id));
    return restored;
  }
  workflowPlan(args) {
    const workflow = this.get("workflow", "workflow_id", args);
    const definitions = array(workflow.inputs ?? [], "workflow inputs");
    if (typeof (args.inputs ?? {}) !== "object" || Array.isArray(args.inputs)) {
      throw new Error("inputs must be an object");
    }
    const inputs = resolveInputs(definitions, args.inputs ?? {});
    const stepDefinitions = array(workflow.steps ?? [], "workflow steps");
    const steps = normalizeSteps(substitute(stepDefinitions, inputs));
    const allowExecution = optionalBoolean(args.allow_execution, "allow_execution") ?? false;
    const sideEffects = array(args.approved_side_effects ?? [], "approved_side_effects");
    const approved = approvedEffects(allowExecution, sideEffects);
    return {
      workflow_id: workflow.id,
      workflow_version: workflow.version,
      inputs,
      steps,
      approved_side_effects: [...approved],
      executable: steps.every((step) => approved.has(String(step.side_effect)))
    };
  }
  workflowRun(args) {
    const plan = this.workflowPlan(args);
    const root = text(args.project_root, "project_root");
    const results = executeSteps(
      plan.steps,
      root,
      new Set(plan.approved_side_effects)
    );
    const passed = results.length === plan.steps.length && results.every((item) => item.passed);
    return this.store.save("workflow_run", id("run"), {
      workflow_id: plan.workflow_id,
      workflow_version: plan.workflow_version,
      project_root: root,
      inputs: plan.inputs,
      results,
      status: passed ? "passed" : "failed"
    });
  }
  workflowTrialRun(args) {
    const plan = this.workflowPlan(args);
    const trial = this.trialStart({
      trial_id: args.trial_id,
      task_id: args.task_id,
      case_id: args.case_id,
      subject_type: "workflow",
      subject_id: plan.workflow_id,
      subject_version: plan.workflow_version,
      harness_configuration_id: args.harness_configuration_id,
      harness_configuration_version: args.harness_configuration_version,
      environment: args.environment ?? {},
      budget: args.budget ?? {}
    });
    const trialId = String(trial.id);
    this.trialTraceAppend({
      trial_id: trialId,
      event_type: "workflow.started",
      source: "program_verified",
      data: { workflow_id: plan.workflow_id, workflow_version: plan.workflow_version }
    });
    const startedAt = Date.now();
    let run;
    try {
      run = this.workflowRun({ ...args, version: plan.workflow_version });
    } catch {
      const evidence2 = this.evidenceRecord({
        source_type: "program",
        confidence: "confirmed",
        claim: "Workflow execution crashed before a durable run receipt was produced.",
        locator: { workflow_id: plan.workflow_id, workflow_version: plan.workflow_version }
      });
      this.trialTraceAppend({
        trial_id: trialId,
        event_type: "workflow.crashed",
        source: "program_verified",
        data: { error_type: "ExecutionError" },
        evidence_ids: [evidence2.id]
      });
      this.outcomeRecord({
        trial_id: trialId,
        verdict: "failed",
        summary: "Workflow execution crashed before completion.",
        failure_type: "execution_error",
        scores: {},
        costs: { duration_ms: Date.now() - startedAt },
        evidence_ids: [evidence2.id],
        source: "program_verified"
      });
      return { workflow_run: null, artifact: null, evidence: evidence2, ...this.trialGet({ trial_id: trialId }) };
    }
    const artifact = this.artifactRegister({
      kind: "workflow_receipt",
      name: `Workflow run ${run.id}`,
      uri: `craft://workflow-runs/${run.id}`,
      media_type: "application/json",
      producer_type: "workflow_run",
      producer_id: run.id,
      metadata: { workflow_id: plan.workflow_id, workflow_version: plan.workflow_version }
    });
    const passed = run.status === "passed";
    const evidence = this.evidenceRecord({
      source_type: "program",
      confidence: "confirmed",
      claim: `Workflow run ${run.id} ${passed ? "passed" : "failed"} deterministic checks.`,
      artifact_id: artifact.id,
      locator: { workflow_run_id: run.id }
    });
    this.trialTraceAppend({
      trial_id: trialId,
      event_type: "workflow.completed",
      source: "program_verified",
      data: { status: run.status, workflow_run_id: run.id },
      artifact_ids: [artifact.id],
      evidence_ids: [evidence.id]
    });
    const results = run.results;
    this.outcomeRecord({
      trial_id: trialId,
      verdict: passed ? "passed" : "failed",
      summary: passed ? "Workflow passed deterministic checks." : "Workflow failed deterministic checks.",
      ...passed ? {} : { failure_type: "deterministic_check_failed" },
      scores: { passed_steps: results.filter((item) => item.passed).length, total_steps: results.length },
      costs: { duration_ms: Date.now() - startedAt },
      evidence_ids: [evidence.id],
      source: "program_verified"
    });
    return { workflow_run: run, artifact, evidence, ...this.trialGet({ trial_id: trialId }) };
  }
  orchestrationCreate(args) {
    const nodes = normalizeNodes(args.nodes ?? []).map((node) => ({
      ...node,
      profile_versions: node.profile_ids.map((profileId) => Number(this.store.get("agent_profile", profileId).version))
    }));
    const max = Number(args.max_concurrency ?? 4);
    if (!Number.isInteger(max) || max < 1 || max > 32) throw new Error("max_concurrency must be between 1 and 32");
    const leaseTtl = finiteInteger(args.lease_ttl_seconds, "lease_ttl_seconds", 300, 1, 3600);
    const budget = budgetLimits(object(args.budget ?? {}, "budget"));
    const planId = args.plan_id === void 0 ? id("plan") : text(args.plan_id, "plan_id");
    return this.store.create("orchestration_plan", planId, {
      goal: text(args.goal, "goal"),
      task_id: args.task_id ?? null,
      trial_id: args.trial_id ?? null,
      trial_started_at: args.trial_started_at ?? null,
      accumulated_costs: {},
      submission_receipts: [],
      budget,
      lease_ttl_seconds: leaseTtl,
      max_concurrency: max,
      status: "running",
      nodes,
      policy: object(args.policy ?? {}, "policy")
    });
  }
  orchestrationTrialStart(args) {
    const taskId = text(args.task_id, "task_id");
    this.store.get("task", taskId);
    const trialId = args.trial_id === void 0 ? id("trial") : text(args.trial_id, "trial_id");
    if (this.store.find("trial", trialId)) throw new Error(`Trial already exists: ${trialId}`);
    const caseId = args.case_id === void 0 ? void 0 : text(args.case_id, "case_id");
    const environment = object(args.environment ?? {}, "environment");
    const budget = object(args.budget ?? {}, "budget");
    if (args.harness_configuration_id !== void 0) {
      this.store.get(
        "harness_configuration",
        text(args.harness_configuration_id, "harness_configuration_id"),
        args.harness_configuration_version === void 0 ? void 0 : finiteInteger(args.harness_configuration_version, "harness_configuration_version", 1)
      );
    }
    const plan = this.orchestrationCreate({
      ...args,
      task_id: taskId,
      trial_id: trialId,
      trial_started_at: (/* @__PURE__ */ new Date()).toISOString()
    });
    const trial = this.trialStart({
      trial_id: trialId,
      task_id: taskId,
      case_id: caseId,
      subject_type: "orchestration_plan",
      subject_id: plan.id,
      subject_version: plan.version,
      harness_configuration_id: args.harness_configuration_id,
      harness_configuration_version: args.harness_configuration_version,
      environment,
      budget
    });
    this.trialTraceAppend({
      trial_id: trial.id,
      event_type: "orchestration.started",
      source: "program_verified",
      data: { plan_id: plan.id, plan_version: plan.version }
    });
    return { plan, ...this.trialGet({ trial_id: trial.id }) };
  }
  orchestrationDispatch(args) {
    const plan = this.get("orchestration_plan", "plan_id", args);
    if (plan.status !== "running") throw new Error(`Plan is not running: ${plan.status}`);
    const owner = text(args.claimed_by, "claimed_by");
    const maximum = finiteInteger(plan.max_concurrency, "plan max_concurrency", 4, 1, 32);
    const requested = finiteInteger(args.capacity, "capacity", maximum, 1);
    const capacity = Math.min(requested, maximum);
    const recovered = recoverExpiredLeases(plan.nodes);
    const result = dispatchNodes(
      recovered.nodes,
      capacity,
      owner,
      finiteInteger(plan.lease_ttl_seconds, "plan lease_ttl_seconds", 300, 1, 3600)
    );
    const saved = this.store.updateIfVersion("orchestration_plan", String(plan.id), Number(plan.version), {
      ...plan,
      nodes: result.nodes,
      status: planStatus(result.nodes)
    });
    if (plan.trial_id && result.leases.length) {
      this.trialTraceAppend({
        trial_id: plan.trial_id,
        event_type: "orchestration.dispatched",
        source: "program_verified",
        data: { leases: result.leases }
      });
    }
    return { plan: saved, leases: result.leases };
  }
  orchestrationRenew(args) {
    const plan = this.get("orchestration_plan", "plan_id", args);
    if (plan.status !== "running") throw new Error(`Plan is not running: ${plan.status}`);
    const leaseId = text(args.lease_id, "lease_id");
    const owner = text(args.claimed_by, "claimed_by");
    const ttl = finiteInteger(plan.lease_ttl_seconds, "plan lease_ttl_seconds", 300, 1, 3600);
    let found = false;
    const nodes = plan.nodes.map((node) => {
      if (node.lease_id !== leaseId) return node;
      found = true;
      if (node.status !== "leased" || node.claimed_by !== owner) throw new Error("Lease owner does not match");
      return { ...node, lease_expires_at: new Date(Date.now() + ttl * 1e3).toISOString() };
    });
    if (!found) throw new Error(`Unknown lease: ${leaseId}`);
    return this.store.updateIfVersion("orchestration_plan", String(plan.id), Number(plan.version), { ...plan, nodes });
  }
  orchestrationSubmit(args) {
    const plan = this.get("orchestration_plan", "plan_id", args);
    const leaseId = text(args.lease_id, "lease_id");
    const idempotencyKey = args.idempotency_key === void 0 ? null : text(args.idempotency_key, "idempotency_key");
    const receipts = array(plan.submission_receipts ?? [], "submission_receipts");
    const existing = idempotencyKey === null ? void 0 : receipts.find((receipt) => receipt.idempotency_key === idempotencyKey);
    if (existing) {
      if (existing.lease_id !== leaseId || existing.verdict !== args.verdict) {
        throw new Error("idempotency_key belongs to a different submission");
      }
      return plan;
    }
    const leased = plan.nodes.find((node) => node.lease_id === leaseId);
    if (!leased) throw new Error(`Unknown lease: ${leaseId}`);
    if (args.claimed_by !== void 0) {
      if (leased.claimed_by !== text(args.claimed_by, "claimed_by")) throw new Error("Lease owner does not match");
    }
    const provenance = String(args.provenance ?? "agent_reported");
    const verdict = text(args.verdict, "verdict");
    const costs = object(args.costs ?? {}, "costs");
    const accumulatedCosts = addCosts(object(plan.accumulated_costs ?? {}, "accumulated costs"), costs);
    const exceedsBudget = budgetExceeded(accumulatedCosts, budgetLimits(object(plan.budget ?? {}, "plan budget")));
    const artifactIds = array(args.artifact_ids ?? [], "artifact_ids").map((value) => text(value, "artifact_id"));
    const evidenceIds = array(args.evidence_ids ?? [], "evidence_ids").map((value) => text(value, "evidence_id"));
    for (const artifactId of artifactIds) this.store.get("artifact", artifactId);
    for (const evidenceId of evidenceIds) this.store.get("evidence", evidenceId);
    const summary = args.summary === void 0 ? null : text(args.summary, "summary");
    const submitted = submitNode(plan.nodes, leaseId, verdict, provenance);
    const nodes = exceedsBudget ? submitted.map((node) => node.status === "pending" ? { ...node, status: "blocked", last_provenance: "budget_exceeded" } : node) : submitted;
    const status = planStatus(nodes);
    const saved = this.store.updateIfVersion(
      "orchestration_plan",
      String(plan.id),
      Number(plan.version),
      {
        ...plan,
        nodes,
        status,
        accumulated_costs: accumulatedCosts,
        budget_exceeded: exceedsBudget,
        submission_receipts: idempotencyKey === null ? receipts : [...receipts, {
          idempotency_key: idempotencyKey,
          lease_id: leaseId,
          verdict
        }]
      }
    );
    if (plan.trial_id) {
      this.trialTraceAppend({
        trial_id: plan.trial_id,
        event_type: "orchestration.node_submitted",
        source: provenance,
        data: {
          node_id: leased.id,
          profile_id: leased.profile_ids[Number(leased.route_index)],
          profile_version: leased.profile_versions[Number(leased.route_index)],
          verdict,
          summary,
          costs
        },
        artifact_ids: artifactIds,
        evidence_ids: evidenceIds
      });
      if (status !== "running") this.orchestrationTrialFinalize({ plan_id: saved.id });
    }
    return saved;
  }
  orchestrationTrialFinalize(args) {
    const plan = this.get("orchestration_plan", "plan_id", args);
    if (!plan.trial_id) throw new Error("Orchestration plan is not linked to a Trial");
    if (plan.status === "running") throw new Error("Orchestration plan is still running");
    const trialId = String(plan.trial_id);
    if (this.store.find("outcome", `outcome_${trialId}`)) {
      return { plan, ...this.trialGet({ trial_id: trialId }) };
    }
    const result = orchestrationOutcome(plan.nodes, Boolean(plan.budget_exceeded));
    const stableKey = (0, import_node_crypto4.createHash)("sha256").update(`${plan.id}:${trialId}`).digest("hex");
    const artifactId = `artifact_${stableKey}`;
    const artifact = this.store.find("artifact", artifactId) ?? this.artifactRegister({
      artifact_id: artifactId,
      kind: "orchestration_receipt",
      name: `Orchestration plan ${plan.id}`,
      uri: `craft://orchestration-plans/${plan.id}/versions/${plan.version}`,
      media_type: "application/json",
      producer_type: "orchestration_plan",
      producer_id: plan.id,
      metadata: { plan_version: plan.version }
    });
    const evidenceId = `evidence_${stableKey}`;
    const evidence = this.store.find("evidence", evidenceId) ?? this.evidenceRecord({
      evidence_id: evidenceId,
      source_type: "orchestration",
      confidence: "confirmed",
      claim: `Orchestration plan ${plan.id} reached ${plan.status} from recorded node submissions.`,
      artifact_id: artifact.id,
      locator: { plan_id: plan.id, plan_version: plan.version }
    });
    const events = this.store.events(`trial:${trialId}`);
    if (!events.some((event) => event.event_type === "orchestration.completed")) {
      this.trialTraceAppend({
        trial_id: trialId,
        event_type: "orchestration.completed",
        source: "program_verified",
        data: { status: plan.status, plan_version: plan.version },
        artifact_ids: [artifact.id],
        evidence_ids: [evidence.id]
      });
    }
    const traceEvidence = this.store.events(`trial:${trialId}`).flatMap((event) => event.payload.evidence_ids ?? []);
    const startedAt = Date.parse(String(plan.trial_started_at));
    this.outcomeRecord({
      trial_id: trialId,
      verdict: result.verdict,
      failure_type: result.failure_type ?? void 0,
      summary: result.verdict === "passed" ? "Orchestration completed all nodes." : "Orchestration did not complete all nodes.",
      scores: result.scores,
      costs: {
        ...plan.accumulated_costs,
        wall_duration_ms: Math.max(0, Date.now() - startedAt)
      },
      evidence_ids: [...new Set(traceEvidence)],
      source: "orchestration_aggregated"
    });
    return { plan, ...this.trialGet({ trial_id: trialId }) };
  }
};

// src/mcp.ts
var schemaFor = (name) => {
  if (["scan", "enabled", "allow_execution", "allow_external_write", "require_held_out", "require_outcome_passed"].includes(name)) return { type: "boolean" };
  if ([
    "limit",
    "version",
    "capacity",
    "max_concurrency",
    "size_bytes",
    "subject_version",
    "suite_version",
    "configuration_version",
    "harness_configuration_version",
    "target_version",
    "grader_version",
    "policy_version",
    "lease_ttl_seconds"
  ].includes(name)) return { type: "integer" };
  if (["score"].includes(name)) return { type: "number" };
  if ([
    "inputs",
    "metadata",
    "policy",
    "dimensions",
    "environment",
    "budget",
    "data",
    "scores",
    "costs",
    "metrics",
    "configuration",
    "receipt_requirements"
  ].includes(name)) return { type: "object" };
  if ([
    "completed",
    "pending",
    "decisions",
    "artifacts",
    "steps",
    "cases",
    "capabilities",
    "allowed_side_effects",
    "approved_side_effects",
    "nodes",
    "artifact_ids",
    "evidence_ids",
    "trial_ids",
    "requirements",
    "grade_ids",
    "pattern_ids",
    "failure_modes",
    "receipt_ids",
    "allowed_operations"
  ].includes(name)) return { type: "array" };
  return { type: "string" };
};
var objectSchema = (required = [], optional = []) => ({
  type: "object",
  properties: Object.fromEntries([...required, ...optional].map((name) => [name, schemaFor(name)])),
  required,
  additionalProperties: false
});
var tool = (name, description, required = [], readOnly = false, optional = []) => ({
  name,
  description,
  inputSchema: objectSchema(required, optional),
  ...readOnly ? { annotations: { readOnlyHint: true } } : {}
});
var TOOLS = [
  tool("craft_info", "Show the Craft version, data location, and record counts.", [], true),
  tool("craft_source_add", "Add and optionally scan a local capability directory.", ["path"], false, ["label", "scan"]),
  tool("craft_source_list", "List configured capability sources and resolved paths.", [], true),
  tool("craft_source_update", "Enable, disable, or relabel a source.", ["source_id"], false, ["enabled", "label"]),
  tool("craft_source_remove", "Remove a source index without deleting its files.", ["source_id"]),
  tool("craft_source_scan", "Incrementally scan one or all enabled sources.", [], false, ["source_id"]),
  tool("craft_capability_search", "Return a small ranked set of matching capabilities.", ["query"], true, ["limit"]),
  tool("craft_capability_get", "Read one indexed capability.", ["asset_id"], true),
  tool(
    "craft_default_route",
    "Create a durable route that prefers matching verified Workflows and otherwise returns the shortest safe host plan.",
    ["goal"],
    false,
    ["title", "project_id", "mode"]
  ),
  tool(
    "craft_default_route_execute",
    "Run the exact verified Workflow selected by a route and capture its Trial lifecycle.",
    ["route_id", "project_root"],
    false,
    [
      "inputs",
      "allow_execution",
      "approved_side_effects",
      "case_id",
      "harness_configuration_id",
      "harness_configuration_version",
      "environment",
      "budget"
    ]
  ),
  tool("craft_default_route_resume", "Resume a durable default route and return only its next safe action.", ["task_id"], true),
  tool(
    "craft_default_route_find",
    "Find one uniquely matching active default route for a natural-language continuation; never guess on a tie.",
    ["query"],
    true,
    ["project_id"]
  ),
  tool(
    "craft_project_policy_save",
    "Save a versioned project policy that can require evidence-backed route receipts.",
    ["project_id", "name"],
    false,
    ["policy_id", "enforcement", "receipt_requirements"]
  ),
  tool("craft_project_policy_get", "Read a project policy version.", ["policy_id"], true, ["version"]),
  tool("craft_project_policy_list", "List project policies.", [], true, ["limit", "query"]),
  tool(
    "craft_route_receipt_record",
    "Register a structured command receipt for the current safe route stage; secrets are rejected.",
    ["route_id", "stage_id", "kind", "status", "command", "summary"],
    false,
    ["receipt_id", "uri", "host_adapter_id"]
  ),
  tool(
    "craft_host_adapter_save",
    "Save a versioned Host Adapter contract; it grants only listed route operations.",
    ["name", "host", "allowed_operations"],
    false,
    ["host_adapter_id"]
  ),
  tool("craft_host_adapter_get", "Read a Host Adapter version.", ["host_adapter_id"], true, ["version"]),
  tool("craft_host_adapter_list", "List Host Adapter contracts.", [], true, ["limit", "query"]),
  tool(
    "craft_host_adapter_dispatch",
    "Lease only the next safe route action to a compatible Host Adapter.",
    ["host_adapter_id", "route_id"],
    false,
    ["host_adapter_version", "dispatch_id"]
  ),
  tool(
    "craft_host_adapter_report",
    "Record a Host Adapter dispatch completion without fabricating route evidence.",
    ["dispatch_id", "status", "summary"]
  ),
  tool(
    "craft_route_workflow_proposal_create",
    "Create only a draft Workflow from two or more passed evidence-backed safe routes; promotion still requires evaluation.",
    ["route_id", "name", "steps"],
    false,
    ["workflow_id", "description", "inputs"]
  ),
  tool(
    "craft_default_route_update",
    "Record one required safe-plan stage with real evidence; the final stage records the route Outcome.",
    ["route_id", "stage_id", "summary"],
    false,
    ["artifact_ids", "evidence_ids", "receipt_ids", "verdict"]
  ),
  tool("craft_task_open", "Create a durable task or resume one by ID.", [], false, ["task_id", "title", "goal", "project_id"]),
  tool("craft_task_list", "List durable tasks.", [], true, ["limit", "status", "project_id"]),
  tool("craft_task_checkpoint", "Persist task progress, evidence references, and pending work.", ["task_id", "summary"], false, ["completed", "pending", "decisions", "artifacts", "status", "source"]),
  tool("craft_feedback_record", "Record an explicit scoped correction or preference.", ["corrected"], false, ["kind", "scope", "task_id", "original", "applies_to", "source"]),
  tool("craft_artifact_register", "Register a portable artifact reference.", ["kind", "name", "uri"], false, ["artifact_id", "media_type", "digest", "size_bytes", "producer_type", "producer_id", "metadata"]),
  tool("craft_artifact_get", "Read an artifact reference.", ["artifact_id"], true),
  tool("craft_artifact_list", "List artifact references.", [], true, ["limit", "query"]),
  tool("craft_evidence_record", "Record a claim with source and confidence.", ["source_type", "claim"], false, ["evidence_id", "confidence", "artifact_id", "locator", "observed_at", "metadata"]),
  tool("craft_evidence_get", "Read an evidence record.", ["evidence_id"], true),
  tool("craft_evidence_list", "List evidence records.", [], true, ["limit", "query"]),
  tool("craft_workflow_save", "Save a new draft workflow version.", ["name"], false, ["workflow_id", "inputs", "steps", "description"]),
  tool("craft_workflow_get", "Read a workflow version.", ["workflow_id"], true, ["version"]),
  tool("craft_workflow_search", "Search reusable workflows.", [], true, ["limit", "query"]),
  tool("craft_workflow_plan", "Resolve inputs and side-effect approvals without executing.", ["workflow_id"], true, ["version", "inputs", "allow_execution", "approved_side_effects"]),
  tool("craft_workflow_run", "Execute deterministic Workflow steps with explicit side-effect approval.", ["workflow_id", "project_root"], false, ["version", "inputs", "allow_execution", "approved_side_effects"]),
  tool(
    "craft_workflow_trial_run",
    "Execute a Workflow and automatically capture its Trial, Trace, Artifact, Evidence, and Outcome.",
    ["task_id", "workflow_id", "project_root"],
    false,
    [
      "trial_id",
      "case_id",
      "version",
      "inputs",
      "allow_execution",
      "approved_side_effects",
      "harness_configuration_id",
      "harness_configuration_version",
      "environment",
      "budget"
    ]
  ),
  tool("craft_workflow_run_get", "Read a durable Workflow execution receipt.", ["run_id"], true),
  tool(
    "craft_workflow_transition",
    "Move a workflow through draft, candidate, verified, or deprecated with evidence gates.",
    ["workflow_id", "target", "reason"],
    false,
    ["evaluation_run_id", "signoff_id"]
  ),
  tool(
    "craft_workflow_rollback",
    "Restore a previously verified workflow version as the latest version.",
    ["workflow_id", "target_version", "reason"]
  ),
  tool(
    "craft_experience_pattern_create",
    "Derive a reusable experience pattern from at least two completed Trials and their Evidence references.",
    ["task_id", "summary", "success_strategy", "applicability", "trial_ids", "evidence_ids", "failure_modes"],
    false,
    ["pattern_id"]
  ),
  tool("craft_experience_pattern_get", "Read an experience pattern.", ["pattern_id"], true, ["version"]),
  tool("craft_experience_pattern_list", "List reusable experience patterns.", [], true, ["limit", "query"]),
  tool("craft_experience_candidate_list", "List automatic Experience Pattern candidates backed by at least two completed Trials with Evidence.", [], true),
  tool(
    "craft_skill_proposal_create",
    "Save a versioned SKILL.md candidate derived from Experience Patterns; this does not change any source file.",
    ["name", "summary", "skill_markdown", "pattern_ids"],
    false,
    ["proposal_id"]
  ),
  tool("craft_skill_proposal_get", "Read a versioned Skill candidate.", ["proposal_id"], true, ["version"]),
  tool("craft_skill_proposal_list", "List Skill candidates.", [], true, ["limit", "query"]),
  tool(
    "craft_skill_proposal_transition",
    "Move a Skill candidate through the existing held-out Evaluation and Signoff Gate.",
    ["proposal_id", "target", "reason"],
    false,
    ["evaluation_run_id", "signoff_id"]
  ),
  tool(
    "craft_skill_proposal_rollback",
    "Restore a previously verified Skill candidate version as the latest version.",
    ["proposal_id", "target_version", "reason"]
  ),
  tool(
    "craft_skill_proposal_publish",
    "Write only a verified Skill candidate to an existing SKILL.md with explicit authorization, digest protection, and backup.",
    ["proposal_id", "source_id", "target_path", "expected_digest", "allow_external_write"],
    false,
    ["publication_id"]
  ),
  tool("craft_skill_publication_get", "Read a Skill publication receipt.", ["publication_id"], true, ["version"]),
  tool("craft_skill_publication_list", "List Skill publication receipts.", [], true, ["limit", "query"]),
  tool(
    "craft_skill_publication_rollback",
    "Restore a published SKILL.md only when its digest still matches the published candidate.",
    ["publication_id", "expected_digest", "allow_external_write"]
  ),
  tool("craft_eval_suite_save", "Save an immutable evaluation suite.", ["name"], false, ["suite_id", "cases", "description", "scope"]),
  tool("craft_eval_suite_get", "Read an evaluation suite.", ["suite_id"], true, ["version"]),
  tool("craft_eval_suite_list", "Search evaluation suites.", [], true, ["limit", "query"]),
  tool(
    "craft_harness_configuration_save",
    "Save a versioned six-dimensional harness configuration.",
    ["name", "dimensions"],
    false,
    ["configuration_id", "description"]
  ),
  tool(
    "craft_harness_configuration_get",
    "Read a harness configuration version.",
    ["configuration_id"],
    true,
    ["version"]
  ),
  tool("craft_harness_configuration_list", "List harness configurations.", [], true, ["limit", "query"]),
  tool(
    "craft_trial_start",
    "Create an immutable execution trial linked to a task and exact subject version.",
    ["task_id", "subject_type", "subject_id", "subject_version"],
    false,
    ["trial_id", "case_id", "harness_configuration_id", "harness_configuration_version", "environment", "budget"]
  ),
  tool(
    "craft_trial_trace_append",
    "Append an immutable trace event to a trial.",
    ["trial_id", "event_type"],
    false,
    ["source", "data", "artifact_ids", "evidence_ids"]
  ),
  tool("craft_trial_get", "Read a trial with its trace and outcome.", ["trial_id"], true),
  tool("craft_trial_list", "List immutable trials.", [], true, ["limit", "query"]),
  tool(
    "craft_outcome_record",
    "Record the single immutable outcome for a trial.",
    ["trial_id", "verdict", "summary"],
    false,
    ["failure_type", "scores", "costs", "evidence_ids", "source"]
  ),
  tool(
    "craft_evaluation_run_record",
    "Record a reproducible evaluation from completed trials in one suite partition.",
    ["suite_id", "split", "subject_type", "subject_id", "subject_version", "trial_ids"],
    false,
    ["run_id", "suite_version", "metrics"]
  ),
  tool("craft_evaluation_run_get", "Read an immutable evaluation run.", ["run_id"], true),
  tool("craft_evaluation_run_list", "List evaluation runs.", [], true, ["limit", "query"]),
  tool("craft_evaluation_run_aggregate", "Compute reproducible quality, score, cost, duration, and failure aggregates for an evaluation run.", ["run_id"], true),
  tool(
    "craft_evaluation_compare",
    "Compare two runs only when suite version, split, subject type, and case set match.",
    ["baseline_run_id", "candidate_run_id"],
    false,
    ["comparison_id"]
  ),
  tool("craft_evaluation_comparison_get", "Read an immutable evaluation comparison.", ["comparison_id"], true),
  tool("craft_evaluation_comparison_list", "List immutable evaluation comparisons.", [], true, ["limit", "query"]),
  tool(
    "craft_grader_save",
    "Save a versioned program, model, human, or operational grader.",
    ["name", "grader_type"],
    false,
    ["grader_id", "description", "configuration"]
  ),
  tool("craft_grader_get", "Read an exact grader version.", ["grader_id"], true, ["version"]),
  tool("craft_grader_list", "List graders.", [], true, ["limit", "query"]),
  tool(
    "craft_grade_record",
    "Record one immutable grade for a Trial and exact Grader version.",
    ["trial_id", "grader_id", "grader_version", "verdict", "summary"],
    false,
    ["score", "evidence_ids", "metadata"]
  ),
  tool("craft_grade_get", "Read an immutable grade.", ["grade_id"], true),
  tool("craft_grade_list", "List grades.", [], true, ["limit", "query"]),
  tool(
    "craft_signoff_policy_save",
    "Save a versioned policy for evaluation and grader requirements.",
    ["name"],
    false,
    ["policy_id", "description", "requirements", "require_held_out", "require_outcome_passed"]
  ),
  tool("craft_signoff_policy_get", "Read a signoff policy version.", ["policy_id"], true, ["version"]),
  tool("craft_signoff_policy_list", "List signoff policies.", [], true, ["limit", "query"]),
  tool(
    "craft_signoff_evaluate",
    "Evaluate an immutable signoff decision from an Evaluation Run and explicit Grades.",
    ["policy_id", "evaluation_run_id"],
    false,
    ["signoff_id", "policy_version", "grade_ids"]
  ),
  tool("craft_signoff_get", "Read an immutable signoff decision.", ["signoff_id"], true),
  tool("craft_signoff_list", "List signoff decisions.", [], true, ["limit", "query"]),
  tool("craft_agent_profile_save", "Save a versioned cross-host agent profile.", ["name", "role", "host", "model"], false, ["profile_id", "provider", "reasoning_effort", "capabilities", "allowed_side_effects", "metadata"]),
  tool("craft_agent_profile_get", "Read an agent profile.", ["profile_id"], true, ["version"]),
  tool("craft_agent_profile_list", "List agent profiles.", [], true, ["limit", "query"]),
  tool("craft_orchestration_plan_create", "Create a dependency-aware multi-Agent plan with pinned Agent Profile versions.", ["goal", "nodes"], false, ["plan_id", "task_id", "max_concurrency", "lease_ttl_seconds", "budget", "policy"]),
  tool(
    "craft_orchestration_trial_start",
    "Create an orchestration plan and automatically capture its Trial lifecycle.",
    ["task_id", "goal", "nodes"],
    false,
    [
      "plan_id",
      "trial_id",
      "case_id",
      "max_concurrency",
      "lease_ttl_seconds",
      "policy",
      "harness_configuration_id",
      "harness_configuration_version",
      "environment",
      "budget"
    ]
  ),
  tool("craft_orchestration_plan_get", "Read a multi-Agent plan and node states.", ["plan_id"], true),
  tool("craft_orchestration_plan_list", "List multi-Agent plans.", [], true, ["limit", "query"]),
  tool("craft_orchestration_dispatch", "Lease ready nodes to a host within concurrency limits.", ["plan_id", "claimed_by"], false, ["capacity"]),
  tool(
    "craft_orchestration_renew",
    "Renew an owned orchestration lease before its TTL expires.",
    ["plan_id", "lease_id", "claimed_by"]
  ),
  tool(
    "craft_orchestration_submit",
    "Submit a leased node result; trial-backed plans capture trace, cost, evidence, and terminal outcome automatically.",
    ["plan_id", "lease_id", "verdict"],
    false,
    ["provenance", "claimed_by", "summary", "costs", "artifact_ids", "evidence_ids", "idempotency_key"]
  ),
  tool(
    "craft_orchestration_trial_finalize",
    "Idempotently reconcile a terminal trial-backed plan into its receipt, evidence, and outcome.",
    ["plan_id"],
    false
  )
];
var McpServer = class {
  service;
  handlers;
  constructor(service) {
    this.service = service;
    this.handlers = {
      craft_info: () => service.info(),
      craft_source_add: (a) => service.sourceAdd(a),
      craft_source_list: () => service.sourceList(),
      craft_source_update: (a) => service.sourceUpdate(a),
      craft_source_remove: (a) => service.sourceRemove(a),
      craft_source_scan: (a) => service.sourceScan(a),
      craft_capability_search: (a) => service.capabilitySearch(a),
      craft_capability_get: (a) => service.capabilityGet(a),
      craft_default_route: (a) => service.defaultRoute(a),
      craft_default_route_execute: (a) => service.defaultRouteExecute(a),
      craft_default_route_resume: (a) => service.defaultRouteResume(a),
      craft_default_route_find: (a) => service.defaultRouteFind(a),
      craft_project_policy_save: (a) => service.projectPolicySave(a),
      craft_project_policy_get: (a) => service.get("project_policy", "policy_id", a),
      craft_project_policy_list: (a) => service.list("project_policy", "policies", a),
      craft_route_receipt_record: (a) => service.routeReceiptRecord(a),
      craft_host_adapter_save: (a) => service.hostAdapterSave(a),
      craft_host_adapter_get: (a) => service.get("host_adapter", "host_adapter_id", a),
      craft_host_adapter_list: (a) => service.list("host_adapter", "host_adapters", a),
      craft_host_adapter_dispatch: (a) => service.hostAdapterDispatch(a),
      craft_host_adapter_report: (a) => service.hostAdapterReport(a),
      craft_route_workflow_proposal_create: (a) => service.routeWorkflowProposalCreate(a),
      craft_default_route_update: (a) => service.defaultRouteUpdate(a),
      craft_task_open: (a) => service.taskOpen(a),
      craft_task_list: (a) => service.taskList(a),
      craft_task_checkpoint: (a) => service.taskCheckpoint(a),
      craft_feedback_record: (a) => service.feedbackRecord(a),
      craft_artifact_register: (a) => service.artifactRegister(a),
      craft_artifact_get: (a) => service.get("artifact", "artifact_id", a),
      craft_artifact_list: (a) => service.list("artifact", "artifacts", a),
      craft_evidence_record: (a) => service.evidenceRecord(a),
      craft_evidence_get: (a) => service.get("evidence", "evidence_id", a),
      craft_evidence_list: (a) => service.list("evidence", "evidence", a),
      craft_workflow_save: (a) => service.workflowSave(a),
      craft_workflow_get: (a) => service.get("workflow", "workflow_id", a),
      craft_workflow_search: (a) => service.list("workflow", "workflows", a),
      craft_workflow_plan: (a) => service.workflowPlan(a),
      craft_workflow_run: (a) => service.workflowRun(a),
      craft_workflow_trial_run: (a) => service.workflowTrialRun(a),
      craft_workflow_run_get: (a) => service.get("workflow_run", "run_id", a),
      craft_workflow_transition: (a) => service.workflowTransition(a),
      craft_workflow_rollback: (a) => service.workflowRollback(a),
      craft_experience_pattern_create: (a) => service.experiencePatternCreate(a),
      craft_experience_pattern_get: (a) => service.get("experience_pattern", "pattern_id", a),
      craft_experience_pattern_list: (a) => service.list("experience_pattern", "patterns", a),
      craft_experience_candidate_list: (a) => service.experienceCandidateList(a),
      craft_skill_proposal_create: (a) => service.skillProposalCreate(a),
      craft_skill_proposal_get: (a) => service.get("skill_proposal", "proposal_id", a),
      craft_skill_proposal_list: (a) => service.list("skill_proposal", "proposals", a),
      craft_skill_proposal_transition: (a) => service.skillProposalTransition(a),
      craft_skill_proposal_rollback: (a) => service.skillProposalRollback(a),
      craft_skill_proposal_publish: (a) => service.skillProposalPublish(a),
      craft_skill_publication_get: (a) => service.get("skill_publication", "publication_id", a),
      craft_skill_publication_list: (a) => service.list("skill_publication", "publications", a),
      craft_skill_publication_rollback: (a) => service.skillPublicationRollback(a),
      craft_eval_suite_save: (a) => service.evaluationSuiteSave(a),
      craft_eval_suite_get: (a) => service.get("evaluation_suite", "suite_id", a),
      craft_eval_suite_list: (a) => service.list("evaluation_suite", "suites", a),
      craft_harness_configuration_save: (a) => service.harnessConfigurationSave(a),
      craft_harness_configuration_get: (a) => service.get("harness_configuration", "configuration_id", a),
      craft_harness_configuration_list: (a) => service.list("harness_configuration", "configurations", a),
      craft_trial_start: (a) => service.trialStart(a),
      craft_trial_trace_append: (a) => service.trialTraceAppend(a),
      craft_trial_get: (a) => service.trialGet(a),
      craft_trial_list: (a) => service.list("trial", "trials", a),
      craft_outcome_record: (a) => service.outcomeRecord(a),
      craft_evaluation_run_record: (a) => service.evaluationRunRecord(a),
      craft_evaluation_run_get: (a) => service.get("evaluation_run", "run_id", a),
      craft_evaluation_run_list: (a) => service.list("evaluation_run", "runs", a),
      craft_evaluation_run_aggregate: (a) => service.evaluationRunAggregate(a),
      craft_evaluation_compare: (a) => service.evaluationCompare(a),
      craft_evaluation_comparison_get: (a) => service.get("evaluation_comparison", "comparison_id", a),
      craft_evaluation_comparison_list: (a) => service.list("evaluation_comparison", "comparisons", a),
      craft_grader_save: (a) => service.graderSave(a),
      craft_grader_get: (a) => service.get("grader", "grader_id", a),
      craft_grader_list: (a) => service.list("grader", "graders", a),
      craft_grade_record: (a) => service.gradeRecord(a),
      craft_grade_get: (a) => service.get("grade", "grade_id", a),
      craft_grade_list: (a) => service.list("grade", "grades", a),
      craft_signoff_policy_save: (a) => service.signoffPolicySave(a),
      craft_signoff_policy_get: (a) => service.get("signoff_policy", "policy_id", a),
      craft_signoff_policy_list: (a) => service.list("signoff_policy", "policies", a),
      craft_signoff_evaluate: (a) => service.signoffEvaluate(a),
      craft_signoff_get: (a) => service.get("signoff", "signoff_id", a),
      craft_signoff_list: (a) => service.list("signoff", "signoffs", a),
      craft_agent_profile_save: (a) => service.saveVersioned(
        "agent_profile",
        "profile",
        a,
        ["name", "role", "host", "model"]
      ),
      craft_agent_profile_get: (a) => service.get("agent_profile", "profile_id", a),
      craft_agent_profile_list: (a) => service.list("agent_profile", "profiles", a),
      craft_orchestration_plan_create: (a) => service.orchestrationCreate(a),
      craft_orchestration_trial_start: (a) => service.orchestrationTrialStart(a),
      craft_orchestration_plan_get: (a) => service.get("orchestration_plan", "plan_id", a),
      craft_orchestration_plan_list: (a) => service.list("orchestration_plan", "plans", a),
      craft_orchestration_dispatch: (a) => service.orchestrationDispatch(a),
      craft_orchestration_renew: (a) => service.orchestrationRenew(a),
      craft_orchestration_submit: (a) => service.orchestrationSubmit(a),
      craft_orchestration_trial_finalize: (a) => service.orchestrationTrialFinalize(a)
    };
  }
  async handle(message) {
    if (!message || typeof message !== "object" || Array.isArray(message)) return this.error(null, -32600, "Invalid Request");
    const request = message;
    if (request.jsonrpc !== void 0 && request.jsonrpc !== "2.0" || typeof request.method !== "string") {
      return this.error(request.id ?? null, -32600, "Invalid Request");
    }
    if (request.method === "notifications/initialized" || request.id === void 0) return void 0;
    if (request.method === "initialize") {
      const requested = request.params?.protocolVersion;
      const version = ["2025-03-26", "2025-06-18", "2025-11-25"].includes(String(requested)) ? requested : "2025-11-25";
      return this.ok(request.id, {
        protocolVersion: version,
        capabilities: { tools: {} },
        serverInfo: { name: "craft", version: VERSION }
      });
    }
    if (request.method === "ping") return this.ok(request.id, {});
    if (request.method === "tools/list") return this.ok(request.id, { tools: TOOLS });
    if (request.method !== "tools/call") return this.error(request.id, -32601, `Method not found: ${request.method}`);
    if (!request.params || typeof request.params !== "object" || Array.isArray(request.params)) {
      return this.error(request.id, -32602, "Tool call params must be an object");
    }
    const params = request.params;
    const handler = this.handlers[String(params.name)];
    if (!handler) return this.error(request.id, -32602, `Unknown tool: ${params.name}`);
    try {
      const supplied = params.arguments ?? {};
      if (!supplied || typeof supplied !== "object" || Array.isArray(supplied)) {
        return this.error(request.id, -32602, "Tool arguments must be an object");
      }
      const result = await handler(supplied);
      return this.ok(request.id, {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        structuredContent: result,
        isError: false
      });
    } catch (error) {
      return this.ok(request.id, {
        content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
        isError: true
      });
    }
  }
  ok(requestId, result) {
    return { jsonrpc: "2.0", id: requestId, result };
  }
  error(requestId, code, message) {
    return { jsonrpc: "2.0", id: requestId, error: { code, message } };
  }
};

// bin/craft-mcp.ts
async function main() {
  const store = await new CraftStore().open();
  const server = new McpServer(new CraftService(store));
  const input = (0, import_node_readline.createInterface)({ input: process.stdin, crlfDelay: Infinity });
  try {
    for await (const line of input) {
      let response;
      try {
        response = await server.handle(JSON.parse(line));
      } catch {
        response = { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } };
      }
      if (response) process.stdout.write(`${JSON.stringify(response)}
`);
    }
  } finally {
    store.close();
  }
}
main().catch(() => {
  process.stderr.write("Craft MCP failed to start.\n");
  process.exitCode = 1;
});
