/**
 * rc.6-compatible settings scope for the openviking web card.
 *
 * The official settings scope answers "unavailable" for every third-party
 * namespace on rc.6 hosts (the apiproxy allowlist is hard-coded), which would
 * turn the card into a read-only explanation. This module wraps the official
 * scope: when it reports the namespace ready, the wrapper is a pass-through;
 * when it reports unavailable on a loopback connection, a bridge controller
 * takes over and serves the same SettingsScope contract from the host-side
 * bridge routes (/api/dsh-openviking). Remote browsers (non-loopback) never
 * use the bridge, matching the official process-local policy.
 *
 * The bridge controller additionally carries an optional batch surface
 * (`mutate`): one POST applies every planned write together, so the card
 * saves atomically when the bridge is the active transport; the official
 * path writes per-field (its writes are out of our reach).
 */
import type { SettingsScope, SettingsScopeSnapshot, SettingsScopeSpec } from "@deepseek-ai/dsh-client-runtime/client";
import { OPENVIKING_SETTINGS_BRIDGE_PREFIX } from "../bridge-protocol.js";
import type { BridgeDescribeResult, BridgeMutateRequest, BridgeMutateResult, BridgeNamespaceView } from "../bridge-protocol.js";

/**
 * Minimal snapshot store: a stable reference between replacements and a
 * listener set — the observable contract useSyncExternalStore needs. The
 * official runtime ships one, but this module must not require it at runtime
 * (the browser loader resolves only the packages the boot graph declares).
 */
class SnapshotStore<T> {
  private snapshot: T;
  private readonly listeners = new Set<() => void>();

  constructor(initial: T) {
    this.snapshot = initial;
  }

  /** Stable reference between replacements. */
  getSnapshot(): T {
    return this.snapshot;
  }

  /** Subscribe to replacements; returns the disposer. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Replace the snapshot and notify every listener. */
  set(next: T): void {
    this.snapshot = next;
    for (const listener of [...this.listeners]) listener();
  }

  /** Shallow-copy the snapshot, mutate the copy, and publish it. */
  update(mutate: (draft: T) => void): void {
    const next = { ...this.snapshot };
    mutate(next);
    this.set(next);
  }
}

/** True when the value is a well-formed bridge RPC result envelope. */
function isBridgeResult(value: unknown): value is BridgeDescribeResult | BridgeMutateResult {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  if (typeof record.ok !== "boolean") return false;
  if (record.ok) return typeof record.value === "object" && record.value !== null;
  return typeof record.code === "string" && typeof record.message === "string";
}

/** The settings wire face the bridge controller consumes. */
export interface BridgeSettingsFace {
  settings: {
    describe: (payload: Record<string, never>) => Promise<{ result: BridgeDescribeResult }>;
    mutate: (payload: BridgeMutateRequest) => Promise<{ result: BridgeMutateResult }>;
  };
}

/** One durable write a batched scope mutation performs. */
export interface BridgeBatchOp {
  field: string;
  op: "set" | "unset";
  value?: unknown;
}

/** Per-field outcome of one batched scope mutation. */
export interface BridgeBatchFieldResult {
  field: string;
  landed: boolean;
}

/** Result of one batched scope mutation. */
export interface BridgeBatchResult {
  /** Whether the whole mutate was accepted. */
  ok: boolean;
  /** Per-field success, in the request order (always present when ok). */
  fields: BridgeBatchFieldResult[];
  /** Host rejection code (mutate refused). */
  code?: string;
  /** Host rejection message (mutate refused). */
  message?: string;
}

/** The optional batch surface the bridge scope adds over the SettingsScope contract. */
export interface BatchedSettingsScope {
  /** One atomic mutation of every planned write; present only on the bridge path. */
  mutate?(writes: BridgeBatchOp[]): Promise<BridgeBatchResult>;
}

/** The compat scope contract the card consumes. */
export type CompatSettingsScope<T> = SettingsScope<T> & { load(): Promise<void> } & BatchedSettingsScope;

/** One settled bridge POST, always shaped as an RPC result envelope. */
type EnvelopedResult = { result: BridgeDescribeResult | BridgeMutateResult };

/**
 * Build the fetch-backed settings face for the bridge routes. Network and
 * HTTP failures collapse into an ok:false envelope so the controller keeps
 * its unavailable state instead of throwing into plugin activation.
 * @param fetchFn - the fetch implementation (the global fetch on loopback).
 * @returns the settings face.
 */
