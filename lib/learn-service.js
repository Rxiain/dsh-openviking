import { parseVikingUri } from "./uri.js";
export const MEMLEARN_MAX_MEMORY_CHARS = 8_000;
export const MEMLEARN_MAX_SKILL_BODY_CHARS = 16_000;
export const MEMLEARN_DEFAULT_MIN_SCORE = 0.5;
export const SKILL_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
/** Secret shapes redacted before anything is persisted (mirrors oh-my-pi). */
const SECRET_PATTERNS = [
    /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/g,
    /\b(?:sk|pk|rk)-[A-Za-z0-9]{20,}/g,
    /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g,
    /\bAKIA[0-9A-Z]{16}\b/g,
    /\bxox[baprs]-[A-Za-z0-9-]{10,}/g,
    /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
];
export function redactSecrets(text) {
    let redacted = 0;
    let out = text;
    for (const pattern of SECRET_PATTERNS) {
        out = out.replace(pattern, () => {
            redacted += 1;
            return "[redacted]";
        });
    }
    return { text: out, redacted };
}
export function clampScore(value) {
    if (value === undefined)
        return MEMLEARN_DEFAULT_MIN_SCORE;
    if (Number.isNaN(value))
        return MEMLEARN_DEFAULT_MIN_SCORE;
    return Math.min(1, Math.max(0, value));
}
export function createLearnService(client) {
    return {
        async learn(input, exec = {}) {
            const memory = (input.memory ?? "").trim();
            const skill = input.skill;
            const signal = exec.signal;
            if (!memory && !skill) {
                throw new Error("memlearn: provide `memory` and/or `skill` — nothing to learn from.");
            }
            if (memory.length > MEMLEARN_MAX_MEMORY_CHARS) {
                throw new Error(`memlearn: memory exceeds ${MEMLEARN_MAX_MEMORY_CHARS} characters — tighten the lesson.`);
            }
            // 1) Redact secrets BEFORE anything touches the wire.
            const redactedMemory = redactSecrets(memory);
            let totalRedacted = redactedMemory.redacted;
            // 2) Skill channel: mint/update a playbook.
            if (skill) {
                const name = (skill.name ?? "").trim();
                if (!SKILL_NAME_RE.test(name)) {
                    throw new Error(`memlearn: invalid skill name "${name}" — use kebab-case, e.g. \`web-search-deep-dive\`.`);
                }
                const rawBody = (skill.body ?? "").trim();
                if (rawBody.length > MEMLEARN_MAX_SKILL_BODY_CHARS) {
                    throw new Error(`memlearn: skill body exceeds ${MEMLEARN_MAX_SKILL_BODY_CHARS} characters — tighten the playbook.`);
                }
                const body = redactSecrets(rawBody);
                totalRedacted += body.redacted;
                const description = redactSecrets((skill.description ?? "").trim());
                totalRedacted += description.redacted;
                // Existence is probed through the service's own skill lookup
                // (0.4.13 stores skills under the user scope, so a hard-coded
                // viking://agent/skills/<name> stat would never match).
                const skillUri = `viking://agent/skills/${name}`;
                let existed = false;
                try {
                    await client.getSkill(name, signal);
                    existed = true;
                }
                catch (error) {
                    // Absence is signalled by OpenVikingError code NOT_FOUND; treat any
                    // error carrying that code as "does not exist yet".
                    const code = error instanceof Error && "code" in error
                        ? error.code
                        : undefined;
                    if (code !== "NOT_FOUND")
                        throw error;
                }
                const action = skill.action;
                if (action === "create" && existed) {
                    throw new Error(`memlearn: skill "${name}" already exists — pass action=update or omit action for automatic behavior.`);
                }
                if (action === "update" && !existed) {
                    throw new Error(`memlearn: skill "${name}" does not exist — pass action=create or omit action for automatic behavior.`);
                }
                const payload = {
                    name,
                    description: description.text,
                    content: body.text,
                    ...(Array.isArray(skill.tags) && skill.tags.length > 0 ? { tags: skill.tags } : {}),
                    ...(Array.isArray(skill.allowed_tools) && skill.allowed_tools.length > 0
                        ? { allowed_tools: skill.allowed_tools }
                        : {}),
                };
                const result = existed
                    ? await client.updateSkill(name, payload, { signal })
                    : await client.addSkill(payload, { signal });
                const uri = typeof result.uri === "string" && result.uri ? result.uri : skillUri;
                const lesson = `Skill ${name}: ${description.text}\n\n${body.text}`;
                const injected = exec.inject !== undefined;
                if (injected)
                    exec.inject("skill", uri, lesson);
                return {
                    action: existed ? "updated" : "created",
                    kind: "skill",
                    uri,
                    redacted: totalRedacted,
                    injected,
                    message: `Skill ${existed ? "updated" : "created"} at ${uri}. It is now searchable via memsearch and will surface in future sessions.`,
                };
            }
            // 3) Memory channel: explicit target first, then semantic dedupe.
            if (input.target !== undefined) {
                parseVikingUri(input.target, "memlearn");
                const lesson = input.context ? `${redactedMemory.text}\n\nProvenance: ${input.context}` : redactedMemory.text;
                await client.writeContent(input.target, lesson, { mode: "append", signal });
                const injected = exec.inject !== undefined;
                if (injected)
                    exec.inject("memory", input.target, lesson);
                return {
                    action: "merged",
                    kind: "memory",
                    uri: input.target,
                    redacted: totalRedacted,
                    injected,
                    message: `Appended lesson to ${input.target}.`,
                };
            }
            const minScore = clampScore(input.minScore);
            const found = await client.find({
                query: redactedMemory.text.slice(0, 4_000),
                targetUri: "viking://user/memories/",
                limit: 5,
                signal,
            });
            const ranked = (found.memories ?? [])
                .filter((item) => typeof item.score === "number" && typeof item.uri === "string")
                .sort((a, b) => b.score - a.score);
            const best = ranked[0];
            if (best && best.uri && (best.score ?? 0) >= minScore) {
                const lesson = input.context ? `${redactedMemory.text}\n\nProvenance: ${input.context}` : redactedMemory.text;
                await client.writeContent(best.uri, lesson, { mode: "append", signal });
                const injected = exec.inject !== undefined;
                if (injected)
                    exec.inject("memory", best.uri, lesson);
                return {
                    action: "merged",
                    kind: "memory",
                    uri: best.uri,
                    score: best.score,
                    redacted: totalRedacted,
                    injected,
                    message: `Merged lesson into existing memory ${best.uri} (score ${best.score?.toFixed(2)}).`,
                };
            }
            // No merge target: do not fake a write. Give the caller a route forward.
            const top = best ? ` closest hit scored ${(best.score ?? 0).toFixed(2)} (below ${minScore.toFixed(2)})` : "";
            return {
                action: "no-match",
                kind: "memory",
                uri: "",
                redacted: totalRedacted,
                injected: false,
                message: `No existing memory is close enough to merge into${top}. ` +
                    `OpenViking has no create-memory endpoint, so choose one of: ` +
                    `(1) call memlearn again with \`skill\` to mint this as a reusable playbook; ` +
                    `(2) call memcommit to let the session extractor persist it; ` +
                    `(3) call memlearn with an explicit \`target\` URI of an existing memory file.`,
            };
        },
    };
}
