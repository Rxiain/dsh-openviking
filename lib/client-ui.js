window.__ModuleLoader__.load({
	id: "dsh-openviking",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/client-ui.tsx
var client_ui_exports = {};
__export(client_ui_exports, {
  apply: () => apply,
  inject: () => inject
});
module.exports = __toCommonJS(client_ui_exports);
var import_dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");
var import_react = require("react");

// src/bridge-protocol.ts
var OPENVIKING_SETTINGS_BRIDGE_PREFIX = "/api/dsh-openviking";

// src/client-ui/compat-scope.ts
var SnapshotStore = class {
  snapshot;
  listeners = /* @__PURE__ */ new Set();
  constructor(initial) {
    this.snapshot = initial;
  }
  /** Stable reference between replacements. */
  getSnapshot() {
    return this.snapshot;
  }
  /** Subscribe to replacements; returns the disposer. */
  subscribe(listener) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  /** Replace the snapshot and notify every listener. */
  set(next) {
    this.snapshot = next;
    for (const listener of [...this.listeners]) listener();
  }
  /** Shallow-copy the snapshot, mutate the copy, and publish it. */
  update(mutate) {
    const next = { ...this.snapshot };
    mutate(next);
    this.set(next);
  }
};
function isBridgeResult(value) {
  if (typeof value !== "object" || value === null) return false;
  const record = value;
  if (typeof record.ok !== "boolean") return false;
  if (record.ok) return typeof record.value === "object" && record.value !== null;
  return typeof record.code === "string" && typeof record.message === "string";
}
function createBridgeApi(fetchFn) {
  const post = async (path, body) => {
    try {
      const response = await fetchFn(OPENVIKING_SETTINGS_BRIDGE_PREFIX + path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body)
      });
      if (!response.ok) return { result: { ok: false, code: "internal", message: "bridge HTTP " + response.status } };
      const parsed = await response.json();
      if (!isBridgeResult(parsed)) return { result: { ok: false, code: "internal", message: "bridge malformed response" } };
      return { result: parsed };
    } catch {
      return { result: { ok: false, code: "internal", message: "settings bridge unreachable" } };
    }
  };
  return {
    settings: {
      describe: async (payload) => post("/describe", payload),
      mutate: async (payload) => post("/mutate", payload)
    }
  };
}
var BridgeScopeController = class {
  constructor(api, spec) {
    this.api = api;
    this.spec = spec;
    this.store = new SnapshotStore({
      status: "loading",
      value: void 0,
      base: void 0,
      user: void 0,
      revision: void 0,
      writable: false,
      mode: "host"
    });
  }
  api;
  spec;
  store;
  tail = Promise.resolve();
  disposed = false;
  getSnapshot() {
    return this.store.getSnapshot();
  }
  subscribe(listener) {
    return this.store.subscribe(listener);
  }
  /** Queue a Host refresh; a newer read or user write suppresses stale publication. */
  load() {
    return this.enqueue(() => this.read());
  }
  set(field, value) {
    return this.write({ op: "set", path: [field], value });
  }
  unset(field) {
    return this.write({ op: "unset", path: [field] });
  }
  /**
   * Apply every write in one mutation (the card's atomic save path). Per-field
   * success is read from the fresh view so a field the Host silently failed to
   * hold is not cleared on the card.
   * @param writes - the durable writes, in order.
   * @returns the batch outcome.
   */
  async mutate(writes) {
    if (writes.length === 0) return { ok: true, fields: [] };
    const result = await this.postMutate(
      writes.map(
        (write) => write.op === "set" ? { op: "set", path: [write.field], value: write.value } : { op: "unset", path: [write.field] }
      )
    );
    if (!result.ok) {
      await this.load();
      return {
        ok: false,
        fields: [],
        ...result.code !== void 0 ? { code: result.code } : {},
        ...result.message !== void 0 ? { message: result.message } : {}
      };
    }
    this.accept(result.view);
    const view = this.getSnapshot();
    return {
      ok: true,
      fields: writes.map((write) => ({
        field: write.field,
        landed: this.landed(view, write)
      }))
    };
  }
  /** Whether the fresh user layer holds (or, for unset, no longer holds) the write. */
  landed(view, write) {
    const user = view.user;
    if (write.op === "unset") return user === void 0 || !Object.hasOwn(user, write.field);
    return user !== void 0 && user[write.field] === write.value;
  }
  write(op) {
    return this.enqueue(async () => {
      const result = await this.postMutate([op]);
      if (result.ok) this.accept(result.view);
      else await this.read();
    });
  }
  /** One revision-fenced mutate POST, collapsing transport failures into a refusal. */
  async postMutate(ops) {
    const revision = this.getSnapshot().revision;
    let response;
    try {
      response = await this.api.settings.mutate({
        ns: String(this.spec.namespace),
        ops,
        ...revision === void 0 ? {} : { expectedRevision: revision }
      });
    } catch {
      return { ok: false };
    }
    if (!response.result.ok) {
      return { ok: false, code: response.result.code, message: response.result.message };
    }
    return { ok: true, view: response.result.value };
  }
  enqueue(operation) {
    if (this.disposed) return Promise.resolve();
    const task = this.tail.then(async () => {
      if (this.disposed) return;
      await operation();
    });
    this.tail = task.catch(() => {
    });
    return task;
  }
  async read() {
    let response;
    try {
      response = await this.api.settings.describe({});
    } catch {
      return;
    }
    if (!response.result.ok || this.disposed) return;
    const value = response.result.value;
    if (!("namespaces" in value)) return;
    const view = value.namespaces.find((candidate) => candidate.ns === String(this.spec.namespace));
    if (view === void 0) {
      this.store.update((draft) => {
        draft.status = "unavailable";
      });
      return;
    }
    this.accept(view);
    this.store.update((draft) => {
      draft.writable = value.writable;
    });
  }
  /** Fold one bridge namespace view into the snapshot (value, base, user, revision). */
  accept(view) {
    this.store.update((draft) => {
      draft.revision = view.revision;
      draft.base = view.base;
      draft.user = view.user;
      draft.status = "ready";
      draft.value = view.value;
    });
  }
};
function createCompatScope(options) {
  const { namespace, primary } = options;
  const fallback = options.fetchFn === void 0 ? void 0 : new BridgeScopeController(createBridgeApi(options.fetchFn), { namespace });
  const store = new SnapshotStore(project());
  let fallbackStarted = false;
  const publish = () => {
    store.set(project());
  };
  const startFallback = () => {
    if (fallback === void 0 || fallbackStarted) return;
    fallbackStarted = true;
    void fallback.load();
  };
  function project() {
    const primarySnapshot = primary.getSnapshot();
    if (primarySnapshot.status === "ready" || fallback === void 0) return primarySnapshot;
    if (primarySnapshot.status === "loading") return primarySnapshot;
    const bridgeSnapshot = fallback.getSnapshot();
    if (bridgeSnapshot.status === "ready") return bridgeSnapshot;
    if (bridgeSnapshot.status === "loading") return { ...primarySnapshot, status: "loading" };
    return primarySnapshot;
  }
  primary.subscribe(() => {
    publish();
    if (primary.getSnapshot().status === "unavailable") startFallback();
  });
  fallback?.subscribe(publish);
  if (primary.getSnapshot().status === "unavailable") startFallback();
  const active = () => primary.getSnapshot().status === "ready" ? primary : fallback ?? primary;
  return {
    getSnapshot: () => store.getSnapshot(),
    subscribe: (listener) => store.subscribe(listener),
    set: (field, value) => active().set(field, value),
    unset: (field) => active().unset(field),
    load: async () => {
      fallbackStarted = true;
      await fallback?.load();
      await primary.load();
    },
    // The batch surface exists only while the bridge controller is the active
    // transport; the official scope path still writes per-field. A getter
    // keeps the capability decision at call time instead of freezing it when
    // the wrapper is built.
    get mutate() {
      const backend = active();
      if (fallback !== void 0 && backend === fallback) return fallback.mutate.bind(fallback);
      return void 0;
    }
  };
}

