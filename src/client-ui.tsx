/**
 * Browser half of dsh-openviking: the OpenViking card inside the dsh web
 * UI's Plugins → Plugin configuration section.
 *
 * The card binds the host-side `openviking` settings namespace through the
 * client settings scope, stages user edits, and writes them with
 * `settings.mutate` path ops (one save = one revision-fenced write). Fields
 * the profile's composition layer owns show an "Overridden" badge and a
 * reset control that clears the user-layer entry; number fields validate
 * before a save is offered. The card is registered into the
 * `settings.plugin.item` list slot declared by
 * `@deepseek-ai/dsh-client-ui-settings-plugins`, so it appears wherever that
 * section ships — no change to the harness bundle is required beyond the
 * host-side namespace exposure.
 *
 * The bundle is built by `scripts/build-client.mjs` into the dsh browser
 * loader format (`window.__ModuleLoader__.load`) and served by the host's
 * client-module registry at `/plugins/dsh-openviking/client.js`.
 */
import type { ClientContext } from "@deepseek-ai/dsh-client-runtime/client";
// Value import emitted as a loader require(); the app shell statically
// registers dsh-client-ui-primitives in every composition that renders the
// plugin settings section.
import { IconChevronDownOutline14 } from "@deepseek-ai/dsh-client-ui-primitives";
import type { ConnectionHandle } from "@deepseek-ai/dsh-client-connection/client";
import type { SettingsScopeBinder } from "@deepseek-ai/dsh-client-ui-settings/client";
import type { LocaleRuntime } from "@deepseek-ai/dsh-client-locale/client";
import type { Translate } from "@deepseek-ai/dsh-client-ui-slots";
import type { ComponentType, ReactNode } from "react";
import { useSyncExternalStore, useState } from "react";
import { createCompatScope, type BridgeBatchOp, type CompatSettingsScope } from "./client-ui/compat-scope.js";

// ─── slot + locale type contract ────────────────────────────────────────
// The runtime slot table lives in the dsh web bundle; the declarations below
// mirror the ones the harness ships so this package can type its own
// contribution without depending on the settings-plugins package.

declare module "@deepseek-ai/dsh-client-ui-slots" {
  interface SlotMap {
    /** One plugin card inside the plugin configuration section. */
    "settings.plugin.item": {
      kind: "list";
      scope: "root";
      owner: Record<string, never>;
    };
  }
  interface LocaleNamespaceMap {
    /** Dictionary namespace owned by this card. */
    openviking: OpenVikingDictKey;
  }
}

type OpenVikingDictKey =
  | "cardTitle"
  | "cardDescription"
  | "groupConnection"
  | "groupRepoContext"
  | "groupAutoRecall"
  | "groupAutoCommit"
  | "fieldEndpoint"
  | "fieldEndpointHint"
  | "fieldApiKey"
  | "fieldApiKeyHint"
  | "fieldAccount"
  | "fieldAccountHint"
  | "fieldUser"
  | "fieldUserHint"
  | "fieldAgentId"
  | "fieldAgentIdHint"
  | "fieldTimeoutMs"
  | "fieldTimeoutMsHint"
  | "fieldStateFile"
  | "fieldStateFileHint"
  | "fieldRepoEnabled"
  | "fieldRepoEnabledHint"
  | "fieldCacheTtlMs"
  | "fieldCacheTtlMsHint"
  | "fieldRecallEnabled"
  | "fieldRecallEnabledHint"
  | "fieldRecallLimit"
  | "fieldRecallLimitHint"
  | "fieldScoreThreshold"
  | "fieldScoreThresholdHint"
  | "fieldMaxContentChars"
  | "fieldMaxContentCharsHint"
  | "fieldTokenBudget"
  | "fieldTokenBudgetHint"
  | "fieldCommitEnabled"
  | "fieldCommitEnabledHint"
  | "fieldIntervalMinutes"
  | "fieldIntervalMinutesHint"
  | "overridden"
  | "reset"
  | "readOnly"
  | "expand"
  | "collapse"
  | "save"
  | "saving"
  | "discard"
  | "unsaved"
  | "saveFailed"
  | "invalidNumber";

