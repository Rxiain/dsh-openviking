/**
 * Tool suite tests: exact tool names, parameter→endpoint/body mapping,
 * canonical structured output values, and fail-closed behavior.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createOpenVikingTools } from "../lib/tools.js";
import { stubClient, stubFs } from "./helpers.mjs";

const SIGNAL = () => new AbortController().signal;

function makeTools({ client = stubClient().client, fs = stubFs(), sessionManager = stubSessionManager(), config = { timeoutMs: 30000 } } = {}) {
  const ctx = { fs: fs.fs };
  return {
    tools: createOpenVikingTools(ctx, client, sessionManager, config),
    client,
    fs,
    sessionManager,
  };
}

function stubSessionManager() {
  const calls = [];
  return {
    calls,
    async ensureSession(agent, signal) {
      calls.push({ name: "ensureSession", agent, signal });
    },
    async commitCurrentSession(agent, signal, explicitSessionId) {
      calls.push({ name: "commitCurrentSession", agent, signal, explicitSessionId });
      return { session_id: explicitSessionId ?? String(agent.id), status: "completed", memories_extracted: 0 };
    },
    async commitExplicitSession(sessionId, signal) {
      calls.push({ name: "commitExplicitSession", sessionId, signal });
      return { session_id: sessionId, status: "completed", memories_extracted: 0 };
    },
  };
}

function byName(tools, name) {
  const tool = tools.find((t) => t.name === name);
  assert.ok(tool, `tool ${name} registered`);
  return tool;
}

test("registers exactly the ten canonical tool names, no meadd alias", () => {
  const { tools } = makeTools();
  const names = tools.map((t) => t.name).sort();
  assert.deepEqual(names, [
    "memadd",
    "membrowse",
    "memcommit",
    "memfind",
    "memglob",
    "memgrep",
    "memqueue",
    "memread",
    "memremove",
    "memsearch",
  ]);
  assert.ok(!tools.some((t) => t.name === "meadd"));
});

test("memfind maps defaults and optional fields to the canonical search request", async () => {
  const { client, calls } = stubClient();
  client.find = (opts) => {
    calls.push({ name: "find", opts });
    return Promise.resolve({
      memories: [{ uri: "viking://user/memories/1", score: 0.9, abstract: "a" }],
      resources: [],
      skills: [{ uri: "viking://skills/1" }],
      total: 2,
    });
  };
  const { tools } = makeTools({ client });

  // defaults: limit 10, optional body fields omitted
  await byName(tools, "memfind").execute({ query: "q" }, { signal: SIGNAL() });
  assert.equal(calls[0].opts.limit, 10);
  assert.equal(calls[0].opts.targetUri, undefined);
  assert.equal(calls[0].opts.scoreThreshold, undefined);

  // explicit fields map into the /search/find body
  const value = await byName(tools, "memfind").execute(
    { query: "hello?", target_uri: "viking://resources/", limit: 4, score_threshold: 0.3 },
    { signal: SIGNAL() },
  );
  assert.equal(calls[1].opts.limit, 4);
  assert.equal(calls[1].opts.scoreThreshold, 0.3);
  assert.equal(calls[1].opts.targetUri, "viking://resources/");

  assert.equal(value.mode, "fast");
  assert.equal(value.query, "hello?");
  assert.deepEqual(value.memories, [{ uri: "viking://user/memories/1", score: 0.9, abstract: "a" }]);
  assert.equal(value.skills.length, 1);
  assert.equal(value.total, 2);
});

test("memsearch selects fast or deep mode, maps session_id, and ensures agent sessions", async () => {
  const { client, calls } = stubClient();
  client.find = (opts) => {
    calls.push({ name: "find", opts });
    return Promise.resolve({ memories: [], resources: [], skills: [], total: 0 });
  };
  client.search = (opts) => {
    calls.push({ name: "search", opts });
    return Promise.resolve({ memories: [], resources: [], skills: [], total: 0, query_plan: { mode: "hybrid" } });
  };
  const { tools, sessionManager } = makeTools({ client });
  const agent = { id: "agent-1", session: { header: {} } };
  const findCalls = () => calls.filter((c) => c.name === "find");
  const searchCalls = () => calls.filter((c) => c.name === "search");

  // auto without an agent: short queries fall back to fast
  await byName(tools, "memsearch").execute({ query: "short" }, { signal: SIGNAL() });
  assert.equal(findCalls().length, 1);

  // auto without an agent: question-like or long queries pick deep, no session_id
  await byName(tools, "memsearch").execute({ query: "a question?" }, { signal: SIGNAL() });
  assert.equal(searchCalls().length, 1);
  assert.equal(searchCalls()[0].opts.sessionId, undefined);

  await byName(tools, "memsearch").execute({ query: "one two three four five six seven eight" }, { signal: SIGNAL() });
  assert.equal(searchCalls().length, 2);

  // explicit deep passes session_id through to /search and returns query_plan
  const explicit = await byName(tools, "memsearch").execute(
    { query: "q", mode: "deep", session_id: "sess-9" },
    { agent, signal: SIGNAL() },
  );
  assert.equal(explicit.mode, "deep");
  const deepCall = searchCalls().at(-1);
  assert.equal(deepCall.opts.sessionId, "sess-9");
  assert.equal(deepCall.opts.limit, 10);
  assert.equal(explicit.query_plan.mode, "hybrid");

  // auto with a live agent session ensures the session and uses its id for deep
  const auto = await byName(tools, "memsearch").execute({ query: "short query" }, { agent, signal: SIGNAL() });
  assert.equal(auto.mode, "deep");
  assert.equal(searchCalls().at(-1).opts.sessionId, "agent-1");
  assert.deepEqual(sessionManager.calls.map((c) => c.name), ["ensureSession"]);
});

test("memread validates URIs and resolves automatic or explicit read levels", async () => {
  const { client, calls } = stubClient();
  client.stat = (uri) => {
    calls.push({ name: "stat", uri });
    return Promise.resolve({ uri, isDir: true });
  };
  client.readContent = (level, uri) => {
    calls.push({ name: "readContent", level, uri });
    return Promise.resolve("content:" + level);
  };
  const { tools } = makeTools({ client });

  // auto level resolves directories to overview via stat
  const auto = await byName(tools, "memread").execute({ uri: "viking://resources/dir", level: "auto" }, { signal: SIGNAL() });
  assert.equal(auto.level, "overview");
  assert.equal(auto.content, "content:overview");
  assert.equal(calls[1].level, "overview");

  // explicit levels bypass stat entirely
  const explicit = await byName(tools, "memread").execute({ uri: "viking://resources/f", level: "read" }, { signal: SIGNAL() });
  assert.equal(explicit.level, "read");
  assert.equal(explicit.content, "content:read");
  assert.equal(calls.filter((c) => c.name === "stat").length, 1);

  // stat failure falls back to reading the file
  client.stat = () => Promise.reject(new Error("boom"));
  const fallback = await byName(tools, "memread").execute({ uri: "viking://resources/f", level: "auto" }, { signal: SIGNAL() });
  assert.equal(fallback.level, "read");
  assert.equal(fallback.content, "content:read");

  // non-viking URIs are rejected
  await assert.rejects(
    () => byName(tools, "memread").execute({ uri: "http://bad" }, { signal: SIGNAL() }),
    /invalid URI format/,
  );

  // non-resources scopes remain readable
  const userScope = await byName(tools, "memread").execute({ uri: "viking://user/memories/1", level: "read" }, { signal: SIGNAL() });
  assert.equal(userScope.level, "read");
  assert.equal(userScope.content, "content:read");

  // dot-segment and percent-encoded traversal are rejected
  await assert.rejects(
    () => byName(tools, "memread").execute({ uri: "viking://resources/../x" }, { signal: SIGNAL() }),
    /invalid URI/,
  );
  await assert.rejects(
    () => byName(tools, "memread").execute({ uri: "viking://resources/%2e%2e/secret" }, { signal: SIGNAL() }),
    /invalid URI/,
  );
  await assert.rejects(
    () => byName(tools, "memread").execute({ uri: "viking://resources/a%2f..%2fb" }, { signal: SIGNAL() }),
    /invalid URI/,
  );
});

test("membrowse maps view to fs endpoints", async () => {
  const { client, calls } = stubClient();
  client.list = (opts) => {
    calls.push({ name: "list", opts });
    return Promise.resolve([{ uri: "viking://resources/x" }]);
  };
  client.tree = (opts) => {
    calls.push({ name: "tree", opts });
    return Promise.resolve({ tree: "t" });
  };
  client.stat = (uri) => {
    calls.push({ name: "stat", uri });
    return Promise.resolve({ uri, isDir: true });
  };
  const { tools } = makeTools({ client });

  const listValue = await byName(tools, "membrowse").execute(
    { uri: "viking://resources/", view: "list", recursive: true, simple: true },
    { signal: SIGNAL() },
  );
  assert.equal(listValue.view, "list");
  assert.deepEqual(listValue.result, [{ uri: "viking://resources/x" }]);
  assert.equal(calls[0].opts.recursive, true);
  assert.equal(calls[0].opts.simple, true);

  const treeValue = await byName(tools, "membrowse").execute({ uri: "viking://resources/", view: "tree" }, { signal: SIGNAL() });
  assert.equal(treeValue.view, "tree");
  assert.deepEqual(treeValue.result, { tree: "t" });

  const statValue = await byName(tools, "membrowse").execute({ uri: "viking://resources/", view: "stat" }, { signal: SIGNAL() });
  assert.equal(statValue.view, "stat");
  assert.equal(statValue.result.isDir, true);
});

test("memgrep maps defaults and fields and produces canonical match views", async () => {
  const { client, calls } = stubClient();
  client.grep = (opts) => {
    calls.push({ name: "grep", opts });
    return Promise.resolve({
      matches: [
        { line: 3, uri: "viking://resources/a.txt", content: "needle here" },
        { line: 9, uri: "viking://resources/a.txt", content: "needle again" },
        { line: 1, uri: "viking://resources/b.txt", content: "needle b" },
      ],
      count: 3,
      match_count: 1,
      files_scanned: 12,
    });
  };
  const { tools } = makeTools({ client });
  const value = await byName(tools, "memgrep").execute(
    { pattern: "needle", case_insensitive: true, exclude_uri: "viking://resources/skip", node_limit: 10, level_limit: 4 },
    { signal: SIGNAL() },
  );
  assert.equal(calls[0].opts.uri, "viking://resources/");
  assert.equal(calls[0].opts.pattern, "needle");
  assert.equal(calls[0].opts.caseInsensitive, true);
  assert.equal(calls[0].opts.excludeUri, "viking://resources/skip");
  assert.equal(calls[0].opts.nodeLimit, 10);
  assert.equal(calls[0].opts.levelLimit, 4);
  assert.equal(value.count, 3);
  assert.equal(value.match_count, 1);
  assert.equal(value.files_scanned, 12);
  assert.equal(value.matches[0].line, 3);

  const meta = byName(tools, "memgrep").output.presentationMeta({ pattern: "needle" }, value);
  assert.equal(meta.shape, "matches");
  assert.equal(meta.files.length, 2);
  assert.equal(meta.files[0].path, "viking://resources/a.txt");
  assert.equal(meta.files[0].matches.length, 2);
  const view = byName(tools, "memgrep").presentResult({ pattern: "needle" }, { content: [], isError: false, meta });
  assert.equal(view.card, "search");
  assert.equal(view.shape, "matches");
  assert.equal(view.total, 3);
});

test("memglob defaults uri and produces search/paths views", async () => {
  const { client, calls } = stubClient();
  client.glob = (opts) => {
    calls.push({ name: "glob", opts });
    return Promise.resolve({ matches: ["viking://resources/x/a.py", "viking://resources/x/b.py"], count: 2 });
  };
  const { tools } = makeTools({ client });
  const value = await byName(tools, "memglob").execute({ pattern: "**/*.py", node_limit: 5 }, { signal: SIGNAL() });
  assert.equal(calls[0].opts.uri, "viking://resources/");
  assert.equal(calls[0].opts.nodeLimit, 5);
  assert.equal(value.count, 2);
  assert.equal(value.matches.length, 2);

  const meta = byName(tools, "memglob").output.presentationMeta({ pattern: "**/*.py" }, value);
  assert.equal(meta.shape, "paths");
  assert.deepEqual(meta.paths, ["viking://resources/x/a.py", "viking://resources/x/b.py"]);
  const view = byName(tools, "memglob").presentResult({ pattern: "**/*.py" }, { content: [], isError: false, meta });
  assert.equal(view.shape, "paths");
  assert.equal(view.total, 2);
});