// src/client-ui.tsx
var import_jsx_runtime = require("react/jsx-runtime");
var en = {
  cardTitle: "OpenViking",
  cardDescription: "OpenViking retrieval, resource management, auto-recall and session memory.",
  groupConnection: "Connection",
  groupRepoContext: "Repository context",
  groupAutoRecall: "Auto recall",
  groupAutoCommit: "Auto commit",
  fieldEndpoint: "Service endpoint",
  fieldEndpointHint: "OpenViking HTTP service base URL.",
  fieldApiKey: "API key",
  fieldApiKeyHint: "X-API-Key request header; empty omits the header.",
  fieldAccount: "Account",
  fieldAccountHint: "X-OpenViking-Account tenant header; empty omits it.",
  fieldUser: "User",
  fieldUserHint: "X-OpenViking-User header; empty omits it.",
  fieldAgentId: "Agent id",
  fieldAgentIdHint: "X-OpenViking-Agent identifier header.",
  fieldTimeoutMs: "Request timeout (ms)",
  fieldTimeoutMsHint: "Per-request timeout; 1000\u2013300000.",
  fieldStateFile: "Session state file",
  fieldStateFileHint: "Where synced message ids are persisted; applies on restart.",
  fieldRepoEnabled: "Inject repository list",
  fieldRepoEnabledHint: "List indexed repositories into the system prompt.",
  fieldCacheTtlMs: "Repository cache TTL (ms)",
  fieldCacheTtlMsHint: "How long the repository list cache stays valid.",
  fieldRecallEnabled: "Auto-recall memories",
  fieldRecallEnabledHint: "Search relevant memories before each model step.",
  fieldRecallLimit: "Memories per step",
  fieldRecallLimitHint: "Maximum memories injected per step (1\u201350).",
  fieldScoreThreshold: "Minimum score",
  fieldScoreThresholdHint: "Non-leaf filler memories below this score are dropped (0\u20131).",
  fieldMaxContentChars: "Memory content cap (chars)",
  fieldMaxContentCharsHint: "Per-memory content character cap (100\u20135000).",
  fieldTokenBudget: "Token budget",
  fieldTokenBudgetHint: "Injected block is capped at tokenBudget \xD7 4 characters (100\u201310000).",
  fieldAgentSpaces: "Also search agent space",
  fieldAgentSpacesHint: "Recall cases/patterns/tools/skills memories and skill playbooks from the agent space too.",
  fieldRefreshSteps: "Refresh every N tool steps",
  fieldRefreshStepsHint: "Re-search mid-message every N tool steps and inject only new memories (0 disables).",
  fieldStartupMapEveryTurns: "Refresh memory map every N user turns",
  fieldStartupMapEveryTurnsHint: "Memory-library map: injected at session start, then refreshed every N user turns (1 = start only, 0 = never).",
  fieldCommitEnabled: "Auto-commit sessions",
  fieldCommitEnabledHint: "Periodically commit sessions with uncommitted messages.",
  fieldTurns: "Commit after N user turns",
  fieldTurnsHint: "Commit once N uncommitted user turns accumulate (0 disables the turn trigger).",
  fieldIntervalMinutes: "Commit interval (min)",
  fieldIntervalMinutesHint: "Wall-clock fallback; commits dirty sessions older than this (after the first commit).",
  overridden: "Overridden",
  reset: "Reset to default",
  readOnly: "This deployment stores settings read-only.",
  expand: "Show settings",
  collapse: "Hide settings",
  save: "Save",
  saving: "Saving\u2026",
  discard: "Discard",
  unsaved: "Unsaved",
  saveFailed: "The deployment did not accept these values; they were left for you to correct.",
  invalidNumber: "Enter a number, or leave blank to use the default."
};
var zh = {
  cardTitle: "OpenViking",
  cardDescription: "OpenViking \u68C0\u7D22\u3001\u8D44\u6E90\u7BA1\u7406\u3001\u81EA\u52A8\u53EC\u56DE\u4E0E\u4F1A\u8BDD\u8BB0\u5FC6\u3002",
  groupConnection: "\u8FDE\u63A5",
  groupRepoContext: "\u4ED3\u5E93\u4E0A\u4E0B\u6587",
  groupAutoRecall: "\u81EA\u52A8\u53EC\u56DE",
  groupAutoCommit: "\u81EA\u52A8\u63D0\u4EA4",
  fieldEndpoint: "\u670D\u52A1\u5730\u5740",
  fieldEndpointHint: "OpenViking HTTP \u670D\u52A1\u5730\u5740\u3002",
  fieldApiKey: "API \u5BC6\u94A5",
  fieldApiKeyHint: "X-API-Key \u8BF7\u6C42\u5934\uFF1B\u7559\u7A7A\u5219\u4E0D\u53D1\u9001\u3002",
  fieldAccount: "\u79DF\u6237\uFF08Account\uFF09",
  fieldAccountHint: "X-OpenViking-Account \u8BF7\u6C42\u5934\uFF1B\u7559\u7A7A\u5219\u4E0D\u53D1\u9001\u3002",
  fieldUser: "\u7528\u6237\uFF08User\uFF09",
  fieldUserHint: "X-OpenViking-User \u8BF7\u6C42\u5934\uFF1B\u7559\u7A7A\u5219\u4E0D\u53D1\u9001\u3002",
  fieldAgentId: "Agent \u6807\u8BC6",
  fieldAgentIdHint: "X-OpenViking-Agent \u8BF7\u6C42\u5934\u3002",
  fieldTimeoutMs: "\u8BF7\u6C42\u8D85\u65F6\uFF08\u6BEB\u79D2\uFF09",
  fieldTimeoutMsHint: "\u5355\u6B21\u8BF7\u6C42\u8D85\u65F6\uFF1B\u8303\u56F4 1000\u2013300000\u3002",
  fieldStateFile: "\u4F1A\u8BDD\u72B6\u6001\u6587\u4EF6",
  fieldStateFileHint: "\u5DF2\u540C\u6B65\u6D88\u606F id \u7684\u6301\u4E45\u5316\u4F4D\u7F6E\uFF1B\u91CD\u542F\u540E\u751F\u6548\u3002",
  fieldRepoEnabled: "\u6CE8\u5165\u4ED3\u5E93\u5217\u8868",
  fieldRepoEnabledHint: "\u628A\u5DF2\u7D22\u5F15\u4ED3\u5E93\u5217\u8868\u6CE8\u5165\u7CFB\u7EDF\u63D0\u793A\u8BCD\u3002",
  fieldCacheTtlMs: "\u4ED3\u5E93\u7F13\u5B58 TTL\uFF08\u6BEB\u79D2\uFF09",
  fieldCacheTtlMsHint: "\u4ED3\u5E93\u5217\u8868\u7F13\u5B58\u7684\u6709\u6548\u65F6\u957F\u3002",
  fieldRecallEnabled: "\u81EA\u52A8\u53EC\u56DE\u8BB0\u5FC6",
  fieldRecallEnabledHint: "\u6BCF\u4E2A\u6A21\u578B\u6B65\u9AA4\u524D\u68C0\u7D22\u76F8\u5173\u8BB0\u5FC6\u3002",
  fieldRecallLimit: "\u6BCF\u6B65\u8BB0\u5FC6\u6761\u6570",
  fieldRecallLimitHint: "\u6BCF\u6B65\u6700\u591A\u6CE8\u5165\u7684\u8BB0\u5FC6\u6761\u6570\uFF081\u201350\uFF09\u3002",
  fieldScoreThreshold: "\u6700\u4F4E\u5206\u6570",
  fieldScoreThresholdHint: "\u4F4E\u4E8E\u8BE5\u5206\u6570\u7684\u975E\u53F6\u586B\u5145\u8BB0\u5FC6\u88AB\u4E22\u5F03\uFF080\u20131\uFF09\u3002",
  fieldMaxContentChars: "\u5355\u6761\u8BB0\u5FC6\u4E0A\u9650\uFF08\u5B57\u7B26\uFF09",
  fieldMaxContentCharsHint: "\u5355\u6761\u8BB0\u5FC6\u5185\u5BB9\u5B57\u7B26\u4E0A\u9650\uFF08100\u20135000\uFF09\u3002",
  fieldTokenBudget: "Token \u9884\u7B97",
  fieldTokenBudgetHint: "\u6CE8\u5165\u5757\u4E0A\u9650\u7EA6\u4E3A tokenBudget \xD7 4 \u5B57\u7B26\uFF08100\u201310000\uFF09\u3002",
  fieldAgentSpaces: "\u540C\u65F6\u68C0\u7D22 agent \u7A7A\u95F4",
  fieldAgentSpacesHint: "\u540C\u65F6\u53EC\u56DE agent \u7A7A\u95F4\u7684 cases/patterns/tools/skills \u8BB0\u5FC6\u4E0E\u6280\u80FD\u624B\u518C\u3002",
  fieldRefreshSteps: "\u6BCF N \u4E2A\u5DE5\u5177\u6B65\u9AA4\u5237\u65B0",
  fieldRefreshStepsHint: "\u540C\u4E00\u6761\u6D88\u606F\u5185\u6BCF N \u6B65\u91CD\u65B0\u68C0\u7D22\u4E00\u6B21\uFF0C\u53EA\u6CE8\u5165\u65B0\u8BB0\u5FC6\uFF080 \u5173\u95ED\uFF09\u3002",
  fieldStartupMapEveryTurns: "\u6BCF N \u4E2A\u7528\u6237\u56DE\u5408\u5237\u65B0\u8BB0\u5FC6\u5730\u56FE",
  fieldStartupMapEveryTurnsHint: "\u4F1A\u8BDD\u542F\u52A8\u6CE8\u5165\u4E00\u6B21\u8BB0\u5FC6\u5E93\u6982\u89C8\uFF0C\u4E4B\u540E\u6BCF N \u4E2A\u7528\u6237\u56DE\u5408\u5237\u65B0\u4E00\u6B21\uFF081 = \u4EC5\u542F\u52A8\u65F6\uFF0C0 = \u5173\u95ED\uFF09\u3002",
  fieldCommitEnabled: "\u81EA\u52A8\u63D0\u4EA4\u4F1A\u8BDD",
  fieldCommitEnabledHint: "\u5B9A\u671F\u63D0\u4EA4\u542B\u672A\u63D0\u4EA4\u6D88\u606F\u7684\u4F1A\u8BDD\u3002",
  fieldTurns: "\u7D2F\u8BA1 N \u4E2A\u7528\u6237\u56DE\u5408\u63D0\u4EA4",
  fieldTurnsHint: "\u672A\u63D0\u4EA4\u7684\u7528\u6237\u56DE\u5408\u8FBE\u5230 N \u4E2A\u5373\u63D0\u4EA4\uFF080 \u5173\u95ED\u56DE\u5408\u89E6\u53D1\uFF09\u3002",
  fieldIntervalMinutes: "\u63D0\u4EA4\u95F4\u9694\uFF08\u5206\u949F\uFF09",
  fieldIntervalMinutesHint: "\u65F6\u95F4\u515C\u5E95\uFF1A\u5DF2\u63D0\u4EA4\u8FC7\u7684\u4F1A\u8BDD\u8D85\u8FC7\u8BE5\u95F4\u9694\u4ECD\u6709\u672A\u63D0\u4EA4\u6D88\u606F\u4E5F\u4F1A\u63D0\u4EA4\u3002",
  overridden: "\u5DF2\u8986\u76D6",
  reset: "\u6062\u590D\u9ED8\u8BA4",
  readOnly: "\u672C\u90E8\u7F72\u7684\u8BBE\u7F6E\u4E3A\u53EA\u8BFB\u3002",
  expand: "\u5C55\u5F00\u8BBE\u7F6E",
  collapse: "\u6536\u8D77\u8BBE\u7F6E",
  save: "\u4FDD\u5B58",
  saving: "\u4FDD\u5B58\u4E2D\u2026",
  discard: "\u653E\u5F03\u4FEE\u6539",
  unsaved: "\u672A\u4FDD\u5B58",
  saveFailed: "\u672C\u90E8\u7F72\u6CA1\u6709\u63A5\u53D7\u8FD9\u4E9B\u503C\uFF0C\u5DF2\u4FDD\u7559\u4F9B\u4F60\u4FEE\u6539\u3002",
  invalidNumber: "\u8BF7\u586B\u6570\u5B57\uFF1B\u7559\u7A7A\u8868\u793A\u4F7F\u7528\u9ED8\u8BA4\u503C\u3002"
};
var NS = "openviking";
var FIELDS = [
  { path: ["endpoint"], kind: "text", group: "connection", labelKey: "fieldEndpoint", hintKey: "fieldEndpointHint" },
  { path: ["apiKey"], kind: "password", group: "connection", labelKey: "fieldApiKey", hintKey: "fieldApiKeyHint" },
  { path: ["account"], kind: "text", group: "connection", labelKey: "fieldAccount", hintKey: "fieldAccountHint" },
  { path: ["user"], kind: "text", group: "connection", labelKey: "fieldUser", hintKey: "fieldUserHint" },
  { path: ["agentId"], kind: "text", group: "connection", labelKey: "fieldAgentId", hintKey: "fieldAgentIdHint" },
  { path: ["timeoutMs"], kind: "number", group: "connection", labelKey: "fieldTimeoutMs", hintKey: "fieldTimeoutMsHint" },
  { path: ["stateFile"], kind: "text", group: "connection", labelKey: "fieldStateFile", hintKey: "fieldStateFileHint" },
  { path: ["repoContext", "enabled"], kind: "bool", group: "repoContext", labelKey: "fieldRepoEnabled", hintKey: "fieldRepoEnabledHint" },
  { path: ["repoContext", "cacheTtlMs"], kind: "number", group: "repoContext", labelKey: "fieldCacheTtlMs", hintKey: "fieldCacheTtlMsHint" },
  { path: ["autoRecall", "enabled"], kind: "bool", group: "autoRecall", labelKey: "fieldRecallEnabled", hintKey: "fieldRecallEnabledHint" },
  { path: ["autoRecall", "limit"], kind: "number", group: "autoRecall", labelKey: "fieldRecallLimit", hintKey: "fieldRecallLimitHint" },
  { path: ["autoRecall", "scoreThreshold"], kind: "number", group: "autoRecall", labelKey: "fieldScoreThreshold", hintKey: "fieldScoreThresholdHint" },
  { path: ["autoRecall", "maxContentChars"], kind: "number", group: "autoRecall", labelKey: "fieldMaxContentChars", hintKey: "fieldMaxContentCharsHint" },
  { path: ["autoRecall", "tokenBudget"], kind: "number", group: "autoRecall", labelKey: "fieldTokenBudget", hintKey: "fieldTokenBudgetHint" },
  { path: ["autoRecall", "agentSpaces"], kind: "bool", group: "autoRecall", labelKey: "fieldAgentSpaces", hintKey: "fieldAgentSpacesHint" },
  { path: ["autoRecall", "refreshSteps"], kind: "number", group: "autoRecall", labelKey: "fieldRefreshSteps", hintKey: "fieldRefreshStepsHint" },
  { path: ["autoRecall", "startupMapEveryTurns"], kind: "number", group: "autoRecall", labelKey: "fieldStartupMapEveryTurns", hintKey: "fieldStartupMapEveryTurnsHint" },
  { path: ["autoCommit", "enabled"], kind: "bool", group: "autoCommit", labelKey: "fieldCommitEnabled", hintKey: "fieldCommitEnabledHint" },
  { path: ["autoCommit", "turns"], kind: "number", group: "autoCommit", labelKey: "fieldTurns", hintKey: "fieldTurnsHint" },
  { path: ["autoCommit", "intervalMinutes"], kind: "number", group: "autoCommit", labelKey: "fieldIntervalMinutes", hintKey: "fieldIntervalMinutesHint" }
];
var FIELD_BY_KEY = new Map(FIELDS.map((field) => [pathKey(field.path), field]));
function pathKey(path) {
  return path.join(".");
}
function atPath(value, path) {
  let cursor = value;
  for (const segment of path) {
    if (typeof cursor !== "object" || cursor === null || !(segment in cursor)) return void 0;
    cursor = cursor[segment];
  }
  return cursor;
}
function hasPath(value, path) {
  let cursor = value;
  for (const segment of path) {
    if (typeof cursor !== "object" || cursor === null || !(segment in cursor)) return false;
    cursor = cursor[segment];
  }
  return true;
}
function formatValue(value) {
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return String(value);
  return "";
}
var OpenVikingCardController = class {
  scope;
  staged = /* @__PURE__ */ new Map();
  listeners = /* @__PURE__ */ new Set();
  snapshot;
  saving = false;
  failed = false;
  failedReason;
  constructor(ctx) {
    const connection = ctx.get("connection");
    this.scope = createCompatScope({
      namespace: NS,
      primary: ctx.settingsScope.bind({ namespace: NS }),
      fetchFn: connection.isLoopback ? ((input, init) => fetch(input, init)) : void 0
    });
    ctx.effect(() => {
      const disposers = [];
      const remote = ctx.get("remote");
      if (remote !== void 0) {
        disposers.push(
          remote.$on("settings/document-updated", (namespace) => {
            if (namespace !== void 0 && namespace !== NS) return;
            void this.scope.load();
          })
        );
      }
      disposers.push(
        ctx.on("connection/reset", () => {
          void this.scope.load();
        })
      );
      return () => {
        for (const dispose of disposers) dispose();
      };
    }, "openviking: card scope invalidation");
    this.snapshot = this.project();
    this.scope.subscribe(() => this.publish());
  }
  // ── observable face (useSyncExternalStore) ────────────────────────────
  /** Stable snapshot reference between publications. */
  getSnapshot = () => this.snapshot;
  /** Subscribe to projection replacements. */
  subscribe = (listener) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  // ── staging actions the card binds to controls ────────────────────────
  /** Stage draft text for one text/number/password field. */
  edit(fieldKey, text) {
    this.stage(fieldKey, { kind: "text", text });
  }
  /** Stage a checkbox value for one bool field. */
  toggle(fieldKey, checked) {
    this.stage(fieldKey, { kind: "bool", checked });
  }
  /** Stage a clear, so saving lets the field re-inherit the composition layer. */
  resetField(fieldKey) {
    this.stage(fieldKey, { kind: "clear" });
  }
  /** Stage one edit; any prior failure state is cleared by the new draft. */
  stage(fieldKey, staged) {
    this.staged.set(fieldKey, staged);
    this.failed = false;
    this.failedReason = void 0;
    this.publish();
  }
  /** Drop every staged edit. */
  discard() {
    this.staged.clear();
    this.failed = false;
    this.failedReason = void 0;
    this.publish();
  }
  /** Write every staged edit, then re-seed from what the Host accepted. */
  async save() {
    if (this.saving || !this.snapshot.available || !this.snapshot.writable || this.snapshot.invalid) return;
    const writes = [];
    const fields = /* @__PURE__ */ new Set();
    for (const [fieldKey, staged] of this.staged) {
      const field = FIELD_BY_KEY.get(fieldKey);
      if (!field) continue;
      fields.add(fieldKey);
      if (staged.kind === "text") {
        if (staged.text === "") writes.push({ field: fieldKey, op: "unset" });
        else writes.push({ field: fieldKey, op: "set", value: field.kind === "number" ? Number(staged.text) : staged.text });
      } else if (staged.kind === "clear") {
        writes.push({ field: fieldKey, op: "unset" });
      } else {
        writes.push({ field: fieldKey, op: "set", value: staged.checked });
      }
    }
    this.saving = true;
    this.failed = false;
    this.failedReason = void 0;
    this.publish();
    try {
      const landed = /* @__PURE__ */ new Set();
      let accepted = true;
      let reason;
      const batch = this.scope.mutate;
      if (batch !== void 0 && writes.length > 0) {
        const result = await batch(writes);
        accepted = result.ok;
        reason = result.message;
        if (result.ok) {
          for (const field of result.fields) {
            if (field.landed) landed.add(field.field);
          }
        }
      } else {
        for (const write of writes) {
          if (write.op === "set") await this.scope.set(write.field, write.value);
          else await this.scope.unset(write.field);
          if (this.landed(write)) landed.add(write.field);
        }
      }
      await this.scope.load();
      if (accepted) {
        for (const fieldKey of fields) {
          if (landed.has(fieldKey)) this.staged.delete(fieldKey);
        }
        this.failed = landed.size !== fields.size;
        this.failedReason = this.failed ? reason : void 0;
      } else {
        this.failed = true;
        this.failedReason = reason;
      }
    } finally {
      this.saving = false;
      this.publish();
    }
  }
  /** Whether the current user layer holds (or, for unset, no longer holds) the write. */
  landed(write) {
    const user = this.scope.getSnapshot().user;
    if (write.op === "unset") return user === void 0 || !Object.hasOwn(user, write.field);
    return user !== void 0 && user[write.field] === write.value;
  }
  // ── projection ────────────────────────────────────────────────────────
  project() {
    const scope = this.scope.getSnapshot();
    const available = scope.status === "ready";
    let dirty = false;
    let invalid = false;
    const fields = {};
    for (const field of FIELDS) {
      const key = pathKey(field.path);
      const staged = this.staged.get(key);
      const effective = atPath(scope.value, field.path);
      const userHas = hasPath(scope.user, field.path);
      let text = formatValue(effective);
      let checked = Boolean(effective);
      let overridden = userHas;
      if (staged?.kind === "text") {
        text = staged.text;
        overridden = true;
        if (staged.text !== formatValue(effective)) dirty = true;
        if (field.kind === "number" && staged.text !== "" && !Number.isFinite(Number(staged.text))) invalid = true;
      } else if (staged?.kind === "bool") {
        checked = staged.checked;
        overridden = true;
        if (staged.checked !== Boolean(effective)) dirty = true;
      } else if (staged?.kind === "clear") {
        text = "";
        overridden = false;
        if (userHas) dirty = true;
      }
      fields[key] = { text, checked, overridden, invalid };
    }
    return {
      available,
      writable: scope.writable,
      dirty,
      invalid,
      saving: this.saving,
      failed: this.failed,
      ...this.failedReason === void 0 ? {} : { failedReason: this.failedReason },
      fields
    };
  }
  publish() {
    this.snapshot = this.project();
    for (const listener of [...this.listeners]) listener();
  }
};
var css = `
.ovk_card{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:12px;list-style:none;transition:border-color .16s,background .16s}
.ovk_card:hover{border-color:var(--dsw-alias-label-dimmed)}
.ovk_cardOpen{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-label-dimmed)}
.ovk_header{appearance:none;width:100%;font:inherit;color:inherit;text-align:left;cursor:pointer;background:0 0;border:0;border-radius:12px;align-items:center;gap:12px;padding:14px 16px;display:flex}
.ovk_header:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}
.ovk_headText{flex-direction:column;flex:1;gap:4px;min-width:0;display:flex}
.ovk_name{color:var(--dsw-alias-label-primary);font-size:15px;font-weight:600;line-height:1.4}
.ovk_description{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:1.5}
.ovk_chevron{color:var(--dsw-alias-label-tertiary);flex:none;transition:transform .16s}
.ovk_chevronOpen{transform:rotate(180deg)}
.ovk_body{border-top:1px solid var(--dsw-alias-border-l2);margin:0 16px;padding-bottom:8px}
.ovk_readOnly{color:var(--dsw-alias-label-tertiary);margin:12px 0 0;font-size:12px;line-height:1.5}
.ovk_pending{white-space:nowrap;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);border-radius:999px;flex:none;padding:1px 8px;font-size:11px;font-weight:500;line-height:17px}
.ovk_footer{border-top:1px solid var(--dsw-alias-border-l2);justify-content:flex-end;align-items:center;gap:8px;padding:12px 0 4px;display:flex}
.ovk_failed{min-width:0;color:var(--dsw-alias-label-error);flex:1;margin:0;font-size:12px;line-height:1.5}
.ovk_discard,.ovk_save{appearance:none;font:inherit;cursor:pointer;border:1px solid transparent;border-radius:8px;padding:5px 14px;font-size:13px;line-height:1.5}
.ovk_discard{border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);background:0 0}
.ovk_discard:hover:not(:disabled){color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-dimmed)}
.ovk_save{background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-3)}
.ovk_discard:disabled,.ovk_save:disabled{opacity:.4;cursor:default}
.ovk_discard:focus-visible,.ovk_save:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.ovk_group{margin:14px 0 2px;color:var(--dsw-alias-label-secondary);font-size:12px;font-weight:600;letter-spacing:.04em;text-transform:uppercase}
.ovk_field{flex-direction:column;gap:6px;padding:12px 0;display:flex}
.ovk_field+.ovk_field{border-top:1px solid var(--dsw-alias-border-l2)}
.ovk_head{align-items:center;gap:8px;display:flex}
.ovk_label{min-width:0;color:var(--dsw-alias-label-primary);flex:1;font-size:13px;font-weight:500;line-height:1.5}
.ovk_badges{align-items:center;gap:8px;display:inline-flex}
.ovk_badge{white-space:nowrap;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);border-radius:999px;padding:1px 8px;font-size:11px;font-weight:500;line-height:17px}
.ovk_reset{font:inherit;color:var(--dsw-alias-label-secondary);cursor:pointer;background:0 0;border:none;padding:0;font-size:12px;line-height:1.5}
.ovk_reset:hover:not(:disabled){color:var(--dsw-alias-label-primary)}
.ovk_reset:disabled{cursor:default}
.ovk_input{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);height:34px;font:inherit;color:var(--dsw-alias-label-primary);border-radius:8px;padding:0 12px;font-size:13px;line-height:1.5}
.ovk_input:focus-visible{border-color:var(--dsw-alias-brand-primary);outline:none}
.ovk_input:disabled{color:var(--dsw-alias-label-tertiary);cursor:default}
.ovk_inputInvalid{border-color:var(--dsw-alias-label-error)}
.ovk_invalid{color:var(--dsw-alias-label-error);margin:0;font-size:12px;line-height:1.5}
.ovk_hint{color:var(--dsw-alias-label-tertiary);margin:0;font-size:12px;line-height:1.5}
.ovk_check{accent-color:var(--dsw-alias-brand-primary);width:16px;height:16px;flex:none;margin:0}
.ovk_checkRow{flex-direction:row;align-items:center;gap:10px;display:flex}
`;
var cssTag = "dsh-openviking/card.css";
if (typeof document !== "undefined" && document.querySelector(`style[data-plugin-css=${JSON.stringify(cssTag)}]`) === null) {
  const tag = document.createElement("style");
  tag.dataset.plugin = "dsh-openviking";
  tag.dataset.pluginCss = cssTag;
  tag.textContent = css;
  document.head.appendChild(tag);
}
function OpenVikingField(props) {
  const { t, field, view, disabled, onEdit, onReset } = props;
  const inputId = `plugin-config-openviking-${pathKey(field.path).replaceAll(".", "-")}`;
  const control = field.kind === "bool" ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "ovk_checkRow", children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
      "input",
      {
        id: inputId,
        className: "ovk_check",
        type: "checkbox",
        checked: view.checked,
        disabled,
        onChange: (event) => {
          props.onToggle(event.target.checked);
        }
      }
    ),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("label", { className: "ovk_label", htmlFor: inputId, children: t(field.labelKey) })
  ] }) : /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(import_jsx_runtime.Fragment, { children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "ovk_head", children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("label", { className: "ovk_label", htmlFor: inputId, children: t(field.labelKey) }),
      view.overridden ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { className: "ovk_badges", children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "ovk_badge", children: t("overridden") }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", className: "ovk_reset", disabled, onClick: onReset, children: t("reset") })
      ] }) : null
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
      "input",
      {
        id: inputId,
        className: view.invalid ? "ovk_input ovk_inputInvalid" : "ovk_input",
        type: field.kind === "password" ? "password" : "text",
        inputMode: field.kind === "number" ? "numeric" : void 0,
        "aria-invalid": view.invalid || void 0,
        value: view.text,
        placeholder: "",
        disabled,
        onChange: (event) => {
          onEdit(event.target.value);
        }
      }
    )
  ] });
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "ovk_field", children: [
    control,
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: view.invalid ? "ovk_invalid" : "ovk_hint", children: view.invalid ? t("invalidNumber") : t(field.hintKey) })
  ] });
}
function OpenVikingCard(props) {
  const { t, controller } = props;
  const state = (0, import_react.useSyncExternalStore)(controller.subscribe, controller.getSnapshot);
  const [open, setOpen] = (0, import_react.useState)(false);
  if (!state.available) return null;
  const blocked = !state.dirty || state.invalid || state.saving;
  const groups = [
    { key: "connection", labelKey: "groupConnection" },
    { key: "repoContext", labelKey: "groupRepoContext" },
    { key: "autoRecall", labelKey: "groupAutoRecall" },
    { key: "autoCommit", labelKey: "groupAutoCommit" }
  ];
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("li", { className: open ? "ovk_card ovk_cardOpen" : "ovk_card", children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(
      "button",
      {
        type: "button",
        className: "ovk_header",
        "aria-expanded": open,
        "aria-label": `${t(open ? "collapse" : "expand")}: ${t("cardTitle")}`,
        onClick: () => {
          setOpen(!open);
        },
        children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { className: "ovk_headText", children: [
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "ovk_name", children: t("cardTitle") }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "ovk_description", children: t("cardDescription") })
          ] }),
          state.dirty ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "ovk_pending", children: t("unsaved") }) : null,
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.IconChevronDownOutline14, { className: open ? "ovk_chevron ovk_chevronOpen" : "ovk_chevron" })
        ]
      }
    ),
    open ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "ovk_body", children: [
      !state.writable ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: "ovk_readOnly", role: "status", children: t("readOnly") }) : null,
      groups.map((group) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("h3", { className: "ovk_group", children: t(group.labelKey) }),
        FIELDS.filter((field) => field.group === group.key).map((field) => {
          const fieldKey = pathKey(field.path);
          const view = state.fields[fieldKey];
          if (!view) return null;
          return /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
            OpenVikingField,
            {
              t,
              field,
              view,
              disabled: !state.writable,
              onEdit: (text) => {
                controller.edit(fieldKey, text);
              },
              onToggle: (checked) => {
                controller.toggle(fieldKey, checked);
              },
              onReset: () => {
                controller.resetField(fieldKey);
              }
            },
            fieldKey
          );
        })
      ] }, group.key)),
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "ovk_footer", children: [
        state.failed ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("p", { className: "ovk_failed", role: "status", children: [
          t("saveFailed"),
          state.failedReason !== void 0 && state.failedReason !== "" ? `\uFF1A${state.failedReason}` : ""
        ] }) : null,
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
          "button",
          {
            type: "button",
            className: "ovk_discard",
            disabled: !state.dirty || state.saving,
            onClick: () => {
              controller.discard();
            },
            children: t("discard")
          }
        ),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
          "button",
          {
            type: "button",
            className: "ovk_save",
            disabled: blocked,
            onClick: () => {
              void controller.save();
            },
            children: t(state.saving ? "saving" : "save")
          }
        )
      ] })
    ] }) : null
  ] });
}
var inject = ["slots", "locale", "connection", "remote", "settingsScope"];
function apply(ctx) {
  ctx.effect(() => ctx.locale.register("openviking", { en, zh }), "openviking: card dictionaries");
  const controller = new OpenVikingCardController(ctx);
  ctx.slots.inject(
    "settings.plugin.item",
    () => ctx.slots.register(
      {
        name: "settings.plugin.item",
        id: "openviking",
        order: 30,
        locale: "openviking",
        inject: () => ({ controller })
      },
      OpenVikingCard
    )
  );
}
		return module.exports;
	}
});
