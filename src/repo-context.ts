/**
 * RepoContext: an in-process TTL cache of `viking://resources/` direct
 * children, injected into the model prompt as dynamic context.
 *
 * The `systemPrompt.context` provider is synchronous and only reads the cache;
 * refresh happens best-effort in `apply()`, queued on `agent/session-start`,
 * and awaited once per `agent/pre-step` before the final decision returns.
 * Failures keep the last successful cache and log one deduplicated warning.
 */
import type { Context } from "@deepseek-ai/cordis";
import type { OpenVikingClient } from "./client.js";
import { isRecord, type FsNode } from "./types.js";

export interface RepoContextConfig {
  enabled: boolean;
  cacheTtlMs: number;
}

export interface RepoContext {
  /** Best-effort refresh; resolves to the current cache text (maybe stale). */
  refresh(options?: { force?: boolean; signal?: AbortSignal }): Promise<string | undefined>;
  /** Synchronous prompt text; "" when disabled, empty, or never populated. */
  getPrompt(): string;
}

export function createRepoContext(
  ctx: Context,
  client: OpenVikingClient,
  config: RepoContextConfig | (() => RepoContextConfig),
): RepoContext {
  // Accept a plain object (tests, direct callers) or a thunk (live settings).
  const getConfig = typeof config === "function" ? config : () => config;
  const logger = ctx.logger("openviking:repo-context");
  const warningKeys = new Set<string>();
  let cachedRepos: string | undefined;
  let lastFetchTime = 0;
  let inflight: Promise<string | undefined> | undefined;

  async function refresh(options: { force?: boolean; signal?: AbortSignal } = {}): Promise<string | undefined> {
    const config = getConfig();
    if (!config.enabled) return undefined;
    const now = Date.now();
    if (!options.force && cachedRepos !== undefined && now - lastFetchTime < config.cacheTtlMs) {
      return cachedRepos;
    }
    if (inflight) return inflight;
    inflight = (async () => {
      try {
        const result = await client.list({
          uri: "viking://resources/",
          recursive: false,
          simple: false,
          signal: options.signal,
        });
        const items = Array.isArray(result) ? result : [];
        const repos: string[] = [];
        for (const raw of items) {
          if (!isRecord(raw) || typeof raw.uri !== "string") continue;
          const uri = raw.uri;
          if (uri === "viking://resources/" || !uri.startsWith("viking://resources/")) continue;
          const abstract = typeof raw.abstract === "string" ? raw.abstract : "";
          const overview = typeof raw.overview === "string" ? raw.overview : "";
          repos.push(formatRepoLine({ uri, abstract: abstract || undefined, overview: overview || undefined }));
        }
        cachedRepos = repos.length > 0 ? repos.join("\n") : "";
        lastFetchTime = Date.now();
        return cachedRepos;
      } catch (error) {
        if (options.signal?.aborted) return cachedRepos;
        const message = error instanceof Error ? error.message : String(error);
        const dedupeKey = `${client.endpoint}:${message}`;
        if (!warningKeys.has(dedupeKey)) {
          warningKeys.add(dedupeKey);
          logger.warn("repo context refresh failed; keeping last successful cache", {
            endpoint: client.endpoint,
            error: message,
          });
        }
        return cachedRepos;
      } finally {
        inflight = undefined;
      }
    })();
    return inflight;
  }

  function getPrompt(): string {
    if (!getConfig().enabled || !cachedRepos) return "";
    return [
      "## OpenViking - Indexed Code Repositories",
      "",
      "The following external repositories are indexed in OpenViking and searchable through tools.",
      "When the user asks about these projects or their internals, use the OpenViking tools before answering.",
      "",
      "Tool guidance:",
      "- Use `memsearch` or `memfind` for semantic or conceptual repository questions.",
      "- Use `memgrep` for exact symbols, error strings, class names, function names, and regex-like searches.",
      "- Use `memglob` to enumerate files by pattern.",
      "- Use `membrowse` to inspect directory structure and `memread` to read specific URIs.",
      "- Use `memadd`, `memremove`, and `memqueue` for repository resource management when explicitly requested.",
      "",
      cachedRepos,
    ].join("\n");
  }

  return { refresh, getPrompt };
}

function formatRepoLine(item: FsNode): string {
  const uri = String(item.uri);
  const name = uri.replace("viking://resources/", "").replace(/\/$/, "") || "resources";
  const abstract =
    typeof item.abstract === "string" ? item.abstract : typeof item.overview === "string" ? item.overview : "";
  return abstract ? `- **${name}** (${uri})\n  ${abstract}` : `- **${name}** (${uri})`;
}
