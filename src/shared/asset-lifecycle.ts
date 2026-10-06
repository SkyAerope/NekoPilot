import { deleteUnreferencedAssets, isScreenshotRef } from "./assets";
import type { ScreenshotRef } from "./assets";
import { readAssetRoots } from "./asset-roots";

const lifecycleLock = "nekopilot-assets-lifecycle";
const metadataLock = "nekopilot-conversation-metadata";
const pinPrefix = "nekopilot-asset-pin:";

export function screenshotEventRef(event: {
  readonly type: string;
  readonly data: unknown;
}): ScreenshotRef | undefined {
  const data = event.data;
  if (
    event.type !== "tool_result" ||
    typeof data !== "object" ||
    data === null ||
    !("result" in data)
  )
    return;
  const result = data.result;
  if (
    typeof result === "object" &&
    result !== null &&
    "data" in result &&
    isScreenshotRef(result.data)
  )
    return result.data;
}

type Lease = { readonly release: () => Promise<void> };
export type AssetCollectionResult =
  | { readonly status: "collected"; readonly deleted: number }
  | { readonly status: "busy" | "unavailable" }
  | { readonly status: "failed"; readonly error: string };
let collection: Promise<AssetCollectionResult> | undefined;
let collectionRequested = false;

async function acquireSharedLease(name: string): Promise<Lease> {
  if (typeof navigator === "undefined" || !navigator.locks)
    return { release: async () => {} };
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let acquired = () => {};
  const ready = new Promise<void>((resolve) => {
    acquired = resolve;
  });
  const settled = navigator.locks.request(name, { mode: "shared" }, () => {
    acquired();
    return held;
  });
  await Promise.race([ready, settled]);
  return {
    release: async () => {
      release();
      await settled;
      // 包括其他上下文发起的忙碌回收；不使用定时器或过期宽限期。
      void collectOrphanAssets();
    },
  };
}

export function acquireAssetPublication(): Promise<Lease> {
  return acquireSharedLease(lifecycleLock);
}

export async function withAssetPublication<T>(
  work: () => Promise<T>,
): Promise<T> {
  const lease = await acquireAssetPublication();
  try {
    return await work();
  } finally {
    await lease.release();
  }
}

/** 元数据写入与清空共用串行屏障；代次检查必须在回调内执行。 */
export async function withConversationWrite<T>(
  work: () => Promise<T>,
): Promise<T> {
  if (typeof navigator === "undefined" || !navigator.locks) return work();
  return navigator.locks.request(metadataLock, work);
}

/** 内存中的截图保留到新建对话或面板卸载，覆盖防抖与保存失败窗口。 */
export class AssetPins {
  private readonly leases = new Map<string, Promise<Lease>>();
  private generation = 0;

  async retain(ids: readonly string[]): Promise<void> {
    const generation = this.generation;
    await withAssetPublication(async () => {
      if (generation !== this.generation) return;
      for (const id of ids) {
        if (!this.leases.has(id))
          this.leases.set(id, acquireSharedLease(`${pinPrefix}${id}`));
      }
      await Promise.all(this.leases.values());
    });
  }

  async clear(): Promise<void> {
    this.generation++;
    const leases = [...this.leases.values()];
    this.leases.clear();
    await Promise.all(leases.map(async (lease) => (await lease).release()));
  }
}

/** 排他锁内才读取引用，禁止把过期快照用于删除。 */
export function collectOrphanAssets(): Promise<AssetCollectionResult> {
  collectionRequested = true;
  if (!collection)
    collection = drainCollection().finally(() => {
      collection = undefined;
      if (collectionRequested) void collectOrphanAssets();
    });
  return collection;
}

async function drainCollection(): Promise<AssetCollectionResult> {
  let result: AssetCollectionResult;
  do {
    collectionRequested = false;
    result = await collect();
  } while (collectionRequested);
  return result;
}

async function collect(): Promise<AssetCollectionResult> {
  if (typeof navigator === "undefined" || !navigator.locks)
    return { status: "unavailable" };
  try {
    return await navigator.locks.request(
      lifecycleLock,
      { mode: "exclusive", ifAvailable: true },
      async (lock): Promise<AssetCollectionResult> => {
        if (!lock) return { status: "busy" };
        const retained = await readAssetRoots();
        const { held } = await navigator.locks.query();
        for (const pin of held ?? []) {
          if (pin.name?.startsWith(pinPrefix))
            retained.add(pin.name.slice(pinPrefix.length));
        }
        return {
          status: "collected",
          deleted: await deleteUnreferencedAssets(retained),
        };
      },
    );
  } catch (error: unknown) {
    return {
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