export function createBridgeApi(fetchFn: typeof fetch): BridgeSettingsFace {
  const post = async (path: string, body: unknown): Promise<EnvelopedResult> => {
    try {
      const response = await fetchFn(OPENVIKING_SETTINGS_BRIDGE_PREFIX + path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!response.ok) return { result: { ok: false, code: "internal", message: "bridge HTTP " + response.status } };
      const parsed: unknown = await response.json();
      if (!isBridgeResult(parsed)) return { result: { ok: false, code: "internal", message: "bridge malformed response" } };
      return { result: parsed };
    } catch {
      return { result: { ok: false, code: "internal", message: "settings bridge unreachable" } };
    }
  };
  return {
    settings: {
      describe: async (payload) => post("/describe", payload) as Promise<{ result: BridgeDescribeResult }>,
      mutate: async (payload) => post("/mutate", payload) as Promise<{ result: BridgeMutateResult }>,
    },
  };
}

/** One path-addressed settings edit sent to the bridge. */
interface BridgeWrite {
  op: "set" | "unset";
  path: string[];
  value?: unknown;
}

/**
 * A minimal SettingsScopeController over the bridge face. Mirrors the
 * official controller's ordering (serialized queue, revision-fenced writes,
 * recovery read after a refusal) but trusts the Host-seam value without
 * re-running the wire-schema validation: the seam already validated it, and
 * the card binds without a narrowing decoder.
 */
class BridgeScopeController<T> implements SettingsScope<T>, BatchedSettingsScope {
  private readonly store: SnapshotStore<SettingsScopeSnapshot<T>>;
  private tail: Promise<unknown> = Promise.resolve();
  private disposed = false;

  constructor(
    private readonly api: BridgeSettingsFace,
    private readonly spec: SettingsScopeSpec<T>,
  ) {
    this.store = new SnapshotStore<SettingsScopeSnapshot<T>>({
      status: "loading",
      value: undefined,
      base: undefined,
      user: undefined,
      revision: undefined,
      writable: false,
      mode: "host",
    });
  }

  getSnapshot(): SettingsScopeSnapshot<T> {
    return this.store.getSnapshot();
  }

  subscribe(listener: () => void): () => void {
    return this.store.subscribe(listener);
  }

  /** Queue a Host refresh; a newer read or user write suppresses stale publication. */
  load(): Promise<void> {
    return this.enqueue(() => this.read());
  }

  set(field: string, value: unknown): Promise<void> {
    return this.write({ op: "set", path: [field], value });
  }

  unset(field: string): Promise<void> {
    return this.write({ op: "unset", path: [field] });
  }

  /**
   * Apply every write in one mutation (the card's atomic save path). Per-field
   * success is read from the fresh view so a field the Host silently failed to
   * hold is not cleared on the card.
   * @param writes - the durable writes, in order.
   * @returns the batch outcome.
   */
  async mutate(writes: BridgeBatchOp[]): Promise<BridgeBatchResult> {
    if (writes.length === 0) return { ok: true, fields: [] };
    const result = await this.postMutate(
      writes.map((write) =>
        write.op === "set"
          ? { op: "set" as const, path: [write.field], value: write.value }
          : { op: "unset" as const, path: [write.field] },
      ),
    );
    if (!result.ok) {
      await this.load();
      return {
        ok: false,
        fields: [],
        ...(result.code !== undefined ? { code: result.code } : {}),
        ...(result.message !== undefined ? { message: result.message } : {}),
      };
    }
    this.accept(result.view);
    const view = this.getSnapshot();
    return {
      ok: true,
      fields: writes.map((write) => ({
        field: write.field,
        landed: this.landed(view, write),
      })),
    };
  }

  /** Whether the fresh user layer holds (or, for unset, no longer holds) the write. */
  private landed(view: SettingsScopeSnapshot<T>, write: BridgeBatchOp): boolean {
    const user = view.user as Record<string, unknown> | undefined;
    if (write.op === "unset") return user === undefined || !Object.hasOwn(user, write.field);
    return user !== undefined && user[write.field] === write.value;
  }

  private write(op: BridgeWrite): Promise<void> {
    return this.enqueue(async () => {
      const result = await this.postMutate([op]);
      if (result.ok) this.accept(result.view);
      else await this.read();
    });
  }

