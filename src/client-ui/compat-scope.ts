/**
 * Version-tolerant settings scope for the openviking web card.
 *
 * The official settings scope answers "unavailable" for every third-party
 * namespace on pre-0.1.2 hosts (the apiproxy allowlist is hard-coded there),
 * which would turn the card into a read-only explanation. This module wraps
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
import type { SettingsScope, SettingsScopeSnapshot, SettingsScopeSpec } from "@deepseek-ai/dsh-client-ui-settings/client";
import type { SettingsPathOpView } from "@deepseek-ai/dsh-api-remotes/client";
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

/** The compat scope contract the card consumes: the official scope plus an
 * explicit refresh (the official controller no longer exposes `load`). */
export type CompatSettingsScope<T> = SettingsScope<T> & { load(): Promise<void> };

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
class BridgeScopeController<T> implements SettingsScope<T> {
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
   * Queue one atomic namespace mutation. All operations share one revision
   * fence and one recovery read, matching the official controller: a refused
   * or failed write reloads Host state instead of throwing, so the card
   * learns what landed from the snapshot it reads back.
   * @param ops - ordered field operations, copied when queued.
   * @param expectedRevision - optional fixed revision fencing this write.
   */
  mutate(ops: readonly SettingsPathOpView[], expectedRevision?: number): Promise<void> {
    if (ops.length === 0) return Promise.resolve();
    const writes: BridgeWrite[] = ops.map((op) =>
      op.op === "set" ? { op: "set", path: [...op.path], value: op.value } : { op: "unset", path: [...op.path] },
    );
    return this.enqueue(async () => {
      const revision = expectedRevision ?? this.getSnapshot().revision;
      const result = await this.postMutate(writes, revision);
      if (result.ok) this.accept(result.view);
      else await this.read();
    });
  }

  private write(op: BridgeWrite): Promise<void> {
    return this.enqueue(async () => {
      const result = await this.postMutate([op], this.getSnapshot().revision);
      if (result.ok) this.accept(result.view);
      else await this.read();
    });
  }

  /** One revision-fenced mutate POST, collapsing transport failures into a refusal. */
  private async postMutate(ops: BridgeWrite[], revision: number | undefined): Promise<{ ok: true; view: BridgeNamespaceView } | { ok: false; code?: string; message?: string }> {
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
      // The official controller carried load() at runtime through 0.1.1-rc.2,
      // where the contract type omitted it and the call went through a
      // narrowed face. On 0.1.2-alpha.1 it is gone from the runtime too, so
      // the cast describes nothing and calling it throws. Probe instead:
      // bind() already triggers mirror.ensure() and the controller publishes
      // through subscribe(), so skipping the explicit refresh loses nothing
      // on hosts that no longer expose it.
      const withLoad = primary as SettingsScope<T> & { load?(): Promise<void> };
      if (typeof withLoad.load === "function") await withLoad.load();
    },
    // Atomic writes work on both transports now that the official scope grew
    // its own `mutate`; the call-time backend decision stays dynamic.
    mutate: (ops, expectedRevision) => active().mutate(ops, expectedRevision),
  };
}
