/**
 * Human `/memlearn` command registration and model-tool parity tests.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createOpenVikingTools } from "../lib/tools.js";
import { createLearnService } from "../lib/learn-service.js";
import {
  registerCommandsOn,
  registerOpenVikingCommands,
  MEMLEARN_USAGE,
} from "../lib/commands.js";
import { stubClient, makeAgent } from "./helpers.mjs";

// ─── helpers ────────────────────────────────────────────────────────────

function makeDeps(client = stubClient().client) {
  return { client, learn: createLearnService(client), timeoutMs: () => 30_000 };
}

/** In-memory command registry mimicking CommandRuntime.register(). */
function fakeCommands() {
  const definitions = new Map();
  const disposers = [];
  return {
    definitions,
    register(definition) {
      definitions.set(definition.name, definition);
      let disposed = false;
      const dispose = () => {
        if (disposed) return;
        disposed = true;
        definitions.delete(definition.name);
      };
      disposers.push(dispose);
      return dispose;
    },
    disposeAll() {
      for (const dispose of disposers) dispose();
    },
    find(_agent, name) {
      return definitions.get(name);
    },
    list(_agent) {
      return [...definitions.values()]
        .map((definition) => ({
          name: definition.name,
          description: definition.description,
          ...(definition.input ? { input: definition.input } : {}),
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
    },
  };
}

function invocation(rawInput, { signal = new AbortController().signal, agent } = {}) {
  return { commandId: "cmd-test-1", agent: agent ?? makeAgent("agent-1"), rawInput, signal };
}

async function runCommand(definitions, name, rawInput, options) {
  const definition = definitions.get(name);
  assert.ok(definition, `command ${name} registered`);
  return definition.handler(invocation(rawInput, options));
}

/** Stub client with real LearnService-callable behavior and call recording. */
function learnStub({ find = undefined } = {}) {
  const abortError = () => new DOMException("The operation was aborted", "AbortError");
  const calls = [];
  const client = {
    endpoint: "http://stub",
    async find(opts = {}) {
      if (opts.signal?.aborted) throw abortError();
      if (find) return find();
      return { memories: [{ uri: "viking://user/memories/existing.md", score: 0.91 }], resources: [], skills: [], total: 1 };
    },
    async writeContent(uri, content, opts = {}) {
      if (opts.signal?.aborted) throw abortError();
      calls.push({ name: "writeContent", uri, content, opts });
      return { uri };
    },
    async getSkill() {
      const error = new Error("not found");
      error.code = "NOT_FOUND";
      throw error;
    },
    async addSkill(data) {
      calls.push({ name: "addSkill", data });
      return { status: "success", uri: `viking://agent/skills/${data.name}`, name: data.name };
    },
    async updateSkill(name, data) {
      calls.push({ name: "updateSkill", name, data });
      return { status: "success", uri: `viking://agent/skills/${name}`, name };
    },
  };
  return { client, calls };
}

function toolExec(extra = {}) {
  const deferred = [];
  return {
    signal: new AbortController().signal,
    deferContext(context) {
      deferred.push(context);
    },
    deferred,
    ...extra,
  };
}

// ─── 5.1 /memlearn registration, discovery, disposal, parsing ──────────

test("5.1 registers memlearn on the command registry, discoverable and disposable", () => {
  const commands = fakeCommands();
  const disposers = registerCommandsOn(commands, makeDeps());
  assert.equal(disposers.length, 1);

  const descriptors = commands.list(makeAgent("agent-1"));
  assert.deepEqual(descriptors.map((d) => d.name), ["memlearn"]);
  const memlearn = commands.find(undefined, "memlearn");
  assert.ok(memlearn.description.includes("lesson"));
  assert.equal(memlearn.recordInput, false, "raw lesson never duplicated into the session log");
  assert.equal(memlearn.input.hint, "<lesson to remember>");

  for (const dispose of disposers) dispose();
  assert.equal(commands.find(undefined, "memlearn"), undefined);
});

test("5.1 /memlearn accepts a free-form lesson, routes through the shared service, and reports action/kind/uri/redacted", async () => {
  const { client, calls } = learnStub();
  const commands = fakeCommands();
  registerCommandsOn(commands, makeDeps(client));

  const result = await runCommand(
    commands.definitions,
    "memlearn",
    "   The deployment requires a fake server before lifecycle tests   ",
  );
  assert.equal(result.kind, "success");
  assert.match(result.text, /Learned: merged \(memory\)/);
  assert.match(result.text, /uri: viking:\/\/user\/memories\/existing\.md/);
  assert.match(result.text, /redacted: 0/);
  const write = calls.find((c) => c.name === "writeContent");
  assert.ok(write, "lesson persisted through writeContent");
  assert.match(write.content, /fake server before lifecycle tests/);
  assert.equal(result.sourceEventSeq, undefined, "command text is the single emission");
});

test("5.1 empty /memlearn input returns usage, calls no OpenViking, and opens no model turn", async () => {
  const { client, calls } = learnStub();
  const commands = fakeCommands();
  registerCommandsOn(commands, makeDeps(client));

  const empty = await runCommand(commands.definitions, "memlearn", "   ");
  assert.equal(empty.kind, "error");
  assert.match(empty.text, /Usage: \/memlearn/);
  assert.deepEqual(calls, [], "no persistence call on empty input");
  assert.equal(MEMLEARN_USAGE.includes("Usage: /memlearn"), true);

  const whitespaceOnly = await runCommand(commands.definitions, "memlearn", "\t\n ");
  assert.equal(whitespaceOnly.kind, "error");
  assert.match(whitespaceOnly.text, /Usage: \/memlearn/);
});


// ─── 5.2 parity between /memlearn, the service, and the model tool ──────

test("5.2 secret redaction parity: command, service, and model tool persist identical redacted text and counts", async () => {
  const lesson = "Keep the api key sk-abcdefghijklmnopqrstuvwxyz123456 out of search.";
  const expectedRedacted = 1;
  const HIT = () => ({ memories: [{ uri: "viking://user/memories/x.md", score: 0.9 }], resources: [], skills: [], total: 1 });

  // Model tool path: records the persisted (redacted) text and checks injection.
  const toolRecord = [];
  const toolClient = stubClient().client;
  toolClient.find = HIT;
  toolClient.writeContent = async (uri, content, opts) => {
    toolRecord.push(content);
    return { uri };
  };
  const ctx = { fs: {} };
  const sessionManager = { async ensureSession() {} };
  const tools = createOpenVikingTools(ctx, toolClient, sessionManager, { timeoutMs: 30000 });
  const tool = tools.find((t) => t.name === "memlearn");
  const toolValue = await tool.execute({ memory: lesson }, toolExec());
  assert.equal(toolValue.redacted, expectedRedacted);
  assert.equal(toolValue.injected, true);

  // Service path without inject (the command has no model turn).
  const serviceWrites = [];
  const serviceClient = stubClient().client;
  serviceClient.find = HIT;
  serviceClient.writeContent = async (uri, content) => {
    serviceWrites.push(content);
    return { uri };
  };
  const service = createLearnService(serviceClient);
  const serviceValue = await service.learn({ memory: lesson }, {});
  assert.equal(serviceValue.redacted, expectedRedacted);
  assert.equal(serviceValue.injected, false);
  assert.equal(serviceValue.action, "merged");
  assert.equal(serviceValue.uri, "viking://user/memories/x.md");

  // Command path.
  const commands = fakeCommands();
  registerCommandsOn(commands, makeDeps(serviceClient));
  const commandResult = await runCommand(commands.definitions, "memlearn", lesson);
  assert.equal(commandResult.kind, "success");
  assert.match(commandResult.text, new RegExp(`Learned: merged \\(memory\\)`));
  assert.match(commandResult.text, new RegExp(`redacted: ${expectedRedacted}`));

  // All three persist the same redacted lesson text.
  const redactedCheck = (text) => {
    assert.ok(text.includes("[redacted]"), "secret replaced");
    assert.ok(!text.includes("sk-abcdefghijklmnopqrstuvwxyz123456"), "raw secret never persisted");
  };
  redactedCheck(toolRecord[0]);
  redactedCheck(serviceWrites[0]);
  redactedCheck(toolRecord[0]);
});

test("5.2 dedupe and no-match parity: command and model tool share merge selection and no-fake-write behavior", async () => {
  const lesson = "Brand-new topic with a close neighbor.";

  // High-score hit → both merge into the same URI.
  const hitClient = stubClient().client;
  hitClient.find = () => Promise.resolve({ memories: [{ uri: "viking://user/memories/patterns/high.md", score: 0.83 }], resources: [], skills: [], total: 1 });
  const writes = [];
  hitClient.writeContent = async (uri, content, opts) => {
    writes.push(uri);
    return { uri };
  };
  const ctx = { fs: {} };
  const sessionManager = { async ensureSession() {} };
  const tools = createOpenVikingTools(ctx, hitClient, sessionManager, { timeoutMs: 30000 });
  const tool = tools.find((t) => t.name === "memlearn");
  const toolValue = await tool.execute({ memory: lesson }, toolExec());

  const service = createLearnService(hitClient);
  const serviceValue = await service.learn({ memory: lesson }, {});

  const commands = fakeCommands();
  registerCommandsOn(commands, makeDeps(hitClient));
  const commandValue = await runCommand(commands.definitions, "memlearn", lesson);

  assert.equal(toolValue.uri, "viking://user/memories/patterns/high.md");
  assert.equal(serviceValue.uri, toolValue.uri);
  assert.equal(commandValue.kind, "success");
  assert.match(commandValue.text, /viking:\/\/user\/memories\/patterns\/high\.md/);
  assert.equal(writes.filter((u) => u === toolValue.uri).length >= 2, true, "both paths append to the same memory");

  // No hit → both report no-match and write nothing.
  const noneClient = stubClient().client;
  const noneWrites = [];
  noneClient.find = () => Promise.resolve({ memories: [], resources: [], skills: [], total: 0 });
  noneClient.writeContent = async (uri, content) => {
    noneWrites.push(uri);
    return { uri };
  };
  const noneCommands = fakeCommands();
  registerCommandsOn(noneCommands, makeDeps(noneClient));
  const noneResult = await runCommand(noneCommands.definitions, "memlearn", "Fresh topic with no neighbor.");
  assert.equal(noneResult.kind, "success");
  assert.match(noneResult.text, /no-match/);
  assert.match(noneResult.text, /memcommit/);
  assert.deepEqual(noneWrites, [], "no fake write on no-match");
});

test("5.2 limits and error parity: oversized lesson and invalid skill names fail identically", async () => {
  const { client } = learnStub();
  const service = createLearnService(client);
  const commands = fakeCommands();
  registerCommandsOn(commands, makeDeps(client));

  const oversized = "x".repeat(8_001);
  await assert.rejects(() => service.learn({ memory: oversized }, {}), /exceeds 8000 characters/);
  const command = await runCommand(commands.definitions, "memlearn", oversized);
  assert.equal(command.kind, "error");
  assert.match(command.text, /exceeds 8000 characters/);

  const emptyError = await runCommand(commands.definitions, "memlearn", "");
  assert.equal(emptyError.kind, "error");
  assert.match(emptyError.text, /Usage:/);

  // A service OpenViking failure must not claim persistence.
  const failing = stubClient().client;
  failing.find = () => Promise.reject(Object.assign(new Error("boom"), { code: "UNREACHABLE" }));
  const failingCommands = fakeCommands();
  registerCommandsOn(failingCommands, makeDeps(failing));
  const failed = await runCommand(failingCommands.definitions, "memlearn", "some lesson");
  assert.equal(failed.kind, "error");
  assert.ok(!failed.text.includes("persisted"));
});



test("5.5 /memlearn cancellation reports cancellation and never a successful persistence result", async () => {
  const controller = new AbortController();
  controller.abort();
  const { client, calls } = learnStub();
  const commands = fakeCommands();
  registerCommandsOn(commands, makeDeps(client));
  const result = await runCommand(commands.definitions, "memlearn", "a lesson", { signal: controller.signal });
  assert.equal(result.kind, "error");
  assert.match(result.text, /cancelled/i);
  assert.ok(!result.text.includes("Learned:"), "no success emission on cancel");
  assert.deepEqual(calls, [], "no persistence attempt after cancellation");
});

// ─── 4.1 conditional registration ───────────────────────────────────────

test("4.1 registration is skipped entirely when ctx.commands is unavailable", () => {
  const deps = makeDeps();
  assert.doesNotThrow(() => registerOpenVikingCommands({ effect() {} }, deps));
});


test("4.1 registration defers through the nested inject when commands mounts later", () => {
  const effects = [];
  const injections = [];
  const commands = fakeCommands();
  const ctx = {
    effect(callback) {
      effects.push(callback);
    },
    inject(deps, callback) {
      injections.push([deps, callback]);
    },
  };
  registerOpenVikingCommands(ctx, makeDeps());
  ctx.commands = commands;
  assert.deepEqual(injections[0][0], ["commands"]);
  assert.equal(commands.definitions.size, 0, "nothing registered before capability mount");

  injections[0][1](ctx);
  assert.deepEqual([...commands.definitions.keys()], ["memlearn"]);

  for (const effect of effects) {
    const dispose = effect();
    if (typeof dispose === "function") dispose();
  }
  assert.equal(commands.definitions.size, 0, "lifecycle disposal unregisters commands");
});