  /** One revision-fenced mutate POST, collapsing transport failures into a refusal. */
  private async postMutate(ops: BridgeWrite[]): Promise<{ ok: true; view: BridgeNamespaceView } | { ok: false; code?: string; message?: string }> {
    const revision = this.getSnapshot().revision;
    let response: EnvelopedResult;
    try {
      response = await this.api.settings.mutate({
        ns: String(this.spec.namespace),
        ops: ops as BridgeMutateRequest["ops"],
        ...(revision === undefined ? {} : { expectedRevision: revision }),
      });
    } catch {
      return { ok: false };
    }
    if (!response.result.ok) {
      return { ok: false, code: response.result.code, message: response.result.message };
    }
    return { ok: true, view: response.result.value as BridgeNamespaceView };
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    if (this.disposed) return Promise.resolve();
    const task = this.tail.then(async () => {
      if (this.disposed) return;
      await operation();
    });
    this.tail = task.catch(() => {});
    return task;
  }

  private async read(): Promise<void> {
    let response: EnvelopedResult;
    try {
      response = await this.api.settings.describe({});
    } catch {
      return;
    }
    if (!response.result.ok || this.disposed) return;
    const value = response.result.value;
    if (!("namespaces" in value)) return;
    const view = value.namespaces.find((candidate) => candidate.ns === String(this.spec.namespace));
    if (view === undefined) {
      this.store.update((draft) => {
        draft.status = "unavailable";
      });
      return;
    }
    this.accept(view);
    this.store.update((draft) => {
      draft.writable = value.writable;
    });
  }

  /** Fold one bridge namespace view into the snapshot (value, base, user, revision). */
  private accept(view: BridgeNamespaceView): void {
    this.store.update((draft) => {
      draft.revision = view.revision;
      draft.base = view.base;
      draft.user = view.user;
      draft.status = "ready";
      draft.value = view.value as T;
    });
  }
}

/** Options for the compat scope wrapper. */
export interface CompatScopeOptions<T> {
  /** Namespace identity (for the bridge fallback). */
  namespace: string;
  /** The official settings scope (primary transport). */
  primary: SettingsScope<T>;
  /** The fetch implementation; undefined on non-loopback connections (no fallback). */
  fetchFn?: typeof fetch;
}

/**
 * Wrap the official scope with the bridge fallback. The official scope stays
 * the primary transport wherever it works; the bridge controller is started
 * only when the primary settles as unavailable and a fetch face exists.
 * @param options - namespace, the official scope, and the optional fetch face.
 * @returns the compat scope (SettingsScope + load + optional batch mutate).
 */
export function createCompatScope<T>(options: CompatScopeOptions<T>): CompatSettingsScope<T> {
  const { namespace, primary } = options;
  const fallback = options.fetchFn === undefined ? undefined : new BridgeScopeController<T>(createBridgeApi(options.fetchFn), { namespace });
  const store = new SnapshotStore<SettingsScopeSnapshot<T>>(project());
  let fallbackStarted = false;

  const publish = (): void => {
    store.set(project());
  };

  const startFallback = (): void => {
    if (fallback === undefined || fallbackStarted) return;
    fallbackStarted = true;
    void fallback.load();
  };

  function project(): SettingsScopeSnapshot<T> {
    const primarySnapshot = primary.getSnapshot();
    if (primarySnapshot.status === "ready" || fallback === undefined) return primarySnapshot;
    if (primarySnapshot.status === "loading") return primarySnapshot;
    const bridgeSnapshot = fallback.getSnapshot();
    if (bridgeSnapshot.status === "ready") return bridgeSnapshot;
    if (bridgeSnapshot.status === "loading") return { ...primarySnapshot, status: "loading" };
    return primarySnapshot;
  }

  primary.subscribe(() => {
    publish();
    if (primary.getSnapshot().status === "unavailable") startFallback();
  });
  fallback?.subscribe(publish);
  if (primary.getSnapshot().status === "unavailable") startFallback();

  const active = (): SettingsScope<T> => (primary.getSnapshot().status === "ready" ? primary : fallback ?? primary);

  return {
    getSnapshot: () => store.getSnapshot(),
    subscribe: (listener) => store.subscribe(listener),
    set: (field, value) => active().set(field, value),
    unset: (field) => active().unset(field),
    load: async () => {
      fallbackStarted = true;
      await fallback?.load();
      // The official controller carries load() at runtime; the contract type
      // omits it, so the call is made through the narrowed face.
      await (primary as SettingsScope<T> & { load(): Promise<void> }).load();
    },
    // The batch surface exists only while the bridge controller is the active
    // transport; the official scope path still writes per-field. A getter
    // keeps the capability decision at call time instead of freezing it when
    // the wrapper is built.
    get mutate() {
      const backend = active();
      if (fallback !== undefined && backend === fallback) return fallback.mutate.bind(fallback);
      return undefined;
    },
  };
}