test("memadd rejects to+parent and non-resources targets", async () => {
  const { tools } = makeTools();
  await assert.rejects(
    () => byName(tools, "memadd").execute({ path: "x", to: "viking://resources/a", parent: "viking://resources/b" }, { signal: SIGNAL() }),
    /either `to` or `parent`, not both/,
  );
  await assert.rejects(
    () => byName(tools, "memadd").execute({ path: "x", to: "viking://user/memories/x" }, { signal: SIGNAL() }),
    /`to` must be under viking:\/\/resources/,
  );
  await assert.rejects(
    () => byName(tools, "memadd").execute({ path: "x", parent: "viking://user/memories/x" }, { signal: SIGNAL() }),
    /`parent` must be under viking:\/\/resources/,
  );

  // a scope glued without a slash must not be treated as scope "resources"
  await assert.rejects(
    () => byName(tools, "memadd").execute({ path: "x", to: "viking://resources.evil/x" }, { signal: SIGNAL() }),
    /`to` must be under viking:\/\/resources/,
  );

  // targets without at least one path segment are not under viking://resources/
  await assert.rejects(
    () => byName(tools, "memadd").execute({ path: "x", to: "viking://resources" }, { signal: SIGNAL() }),
    /`to` must be under viking:\/\/resources/,
  );

  // dot-segment and percent-encoded traversal are rejected
  await assert.rejects(
    () => byName(tools, "memadd").execute({ path: "x", to: "viking://resources/../x" }, { signal: SIGNAL() }),
    /invalid URI/,
  );
  await assert.rejects(
    () => byName(tools, "memadd").execute({ path: "x", to: "viking://resources/%2e%2e/secret" }, { signal: SIGNAL() }),
    /invalid URI/,
  );
  await assert.rejects(
    () => byName(tools, "memadd").execute({ path: "x", parent: "viking://resources/a/..%2fb" }, { signal: SIGNAL() }),
    /invalid URI/,
  );
});