/** English copy. */
const en: Record<OpenVikingDictKey, string> = {
  cardTitle: "OpenViking",
  cardDescription: "OpenViking retrieval, resource management, auto-recall and session memory.",
  groupConnection: "Connection",
  groupRepoContext: "Repository context",
  groupAutoRecall: "Auto recall",
  groupAutoCommit: "Auto commit",
  fieldEndpoint: "Service endpoint",
  fieldEndpointHint: "OpenViking HTTP service base URL.",
  fieldApiKey: "API key",
  fieldApiKeyHint: "X-API-Key request header; empty omits the header.",
  fieldAccount: "Account",
  fieldAccountHint: "X-OpenViking-Account tenant header; empty omits it.",
  fieldUser: "User",
  fieldUserHint: "X-OpenViking-User header; empty omits it.",
  fieldAgentId: "Agent id",
  fieldAgentIdHint: "X-OpenViking-Agent identifier header.",
  fieldTimeoutMs: "Request timeout (ms)",
  fieldTimeoutMsHint: "Per-request timeout; 1000–300000.",
  fieldStateFile: "Session state file",
  fieldStateFileHint: "Where synced message ids are persisted; applies on restart.",
  fieldRepoEnabled: "Inject repository list",
  fieldRepoEnabledHint: "List indexed repositories into the system prompt.",
  fieldCacheTtlMs: "Repository cache TTL (ms)",
  fieldCacheTtlMsHint: "How long the repository list cache stays valid.",
  fieldRecallEnabled: "Auto-recall memories",
  fieldRecallEnabledHint: "Search relevant memories before each model step.",
  fieldRecallLimit: "Memories per step",
  fieldRecallLimitHint: "Maximum memories injected per step (1–50).",
  fieldScoreThreshold: "Minimum score",
  fieldScoreThresholdHint: "Non-leaf filler memories below this score are dropped (0–1).",
  fieldMaxContentChars: "Memory content cap (chars)",
  fieldMaxContentCharsHint: "Per-memory content character cap (100–5000).",
  fieldTokenBudget: "Token budget",
  fieldTokenBudgetHint: "Injected block is capped at tokenBudget × 4 characters (100–10000).",
  fieldCommitEnabled: "Auto-commit sessions",
  fieldCommitEnabledHint: "Periodically commit sessions with uncommitted messages.",
  fieldIntervalMinutes: "Commit interval (min)",
  fieldIntervalMinutesHint: "Minimum minutes between automatic commits.",
  overridden: "Overridden",
  reset: "Reset to default",
  readOnly: "This deployment stores settings read-only.",
  expand: "Show settings",
  collapse: "Hide settings",
  save: "Save",
  saving: "Saving…",
  discard: "Discard",
  unsaved: "Unsaved",
  saveFailed: "The deployment did not accept these values; they were left for you to correct.",
  invalidNumber: "Enter a number, or leave blank to use the default.",
};

