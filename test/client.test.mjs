/**
 * OpenVikingClient unit tests: auth headers, secret hygiene, timeout/abort
 * error mapping, and the wrapped-response unwrapping rules.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { OpenVikingClient } from "../lib/client.js";
import { OpenVikingError, OpenVikingTimeoutError } from "../lib/types.js";
import { fakeServer, okEnvelope, errorEnvelope, sleep } from "./helpers.mjs";

const API_KEY = "sekrit-test-key-123";

function makeClient(serverUrl, options = {}) {
  return new OpenVikingClient({
    endpoint: serverUrl + "/",
    apiKey: API_KEY,
    account: "astrbot",
    user: "alice",
    agentId: "agent-1",
    timeoutMs: 5000,
    ...options,
  });
}

test("identity headers and request headers are emitted only when applicable", async () => {
  const server = await fakeServer((req, res) => {
    if (req.url === "/api/v1/observer/queue") res.end(okEnvelope({ items: [] }));
    else res.end(okEnvelope({ healthy: true }));
  });
  try {
    const client = makeClient(server.url);
    await client.health();
    const record = server.requests[0];
    assert.equal(record.url, "/health");
    assert.equal(record.headers["x-api-key"], API_KEY);
    assert.equal(record.headers["x-openviking-account"], "astrbot");
    assert.equal(record.headers["x-openviking-user"], "alice");
    assert.equal(record.headers["x-openviking-agent"], "agent-1");
    // GET without a JSON body must not carry Content-Type: application/json.
    assert.equal(record.headers["content-type"], undefined);

    // Empty identity values and no body: neither identity nor content-type headers appear.
    const emptyClient = makeClient(server.url, { apiKey: "", account: "", user: "", agentId: "" });
    await emptyClient.queue();
    const emptyRecord = server.requests[1];
    assert.equal(emptyRecord.headers["x-api-key"], undefined);
    assert.equal(emptyRecord.headers["x-openviking-account"], undefined);
    assert.equal(emptyRecord.headers["content-type"], undefined);
  } finally {
    await server.close();
  }
});

test("find posts the expected body and unwraps the result", async () => {
  const server = await fakeServer((req, res) => {
    res.end(
      okEnvelope({
        memories: [{ uri: "viking://user/memories/1", score: 0.9, abstract: "m" }],
        resources: [],
        skills: [],
        total: 1,
        query_plan: { mode: "hybrid" },
      }),
    );
  });
  try {
    const client = makeClient(server.url);
    const result = await client.find({ query: "q?", targetUri: "viking://resources/", limit: 5, scoreThreshold: 0.2 });
    const record = server.requests[0];
    assert.equal(record.method, "POST");
    assert.equal(record.url, "/api/v1/search/find");
    assert.deepEqual(record.json, {
      query: "q?",
      target_uri: "viking://resources/",
      limit: 5,
      score_threshold: 0.2,
    });
    assert.deepEqual(result.memories, [{ uri: "viking://user/memories/1", score: 0.9, abstract: "m" }]);
    assert.equal(result.total, 1);
    assert.deepEqual(result.query_plan, { mode: "hybrid" });
  } finally {
    await server.close();
  }
});

test("service and HTTP errors preserve useful details without exposing the apiKey", async () => {
  const server = await fakeServer((req, res) => {
    if (req.url === "/api/v1/sessions/nope") {
      res.statusCode = 404;
      res.end(JSON.stringify({ detail: "no such session" }));
    } else {
      res.end(errorEnvelope("NOT_FOUND", "session x missing"));
    }
  });
  try {
    const client = makeClient(server.url);
    // Envelope-level service error: code and message surface; the key never leaks.
    await assert.rejects(
      () => client.getSession("sess-1"),
      (error) => {
        assert.ok(error instanceof OpenVikingError);
        assert.equal(error.code, "NOT_FOUND");
        assert.match(error.message, /\[NOT_FOUND\]/);
        assert.ok(!error.message.includes(API_KEY));
        return true;
      },
    );
    // HTTP-level error: status and FastAPI detail surface; the key never leaks.
    await assert.rejects(
      () => client.getSession("nope"),
      (error) => {
        assert.ok(error instanceof OpenVikingError);
        assert.equal(error.httpStatus, 404);
        assert.equal(error.code, "NOT_FOUND");
        assert.ok(!error.message.includes(API_KEY));
        return true;
      },
    );
  } finally {
    await server.close();
  }
});

test("malformed or incomplete responses produce stable protocol errors", async () => {
  const server = await fakeServer((req, res) => {
    if (req.url === "/api/v1/observer/queue") res.end("<html>oops</html>");
    else res.end(okEnvelope({ nope: 1 }));
  });
  try {
    const client = makeClient(server.url);
    await assert.rejects(
      () => client.queue(),
      (error) => {
        assert.ok(error instanceof OpenVikingError);
        assert.equal(error.code, "INVALID_JSON");
        return true;
      },
    );
    await assert.rejects(
      () => client.uploadTempFile("x.txt", new TextEncoder().encode("hi")),
      (error) => {
        assert.ok(error instanceof OpenVikingError);
        assert.equal(error.code, "INVALID_RESULT");
        return true;
      },
    );
  } finally {
    await server.close();
  }
});

test("timeouts and caller cancellation surface the correct public errors", async () => {
  const server = await fakeServer(() => {
    /* never respond */
  });
  try {
    const client = makeClient(server.url);
    // Internal per-request timeout surfaces the typed OpenVikingTimeoutError.
    const timeoutClient = makeClient(server.url, { timeoutMs: 100 });
    await assert.rejects(
      () => timeoutClient.queue(),
      (error) => {
        assert.ok(error instanceof OpenVikingTimeoutError);
        return true;
      },
    );
    // External caller cancellation is forwarded as a plain AbortError.
    const controller = new AbortController();
    const promise = client.queue(controller.signal);
    await sleep(20);
    controller.abort();
    await assert.rejects(promise, (error) => error.name === "AbortError");
  } finally {
    await server.close();
  }
});