test("memadd remote path skips temp upload and posts path + to", async () => {
  const { client, calls } = stubClient();
  client.addResource = (opts) => {
    calls.push({ name: "addResource", opts });
    return Promise.resolve({ root_uri: "viking://resources/remote" });
  };
  client.queue = () => Promise.resolve({ pending: 0 });
  const { tools } = makeTools({ client });
  const value = await byName(tools, "memadd").execute(
    { path: "https://example.com/file.md", to: "viking://resources/remote", reason: "docs" },
    { signal: SIGNAL() },
  );
  assert.equal(value.source, "remote");
  assert.equal(value.root_uri, "viking://resources/remote");
  assert.deepEqual(value.queue, { pending: 0 });
  const add = calls.find((c) => c.name === "addResource");
  assert.equal(add.opts.path, "https://example.com/file.md");
  assert.equal(add.opts.to, "viking://resources/remote");
  assert.equal(add.opts.tempFileId, undefined);
  assert.equal(add.opts.requestTimeoutMs, undefined);
});

test("memadd resolves local paths, uploads bytes, and rejects directories with guidance", async () => {
  const { client, calls } = stubClient();
  client.uploadTempFile = (filename, bytes) => {
    calls.push({ name: "uploadTempFile", filename, bytes });
    return Promise.resolve("tmp-77");
  };
  client.addResource = (opts) => {
    calls.push({ name: "addResource", opts });
    return Promise.resolve({ root_uri: "viking://resources/local-file" });
  };
  client.queue = () => Promise.resolve({});
  const fs = stubFs({ content: "some text body" });
  const { tools } = makeTools({ client, fs });

  // relative paths resolve against the agent session cwd, read via ctx.fs, upload as UTF-8 bytes
  const exec = { agent: { session: { header: { cwd: "/work/dir" } } }, signal: SIGNAL() };
  const value = await byName(tools, "memadd").execute({ path: "notes.md", to: "viking://resources/local-file" }, exec);
  assert.equal(value.source, "local");
  const upload = calls.find((c) => c.name === "uploadTempFile");
  assert.equal(upload.filename, "notes.md");
  assert.equal(new TextDecoder().decode(upload.bytes), "some text body");
  const add = calls.find((c) => c.name === "addResource");
  assert.equal(add.opts.tempFileId, "tmp-77");
  assert.equal(add.opts.to, "viking://resources/local-file");
  const resolveCall = fs.fsCalls.find((c) => c.name === "resolve");
  assert.equal(resolveCall.opts.cwd, "/work/dir");

  // file:// URLs resolve through fileURLToPath; no agent falls back to process.cwd()
  const fs2 = stubFs();
  const { tools: tools2 } = makeTools({ client, fs: fs2 });
  await byName(tools2, "memadd").execute({ path: "file:///abs/path/doc.md", parent: "viking://resources/x" }, { signal: SIGNAL() });
  const urlResolve = fs2.fsCalls.find((c) => c.name === "resolve");
  assert.equal(urlResolve.path, "/abs/path/doc.md");
  assert.equal(urlResolve.opts.cwd, process.cwd());

  // directories are rejected with compress guidance
  const { tools: tools3 } = makeTools({ client, fs: stubFs({ statType: "directory" }) });
  await assert.rejects(
    () => byName(tools3, "memadd").execute({ path: "somedir" }, { signal: SIGNAL() }),
    /supports files only.*compress it first/,
  );
});