/** Simplified Chinese copy. */
const zh: Record<OpenVikingDictKey, string> = {
  cardTitle: "OpenViking",
  cardDescription: "OpenViking 检索、资源管理、自动召回与会话记忆。",
  groupConnection: "连接",
  groupRepoContext: "仓库上下文",
  groupAutoRecall: "自动召回",
  groupAutoCommit: "自动提交",
  fieldEndpoint: "服务地址",
  fieldEndpointHint: "OpenViking HTTP 服务地址。",
  fieldApiKey: "API 密钥",
  fieldApiKeyHint: "X-API-Key 请求头；留空则不发送。",
  fieldAccount: "租户（Account）",
  fieldAccountHint: "X-OpenViking-Account 请求头；留空则不发送。",
  fieldUser: "用户（User）",
  fieldUserHint: "X-OpenViking-User 请求头；留空则不发送。",
  fieldAgentId: "Agent 标识",
  fieldAgentIdHint: "X-OpenViking-Agent 请求头。",
  fieldTimeoutMs: "请求超时（毫秒）",
  fieldTimeoutMsHint: "单次请求超时；范围 1000–300000。",
  fieldStateFile: "会话状态文件",
  fieldStateFileHint: "已同步消息 id 的持久化位置；重启后生效。",
  fieldRepoEnabled: "注入仓库列表",
  fieldRepoEnabledHint: "把已索引仓库列表注入系统提示词。",
  fieldCacheTtlMs: "仓库缓存 TTL（毫秒）",
  fieldCacheTtlMsHint: "仓库列表缓存的有效时长。",
  fieldRecallEnabled: "自动召回记忆",
  fieldRecallEnabledHint: "每个模型步骤前检索相关记忆。",
  fieldRecallLimit: "每步记忆条数",
  fieldRecallLimitHint: "每步最多注入的记忆条数（1–50）。",
  fieldScoreThreshold: "最低分数",
  fieldScoreThresholdHint: "低于该分数的非叶填充记忆被丢弃（0–1）。",
  fieldMaxContentChars: "单条记忆上限（字符）",
  fieldMaxContentCharsHint: "单条记忆内容字符上限（100–5000）。",
  fieldTokenBudget: "Token 预算",
  fieldTokenBudgetHint: "注入块上限约为 tokenBudget × 4 字符（100–10000）。",
  fieldCommitEnabled: "自动提交会话",
  fieldCommitEnabledHint: "定期提交含未提交消息的会话。",
  fieldIntervalMinutes: "提交间隔（分钟）",
  fieldIntervalMinutesHint: "两次自动提交之间的最少分钟数。",
  overridden: "已覆盖",
  reset: "恢复默认",
  readOnly: "本部署的设置为只读。",
  expand: "展开设置",
  collapse: "收起设置",
  save: "保存",
  saving: "保存中…",
  discard: "放弃修改",
  unsaved: "未保存",
  saveFailed: "本部署没有接受这些值，已保留供你修改。",
  invalidNumber: "请填数字；留空表示使用默认值。",
};

// ─── form model ─────────────────────────────────────────────────────────

/** Settings namespace this card binds. */
const NS = "openviking";

/** One editable field: a path inside the section, its control kind, and copy keys. */
interface FieldDef {
  path: readonly string[];
  kind: "text" | "password" | "number" | "bool";
  group: "connection" | "repoContext" | "autoRecall" | "autoCommit";
  labelKey: OpenVikingDictKey;
  hintKey: OpenVikingDictKey;
}

const FIELDS: readonly FieldDef[] = [
  { path: ["endpoint"], kind: "text", group: "connection", labelKey: "fieldEndpoint", hintKey: "fieldEndpointHint" },
  { path: ["apiKey"], kind: "password", group: "connection", labelKey: "fieldApiKey", hintKey: "fieldApiKeyHint" },
  { path: ["account"], kind: "text", group: "connection", labelKey: "fieldAccount", hintKey: "fieldAccountHint" },
  { path: ["user"], kind: "text", group: "connection", labelKey: "fieldUser", hintKey: "fieldUserHint" },
  { path: ["agentId"], kind: "text", group: "connection", labelKey: "fieldAgentId", hintKey: "fieldAgentIdHint" },
  { path: ["timeoutMs"], kind: "number", group: "connection", labelKey: "fieldTimeoutMs", hintKey: "fieldTimeoutMsHint" },
  { path: ["stateFile"], kind: "text", group: "connection", labelKey: "fieldStateFile", hintKey: "fieldStateFileHint" },
  { path: ["repoContext", "enabled"], kind: "bool", group: "repoContext", labelKey: "fieldRepoEnabled", hintKey: "fieldRepoEnabledHint" },
  { path: ["repoContext", "cacheTtlMs"], kind: "number", group: "repoContext", labelKey: "fieldCacheTtlMs", hintKey: "fieldCacheTtlMsHint" },
  { path: ["autoRecall", "enabled"], kind: "bool", group: "autoRecall", labelKey: "fieldRecallEnabled", hintKey: "fieldRecallEnabledHint" },
  { path: ["autoRecall", "limit"], kind: "number", group: "autoRecall", labelKey: "fieldRecallLimit", hintKey: "fieldRecallLimitHint" },
  { path: ["autoRecall", "scoreThreshold"], kind: "number", group: "autoRecall", labelKey: "fieldScoreThreshold", hintKey: "fieldScoreThresholdHint" },
  { path: ["autoRecall", "maxContentChars"], kind: "number", group: "autoRecall", labelKey: "fieldMaxContentChars", hintKey: "fieldMaxContentCharsHint" },
  { path: ["autoRecall", "tokenBudget"], kind: "number", group: "autoRecall", labelKey: "fieldTokenBudget", hintKey: "fieldTokenBudgetHint" },
  { path: ["autoCommit", "enabled"], kind: "bool", group: "autoCommit", labelKey: "fieldCommitEnabled", hintKey: "fieldCommitEnabledHint" },
  { path: ["autoCommit", "intervalMinutes"], kind: "number", group: "autoCommit", labelKey: "fieldIntervalMinutes", hintKey: "fieldIntervalMinutesHint" },
];

