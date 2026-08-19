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