test("uploadTempFile sends multipart with the file bytes", async () => {
  const server = await fakeServer((req, res) => {
    // multipart: capture raw body, respond with temp_file_id
    res.end(okEnvelope({ temp_file_id: "tmp-42" }));
  });
  try {
    const client = makeClient(server.url);
    const bytes = new TextEncoder().encode("file-content");
    const id = await client.uploadTempFile("note.txt", bytes);
    const record = server.requests[0];
    assert.equal(id, "tmp-42");
    assert.equal(record.method, "POST");
    assert.equal(record.url, "/api/v1/resources/temp_upload");
    assert.match(record.headers["content-type"], /^multipart\/form-data/);
    assert.ok(record.body.includes("note.txt"));
    assert.ok(record.body.includes("file-content"));
  } finally {
    await server.close();
  }
});

test("session, resource, delete, task, and commit methods map to canonical endpoints and fields", async () => {
  const server = await fakeServer((req, res) => {
    if (req.method === "DELETE") res.end(okEnvelope({ uri: "viking://resources/x" }));
    else if (req.url === "/api/v1/tasks/t-1") res.end(okEnvelope({ task_id: "t-1", status: "completed", result: { memories_extracted: { events: 2 } } }));
    else if (req.url === "/api/v1/sessions/s/commit") res.end(okEnvelope({ session_id: "s", status: "accepted", task_id: "t-1", archived: true }));
    else if (req.url === "/api/v1/sessions/sess-1/messages") res.end(okEnvelope({ session_id: "s", message_count: 3 }));
    else res.end(okEnvelope({ root_uri: "viking://resources/x" }));
  });
  try {
    const client = makeClient(server.url);

    const message = await client.addSessionMessage("sess-1", "user", "hello world");
    const messageRecord = server.requests[0];
    assert.equal(messageRecord.url, "/api/v1/sessions/sess-1/messages");
    assert.deepEqual(messageRecord.json, { role: "user", content: "hello world" });
    assert.equal(message.message_count, 3);

    const resource = await client.addResource({ tempFileId: "tmp-1", to: "viking://resources/x", reason: "r", wait: true, timeout: 60 });
    const resourceRecord = server.requests[1];
    assert.equal(resourceRecord.url, "/api/v1/resources");
    assert.deepEqual(resourceRecord.json, {
      temp_file_id: "tmp-1",
      to: "viking://resources/x",
      reason: "r",
      wait: true,
      timeout: 60,
    });
    assert.equal(resource.root_uri, "viking://resources/x");

    await client.remove({ uri: "viking://resources/x", recursive: true });
    const removeRecord = server.requests[2];
    assert.equal(removeRecord.method, "DELETE");
    assert.equal(removeRecord.url, "/api/v1/fs?uri=viking%3A%2F%2Fresources%2Fx&recursive=true");

    const task = await client.getTask("t-1");
    const taskRecord = server.requests[3];
    assert.equal(taskRecord.url, "/api/v1/tasks/t-1");
    assert.equal(task.status, "completed");
    assert.deepEqual(task.result.memories_extracted, { events: 2 });

    const commit = await client.commitSession("s");
    const commitRecord = server.requests[4];
    assert.equal(commitRecord.url, "/api/v1/sessions/s/commit");
    assert.equal(commitRecord.method, "POST");
    assert.equal(commit.archived, true);
  } finally {
    await server.close();
  }
});

