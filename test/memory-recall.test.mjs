/**
 * Automatic recall tests for generic local relevance gating.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createMemoryRecall } from "../lib/memory-recall.js";

function makeContext() {
  return {
    logger: () => ({ warn() {}, info() {}, debug() {} }),
  };
}

function userMessage(text) {
  return {
    role: "user",
    id: "user-1",
    source: { kind: "user" },
    content: [{ type: "text", text }],
  };
}

function config(overrides = {}) {
  return {
    enabled: true,
    limit: 6,
    scoreThreshold: 0.15,
    maxContentChars: 500,
    tokenBudget: 2000,
    agentSpaces: false,
    refreshSteps: 0,
    startupMapEveryTurns: 0,
    ...overrides,
  };
}

test("lexical overlap can recover a low semantic-score memory without identifier conventions", async () => {
  const calls = [];
  const client = {
    endpoint: "http://stub",
    find: async (options) => {
      calls.push(options);
      if (options.scoreThreshold === 0) {
        return {
          memories: [{
            uri: "viking://user/memories/diagnosis.md",
            level: 2,
            score: 0.10185608267784119,
            abstract: "ZXQ-7F3A91 failed because audit context memory verification rejected its schema.",
          }],
        };
      }
      return { memories: [] };
    },
    tree: async () => [],
    memoryStats: async () => ({ total_memories: 0, by_category: {} }),
  };
  const recall = createMemoryRecall(makeContext(), client, config());

  await recall.prepareStep("agent-1", [userMessage("查看 ZXQ-7F3A91 的失败原因")]);
  const block = recall.takeBlock("agent-1");

  assert.match(block, /ZXQ-7F3A91/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].scoreThreshold, 0);
});

test("low semantic-score memories without lexical overlap remain filtered", async () => {
  const client = {
    endpoint: "http://stub",
    find: async () => ({
      memories: [{
        uri: "viking://user/memories/unrelated.md",
        level: 2,
        score: 0.10185608267784119,
        abstract: "Unrelated deployment preferences and editor settings.",
      }],
    }),
    tree: async () => [],
    memoryStats: async () => ({ total_memories: 0, by_category: {} }),
  };
  const recall = createMemoryRecall(makeContext(), client, config());

  await recall.prepareStep("agent-1", [userMessage("查看 ZXQ-7F3A91 的失败原因")]);

  assert.equal(recall.takeBlock("agent-1"), "");
});
