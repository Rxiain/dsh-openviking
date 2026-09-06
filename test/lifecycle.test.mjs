/**
 * Cordis lifecycle tests: mount the compiled plugin on a real Context spine
 * against a local fake OpenViking HTTP server, verifying tool registration,
 * event-driven adoption, config rejection, dispose revocation, and remount
 * idempotence. Plus the built-artifact / manifest smoke.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Context } from "@deepseek-ai/cordis";
import { ToolRuntime } from "@deepseek-ai/dsh-tools";
import { SystemPrompt } from "@deepseek-ai/dsh-system-prompt";
import { FileSystem } from "@deepseek-ai/dsh-fs";
import { AgentRegistry } from "@deepseek-ai/dsh-agent";
import { SessionStore } from "@deepseek-ai/dsh-session";
import * as plugin from "../lib/index.js";
import { fakeServer, okEnvelope, makeAgent, userEvent, waitFor } from "./helpers.mjs";

const TOOL_NAMES = ["memsearch", "memfind", "memread", "membrowse", "memcommit", "memgrep", "memglob", "memadd", "memremove", "memqueue"];

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

/** A fake OpenViking HTTP service covering every endpoint the plugin uses. */
async function startFakeOpenViking() {
  const server = await fakeServer((req, res) => {
    const url = new URL(req.url, "http://fake");
    const path = url.pathname;
    if (path === "/health") return res.end(okEnvelope({ healthy: true, version: "0.4.13" }));
    if (path === "/api/v1/fs/ls") return res.end(okEnvelope([{ uri: "viking://resources/repo-a", abstract: "Repo A" }]));
    if (path === "/api/v1/fs/tree") return res.end(okEnvelope({ tree: "t" }));
    if (path === "/api/v1/fs/stat") return res.end(okEnvelope({ uri: url.searchParams.get("uri"), isDir: false }));
    if (path === "/api/v1/search/find")
      return res.end(
        okEnvelope({ memories: [{ uri: "viking://user/memories/1", level: 2, score: 0.9, abstract: "prefers dark mode" }], resources: [], skills: [], total: 1 }),
      );
    if (path === "/api/v1/search/search") return res.end(okEnvelope({ memories: [], resources: [], skills: [], total: 0 }));
    if (path === "/api/v1/search/grep") return res.end(okEnvelope({ matches: [], count: 0 }));
    if (path === "/api/v1/search/glob") return res.end(okEnvelope({ matches: [], count: 0 }));
    if (path === "/api/v1/content/read" || path === "/api/v1/content/overview" || path === "/api/v1/content/abstract")
      return res.end(okEnvelope("content-body"));
    if (path === "/api/v1/resources/temp_upload") return res.end(okEnvelope({ temp_file_id: "tmp-1" }));
    if (path === "/api/v1/resources") return res.end(okEnvelope({ root_uri: "viking://resources/x" }));
    if (path === "/api/v1/observer/queue") return res.end(okEnvelope({}));
    if (path === "/api/v1/fs" && req.method === "DELETE") return res.end(okEnvelope({ uri: url.searchParams.get("uri") }));
    if (path === "/api/v1/sessions" && req.method === "POST") return res.end(okEnvelope({ session_id: "created" }));
    if (path.startsWith("/api/v1/sessions/") && path.endsWith("/messages") && req.method === "POST")
      return res.end(okEnvelope({ session_id: url.pathname.split("/")[3], message_count: 1 }));
    if (path.startsWith("/api/v1/sessions/") && path.endsWith("/commit") && req.method === "POST")
      return res.end(okEnvelope({ session_id: url.pathname.split("/")[3], status: "accepted", task_id: "t-1", archived: true }));
    if (path.startsWith("/api/v1/sessions/") && req.method === "GET")
      return res.end(okEnvelope({ session_id: url.pathname.split("/")[3], message_count: 0 }));
    if (path.startsWith("/api/v1/tasks/") && req.method === "GET")
      return res.end(okEnvelope({ task_id: url.pathname.split("/")[3], status: "completed", result: { archived: true, memories_extracted: { total: 0 } } }));
    res.statusCode = 404;
    res.end(okEnvelope({ nope: path }));
  });
  return server;
}

function makeConfig(serverUrl, stateFile) {
  return {
    endpoint: serverUrl,
    apiKey: "test-key",
    account: "astrbot",
    user: "alice",
    agentId: "harness-1",
    timeoutMs: 5000,
    stateFile,
    repoContext: { enabled: true, cacheTtlMs: 60000 },
    autoRecall: { enabled: true, limit: 6, scoreThreshold: 0.15, maxContentChars: 500, tokenBudget: 2000 },
    autoCommit: { enabled: true, intervalMinutes: 10 },
  };
}

