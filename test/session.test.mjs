/**
 * SessionManager tests: sync eligibility, ordering, failure retry, state
 * persistence/restore, commit snapshots, auto-commit, and dispose cleanup.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager, stripRecallBlock } from "../lib/session-sync.js";
import { stubCtx, makeAgent, userEvent, pluginUserEvent, toolUserEvent, mixedContentEvent, awaitTicks } from "./helpers.mjs";

function tempDir() {
  return mkdtempSync(join(tmpdir(), "dsh-openviking-test-"));
}

function makeManager({ dir = tempDir(), client: clientArg, autoCommit = { enabled: false, intervalMinutes: 10 }, ctxAgents = [], stateFile } = {}) {
  // Accept the `{ client, calls }` bundle, a raw stub client, or nothing.
  let bundle;
  if (clientArg && clientArg.client) bundle = clientArg;
  else if (clientArg) bundle = { client: clientArg, calls: [] };
  else bundle = stubSessionClient();
  const ctx = stubCtx({ agents: ctxAgents });
  const manager = new SessionManager(ctx, bundle.client, {
    endpoint: "http://localhost:1933",
    apiKey: "key",
    account: "astrbot",
    user: "alice",
    agentId: "harness-1",
    timeoutMs: 5000,
    stateFile: stateFile ?? `${dir}/state.json`,
    autoCommit,
  });
  return { manager, client: bundle.client, calls: bundle.calls, dir, ctx };
}

function stubSessionClient(overrides = {}) {
  const calls = [];
  const client = {
    endpoint: "http://localhost:1933",
    async getSession(sessionId, signal) {
      calls.push({ name: "getSession", sessionId });
      return { session_id: sessionId, message_count: 0 };
    },
    async createSession(sessionId, signal) {
      calls.push({ name: "createSession", sessionId });
      return { session_id: sessionId };
    },
    async addSessionMessage(sessionId, role, content, signal) {
      calls.push({ name: "addSessionMessage", sessionId, role, content });
      return { session_id: sessionId, message_count: 1 };
    },
    async commitSession(sessionId, signal) {
      calls.push({ name: "commitSession", sessionId });
      return { session_id: sessionId, status: "accepted", task_id: "task-1", archived: true };
    },
    async getTask(taskId, signal) {
      calls.push({ name: "getTask", taskId });
      return { task_id: taskId, status: "completed", result: { archived: true, memories_extracted: { events: 2, total: 2 } } };
    },
    ...overrides,
  };
  return { client, calls };
}

async function drainAndDispose(manager, agent) {
  await manager.init();
  manager.adopt(agent);
  await manager.waitForChain(agent);
  await manager.dispose();
}

test("sync sends only real user and assistant text using canonical text extraction", async () => {
  const { manager, calls } = makeManager();
  const agent = makeAgent("agent-1", [
    userEvent("u1", "real user text"),
    pluginUserEvent("u2", "plugin injected context"),
    toolUserEvent("u3", "tool result content"),
    mixedContentEvent("u4", "visible part", "hidden reasoning"),
    {
      type: "assistant/message",
      seq: 4,
      time: Date.now(),
      data: {
        turn: 1,
        step: 1,
        message: {
          id: "a1",
          role: "assistant",
          content: [
            { type: "reasoning", text: "think" },
            { type: "text", text: "line one" },
            { type: "text", text: "line two" },
          ],
          source: { kind: "model", provider: "p", model: "m" },
        },
      },
      surfaceOp: "append",
    },
  ]);
  await drainAndDispose(manager, agent);

  const sends = calls.filter((c) => c.name === "addSessionMessage");
  assert.equal(sends.length, 3);
  assert.deepEqual(
    sends.map((s) => [s.role, s.content]),
    [
      ["user", "real user text"],
      ["user", "visible part"],
      ["assistant", "line one\nline two"],
    ],
  );
  // Canonical extraction never leaks non-text blocks or non-user sources.
  const wire = JSON.stringify(calls);
  assert.ok(!wire.includes("hidden reasoning"), "reasoning blocks are not extracted");
  assert.ok(!wire.includes("plugin injected context"), "plugin source is skipped");
  assert.ok(!wire.includes("tool result content"), "tool source is skipped");
});

test("sync removes recall and memread guidance and drops messages left empty", async () => {
  const { manager, calls } = makeManager();
  const injectedText = [
    "my original question",
    "",
    "<relevant-memories>",
    '<memory uri="viking://user/memories/1">',
    "prefers dark mode",
    "</memory>",
    "</relevant-memories>",
    'Use `memread` with a memory URI and level="overview" or level="read" for more details.',
  ].join("\n");
  const agent = makeAgent("agent-1", [userEvent("u1", injectedText)]);
  await drainAndDispose(manager, agent);
  const sends = calls.filter((c) => c.name === "addSessionMessage");
  assert.equal(sends.length, 1);
  assert.equal(sends[0].content, "my original question");
  assert.ok(!sends[0].content.includes("relevant-memories"));
  assert.ok(!sends[0].content.includes("memread"));

  // stripRecallBlock leaves plain text and mid-text blocks alone.
  const base = "hello world";
  assert.equal(stripRecallBlock(base), base);
  const withBlock = `${base}\n\n<relevant-memories>\n<memory uri="u">\nx\n</memory>\n</relevant-memories>\nUse \`memread\` for details.`;
  assert.equal(stripRecallBlock(withBlock), base);
  const middle = `${base}\n\n<relevant-memories>\n</relevant-memories>\n\ntrailing question`;
  assert.ok(stripRecallBlock(middle).includes("trailing question"), "mid-text block is left alone");

  // A message whose only content is the recall block is dropped entirely.
  const { manager: manager2, calls: calls2 } = makeManager();
  const agent2 = makeAgent("agent-1", [
    userEvent("u2", "\n\n<relevant-memories>\n</relevant-memories>\nUse `memread` for details."),
  ]);
  await drainAndDispose(manager2, agent2);
  assert.equal(calls2.filter((c) => c.name === "addSessionMessage").length, 0);
});

test("drain preserves sequence order and retries from the first failed message", async () => {
  let failOn = "second";
  const { client, calls } = stubSessionClient({
    async addSessionMessage(sessionId, role, content, signal) {
      calls.push({ name: "addSessionMessage", sessionId, role, content });
      if (content === failOn) throw new Error("network down");
      return { session_id: sessionId, message_count: 1 };
    },
  });
  const { manager } = makeManager({ client });
  await manager.init();
  const agent = makeAgent("agent-1", [userEvent("m1", "first"), userEvent("m2", "second"), userEvent("m3", "third")]);
  manager.adopt(agent);
  await manager.waitForChain(agent);
  let sends = calls.filter((c) => c.name === "addSessionMessage").map((c) => c.content);
  assert.deepEqual(sends, ["first", "second"], "stops at the failing message; third never attempted");

  // The failed message is not marked synced: a flush retries it and fails again.
  await assert.rejects(() => manager.flushSession(agent), /network down/);
  sends = calls.filter((c) => c.name === "addSessionMessage").map((c) => c.content);
  assert.deepEqual(sends, ["first", "second", "second"], "failed message retried but never marked synced");

  failOn = null; // service recovers
  await manager.flushSession(agent);
  sends = calls.filter((c) => c.name === "addSessionMessage").map((c) => c.content);
  assert.deepEqual(sends, ["first", "second", "second", "second", "third"], "resumes from the earliest gap after recovery");
  await manager.dispose();

  // Live appends arriving while a drain is in flight are still delivered in log order.
  const { client: client2, calls: calls2 } = stubSessionClient();
  let release;
  client2.addSessionMessage = async (sessionId, role, content) => {
    calls2.push({ name: "addSessionMessage", sessionId, role, content });
    if (content === "live-one") await new Promise((resolve) => (release = resolve));
    return {};
  };
  const { manager: manager2 } = makeManager({ client: client2 });
  await manager2.init();
  const agent2 = makeAgent("agent-2", []);
  manager2.adopt(agent2);
  await manager2.waitForChain(agent2);

  // Emulate live appends (the plugin's session/event handler queues drains).
  agent2.session.append("user/message", {
    id: "live-u1",
    role: "user",
    content: [{ type: "text", text: "live-one" }],
    source: { kind: "user" },
  }, { surfaceOp: "append" });
  manager2.queueDrain(agent2);
  agent2.session.append("user/message", {
    id: "live-u2",
    role: "user",
    content: [{ type: "text", text: "live-two" }],
    source: { kind: "user" },
  }, { surfaceOp: "append" });
  manager2.queueDrain(agent2);
  const chain2 = manager2.waitForChain(agent2);
  await awaitTicks(2);
  release();
  await chain2;
  assert.deepEqual(
    calls2.filter((c) => c.name === "addSessionMessage").map((c) => c.content),
    ["live-one", "live-two"],
    "live appends delivered in strict log order",
  );
  await manager2.dispose();
});

test("dispose finishes accepted work, persists progress, stops later syncing, and remount does not resend", async () => {
  const dir = tempDir();
  const stateFile = `${dir}/state.json`;
  const { manager, calls } = makeManager({ dir, stateFile });
  const agent = makeAgent("agent-1", [userEvent("m1", "hello"), userEvent("m2", "world")]);
  await drainAndDispose(manager, agent);
  assert.equal(calls.filter((c) => c.name === "addSessionMessage").length, 2, "accepted work finished before dispose returns");
  assert.ok(existsSync(stateFile), "dispose persists progress");
  const persisted = JSON.parse(readFileSync(stateFile, "utf8"));
  assert.deepEqual(persisted.sessions["agent-1"].syncedMessageIds, ["user:m1", "user:m2"], "synced ids persisted");

  // Restart with the same state file: the agent replays the same log but the
  // synced ids must suppress re-sending.
  const { manager: manager2, calls: calls2 } = makeManager({ dir, stateFile });
  await manager2.init();
  const agent2 = makeAgent("agent-1", [userEvent("m1", "hello"), userEvent("m2", "world"), userEvent("m3", "new message")]);
  manager2.adopt(agent2);
  await manager2.waitForChain(agent2);
  const sends2 = calls2.filter((c) => c.name === "addSessionMessage").map((c) => c.content);
  assert.deepEqual(sends2, ["new message"], "remount does not resend already-synced messages");
  await manager2.dispose();
});

test("invalid restored state starts fresh for identity mismatch or corruption", async () => {
  // Identity mismatch: stale synced ids from another service are ignored.
  const dirA = tempDir();
  const stateFileA = `${dirA}/state.json`;
  writeFileSync(
    stateFileA,
    JSON.stringify({
      version: 1,
      identity: { endpoint: "http://other:1933", account: "other", user: "x", agentId: "y" },
      sessions: { "agent-1": { syncedMessageIds: ["user:stale"], uncommittedMessageIds: [] } },
    }),
  );
  const { manager: managerA, calls: callsA } = makeManager({ dir: dirA, stateFile: stateFileA });
  const agentA = makeAgent("agent-1", [userEvent("m1", "hello")]);
  await drainAndDispose(managerA, agentA);
  assert.equal(
    callsA.filter((c) => c.name === "addSessionMessage").length,
    1,
    "identity mismatch starts fresh; stale synced id ignored",
  );

  // Corrupt JSON: startup proceeds empty and syncs normally.
  const dirB = tempDir();
  const stateFileB = `${dirB}/state.json`;
  writeFileSync(stateFileB, "{ not json !!!");
  const { manager: managerB, calls: callsB } = makeManager({ dir: dirB, stateFile: stateFileB });
  const agentB = makeAgent("agent-1", [userEvent("m1", "hello")]);
  await drainAndDispose(managerB, agentB);
  assert.equal(callsB.filter((c) => c.name === "addSessionMessage").length, 1, "fresh sync after corrupt state");
});

test("commit flushes history, snapshots uncommitted ids, and clears only the snapshot", async () => {
  const { client, calls } = stubSessionClient();
  client.getTask = async (taskId) => {
    calls.push({ name: "getTask", taskId });
    return { task_id: taskId, status: "completed", result: { archived: true, memories_extracted: { events: 3 } } };
  };
  const { manager } = makeManager({ client });
  await manager.init();
  const agent = makeAgent("agent-1", [userEvent("m1", "one"), userEvent("m2", "two")]);
  manager.adopt(agent);
  const result = await manager.commitCurrentSession(agent, undefined);
  assert.equal(result.status, "completed");
  assert.equal(result.memories_extracted, 3);
  assert.equal(result.archived, true);

  const commit = calls.find((c) => c.name === "commitSession");
  assert.equal(commit.sessionId, "agent-1");
  const tasks = calls.filter((c) => c.name === "getTask");
  assert.equal(tasks.length, 1);

  // A message arriving after the commit starts must survive the snapshot clear.
  agent.session.append("user/message", {
    id: "m3",
    role: "user",
    content: [{ type: "text", text: "three" }],
    source: { kind: "user" },
  }, { surfaceOp: "append" });
  await manager.flushSession(agent);
  await manager.dispose();

  const state = JSON.parse(readFileSync(manager.statePath, "utf8"));
  assert.equal(state.sessions["agent-1"].syncedMessageIds.length, 3);
  assert.deepEqual(state.sessions["agent-1"].uncommittedMessageIds, ["user:m3"], "committed ids dropped, post-commit id kept");
});

test("failed commit task clears pending but keeps uncommitted for retry", async () => {
  const { client, calls } = stubSessionClient();
  client.getTask = async (taskId) => ({ task_id: taskId, status: "failed", error: "extraction blew up" });
  const { manager } = makeManager({ client });
  await manager.init();
  const agent = makeAgent("agent-1", [userEvent("m1", "one")]);
  manager.adopt(agent);
  await assert.rejects(() => manager.commitCurrentSession(agent, undefined), /extraction blew up/);
  await manager.dispose();

  const state = JSON.parse(readFileSync(`${manager.statePath}`, "utf8"));
  assert.deepEqual(state.sessions["agent-1"].uncommittedMessageIds, ["user:m1"], "uncommitted ids preserved for retry");
  assert.equal(state.sessions["agent-1"].pendingCommit, undefined);
});

test("commitExplicitSession commits a foreign session without touching local state", async () => {
  const { client, calls } = stubSessionClient();
  const { manager } = makeManager({ client });
  const result = await manager.commitExplicitSession("foreign-session", undefined);
  assert.equal(result.session_id, "foreign-session");
  assert.equal(result.status, "completed");
  const commit = calls.find((c) => c.name === "commitSession");
  assert.equal(commit.sessionId, "foreign-session");
  await manager.dispose();
  const state = JSON.parse(readFileSync(manager.statePath, "utf8"));
  assert.deepEqual(state.sessions, {}, "no local state written for foreign sessions");
});

test("auto-commit drains, commits, and polls an existing pending commit without duplicate POSTs", async () => {
  const { client, calls } = stubSessionClient();
  let taskStatus = "running";
  client.getTask = async (taskId) => {
    calls.push({ name: "getTask", taskId });
    return { task_id: taskId, status: taskStatus, result: { archived: true, memories_extracted: { total: 1 } } };
  };
  const { manager } = makeManager({
    client,
    autoCommit: { enabled: true, intervalMinutes: 1 },
  });
  await manager.init();
  // Make intervalMinutes effectively zero by setting lastCommitTime far in the past.
  const agent = makeAgent("agent-1", [userEvent("m1", "auto message")]);
  manager.adopt(agent);
  await manager.waitForChain(agent);
  assert.equal(calls.filter((c) => c.name === "addSessionMessage").length, 1, "tick drain mirrors the message first");

  // Force the state's lastCommitTime back so the interval is reached.
  const state = manager.states.get("agent-1");
  state.lastCommitTime = Date.now() - 2 * 60 * 1000;
  await manager.runAutoCommitTick();
  assert.equal(calls.filter((c) => c.name === "commitSession").length, 1, "auto commit posted");
  assert.equal(calls.filter((c) => c.name === "getTask").length, 0, "tick does not wait for the task");

  // A commit already in flight is polled, never re-POSTed.
  state.pendingCommit = { taskId: "task-9", startedAt: Date.now(), messageIds: ["user:m1"] };
  const postsBefore = calls.filter((c) => c.name === "commitSession").length;
  await manager.runAutoCommitTick();
  assert.equal(calls.filter((c) => c.name === "commitSession").length, postsBefore, "existing pending commit polled without a second POST");
  assert.ok(calls.some((c) => c.name === "getTask" && c.taskId === "task-9"), "pending task polled");

  // Later ticks keep polling until the task completes and clears the snapshot.
  taskStatus = "completed";
  await manager.runAutoCommitTick();
  await manager.dispose();
  const persisted = JSON.parse(readFileSync(manager.statePath, "utf8"));
  assert.equal(persisted.sessions["agent-1"].pendingCommit, undefined);
  assert.deepEqual(persisted.sessions["agent-1"].uncommittedMessageIds, [], "completed commit cleared the snapshot");
});

test("synchronous commit completion clears snapshot ids and later ticks do not re-commit", async () => {
  const { client, calls } = stubSessionClient({
    async commitSession(sessionId) {
      calls.push({ name: "commitSession", sessionId });
      return { session_id: sessionId, status: "completed", archived: false };
    },
  });
  const { manager } = makeManager({ client, autoCommit: { enabled: true, intervalMinutes: 1 } });
  await manager.init();
  const agent = makeAgent("agent-1", [userEvent("m1", "one"), userEvent("m2", "two")]);
  manager.adopt(agent);
  await manager.waitForChain(agent);
  assert.equal(calls.filter((c) => c.name === "addSessionMessage").length, 2);

  const state = manager.states.get("agent-1");
  state.lastCommitTime = Date.now() - 2 * 60 * 1000;
  await manager.runAutoCommitTick();
  assert.equal(calls.filter((c) => c.name === "commitSession").length, 1, "auto commit posted");
  assert.deepEqual([...state.uncommittedMessageIds], [], "sync-complete cleared the snapshot ids");

  // A later tick must not re-commit: even with the interval reached again, the
  // uncommitted set is empty.
  state.lastCommitTime = Date.now() - 2 * 60 * 1000;
  await manager.runAutoCommitTick();
  assert.equal(calls.filter((c) => c.name === "commitSession").length, 1, "no re-commit after sync-complete clearing");
  await manager.dispose();
});

test("commitCurrentSession synchronous completion clears uncommitted ids", async () => {
  const { client, calls } = stubSessionClient({
    async commitSession(sessionId) {
      calls.push({ name: "commitSession", sessionId });
      return { session_id: sessionId, status: "completed", archived: true };
    },
  });
  const { manager } = makeManager({ client });
  await manager.init();
  const agent = makeAgent("agent-1", [userEvent("m1", "one")]);
  manager.adopt(agent);
  const result = await manager.commitCurrentSession(agent, undefined);
  assert.equal(result.status, "completed");
  assert.equal(result.archived, true);
  assert.equal(calls.filter((c) => c.name === "commitSession").length, 1);
  assert.equal(calls.filter((c) => c.name === "getTask").length, 0, "no task to poll after synchronous completion");
  assert.deepEqual([...manager.states.get("agent-1").uncommittedMessageIds], [], "snapshot ids cleared");
  await manager.dispose();
  const persisted = JSON.parse(readFileSync(manager.statePath, "utf8"));
  assert.deepEqual(persisted.sessions["agent-1"].uncommittedMessageIds, []);
});

test("dispose runs a final drain for queued messages before saving state", async () => {
  // A message appended without an event drain: only dispose's final drain can
  // deliver it, and its progress must be persisted.
  const dir = tempDir();
  const stateFile = `${dir}/state.json`;
  const { client, calls } = stubSessionClient();
  const { manager } = makeManager({ dir, stateFile, client });
  await manager.init();
  const agent = makeAgent("agent-1", [userEvent("m1", "hello")]);
  manager.adopt(agent);
  await manager.waitForChain(agent);
  assert.equal(calls.filter((c) => c.name === "addSessionMessage").length, 1);

  agent.session.append("user/message", {
    id: "m2",
    role: "user",
    content: [{ type: "text", text: "queued late" }],
    source: { kind: "user" },
  }, { surfaceOp: "append" });
  await manager.dispose();

  const sends = calls.filter((c) => c.name === "addSessionMessage").map((c) => c.content);
  assert.deepEqual(sends, ["hello", "queued late"], "dispose final drain delivers unsynced messages");
  const persisted = JSON.parse(readFileSync(stateFile, "utf8"));
  assert.deepEqual(persisted.sessions["agent-1"].syncedMessageIds, ["user:m1", "user:m2"], "final drain progress persisted");

  // A drain queued before dispose also runs during disposal (closing does not
  // skip accepted work; forget() only stops *new* drains).
  const { client: client2, calls: calls2 } = stubSessionClient();
  const { manager: manager2 } = makeManager({ client: client2 });
  await manager2.init();
  const agent2 = makeAgent("agent-2", [userEvent("n1", "first")]);
  manager2.adopt(agent2);
  await manager2.waitForChain(agent2);
  agent2.session.append("user/message", {
    id: "n2",
    role: "user",
    content: [{ type: "text", text: "queued drain" }],
    source: { kind: "user" },
  }, { surfaceOp: "append" });
  manager2.queueDrain(agent2);
  await manager2.dispose();
  const sends2 = calls2.filter((c) => c.name === "addSessionMessage").map((c) => c.content);
  assert.deepEqual(sends2, ["first", "queued drain"], "pre-dispose queued drain runs during disposal");
});

test("adoption during state load defers until init completes and uses loaded state", async () => {
  const dir = tempDir();
  const stateFile = `${dir}/state.json`;
  writeFileSync(
    stateFile,
    JSON.stringify({
      version: 1,
      identity: { endpoint: "http://localhost:1933", account: "astrbot", user: "alice", agentId: "harness-1" },
      sessions: { "agent-1": { syncedMessageIds: ["user:m1"], uncommittedMessageIds: [] } },
    }),
  );
  const { manager, calls } = makeManager({ dir, stateFile });
  const agent = makeAgent("agent-1", [userEvent("m1", "hello"), userEvent("m2", "world")]);
  // Adopt while init is suspended inside loadState: the adopt must be gated
  // behind init so it cannot create fresh state that loadState overwrites.
  const initPromise = manager.init();
  manager.adopt(agent);
  await initPromise;
  await manager.waitForChain(agent);

  const sends = calls.filter((c) => c.name === "addSessionMessage").map((c) => c.content);
  assert.deepEqual(sends, ["world"], "loaded synced ids honored; no fresh-state overwrite");
  await manager.dispose();
});


test("auto-commit turns rhythm: commits once N user turns accumulate, not wall-clock alone", async (t) => {
  const { client, calls } = stubSessionClient({
    async commitSession(sessionId) {
      calls.push({ name: "commitSession", sessionId });
      return { session_id: sessionId, status: "completed", archived: false };
    },
  });
  const { manager } = makeManager({ client, autoCommit: { enabled: true, turns: 3, intervalMinutes: 10 } });
  t.after(() => manager.dispose());
  await manager.init();
  const agent = makeAgent("agent-1", [userEvent("m1", "一"), userEvent("m2", "二")]);
  manager.adopt(agent);
  await manager.waitForChain(agent);
  assert.equal(calls.filter((c) => c.name === "addSessionMessage").length, 2);

  // Two user turns < 3 and the session never committed: the turn trigger has
  // not been reached, so the tick must NOT fall back to wall-clock (a
  // never-committed session is not treated as "last commit long ago").
  await manager.runAutoCommitTick();
  assert.equal(calls.filter((c) => c.name === "commitSession").length, 0, "turn trigger not reached, no commit");

  // A third user turn arrives: 3 turns accumulate → commit posts.
  agent.session.append("user/message", userEvent("m3", "三").data, { surfaceOp: "append" });
  manager.queueDrain(agent);
  await manager.waitForChain(agent);
  await manager.runAutoCommitTick();
  assert.equal(calls.filter((c) => c.name === "commitSession").length, 1, "3rd user turn triggers the commit");
  assert.equal(calls.filter((c) => c.name === "addSessionMessage").length, 3);
});

test("auto-commit turns rhythm: wall-clock still flushes dirty sessions when the turn count is not reached", async (t) => {
  const { client, calls } = stubSessionClient({
    async commitSession(sessionId) {
      calls.push({ name: "commitSession", sessionId });
      return { session_id: sessionId, status: "completed", archived: false };
    },
  });
  const { manager } = makeManager({ client, autoCommit: { enabled: true, turns: 3, intervalMinutes: 1 } });
  t.after(() => manager.dispose());
  await manager.init();
  const agent = makeAgent("agent-1", [userEvent("m1", "一"), userEvent("m2", "二")]);
  manager.adopt(agent);
  await manager.waitForChain(agent);
  const state = manager.states.get("agent-1");
  state.lastCommitTime = Date.now() - 2 * 60 * 1000;
  await manager.runAutoCommitTick();
  assert.equal(calls.filter((c) => c.name === "commitSession").length, 1, "wall-clock fallback commits after the interval");
});

test("auto-commit turns=0 keeps the wall-clock fallback", async () => {
  const { client, calls } = stubSessionClient({
    async commitSession(sessionId) {
      calls.push({ name: "commitSession", sessionId });
      return { session_id: sessionId, status: "completed", archived: false };
    },
  });
  const { manager } = makeManager({ client, autoCommit: { enabled: true, turns: 0, intervalMinutes: 1 } });
  await manager.init();
  const agent = makeAgent("agent-1", [userEvent("m1", "one")]);
  manager.adopt(agent);
  await manager.waitForChain(agent);
  const state = manager.states.get("agent-1");
  state.lastCommitTime = Date.now() - 2 * 60 * 1000;
  await manager.runAutoCommitTick();
  assert.equal(calls.filter((c) => c.name === "commitSession").length, 1, "interval fallback commits");
  await manager.dispose();
});

test("auto-commit turns=0: a never-committed session commits on the first tick via the interval fallback", async (t) => {
  const { client, calls } = stubSessionClient({
    async commitSession(sessionId) {
      calls.push({ name: "commitSession", sessionId });
      return { session_id: sessionId, status: "completed", archived: false };
    },
  });
  const { manager } = makeManager({ client, autoCommit: { enabled: true, turns: 0, intervalMinutes: 1 } });
  t.after(() => manager.dispose());
  await manager.init();
  const agent = makeAgent("agent-1", [userEvent("m1", "one")]);
  manager.adopt(agent);
  await manager.waitForChain(agent);
  // lastCommitTime stays undefined: the session never committed before, yet
  // with turns=0 the interval is the only fallback and must not wait forever.
  assert.equal(manager.states.get("agent-1").lastCommitTime, undefined);
  await manager.runAutoCommitTick();
  assert.equal(calls.filter((c) => c.name === "commitSession").length, 1, "interval fallback commits a never-committed session");
});

test("auto-commit turns>0: a never-committed session still waits for the turn trigger", async (t) => {
  const { client, calls } = stubSessionClient({
    async commitSession(sessionId) {
      calls.push({ name: "commitSession", sessionId });
      return { session_id: sessionId, status: "completed", archived: false };
    },
  });
  const { manager } = makeManager({ client, autoCommit: { enabled: true, turns: 3, intervalMinutes: 1 } });
  t.after(() => manager.dispose());
  await manager.init();
  const agent = makeAgent("agent-1", [userEvent("m1", "one"), userEvent("m2", "two")]);
  manager.adopt(agent);
  await manager.waitForChain(agent);
  // 2 user turns < 3 and the session never committed (lastCommitTime
  // undefined): it must NOT be treated as "last commit long ago" and must
  // NOT fall back to wall-clock.
  assert.equal(manager.states.get("agent-1").lastCommitTime, undefined);
  await manager.runAutoCommitTick();
  assert.equal(calls.filter((c) => c.name === "commitSession").length, 0, "turn trigger not reached, no commit");
});
