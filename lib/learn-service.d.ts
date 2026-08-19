/**
 * LearnService: the single, shared implementation of the `memlearn` business
 * behavior, consumed by both the model-facing `memlearn` tool and the
 * human-facing `/memlearn` command so the two entry points can never drift in
 * redaction, limits, dedupe, and persistence semantics.
 *
 * OpenViking has no "create a memory file" endpoint, so learning routes by
 * capability instead of pretending otherwise:
 *   - `skill`   → POST/PUT /api/v1/skills (mint/update a playbook; the service
 *                 generates the L1 overview and indexes it).
 *   - `target`  → append to an explicit existing memory file
 *                 (POST /api/v1/content/write, mode append).
 *   - no target → semantic dedupe: search `viking://user/memories/`; when the
 *                 top hit clears `min_score`, append there; otherwise return
 *                 `no-match` with actionable guidance.
 *
 * Secrets are redacted before anything touches the wire. A human command has
 * no model turn, so context injection is optional: only the model-tool path
 * provides an `inject` callback, and only then is the lesson deferred into the
 * current turn (source.kind "plugin", so session-sync never mirrors it back).
 */
import type { OpenVikingClient } from "./client.js";
export declare const MEMLEARN_MAX_MEMORY_CHARS = 8000;
export declare const MEMLEARN_MAX_SKILL_BODY_CHARS = 16000;
export declare const MEMLEARN_DEFAULT_MIN_SCORE = 0.5;
export declare const SKILL_NAME_RE: RegExp;
export declare function redactSecrets(text: string): {
    text: string;
    redacted: number;
};
export declare function clampScore(value: number | undefined): number;
/** Normalized skill payload accepted by the shared service (mirrors the tool schema). */
export interface SkillLearnPayload {
    /** Intent hint: `create` requires absence, `update` requires existence; omit for automatic behavior. */
    action?: string;
    name: string;
    description: string;
    body: string;
    tags?: readonly string[];
    allowed_tools?: readonly string[];
}
/** Normalized lesson input shared by the model tool and the human command. */
export interface LearnInput {
    memory?: string;
    context?: string;
    skill?: SkillLearnPayload;
    target?: string;
    minScore?: number;
}
/** Execution context: cancellation plus optional model-turn context injection. */
export interface LearnExecContext {
    signal?: AbortSignal;
    /**
     * Defer the just-learned lesson into the current model turn. Omitted for
     * human commands (no turn exists), so `injected` stays false there.
     */
    inject?: (kind: "skill" | "memory", uri: string, text: string) => void;
}
export interface LearnResult {
    action: "created" | "updated" | "merged" | "no-match";
    kind: "skill" | "memory";
    uri: string;
    score?: number;
    redacted: number;
    injected: boolean;
    message: string;
}
export interface LearnService {
    learn(input: LearnInput, exec?: LearnExecContext): Promise<LearnResult>;
}
export declare function createLearnService(client: OpenVikingClient): LearnService;
