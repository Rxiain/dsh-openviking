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
 * most once per user message.
 *
 * Ranking is ported from the reference package (preference/temporal
 * weighting, leaf priority, URI/abstract dedupe, score threshold, per-item
 * char cap and `tokenBudget * 4` char budget). Only
 * `viking://user/memories/` is searched so ordinary repository results never
 * get auto-injected.
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
}
export interface MemoryRecall {
    /** Compute recall for the step's user text and store it in the agent's slot. */
    prepareStep(agentKey: string, messages: UserMessage[], signal?: AbortSignal): Promise<void>;
    /** Synchronous read of the stored block ("" when nothing applies). */
    takeBlock(agentKey: string): string;
}
export declare function createMemoryRecall(ctx: Context, client: OpenVikingClient, config: AutoRecallConfig): MemoryRecall;
/** Latest user text from the message list; undefined when absent or already injected. */
export declare function extractLatestUserText(messages: readonly UserMessage[]): string | undefined;