const FIELD_BY_KEY = new Map(FIELDS.map((field) => [pathKey(field.path), field]));

/** Dot-joined key identifying one field's path. */
function pathKey(path: readonly string[]): string {
  return path.join(".");
}

/** Read a value at a path; undefined when any segment is absent. */
function atPath(value: unknown, path: readonly string[]): unknown {
  let cursor = value;
  for (const segment of path) {
    if (typeof cursor !== "object" || cursor === null || !(segment in cursor)) return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
}

/** Whether a path is PRESENT (its own segment exists), used for user-layer overrides. */
function hasPath(value: unknown, path: readonly string[]): boolean {
  let cursor = value;
  for (const segment of path) {
    if (typeof cursor !== "object" || cursor === null || !(segment in cursor)) return false;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return true;
}

/** Render a stored value as draft text; the empty string when absent. */
function formatValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return String(value);
  return "";
}

/** One staged edit. `clear` stages an unset (re-inherit the composition layer). */
type Staged = { kind: "text"; text: string } | { kind: "clear" } | { kind: "bool"; checked: boolean };

/** Projection of one field as the card renders it. */
interface FieldView {
  text: string;
  checked: boolean;
  overridden: boolean;
  invalid: boolean;
}

/** The card's reactive snapshot: shell state plus every field view. */
interface CardSnapshot {
  available: boolean;
  writable: boolean;
  dirty: boolean;
  invalid: boolean;
  saving: boolean;
  failed: boolean;
  /** Host rejection reason of the last failed save, when one was returned. */
  failedReason?: string;
  fields: Record<string, FieldView>;
}

/**
 * The card's staged form over the `openviking` settings namespace. Nothing
 * here writes on its own: the component stages what the user types, and save
 * is the single point where a draft becomes a document mutation. The scope
 * snapshot (value/base/user) and the local drafts are folded into one
 * projection published to subscribers.
 */
class OpenVikingCardController {
  private readonly scope: CompatSettingsScope<Record<string, unknown>>;
  private readonly staged = new Map<string, Staged>();
  private readonly listeners = new Set<() => void>();
  private snapshot: CardSnapshot;
  private saving = false;
  private failed = false;
  private failedReason: string | undefined;

  constructor(ctx: ClientContext) {
    const connection = ctx.get("connection") as ConnectionHandle;
    // Official settings scope first; the bridge fallback takes over only when
    // the namespace is not exposed to this client on a loopback connection.
    this.scope = createCompatScope<Record<string, unknown>>({
      namespace: NS,
      primary: ctx.settingsScope.bind<Record<string, unknown>>({ namespace: NS }),
      fetchFn: connection.isLoopback ? ((input, init) => fetch(input, init)) : undefined,
    });
    // Bridge refreshes ride the same invalidation edges as the official
    // scope: forwarded settings-document updates and connection resets.
    ctx.effect(() => {
      const disposers: Array<() => void> = [];
      const remote = ctx.get("remote") as { $on: (event: string, callback: (namespace?: unknown) => void) => () => void } | undefined;
      if (remote !== undefined) {
        disposers.push(
          remote.$on("settings/document-updated", (namespace) => {
            if (namespace !== undefined && namespace !== NS) return;
            void this.scope.load();
          }),
        );
      }
      disposers.push(
        ctx.on("connection/reset", () => {
          void this.scope.load();
        }),
      );
      return () => {
        for (const dispose of disposers) dispose();
      };
    }, "openviking: card scope invalidation");
    this.snapshot = this.project();
    this.scope.subscribe(() => this.publish());
  }

  // ── observable face (useSyncExternalStore) ────────────────────────────

  /** Stable snapshot reference between publications. */
  getSnapshot = (): CardSnapshot => this.snapshot;

  /** Subscribe to projection replacements. */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  // ── staging actions the card binds to controls ────────────────────────

  /** Stage draft text for one text/number/password field. */
  edit(fieldKey: string, text: string): void {
    this.stage(fieldKey, { kind: "text", text });
  }

  /** Stage a checkbox value for one bool field. */
  toggle(fieldKey: string, checked: boolean): void {
    this.stage(fieldKey, { kind: "bool", checked });
  }

  /** Stage a clear, so saving lets the field re-inherit the composition layer. */
  resetField(fieldKey: string): void {
    this.stage(fieldKey, { kind: "clear" });
  }

  /** Stage one edit; any prior failure state is cleared by the new draft. */
  private stage(fieldKey: string, staged: Staged): void {
    this.staged.set(fieldKey, staged);
    this.failed = false;
    this.failedReason = undefined;
    this.publish();
  }

  /** Drop every staged edit. */
  discard(): void {
    this.staged.clear();
    this.failed = false;
    this.failedReason = undefined;
    this.publish();
  }

  /** Write every staged edit, then re-seed from what the Host accepted. */
  async save(): Promise<void> {
    if (this.saving || !this.snapshot.available || !this.snapshot.writable || this.snapshot.invalid) return;
    const writes: BridgeBatchOp[] = [];
    const fields = new Set<string>();
    for (const [fieldKey, staged] of this.staged) {
      const field = FIELD_BY_KEY.get(fieldKey);
      if (!field) continue;
      fields.add(fieldKey);
      if (staged.kind === "text") {
        if (staged.text === "") writes.push({ field: fieldKey, op: "unset" });
        else writes.push({ field: fieldKey, op: "set", value: field.kind === "number" ? Number(staged.text) : staged.text });
      } else if (staged.kind === "clear") {
        writes.push({ field: fieldKey, op: "unset" });
      } else {
        writes.push({ field: fieldKey, op: "set", value: staged.checked });
      }
    }
    this.saving = true;
    this.failed = false;
    this.failedReason = undefined;
    this.publish();
    try {
      const landed = new Set<string>();
      let accepted = true;
      let reason: string | undefined;
      // The bridge scope batches every write into one mutate; the official
      // scope path writes per-field. Either way the Host is the only
      // authority on what landed — the read-back decides per field.
      const batch = this.scope.mutate;
      if (batch !== undefined && writes.length > 0) {
        const result = await batch(writes);
        accepted = result.ok;
        reason = result.message;
        if (result.ok) {
          for (const field of result.fields) {
            if (field.landed) landed.add(field.field);
          }
        }
      } else {
        for (const write of writes) {
          if (write.op === "set") await this.scope.set(write.field, write.value);
          else await this.scope.unset(write.field);
          if (this.landed(write)) landed.add(write.field);
        }
      }
      await this.scope.load();
      if (accepted) {
        for (const fieldKey of fields) {
          if (landed.has(fieldKey)) this.staged.delete(fieldKey);
        }
        this.failed = landed.size !== fields.size;
        this.failedReason = this.failed ? reason : undefined;
      } else {
        this.failed = true;
        this.failedReason = reason;
      }
    } finally {
      this.saving = false;
      this.publish();
    }
  }

  /** Whether the current user layer holds (or, for unset, no longer holds) the write. */
  private landed(write: BridgeBatchOp): boolean {
    const user = this.scope.getSnapshot().user as Record<string, unknown> | undefined;
    if (write.op === "unset") return user === undefined || !Object.hasOwn(user, write.field);
    return user !== undefined && user[write.field] === write.value;
  }

  // ── projection ────────────────────────────────────────────────────────

  private project(): CardSnapshot {
    const scope = this.scope.getSnapshot();
    const available = scope.status === "ready";
    let dirty = false;
    let invalid = false;
    const fields: Record<string, FieldView> = {};
    for (const field of FIELDS) {
      const key = pathKey(field.path);
      const staged = this.staged.get(key);
      const effective = atPath(scope.value, field.path);
      const userHas = hasPath(scope.user, field.path);
      let text = formatValue(effective);
      let checked = Boolean(effective);
      let overridden = userHas;
      if (staged?.kind === "text") {
        text = staged.text;
        overridden = true;
        if (staged.text !== formatValue(effective)) dirty = true;
        if (field.kind === "number" && staged.text !== "" && !Number.isFinite(Number(staged.text))) invalid = true;
      } else if (staged?.kind === "bool") {
        checked = staged.checked;
        overridden = true;
        if (staged.checked !== Boolean(effective)) dirty = true;
      } else if (staged?.kind === "clear") {
        text = "";
        overridden = false;
        if (userHas) dirty = true;
      }
      fields[key] = { text, checked, overridden, invalid };
    }
    return {
      available,
      writable: scope.writable,
      dirty,
      invalid,
      saving: this.saving,
      failed: this.failed,
      ...(this.failedReason === undefined ? {} : { failedReason: this.failedReason }),
      fields,
    };
  }

  private publish(): void {
    this.snapshot = this.project();
    for (const listener of [...this.listeners]) listener();
  }
}

// ─── card component ─────────────────────────────────────────────────────

/** Props the slot renderer composes for this card. */
interface OpenVikingCardProps {
  /** Locale seat bound to the `openviking` dictionary namespace. */
  t: Translate<OpenVikingDictKey>;
  /** The card's controller (injected by the registration). */
  controller: OpenVikingCardController;
}

const css = `
.ovk_card{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:12px;list-style:none;transition:border-color .16s,background .16s}
.ovk_card:hover{border-color:var(--dsw-alias-label-dimmed)}
.ovk_cardOpen{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-label-dimmed)}
.ovk_header{appearance:none;width:100%;font:inherit;color:inherit;text-align:left;cursor:pointer;background:0 0;border:0;border-radius:12px;align-items:center;gap:12px;padding:14px 16px;display:flex}
.ovk_header:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}
.ovk_headText{flex-direction:column;flex:1;gap:4px;min-width:0;display:flex}
.ovk_name{color:var(--dsw-alias-label-primary);font-size:15px;font-weight:600;line-height:1.4}
.ovk_description{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:1.5}
.ovk_chevron{color:var(--dsw-alias-label-tertiary);flex:none;transition:transform .16s}
.ovk_chevronOpen{transform:rotate(180deg)}
.ovk_body{border-top:1px solid var(--dsw-alias-border-l2);margin:0 16px;padding-bottom:8px}
.ovk_readOnly{color:var(--dsw-alias-label-tertiary);margin:12px 0 0;font-size:12px;line-height:1.5}
.ovk_pending{white-space:nowrap;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);border-radius:999px;flex:none;padding:1px 8px;font-size:11px;font-weight:500;line-height:17px}
.ovk_footer{border-top:1px solid var(--dsw-alias-border-l2);justify-content:flex-end;align-items:center;gap:8px;padding:12px 0 4px;display:flex}
.ovk_failed{min-width:0;color:var(--dsw-alias-label-error);flex:1;margin:0;font-size:12px;line-height:1.5}
.ovk_discard,.ovk_save{appearance:none;font:inherit;cursor:pointer;border:1px solid transparent;border-radius:8px;padding:5px 14px;font-size:13px;line-height:1.5}
.ovk_discard{border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);background:0 0}
.ovk_discard:hover:not(:disabled){color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-dimmed)}
.ovk_save{background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-3)}
.ovk_discard:disabled,.ovk_save:disabled{opacity:.4;cursor:default}
.ovk_discard:focus-visible,.ovk_save:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.ovk_group{margin:14px 0 2px;color:var(--dsw-alias-label-secondary);font-size:12px;font-weight:600;letter-spacing:.04em;text-transform:uppercase}
.ovk_field{flex-direction:column;gap:6px;padding:12px 0;display:flex}
.ovk_field+.ovk_field{border-top:1px solid var(--dsw-alias-border-l2)}
.ovk_head{align-items:center;gap:8px;display:flex}
.ovk_label{min-width:0;color:var(--dsw-alias-label-primary);flex:1;font-size:13px;font-weight:500;line-height:1.5}
.ovk_badges{align-items:center;gap:8px;display:inline-flex}
.ovk_badge{white-space:nowrap;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);border-radius:999px;padding:1px 8px;font-size:11px;font-weight:500;line-height:17px}
.ovk_reset{font:inherit;color:var(--dsw-alias-label-secondary);cursor:pointer;background:0 0;border:none;padding:0;font-size:12px;line-height:1.5}
.ovk_reset:hover:not(:disabled){color:var(--dsw-alias-label-primary)}
.ovk_reset:disabled{cursor:default}
.ovk_input{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);height:34px;font:inherit;color:var(--dsw-alias-label-primary);border-radius:8px;padding:0 12px;font-size:13px;line-height:1.5}
.ovk_input:focus-visible{border-color:var(--dsw-alias-brand-primary);outline:none}
.ovk_input:disabled{color:var(--dsw-alias-label-tertiary);cursor:default}
.ovk_inputInvalid{border-color:var(--dsw-alias-label-error)}
.ovk_invalid{color:var(--dsw-alias-label-error);margin:0;font-size:12px;line-height:1.5}
.ovk_hint{color:var(--dsw-alias-label-tertiary);margin:0;font-size:12px;line-height:1.5}
.ovk_check{accent-color:var(--dsw-alias-brand-primary);width:16px;height:16px;flex:none;margin:0}
.ovk_checkRow{flex-direction:row;align-items:center;gap:10px;display:flex}
`;

const cssTag = "dsh-openviking/card.css";
if (typeof document !== "undefined" && document.querySelector(`style[data-plugin-css=${JSON.stringify(cssTag)}]`) === null) {
  const tag = document.createElement("style");
  tag.dataset.plugin = "dsh-openviking";
  tag.dataset.pluginCss = cssTag;
  tag.textContent = css;
  document.head.appendChild(tag);
}

/** One field control: label, badges, and the input or checkbox. */
function OpenVikingField(props: {
  t: Translate<OpenVikingDictKey>;
  field: FieldDef;
  view: FieldView;
  disabled: boolean;
  onEdit: (text: string) => void;
  onToggle: (checked: boolean) => void;
  onReset: () => void;
}): ReactNode {
  const { t, field, view, disabled, onEdit, onReset } = props;
  const inputId = `plugin-config-openviking-${pathKey(field.path).replaceAll(".", "-")}`;
  const control =
    field.kind === "bool" ? (
      <div className="ovk_checkRow">
        <input
          id={inputId}
          className="ovk_check"
          type="checkbox"
          checked={view.checked}
          disabled={disabled}
          onChange={(event) => {
            props.onToggle(event.target.checked);
          }}
        />
        <label className="ovk_label" htmlFor={inputId}>
          {t(field.labelKey)}
        </label>
      </div>
    ) : (
      <>
        <div className="ovk_head">
          <label className="ovk_label" htmlFor={inputId}>
            {t(field.labelKey)}
          </label>
          {view.overridden ? (
            <span className="ovk_badges">
              <span className="ovk_badge">{t("overridden")}</span>
              <button type="button" className="ovk_reset" disabled={disabled} onClick={onReset}>
                {t("reset")}
              </button>
            </span>
          ) : null}
        </div>
        <input
          id={inputId}
          className={view.invalid ? "ovk_input ovk_inputInvalid" : "ovk_input"}
          type={field.kind === "password" ? "password" : "text"}
          inputMode={field.kind === "number" ? "numeric" : undefined}
          aria-invalid={view.invalid || undefined}
          value={view.text}
          placeholder=""
          disabled={disabled}
          onChange={(event) => {
            onEdit(event.target.value);
          }}
        />
      </>
    );
  return (
    <div className="ovk_field">
      {control}
      <p className={view.invalid ? "ovk_invalid" : "ovk_hint"}>{view.invalid ? t("invalidNumber") : t(field.hintKey)}</p>
    </div>
  );
}

/** The OpenViking configuration card. */
function OpenVikingCard(props: OpenVikingCardProps): ReactNode {
  const { t, controller } = props;
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const [open, setOpen] = useState(false);
  if (!state.available) return null;
  const blocked = !state.dirty || state.invalid || state.saving;
  const groups: Array<{ key: FieldDef["group"]; labelKey: OpenVikingDictKey }> = [
    { key: "connection", labelKey: "groupConnection" },
    { key: "repoContext", labelKey: "groupRepoContext" },
    { key: "autoRecall", labelKey: "groupAutoRecall" },
    { key: "autoCommit", labelKey: "groupAutoCommit" },
  ];
  return (
    <li className={open ? "ovk_card ovk_cardOpen" : "ovk_card"}>
      <button
        type="button"
        className="ovk_header"
        aria-expanded={open}
        aria-label={`${t(open ? "collapse" : "expand")}: ${t("cardTitle")}`}
        onClick={() => {
          setOpen(!open);
        }}
      >
        <span className="ovk_headText">
          <span className="ovk_name">{t("cardTitle")}</span>
          <span className="ovk_description">{t("cardDescription")}</span>
        </span>
        {state.dirty ? <span className="ovk_pending">{t("unsaved")}</span> : null}
        <IconChevronDownOutline14 className={open ? "ovk_chevron ovk_chevronOpen" : "ovk_chevron"} />
      </button>
      {open ? (
        <div className="ovk_body">
          {!state.writable ? (
            <p className="ovk_readOnly" role="status">
              {t("readOnly")}
            </p>
          ) : null}
          {groups.map((group) => (
            <div key={group.key}>
              <h3 className="ovk_group">{t(group.labelKey)}</h3>
              {FIELDS.filter((field) => field.group === group.key).map((field) => {
                const fieldKey = pathKey(field.path);
                const view = state.fields[fieldKey];
                if (!view) return null;
                return (
                  <OpenVikingField
                    key={fieldKey}
                    t={t}
                    field={field}
                    view={view}
                    disabled={!state.writable}
                    onEdit={(text) => {
                      controller.edit(fieldKey, text);
                    }}
                    onToggle={(checked) => {
                      controller.toggle(fieldKey, checked);
                    }}
                    onReset={() => {
                      controller.resetField(fieldKey);
                    }}
                  />
                );
              })}
            </div>
          ))}
          <div className="ovk_footer">
            {state.failed ? (
              <p className="ovk_failed" role="status">
                {t("saveFailed")}
                {state.failedReason !== undefined && state.failedReason !== "" ? `：${state.failedReason}` : ""}
              </p>
            ) : null}
            <button
              type="button"
              className="ovk_discard"
              disabled={!state.dirty || state.saving}
              onClick={() => {
                controller.discard();
              }}
            >
              {t("discard")}
            </button>
            <button
              type="button"
              className="ovk_save"
              disabled={blocked}
              onClick={() => {
                void controller.save();
              }}
            >
              {t(state.saving ? "saving" : "save")}
            </button>
          </div>
        </div>
      ) : null}
    </li>
  );
}

// ─── plugin entry ───────────────────────────────────────────────────────

/** Required services (cordis fiber inject). */
export const inject = ["slots", "locale", "connection", "remote", "settingsScope"];

/**
 * Mount the OpenViking configuration card.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register("openviking", { en, zh }), "openviking: card dictionaries");
  const controller = new OpenVikingCardController(ctx);
  ctx.slots.inject("settings.plugin.item", () =>
    ctx.slots.register(
      {
        name: "settings.plugin.item",
        id: "openviking",
        order: 30,
        locale: "openviking" as const,
        inject: () => ({ controller }),
      },
      OpenVikingCard,
    ),
  );
}