test("memremove fail-closed: confirm must be literal true", async () => {
  const { client, calls } = stubClient();
  client.remove = (opts) => {
    calls.push({ name: "remove", opts });
    return Promise.resolve({ uri: opts.uri });
  };
  const { tools } = makeTools({ client });
  await assert.rejects(
    () => byName(tools, "memremove").execute({ uri: "viking://resources/x", confirm: false }, { signal: SIGNAL() }),
    /Refusing to delete without confirm=true/,
  );
  assert.equal(calls.length, 0);

  const value = await byName(tools, "memremove").execute(
    { uri: "viking://resources/x", recursive: true, confirm: true },
    { signal: SIGNAL() },
  );
  assert.deepEqual(value, { uri: "viking://resources/x", recursive: true, removed: true });
  assert.equal(calls[0].opts.recursive, true);

  // canonical user-memory URIs remain removable
  const userValue = await byName(tools, "memremove").execute(
    { uri: "viking://user/memories/1", confirm: true },
    { signal: SIGNAL() },
  );
  assert.deepEqual(userValue, { uri: "viking://user/memories/1", recursive: false, removed: true });
  assert.equal(calls[1].opts.uri, "viking://user/memories/1");

  // traversal in the uri is rejected even with confirm=true
  await assert.rejects(
    () => byName(tools, "memremove").execute({ uri: "viking://user/memories/../x", confirm: true }, { signal: SIGNAL() }),
    /invalid URI/,
  );
  await assert.rejects(
    () => byName(tools, "memremove").execute({ uri: "viking://resources/%2e%2e/secret", confirm: true }, { signal: SIGNAL() }),
    /invalid URI/,
  );
});

