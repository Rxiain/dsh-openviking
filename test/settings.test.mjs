/**
 * Settings-section tests: mount the plugin on a real Context spine with a
 * real (in-memory) settings provider, verifying namespace registration,
 * layered resolution over the composition entry, live reconfiguration of
 * request-facing fields, seam-side endpoint validation, and the browser-half
 * artifact (loader format, entry shape).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { Context } from "@deepseek-ai/cordis";
import { ToolRuntime } from "@deepseek-ai/dsh-tools";
import { SystemPrompt } from "@deepseek-ai/dsh-system-prompt";
import { FileSystem } from "@deepseek-ai/dsh-fs";
import { AgentRegistry } from "@deepseek-ai/dsh-agent";
import { SessionStore } from "@deepseek-ai/dsh-session";
import { SettingsProvider } from "@deepseek-ai/dsh-settings";
import * as plugin from "../lib/index.js";
import { fakeServer, okEnvelope, makeAgent, userEvent, awaitTicks } from "./helpers.mjs";

class MinimalFs extends FileSystem {
  async resolve(path, opts) {
    return { targetKey: `key:${path}`, displayPath: path };
  }
  processPath(target) {
    return target.displayPath;
  }
  fileUrl(target) {
    return `file://${target.displayPath}`;
  }
  contains(parent, child) {
    return true;
  }
  async stat(target, signal) {
    return { version: "v1", type: "file" };
  }
  async lstat(path, opts, signal) {
    return undefined;
  }
  async readText(target, signal) {
    return "";
  }
  async streamText(target, signal) {
    return { async *[Symbol.asyncIterator]() {} };
  }
  async readBytes(target, signal, maxBytes) {
    return new Uint8Array();
  }
  async listDir(target, signal) {
    return [];
  }
  async writeText(target, content, expected, signal, policy) {
    return { kind: "ok" };
  }
  async editText(target, edit, expected, signal, policy) {
    return { kind: "ok" };
  }
}

/** A fake OpenViking HTTP service covering the endpoints the plugin uses. */
async function startFakeOpenViking() {
  const server = await fakeServer((req, res) => {
    const url = new URL(req.url, "http://fake");
    const path = url.pathname;
    if (path === "/health") return res.end(okEnvelope({ healthy: true, version: "0.4.13" }));
    if (path === "/api/v1/fs/ls") return res.end(okEnvelope([{ uri: "viking://resources/repo-a", abstract: "Repo A" }]));
    if (path === "/api/v1/search/find") return res.end(okEnvelope({ memories: [], resources: [], skills: [], total: 0 }));
    if (path === "/api/v1/search/search") return res.end(okEnvelope({ memories: [], resources: [], skills: [], total: 0 }));
    if (path === "/api/v1/sessions" && req.method === "GET") return res.end(okEnvelope({ session_id: "s", exists: true }));
    if (path === "/api/v1/sessions" && req.method === "POST") return res.end(okEnvelope({ session_id: "s" }));
    if (/^\/api\/v1\/sessions\/[^/]+$/.test(path) && req.method === "GET") return res.end(okEnvelope({ session_id: "s" }));
    if (/^\/api\/v1\/sessions\/[^/]+\/messages$/.test(path) && req.method === "POST") return res.end(okEnvelope({ message_id: "m" }));
    res.end(okEnvelope({}));
  });
  return server;
}

/** In-memory settings provider with an optional seed document. */
class MemorySettings extends SettingsProvider {
  constructor(ctx, { document = {} } = {}) {
    super(ctx);
    this.doc = document;
  }
  get writable() {
    return true;
  }
  async load() {
    return this.doc;
  }
  async persist(ns, section) {
    this.doc = { ...this.doc, [String(ns)]: section };
  }
}

function mountSpine() {
  const ctx = new Context();
  const fibers = [];
  fibers.push(ctx.plugin(SessionStore));
  fibers.push(ctx.plugin(ToolRuntime));
  fibers.push(ctx.plugin(MinimalFs));
  fibers.push(ctx.plugin(SystemPrompt));
  fibers.push(ctx.plugin(AgentRegistry));
  return { ctx, fibers };
}

const PLUGIN = { name: plugin.name, inject: plugin.inject, Config: plugin.Config, apply: plugin.apply };

function makeConfig(endpoint, stateFile) {
  return {
    endpoint,
    apiKey: "test-key",
    account: "test-account",
    user: "test-user",
    agentId: "test-agent",
    timeoutMs: 30000,
    stateFile,
    repoContext: { enabled: true, cacheTtlMs: 60000 },
    autoRecall: { enabled: true, limit: 6, scoreThreshold: 0.15, maxContentChars: 500, tokenBudget: 2000 },
    autoCommit: { enabled: true, intervalMinutes: 10 },
  };
}

