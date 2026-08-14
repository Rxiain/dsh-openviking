/**
 * Real-service contract tests. Explicitly enabled with OPENVIKING_INTEGRATION=1.
 *
 * The harness reads endpoint/account from `ov config show -o json` (non-secret
 * fields only); the API key MUST be injected through the test-process
 * environment (OPENVIKING_API_KEY). Default `npm test` never touches the
 * local service.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenVikingClient } from "../lib/client.js";
import { createOpenVikingTools } from "../lib/tools.js";
import { FileSystem } from "@deepseek-ai/dsh-fs";
import { Context } from "@deepseek-ai/cordis";
import { readFile, stat as fsStat } from "node:fs/promises";
import { resolve } from "node:path";

/** Minimal real local filesystem backend (resolve/stat/readText only). */
class LocalFs extends FileSystem {
  constructor(ctx) {
    super(ctx ?? new Context(), "fs");
  }
  async resolve(path, opts) {
    const cwd = opts?.cwd ?? process.cwd();
    const abs = resolve(cwd, path);
    return { targetKey: abs, displayPath: abs };
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
    try {
      const info = await fsStat(target.displayPath);
      return { version: `${info.mtimeMs}`, type: info.isDirectory() ? "directory" : info.isFile() ? "file" : "other" };
    } catch {
      return undefined;
    }
  }
  async lstat(path, opts, signal) {
    return undefined;
  }
  async readText(target, signal) {
    return readFile(target.displayPath, "utf8");
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

const ENABLED = process.env.OPENVIKING_INTEGRATION === "1";

function ov(args) {
  const result = spawnSync("ov", args, { encoding: "utf8" });
  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    try {
      parsed = JSON.parse(result.stderr);
    } catch {
      parsed = undefined;
    }
  }
  return { status: result.status, parsed, stdout: result.stdout, stderr: result.stderr };
}

function clientFromEnv() {
  const config = ov(["config", "show", "-o", "json"]);
  assert.equal(config.status, 0, "ov config show must succeed");
  const endpoint = config.parsed?.result?.url;
  const account = config.parsed?.result?.account;
  assert.equal(typeof endpoint, "string", "endpoint from ov config");
  const apiKey = process.env.OPENVIKING_API_KEY ?? "";
  assert.ok(apiKey, "OPENVIKING_API_KEY must be injected into the test process");
  return new OpenVikingClient({ endpoint, apiKey, account, user: "", agentId: "", timeoutMs: 30000 });
}

function toolsWith(client) {
  return createOpenVikingTools(
    { fs: new LocalFs() },
    client,
    {
      async ensureSession() {},
      async commitCurrentSession() {
        return { session_id: "x", status: "completed", memories_extracted: 0 };
      },
      async commitExplicitSession() {
        return { session_id: "x", status: "completed", memories_extracted: 0 };
      },
    },
    { timeoutMs: 30000 },
  );
}

function byName(tools, name) {
  return tools.find((t) => t.name === name);
}

/** Find a non-directory file uri inside a tree/browse result. */
function findFileUri(value, marker) {
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (!entry || typeof entry !== "object") continue;
      if (entry.isDir === false && typeof entry.uri === "string") return entry.uri;
      const nested = findFileUri(entry, marker);
      if (nested) return nested;
    }
    return undefined;
  }
  if (value && typeof value === "object") {
    for (const key of ["children", "items", "nodes"]) {
      if (key in value) {
        const nested = findFileUri(value[key], marker);
        if (nested) return nested;
      }
    }
    if (value.isDir === false && typeof value.uri === "string") return value.uri;
  }
  return undefined;
}

const SIGNAL = () => new AbortController().signal;

test("live service health reports ok", { skip: !ENABLED }, async () => {
  const client = clientFromEnv();
  const health = await client.health();
  assert.equal(health.healthy, true);
});

test("live memory search finds the fixture and read returns its content", { skip: !ENABLED }, async () => {
  const client = clientFromEnv();
  const tools = toolsWith(client);
  const value = await byName(tools, "memfind").execute(
    { query: "午后 pi 代码任务", target_uri: "viking://resources/test", limit: 5 },
    { signal: SIGNAL() },
  );
  assert.equal(value.mode, "fast");
  const hit = (value.resources ?? []).find((r) => String(r.uri).includes("pi-mem-test.md/pi-mem-test.md"));
  assert.ok(hit, `expected fixture URI in results, got ${JSON.stringify(value.resources ?? []).slice(0, 300)}`);
  assert.ok(typeof hit.score === "number" && hit.score > 0, "fixture score is nonzero");

  const read = await byName(tools, "memread").execute(
    { uri: hit.uri, level: "read" },
    { signal: SIGNAL() },
  );
  assert.match(String(read.content), /Pi Agent 记忆测试/);
});

test("memadd e2e: upload, verify, remove, confirm gone", { skip: !ENABLED }, async () => {
  const client = clientFromEnv();
  const tools = toolsWith(client);
  const uuid = randomUUID();
  const dir = mkdtempSync(join(tmpdir(), "dsh-openviking-e2e-"));
  const filePath = join(dir, `${uuid}.md`);
  const body = `dsh-openviking e2e fixture ${uuid}\nPi Agent 记忆测试 e2e\n`;
  writeFileSync(filePath, body, "utf8");
  const targetUri = `viking://resources/dsh-openviking-e2e-${uuid}`;

  try {
    const added = await byName(tools, "memadd").execute(
      { path: filePath, to: targetUri, wait: true, timeout: 300 },
      { signal: SIGNAL() },
    );
    assert.equal(added.source, "local");
    assert.equal(typeof added.root_uri, "string");
    assert.ok(added.root_uri.startsWith("viking://resources/dsh-openviking-e2e-"), `root_uri: ${added.root_uri}`);

    // `to` creates a directory; locate the uploaded file inside it.
    const browse = await byName(tools, "membrowse").execute(
      { uri: added.root_uri, view: "tree" },
      { signal: SIGNAL() },
    );
    const fileUri = findFileUri(browse.result, uuid);
    assert.ok(fileUri, `uploaded file visible under ${added.root_uri}: ${JSON.stringify(browse.result).slice(0, 400)}`);

    const read = await byName(tools, "memread").execute(
      { uri: fileUri, level: "read" },
      { signal: SIGNAL() },
    );
    assert.match(String(read.content), new RegExp(uuid), "uploaded body is readable");
  } finally {
    const removed = await byName(tools, "memremove").execute(
      { uri: targetUri, recursive: true, confirm: true },
      { signal: SIGNAL() },
    );
    assert.equal(removed.removed, true);

    const stat = ov(["stat", targetUri, "-o", "json"]);
    assert.notEqual(stat.status, 0, `ov stat must fail after removal (got ${stat.status}: ${stat.stdout})`);
    assert.equal(stat.parsed?.error?.code, "NOT_FOUND", "removed resource reports NOT_FOUND");
    rmSync(dir, { recursive: true, force: true });
    assert.ok(!existsSync(filePath), "temp file deleted");
  }
});
