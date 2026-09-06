/**
 * MemoryRecall: prepare relevant user memories for injection into the next
 * model step.
 *
 * The `agent/pre-step` handler calls `prepareStep` (async search + ranking);
 * the result lands in a per-agent one-shot slot. A `systemPrompt.context`
 * provider (`openviking:memories`) reads that slot synchronously during prompt
 * assembly, so the recalled memories enter the model context as a proper
 * context-injection message — never as an edit to the user's own message.
 * The next step's `prepareStep` clears the slot, so a block is injected at
 * most once per user message. `prepareStep` is also deduplicated per user
 * message: later steps of the same message skip both the searches and the
 * re-injection (the first step's block already rides in the message
 * history), so one user message costs exactly one recall even when the agent
 * runs many tool steps — and an empty result costs exactly one search, not
 * one per step.
 *
 * Ranking combines the OpenViking semantic score with bounded lexical
 * overlap, preference/temporal weighting, URI/abstract dedupe, a local
 * relevance threshold, per-item char cap and `tokenBudget * 4` char budget.
 * `viking://user/memories/` and the agent space (`viking://agent/`, opt-out
 * via `agentSpaces`) are searched, so preferences/entities/events and
 * cases/patterns/tools/skills memories and shared skill playbooks all
 * surface; ordinary repository results never get auto-injected.
 */
import type { Context } from "@deepseek-ai/cordis";
import type { UserMessage } from "@deepseek-ai/dsh-session";
import type { OpenVikingClient } from "./client.js";
export interface AutoRecallConfig {
    enabled: boolean;
    limit: number;
    scoreThreshold: number;
    maxContentChars: number;
    tokenBudget: number;
    /**
     * Also search the agent space (`viking://agent/`): the extractor stores
     * cases/patterns/tools/skills memories and shared skill playbooks there,
     * while `viking://user/memories/` alone only surfaces profile/preferences/
     * entities/events. Safe by construction — the service's tenant filter
     * restricts memory/skill hits to the current user's and agent's own
     * owner spaces regardless of the URI prefix.
     */
    agentSpaces: boolean;
    /**
     * Throttled refresh inside one user message: after this many tool steps of
     * the SAME message, re-search once and inject only memories that were NOT
     * in the previous block (incremental recall). Large tasks that newly write
     * memories mid-flight (memlearn/memcommit) then pick them up without
     * re-searching every step. 0 disables mid-message refresh.
     */
    refreshSteps: number;
    /**
     * Memory-map cadence in USER TURNS: the `<memory-library>` overview is
     * injected on the first user turn of a session, then refreshed once every
     * N user turns (2+). 1 = only the session-start injection, 0 = never. The
     * map is a cheap category overview; long sessions get fresh counts as
     * memories accumulate.
     */
    startupMapEveryTurns: number;
}
export interface MemoryRecall {
    /** Compute recall for the step's user text and store it in the agent's slot. */
    prepareStep(agentKey: string, messages: UserMessage[], signal?: AbortSignal): Promise<void>;
    /** Synchronous read of the stored block ("" when nothing applies). */
    takeBlock(agentKey: string): string;
    /** Synchronous read of the memory map for this turn ("" when none). */
    takeStartupBlock(agentKey: string): string;
    /**
     * Release ALL per-agent state (recall slot, query cache, message/refresh
     * state, memory-map block and turn counter). Called on `agent/disposed` so
     * long-running hosts never accumulate state for gone agents.
     */
    forget(agentKey: string): void;
}
export declare function hasProcedureIntent(query: string): boolean;
export declare function createMemoryRecall(ctx: Context, client: OpenVikingClient, config: AutoRecallConfig | (() => AutoRecallConfig)): MemoryRecall;
/** Latest user text from the message list; undefined when absent or already injected. */
export declare function extractLatestUserText(messages: readonly UserMessage[]): string | undefined;
