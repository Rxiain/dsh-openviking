/**
 * The ten OpenViking tools: `memfind`, `memsearch`, `memread`, `membrowse`,
 * `memgrep`, `memglob`, `memadd`, `memremove`, `memqueue`, `memcommit`.
 *
 * Each tool returns a canonical JSON value (validated against its output
 * schema); `output.render` produces the model-facing text. Infrastructure
 * failures always throw — never a `"Error: ..."` success value.
 */
import type { Context } from "@deepseek-ai/cordis";
import { type ToolDefinition } from "@deepseek-ai/dsh-tools";
import type { OpenVikingClient } from "./client.js";
import type { SessionManager } from "./session-sync.js";
interface ToolConfig {
    timeoutMs: number;
}
export declare function createOpenVikingTools(ctx: Context, client: OpenVikingClient, sessionManager: SessionManager, config: ToolConfig): ToolDefinition[];
/** Register all ten tools on `ctx.tools`. */
export declare function registerOpenVikingTools(ctx: Context, client: OpenVikingClient, sessionManager: SessionManager, config: ToolConfig): void;
export {};