function tempState(prefix) {
  return join(mkdtempSync(join(tmpdir(), "dsh-openviking-lifecycle-")), prefix);
}

/** Register LIFO cleanup so a failed assertion cannot leave fibers or servers alive. */
function cleanupStack(t) {
  const callbacks = [];
  t.after(async () => {
    const errors = [];
    for (const callback of callbacks.reverse()) {
      try {
        await callback();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length > 0) throw new AggregateError(errors, "lifecycle test cleanup failed");
  });
  return (callback) => callbacks.push(callback);
}

async function mountSpine() {
  const ctx = new Context();
  const fibers = [];
  fibers.push(await ctx.plugin(SessionStore));
  fibers.push(await ctx.plugin(ToolRuntime));
  fibers.push(await ctx.plugin(MinimalFs));
  fibers.push(await ctx.plugin(SystemPrompt));
  fibers.push(await ctx.plugin(AgentRegistry));
  return { ctx, fibers };
}

test("compiled artifact exports the canonical plugin shape", async () => {
  const mod = await import("../lib/index.js");
  assert.equal(mod.default, undefined, "no default export");
  assert.equal(typeof mod.apply, "function");
  assert.equal(typeof mod.Config, "function");
  assert.equal(mod.name, "openviking");
  assert.deepEqual(mod.inject, ["tools", "fs", "systemPrompt", "agents"]);
});

test("cordis.patch.yml inserts only the openviking row referencing the package", () => {
  const text = readFileSync(fileURLToPath(new URL("../cordis.patch.yml", import.meta.url)), "utf8");
  assert.match(text, /id: openviking/);
  assert.match(text, /name: 'dsh-openviking'/);
  assert.ok(!/disabled:\s*true/.test(text), "no base rows disabled");
});

test("config defects fail at load time", async (t) => {
  const cleanup = cleanupStack(t);
  const { ctx, fibers } = await mountSpine();
  for (const fiber of fibers) cleanup(() => fiber.dispose());
  const tryMount = async (config) => {
    await ctx.plugin(plugin, config);
  };
  await assert.rejects(() => tryMount({ ...makeConfig("http://localhost:1933", tempState("a")), timeoutMs: 50 }), /timeoutMs/);
  await assert.rejects(() => tryMount({ ...makeConfig("http://localhost:1933", tempState("b")), autoRecall: { enabled: true, limit: 0 } }), /limit/);
  await assert.rejects(() => tryMount({ ...makeConfig("http://localhost:1933", tempState("c")), autoCommit: { enabled: true, intervalMinutes: 0 } }), /intervalMinutes/);
});

test("mount registers ten tools, refreshes context, adopts agents idempotently, and forwards session events", async (t) => {
  const cleanup = cleanupStack(t);
  const server = await startFakeOpenViking();
  cleanup(() => server.close());
  const { ctx, fibers } = await mountSpine();
  for (const baseFiber of fibers) cleanup(() => baseFiber.dispose());

  // An agent that predates the plugin mount must be adopted and drained.
  const preAgent = makeAgent("pre-agent", [userEvent("u1", "before plugin")]);
  ctx.agents.register(preAgent);

  const fiber = await ctx.plugin({ name: plugin.name, inject: plugin.inject, Config: plugin.Config, apply: plugin.apply }, makeConfig(server.url, tempState("mount")));
  cleanup(() => fiber.dispose());
  await waitFor(
    () =>
      server.requests.some((r) => r.url.startsWith("/api/v1/fs/ls?uri=viking%3A%2F%2Fresources%2F")) &&
      server.requests.some((r) => r.url === "/api/v1/sessions/pre-agent/messages"),
    { description: "initial repository refresh and pre-existing agent drain" },
  );

  for (const name of TOOL_NAMES) assert.ok(ctx.tools.get(name), `tool ${name} registered`);
  assert.equal(ctx.tools.get("meadd"), undefined);

  // Repo context refreshed at mount.
  assert.ok(server.requests.some((r) => r.url.startsWith("/api/v1/fs/ls?uri=viking%3A%2F%2Fresources%2F")));

  // Existing agent drained at mount (getSession + addSessionMessage).
  const sessionRequests = server.requests.filter((r) => r.url === "/api/v1/sessions/pre-agent");
  assert.ok(sessionRequests.length >= 1, "remote session ensured");
  let sends = server.requests.filter((r) => r.url === "/api/v1/sessions/pre-agent/messages");
  assert.equal(sends.length, 1);
  assert.equal(sends[0].json.role, "user");
  assert.equal(sends[0].json.content, "before plugin");

  // Auth headers present on real requests.
  const first = server.requests[0];
  assert.equal(first.headers["x-api-key"], "test-key");
  assert.equal(first.headers["x-openviking-account"], "astrbot");

  // Agent created after mount is adopted through agent/created.
  const postAgent = makeAgent("post-agent", [userEvent("u2", "after plugin")]);
  ctx.agents.register(postAgent);
  await waitFor(
    () => server.requests.some((r) => r.url === "/api/v1/sessions/post-agent/messages"),
    { description: "new agent drain" },
  );
  sends = server.requests.filter((r) => r.url === "/api/v1/sessions/post-agent/messages");
  assert.equal(sends.length, 1, "agent/created adoption drains");

  // session-start dispatch: idempotent, no duplicate sends.
  ctx.emit("agent/session-start", { agent: postAgent, source: "startup" });
  sends = server.requests.filter((r) => r.url === "/api/v1/sessions/post-agent/messages");
  assert.equal(sends.length, 1, "session-start adoption is idempotent");

  // Live append via session/event dispatch is drained.
  postAgent.session.append("user/message", {
    id: "u3",
    role: "user",
    content: [{ type: "text", text: "live append" }],
    source: { kind: "user" },
  }, { surfaceOp: "append" });
  ctx.emit("session/event", postAgent.session, postAgent.session.snapshotEvents().at(-1));
  await waitFor(
    () => server.requests.filter((r) => r.url === "/api/v1/sessions/post-agent/messages").length === 2,
    { description: "live session event drain" },
  );
  sends = server.requests.filter((r) => r.url === "/api/v1/sessions/post-agent/messages");
  assert.equal(sends.length, 2);
  assert.equal(sends[1].json.content, "live append");
});


test("dispose stops plugin effects and a remount works cleanly", async (t) => {
  const cleanup = cleanupStack(t);
  const server = await startFakeOpenViking();
  cleanup(() => server.close());
  const { ctx, fibers } = await mountSpine();
  for (const baseFiber of fibers) cleanup(() => baseFiber.dispose());
  const fiber = await ctx.plugin({ name: plugin.name, inject: plugin.inject, Config: plugin.Config, apply: plugin.apply }, makeConfig(server.url, tempState("dispose")));
  cleanup(() => fiber.dispose());
  for (const name of TOOL_NAMES) assert.ok(ctx.tools.get(name));

  await fiber.dispose();

  // Tools gone: registration revoked.
  for (const name of TOOL_NAMES) assert.equal(ctx.tools.get(name), undefined);

  // Remount registers exactly once more (no duplicate-registration error).
  const fiber2 = await ctx.plugin({ name: plugin.name, inject: plugin.inject, Config: plugin.Config, apply: plugin.apply }, makeConfig(server.url, tempState("remount")));
  cleanup(() => fiber2.dispose());
  for (const name of TOOL_NAMES) assert.ok(ctx.tools.get(name));
});

test("autoCommit disabled causes no automatic commit requests", async (t) => {
  const cleanup = cleanupStack(t);
  const server = await startFakeOpenViking();
  cleanup(() => server.close());
  const { ctx, fibers } = await mountSpine();
  for (const baseFiber of fibers) cleanup(() => baseFiber.dispose());
  const fiber = await ctx.plugin(
    { name: plugin.name, inject: plugin.inject, Config: plugin.Config, apply: plugin.apply },
    { ...makeConfig(server.url, tempState("noautocommit")), autoCommit: { enabled: false, intervalMinutes: 10 } },
  );
  cleanup(() => fiber.dispose());

  // Give the plugin pending state: a live agent appends and syncs messages.
  const agent = makeAgent("no-commit-agent", [userEvent("c1", "first message")]);
  ctx.agents.register(agent);
  await waitFor(
    () => server.requests.filter((r) => r.url === "/api/v1/sessions/no-commit-agent/messages").length === 1,
    { description: "initial no-auto-commit agent drain" },
  );
  agent.session.append("user/message", {
    id: "c2",
    role: "user",
    content: [{ type: "text", text: "second message" }],
    source: { kind: "user" },
  }, { surfaceOp: "append" });
  ctx.emit("session/event", agent.session, agent.session.snapshotEvents().at(-1));
  await waitFor(
    () => server.requests.filter((r) => r.url === "/api/v1/sessions/no-commit-agent/messages").length === 2,
    { description: "second no-auto-commit agent drain" },
  );

  // Sync happens (so uncommitted state accumulates), but no commit POST is issued.
  const sends = server.requests.filter((r) => r.url === "/api/v1/sessions/no-commit-agent/messages");
  assert.equal(sends.length, 2, "user messages synced");
  const commits = server.requests.filter((r) => r.url === "/api/v1/sessions/no-commit-agent/commit");
  assert.equal(commits.length, 0, "no automatic commit requests while disabled");
});