test("memqueue returns the canonical queue object", async () => {
  const { client } = stubClient();
  client.queue = () => Promise.resolve({ total: 3, pending: [{ uri: "viking://resources/x", state: "pending" }] });
  const { tools } = makeTools({ client });
  const value = await byName(tools, "memqueue").execute({}, { signal: SIGNAL() });
  assert.equal(typeof value, "object");
  assert.equal(value.total, 3);
});

test("memcommit routes current, matching, and foreign sessions with correct flush behavior", async () => {
  const { client } = stubClient();
  const { tools, sessionManager } = makeTools({ client });
  const agent = { id: "agent-1", session: { header: {} } };

  // without session_id an agent is required and the current session is flushed
  await assert.rejects(
    () => byName(tools, "memcommit").execute({}, { signal: SIGNAL() }),
    /no agent session is available/,
  );
  const current = await byName(tools, "memcommit").execute({}, { agent, signal: SIGNAL() });
  assert.equal(current.status, "completed");
  const flushCalls = () => sessionManager.calls.filter((c) => c.name === "commitCurrentSession");
  const explicitCalls = () => sessionManager.calls.filter((c) => c.name === "commitExplicitSession");
  assert.equal(flushCalls().length, 1);
  assert.equal(flushCalls()[0].explicitSessionId, undefined);

  // a session_id equal to the agent id still routes through the current-session flush
  await byName(tools, "memcommit").execute({ session_id: "agent-1" }, { agent, signal: SIGNAL() });
  assert.equal(flushCalls().length, 2);

  // a foreign session_id commits only that session without touching the current one
  const foreign = await byName(tools, "memcommit").execute({ session_id: "other-session" }, { agent, signal: SIGNAL() });
  assert.equal(foreign.session_id, "other-session");
  assert.equal(explicitCalls().length, 1);
  assert.equal(explicitCalls()[0].sessionId, "other-session");
  assert.equal(flushCalls().length, 2);
});