test("FastAPI-style 404 {detail} body maps to error.code NOT_FOUND", async () => {
  const server = await fakeServer((req, res) => {
    res.statusCode = 404;
    res.end(JSON.stringify({ detail: "Session s does not exist" }));
  });
  try {
    const client = makeClient(server.url);
    await assert.rejects(
      () => client.getSession("s"),
      (error) => {
        assert.ok(error instanceof OpenVikingError);
        assert.equal(error.code, "NOT_FOUND");
        assert.equal(error.httpStatus, 404);
        assert.match(error.message, /\[NOT_FOUND\]/);
        assert.ok(!error.message.includes(API_KEY));
        return true;
      },
    );
  } finally {
    await server.close();
  }
});

test("202 with an envelope body unwraps like other 2xx; empty 202/204 resolve to null", async () => {
  const server = await fakeServer((req, res) => {
    if (req.url === "/api/v1/sessions/s/commit") {
      res.statusCode = 202;
      res.end(okEnvelope({ session_id: "s", status: "accepted", task_id: "t-9", archived: true }));
    } else if (req.url === "/api/v1/sessions/busy/commit") {
      res.statusCode = 202;
      res.end(errorEnvelope("BUSY", "commit already in progress"));
    } else if (req.url === "/api/v1/sessions/empty/commit") {
      res.statusCode = 202;
      res.end(); // empty 202 body → null
    } else {
      res.statusCode = 204;
      res.end(); // 204 never carries a body → null
    }
  });
  try {
    const client = makeClient(server.url);

    // 202 with a JSON envelope unwraps the result exactly like any other 2xx.
    const commit = await client.commitSession("s");
    assert.deepEqual(commit, { session_id: "s", status: "accepted", task_id: "t-9", archived: true });
    assert.equal(server.requests[0].method, "POST");
    assert.equal(server.requests[0].url, "/api/v1/sessions/s/commit");

    // 202 with a status:error envelope throws the envelope error, not null.
    await assert.rejects(
      () => client.commitSession("busy"),
      (error) => {
        assert.ok(error instanceof OpenVikingError);
        assert.equal(error.code, "BUSY");
        assert.equal(error.httpStatus, 202);
        assert.match(error.message, /\[BUSY\]/);
        return true;
      },
    );

    // Empty 202 and 204 bodies resolve to null (commit maps null → {}).
    assert.deepEqual(await client.commitSession("empty"), {});
    assert.equal(await client.queue(), null);
  } finally {
    await server.close();
  }
});

