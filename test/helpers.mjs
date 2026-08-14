/**
 * Shared helpers for the dsh-openviking test suites.
 */
import { createServer } from "node:http";
import { Session, SessionId } from "@deepseek-ai/dsh-session";

/** Start a local HTTP server that records requests and delegates to `handler`. */
export async function fakeServer(handler) {
  const requests = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      const record = {
        method: req.method,
        url: req.url,
        headers: req.headers,
        body,
        json: body ? safeJson(body) : undefined,
      };
      requests.push(record);
      Promise.resolve()
        .then(() => handler(req, res, record))
        .catch((error) => {
          res.statusCode = 500;
          res.end(JSON.stringify({ status: "error", error: { code: "TEST_HANDLER", message: String(error) } }));
        });
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Wrap a JSON body in the OpenViking envelope. */
export function okEnvelope(result) {
  return JSON.stringify({ status: "ok", result });
}

export function errorEnvelope(code, message) {
  return JSON.stringify({ status: "error", error: { code, message } });
}

/** A stub OpenViking client recording every call. */
export function stubClient(overrides = {}) {
  const calls = [];
  const record = (name) => (...args) => {
    calls.push({ name, args });
    return undefined;
  };
  const client = {
    endpoint: "http://stub",
    health: record("health"),
    find: record("find"),
    search: record("search"),
    readContent: record("readContent"),
    list: record("list"),
    tree: record("tree"),
    stat: record("stat"),
    remove: record("remove"),
    grep: record("grep"),
    glob: record("glob"),
    uploadTempFile: record("uploadTempFile"),
    addResource: record("addResource"),
    queue: record("queue"),
    getSession: record("getSession"),
    createSession: record("createSession"),
    addSessionMessage: record("addSessionMessage"),
    commitSession: record("commitSession"),
    getTask: record("getTask"),
    ...overrides,
  };
  return { client, calls };
}

/** A stub fs service recording calls; `content` is returned by readText. */
export function stubFs({ content = "hello from stub fs", statType = "file" } = {}) {
  const calls = [];
  return {
    fs: {
      async resolve(path, opts) {
        calls.push({ name: "resolve", path, opts });
        return { targetKey: `key:${path}`, displayPath: path };
      },
      async stat(target) {
        calls.push({ name: "stat", path: target?.displayPath });
        return { version: "v1", type: statType };
      },
      async readText(target) {
        calls.push({ name: "readText", path: target?.displayPath });
        return content;
      },
    },
    fsCalls: calls,
  };
}

/** A stub ctx with only what SessionManager needs. */
export function stubCtx({ agents = [] } = {}) {
  const warnings = [];
  return {
    agents: { list: () => agents },
    logger: () => ({
      warn: (...args) => warnings.push(args),
      info: () => {},
      debug: () => {},
    }),
    warnings,
  };
}

/** Minimal agent object with a live session; satisfies the public Agent interface for tests. */
export function makeAgent(id, events = []) {
  // Session seeds must be contiguous from seq 0.
  const normalized = events.map((event, index) => ({ ...event, seq: index }));
  const session = Session.create(SessionId(id), normalized);
  const agent = {
    id: session.id,
    options: {},
    session,
    inbox: {},
    status: "idle",
    ctx: undefined,
    cancel() {},
    whenIdle: async () => {},
    runMaintenance: async () => {},
    send() {},
    followup() {},
    steer() {},
    inject() {},
  };
  return agent;
}

/** Wait a few event-loop turns so fire-and-forget promises settle. */
export function awaitTicks(n = 3) {
  const step = () => new Promise((resolve) => setImmediate(resolve));
  let chain = Promise.resolve();
  for (let i = 0; i < n; i += 1) chain = chain.then(step);
  return chain;
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Build the common `{ kind: 'user', source: { kind: 'user' } }` event shapes. */
export function userEvent(id, text, extra = {}) {
  return {
    type: "user/message",
    seq: extra.seq ?? 0,
    time: Date.now(),
    data: {
      id,
      role: "user",
      content: [{ type: "text", text }],
      source: { kind: "user" },
      ...extra.data,
    },
    surfaceOp: "append",
  };
}

export function pluginUserEvent(id, text) {
  return {
    type: "user/message",
    seq: 0,
    time: Date.now(),
    data: {
      id,
      role: "user",
      content: [{ type: "text", text }],
      source: { kind: "plugin", plugin: "test" },
    },
    surfaceOp: "append",
  };
}

export function toolUserEvent(id, text) {
  return {
    type: "user/message",
    seq: 0,
    time: Date.now(),
    data: {
      id,
      role: "user",
      content: [{ type: "text", text }],
      source: { kind: "tool", callId: "call-1" },
    },
    surfaceOp: "append",
  };
}

export function assistantEvent(id, text, extra = {}) {
  return {
    type: "assistant/message",
    seq: extra.seq ?? 0,
    time: Date.now(),
    data: {
      turn: 1,
      step: 1,
      message: {
        id,
        role: "assistant",
        content: [{ type: "text", text }],
        source: { kind: "model", provider: "test", model: "test-model" },
      },
      ...extra.data,
    },
    surfaceOp: "append",
  };
}

export function mixedContentEvent(id, text, reasoning) {
  return {
    type: "user/message",
    seq: 0,
    time: Date.now(),
    data: {
      id,
      role: "user",
      content: [
        { type: "reasoning", text: reasoning ?? "think think" },
        { type: "text", text },
        { type: "image", attachment: { ref: "img-1" } },
      ],
      source: { kind: "user" },
    },
    surfaceOp: "append",
  };
}

export function tempStateFile(dir, name = "state.json") {
  return `${dir}/${name}`;
}