test("every tool output is a canonical JSON value, not a JSON string", async () => {
  const { client, calls } = stubClient();
  client.find = () => Promise.resolve({ memories: [{ uri: "viking://user/memories/1", score: 0.5 }], resources: [], skills: [], total: 1 });
  client.readContent = () => Promise.resolve("text");
  client.stat = () => Promise.resolve({ uri: "viking://resources/f", isDir: false });
  client.list = () => Promise.resolve([]);
  client.queue = () => Promise.resolve({});
  client.remove = () => Promise.resolve({ uri: "viking://resources/x" });
  const { tools } = makeTools({ client });

  const cases = [
    [byName(tools, "memfind").execute({ query: "q" }, { signal: SIGNAL() }), (v) => v.mode === "fast"],
    [byName(tools, "memread").execute({ uri: "viking://resources/f" }, { signal: SIGNAL() }), (v) => typeof v.content === "string"],
    [byName(tools, "membrowse").execute({ uri: "viking://resources/" }, { signal: SIGNAL() }), (v) => Array.isArray(v.result)],
    [byName(tools, "memqueue").execute({}, { signal: SIGNAL() }), (v) => typeof v === "object"],
    [byName(tools, "memremove").execute({ uri: "viking://resources/x", confirm: true }, { signal: SIGNAL() }), (v) => v.removed === true],
  ];
  for (const [promise, check] of cases) {
    const value = await promise;
    assert.equal(typeof value, "object");
    assert.ok(!(typeof value === "string"));
    assert.ok(check(value), "canonical value satisfies its contract");
  }
});
