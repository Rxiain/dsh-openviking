import { OpenVikingError } from "./types.js";
// ─── usage text ─────────────────────────────────────────────────────────
export const MEMLEARN_USAGE = [
    "Usage: /memlearn <lesson>",
    "",
    "Persist a reusable, self-contained lesson into OpenViking memory. The lesson",
    "is secret-redacted, dedupe-merged into the closest existing memory (score",
    ">= 0.5) when one exists, and becomes searchable in future sessions. No model",
    "turn is started; nothing is persisted when the input is empty.",
    "",
    "Example:",
    "  /memlearn The deployment requires a fake server before lifecycle tests",
].join("\n");
/** Render any `/memlearn` failure (validation, service, or network) as text. */
export function formatMemlearnError(error) {
    if (error instanceof Error && error.name === "AbortError") {
        return "/memlearn cancelled — nothing was persisted.";
    }
    if (error instanceof OpenVikingError) {
        const code = error.code ? ` (${error.code})` : "";
        return `OpenViking failed${code}: ${error.message}. Nothing was persisted.`;
    }
    const message = error instanceof Error ? error.message : String(error);
    return message;
}
// ─── result formatting ──────────────────────────────────────────────────
export function formatMemlearnSuccess(result) {
    const lines = [
        `Learned: ${result.action} (${result.kind})`,
        `uri: ${result.uri || "(none)"}`,
        `redacted: ${result.redacted}`,
    ];
    if (result.score !== undefined)
        lines.push(`score: ${result.score.toFixed(2)}`);
    lines.push(result.message);
    if (!result.injected) {
        lines.push("It will be available to future sessions through recall; it is not injected into this turn.");
    }
    return lines.join("\n");
}
// ─── handlers ───────────────────────────────────────────────────────────
async function runMemlearn(invocation, deps) {
    const lesson = invocation.rawInput.trim();
    if (!lesson) {
        return { kind: "error", text: MEMLEARN_USAGE };
    }
    try {
        const result = await deps.learn.learn({ memory: lesson }, { signal: invocation.signal });
        return { kind: "success", text: formatMemlearnSuccess(result) };
    }
    catch (error) {
        if (invocation.signal.aborted)
            return { kind: "error", text: "/memlearn cancelled — nothing was persisted." };
        return { kind: "error", text: formatMemlearnError(error) };
    }
}
// ─── registration ───────────────────────────────────────────────────────
function memlearnDefinition(deps) {
    return {
        name: "memlearn",
        description: "Persist a reusable lesson to OpenViking memory (secret-redacted, dedupe-merged)",
        input: { hint: "<lesson to remember>" },
        // The redacted persisted memory is the authoritative payload; the raw
        // lesson (which may contain secrets) must not be duplicated into the
        // session log's command/run record.
        recordInput: false,
        handler: (invocation) => runMemlearn(invocation, deps),
    };
}
export function registerCommandsOn(commands, deps) {
    return [commands.register(memlearnDefinition(deps))];
}
export function registerOpenVikingCommands(ctx, deps) {
    const host = ctx;
    host.inject?.(["commands"], (scoped) => {
        const runtime = scoped.commands;
        if (!runtime)
            return;
        const disposers = registerCommandsOn(runtime, deps);
        ctx.effect(() => () => {
            for (const dispose of disposers)
                dispose();
        }, "openviking:commands");
    });
}
