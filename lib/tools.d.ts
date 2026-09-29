/**
 * The eleven OpenViking model tools (plus an optional team-scoped twelfth).
 *
 * Each tool returns a canonical JSON value (validated against its output
 * schema); `output.render` produces the model-facing text. Infrastructure
 * failures always throw — never a `"Error: ..."` success value.
 *
 * Agent Teams helper: `memsearchTeam` is registered only when the host
 * exposes Agent Teams (see `isAgentTeamsAvailable`). Non-team deployments see
 * exactly the eleven base tools. The helper is always team-session-scoped:
 * it targets the session-scoped endpoint, never `/find`.
 */
import type { Context } from "@deepseek-ai/cordis";
import { type ToolDefinition } from "@deepseek-ai/dsh-tools";
import type { OpenVikingClient } from "./client.js";
import type { SessionManager } from "./session-sync.js";
interface ToolConfig {
    /** Per-request timeout override for the whole tool set; a thunk reads the live settings value. */
    timeoutMs: number | (() => number);
}
/**
 * Whether the host exposes Agent Teams (`spawn_teammate` teammates).
 *
 * DSH `0.1.7-rc.2` ships no teams service, so this probes defensively: a
 * `teams` service, or a `spawn_teammate` tool on the tool runtime. Anything
 * missing (no `get`, threw lookup, absent service) means "no teams" — the
 * plugin then registers exactly the eleven base tools and the team helper
 * stays unregistered (no surface for non-team deployments).
 */
export declare function isAgentTeamsAvailable(ctx: unknown): boolean;
export declare function createOpenVikingTools(ctx: Context, client: OpenVikingClient, sessionManager: SessionManager, config: ToolConfig): ToolDefinition[];
export declare function registerOpenVikingTools(ctx: Context, client: OpenVikingClient, sessionManager: SessionManager, config: ToolConfig): void;
export {};