function tempState(tag) {
  return join(mkdtempSync(join(tmpdir(), `dsh-ov-${tag}-`)), "state.json");
}

test("settings namespace registers, resolves over the composition entry, and live-reconfigures the client", async () => {
  const server1 = await startFakeOpenViking();
  const server2 = await startFakeOpenViking();
  const { ctx, fibers } = await mountSpine();
  fibers.push(await ctx.plugin(MemorySettings));

  const fiber = await ctx.plugin(PLUGIN, makeConfig(server1.url, tempState("settings")));
  await awaitTicks(8);

  // Namespace registered; resolved value = composition base initially.
  const initial = ctx.settings.get("openviking");
  assert.equal(initial.endpoint, server1.url);
  assert.equal(initial.apiKey, "test-key");
  assert.equal(initial.autoRecall.limit, 6);

  // A user-layer write lands and resolves above the base.
  await ctx.settings.update("openviking", { timeoutMs: 45000, autoRecall: { limit: 3 } });
  const updated = ctx.settings.get("openviking");
  assert.equal(updated.timeoutMs, 45000);
  assert.equal(updated.autoRecall.limit, 3);
  assert.equal(updated.endpoint, server1.url);

  // Live reconfiguration: after an endpoint change, requests hit the new server.
  await ctx.settings.update("openviking", { endpoint: server2.url });
  await awaitTicks(2);
  const tool = ctx.tools.get("memfind");
  await tool.execute({ query: "hello" }, { signal: new AbortController().signal });
  await awaitTicks(2);
  assert.ok(
    server2.requests.some((r) => r.url.startsWith("/api/v1/search/find")),
    "memfind reached the reconfigured endpoint",
  );
  assert.ok(!server1.requests.some((r) => r.url.startsWith("/api/v1/search/find")), "old endpoint no longer used");

  // The seam rejects a malformed endpoint instead of storing it.
  await assert.rejects(() => ctx.settings.update("openviking", { endpoint: "not-a-url" }), /invalid endpoint/);
  assert.equal(ctx.settings.get("openviking").endpoint, server2.url);

  // Disposal removes the namespace registration.
  await fiber.dispose();
  assert.equal(ctx.settings.get("openviking"), undefined);
  for (const f of fibers) await f.dispose();
  await server1.close();
  await server2.close();
});

test("boot resolution includes pre-existing user overrides from the provider document", async () => {
  const server = await startFakeOpenViking();
  const { ctx, fibers } = await mountSpine();
  fibers.push(
    await ctx.plugin(MemorySettings, {
      document: { openviking: { timeoutMs: 12345, autoCommit: { enabled: false } } },
    }),
  );

  const fiber = await ctx.plugin(PLUGIN, makeConfig(server.url, tempState("boot")));
  await awaitTicks(6);

  const resolved = ctx.settings.get("openviking");
  assert.equal(resolved.timeoutMs, 12345);
  assert.equal(resolved.autoCommit.enabled, false);
  assert.equal(resolved.autoCommit.intervalMinutes, 10, "unoverridden nested fields keep the base");
  assert.equal(resolved.endpoint, server.url);

  await fiber.dispose();
  for (const f of fibers) await f.dispose();
  await server.close();
});

test("browser half artifact wraps into the loader format with the canonical entry shape", async () => {
  const source = readFileSync(new URL("../lib/client-ui.js", import.meta.url), "utf8");
  assert.match(source, /window\.__ModuleLoader__\.load\(\{\s*id: "dsh-openviking"/);

  let captured;
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load(entry) {
          captured = entry;
        },
      },
    },
    console,
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: "client-ui.js" });
  assert.ok(captured, "loader entry captured");
  assert.equal(captured.id, "dsh-openviking");
  assert.equal(typeof captured.factory, "function");

  const module = { exports: {} };
  const reactStub = {
    useSyncExternalStore: () => undefined,
    useState: () => [],
    createElement: () => undefined,
  };
  const exported = captured.factory((id) => {
    if (id === "react") return reactStub;
    if (id === "react/jsx-runtime") return { jsx: () => undefined, jsxs: () => undefined, Fragment: {} };
    return undefined;
  });
  assert.equal(typeof exported.apply, "function");
  assert.deepEqual([...exported.inject], ["slots", "locale", "connection", "remote", "settingsScope"]);
});