test("timeout and caller cancellation cover a stalled response body", async () => {
  // Headers are sent but the body never completes: the per-request timeout and
  // external abort must still reach the body read (previously the timer and
  // listener were cleared right after fetch resolved, so this could hang
  // forever and cancellation was lost after the headers arrived).
  const server = await fakeServer((req, res) => {
    res.on("error", () => {}); // client abort may destroy the socket mid-response
    res.writeHead(200, { "Content-Type": "application/json" });
    // intentionally never end the response body
  });
  try {
    const timeoutClient = makeClient(server.url, { timeoutMs: 100 });
    await assert.rejects(
      () => timeoutClient.queue(),
      (error) => {
        assert.ok(error instanceof OpenVikingTimeoutError);
        return true;
      },
    );

    const controller = new AbortController();
    const client = makeClient(server.url);
    const promise = client.queue(controller.signal);
    await sleep(20);
    controller.abort();
    await assert.rejects(promise, (error) => error.name === "AbortError");
  } finally {
    await server.close();
  }
});
test("getSession NOT_FOUND error carries code for ensure-session logic", async () => {
  const server = await fakeServer((req, res) => res.end(errorEnvelope("NOT_FOUND", "Session s not found")));
  try {
    const client = makeClient(server.url);
    await assert.rejects(
      () => client.getSession("s"),
      (error) => {
        assert.equal(error.code, "NOT_FOUND");
        return true;
      },
    );
  } finally {
    await server.close();
  }
});


test("writeContent and addSkill map to canonical endpoints, bodies, and unwrapping", async () => {
  const server = await fakeServer(async (req, res, record) => {
    if (req.url === "/api/v1/content/write") {
      const { json: body } = record;
      if (body?.uri !== "viking://user/memories/x.md") {
        res.statusCode = 404;
        res.end(errorEnvelope("NOT_FOUND", "no such file"));
        return;
      }
      res.end(okEnvelope({ uri: "viking://user/memories/x.md", root_uri: "viking://user/memories", context_type: "memory", mode: "append", written_bytes: 12, semantic_updated: true, vector_updated: true }));
    } else if (req.url === "/api/v1/skills") {
      res.end(okEnvelope({ status: "success", uri: "viking://agent/skills/deep-dive", name: "deep-dive", auxiliary_files: 0 }));
    } else if (req.url === "/api/v1/skills/deep-dive" && req.method === "GET") {
      res.end(okEnvelope({ name: "deep-dive", uri: "viking://user/dsh/skills/deep-dive" }));
    } else if (req.url === "/api/v1/skills/deep-dive" && req.method === "PUT") {
      res.end(okEnvelope({ status: "success", uri: "viking://user/dsh/skills/deep-dive", name: "deep-dive", auxiliary_files: 0, action: "update" }));
    } else {
      res.statusCode = 404;
      res.end(errorEnvelope("NOT_FOUND", "no route"));
    }
  });
  try {
    const client = new OpenVikingClient({ endpoint: server.url });
    const write = await client.writeContent("viking://user/memories/x.md", "lesson text", { mode: "append", signal: undefined });
    const writeRecord = server.requests[0];
    assert.equal(writeRecord.url, "/api/v1/content/write");
    assert.deepEqual(writeRecord.json, { uri: "viking://user/memories/x.md", content: "lesson text", mode: "append", wait: false });
    assert.equal(write.context_type, "memory");
    assert.equal(write.semantic_updated, true);

    const skill = await client.addSkill({ name: "deep-dive", description: "d", content: "body" }, { wait: true });
    const skillRecord = server.requests[1];
    assert.equal(skillRecord.url, "/api/v1/skills");
    assert.equal(skillRecord.method, "POST");
    assert.deepEqual(skillRecord.json, { data: { name: "deep-dive", description: "d", content: "body" }, wait: true });
    assert.equal(skill.uri, "viking://agent/skills/deep-dive");

    const fetched = await client.getSkill("deep-dive");
    const getRecord = server.requests[2];
    assert.equal(getRecord.url, "/api/v1/skills/deep-dive");
    assert.equal(getRecord.method, "GET");
    assert.equal(fetched.name, "deep-dive");

    const updated = await client.updateSkill("deep-dive", { name: "deep-dive", description: "d2", content: "body2" });
    const updateRecord = server.requests[3];
    assert.equal(updateRecord.url, "/api/v1/skills/deep-dive");
    assert.equal(updateRecord.method, "PUT");
    assert.deepEqual(updateRecord.json, { data: { name: "deep-dive", description: "d2", content: "body2" } });
    assert.equal(updated.name, "deep-dive");

    await assert.rejects(
      () => client.writeContent("viking://user/memories/missing.md", "x"),
      (error) => error.code === "NOT_FOUND",
    );
  } finally {
    await server.close();
  }
});
