import { expect, test } from "@playwright/test";
import { compile, loadCollector } from "../helpers/asset-gc";

test("回收只删除无引用文件，相同内容的共享引用保留", async ({ page }) => {
  // Given：真实 IndexedDB 中的两个文件，一个仍被引用。
  await page.route("**/asset-test", (route) =>
    route.fulfill({ body: "<title>gc</title>" }),
  );
  await page.goto("/asset-test");
  const result = await page.evaluate(async (code) => {
    const api: typeof import("../../src/shared/assets") = new Function(
      "exports",
      `${code}; return exports;`,
    )({});
    const retained = await api.storeAsset(
      new Blob(["retained"], { type: "image/png" }),
    );
    const orphan = await api.storeAsset(
      new Blob(["orphan"], { type: "image/png" }),
    );
    const sweep: unknown = Reflect.get(api, "deleteUnreferencedAssets");
    if (typeof sweep !== "function")
      throw new Error("Missing orphan collection API");
    // When：一次事务扫描所有键，保留被引用的内容。
    const deleted: unknown = await sweep(new Set([retained.id]));
    return {
      deleted,
      retained: (await api.readAsset(retained.id))?.size,
      orphan: await api.readAsset(orphan.id),
    };
  }, compile("src/shared/assets.ts"));
  // Then：仅孤立文件消失，引用文件字节不受影响。
  expect(result).toEqual({ deleted: 1, retained: 8, orphan: null });
});

test("回收合并本地、会话和内存引用，保留上下文裁剪截图", async ({ page }) => {
  // Given：各存储独占的引用、空正文工具消息和内存中尚未保存的截图。
  await loadCollector(page);
  const result = await page.evaluate(async () => {
    const store = window.__assetStore;
    const refs = await Promise.all(
      ["local", "session", "memory", "orphan"].map((text) =>
        store.storeAsset(new Blob([text], { type: "image/png" })),
      ),
    );
    const [local, session, memory, orphan] = refs;
    if (!local || !session || !memory || !orphan)
      throw new Error("Missing fixtures");
    window.__assetRoots.local = {
      chatLogs: [{ screenshot: local, prunedFromContext: true }],
    };
    window.__assetRoots.session = {
      conversationState: {
        conversationHistory: [
          { content: null },
          { content: [{ type: "screenshot", screenshot: session }] },
        ],
      },
    };
    const pins = new window.__assetGC.AssetPins();
    await pins.retain([memory.id]);
    // When：回收完成后检查三类引用与孤立记录。
    const collection = await window.__assetGC.collectOrphanAssets();
    const surviving = await Promise.all(
      refs.map(async (ref) => Boolean(await store.readAsset(ref.id))),
    );
    await pins.clear();
    return { collection, surviving };
  });
  // Then：活跃内存引用不依赖防抖持久化，裁剪标记不影响保留。
  expect(result.collection.status).toBe("collected");
  expect(result.surviving).toEqual([true, true, true, false]);
});

for (const failure of ["read", "logs", "reference", "history"] as const) {
  test(`引用读取或结构异常时不删除文件：${failure}`, async ({ page }) => {
    // Given：存储中的文件与不可信的根集合。
    await loadCollector(page);
    const result = await page.evaluate(async (failure) => {
      const ref = await window.__assetStore.storeAsset(new Blob(["retained"]));
      if (failure === "read") window.__assetRoots.failRead = true;
      if (failure === "logs") window.__assetRoots.local = { chatLogs: {} };
      if (failure === "reference")
        window.__assetRoots.local = {
          chatLogs: [{ screenshot: { id: ref.id } }],
        };
      if (failure === "history")
        window.__assetRoots.session = {
          conversationState: { conversationHistory: null },
        };
      // When：尝试回收。
      const collection = await window.__assetGC.collectOrphanAssets();
      return {
        collection,
        survives: Boolean(await window.__assetStore.readAsset(ref.id)),
      };
    }, failure);
    // Then：失败关闭，不把读取失败解释成空引用。
    expect(result.collection.status).toBe("failed");
    expect(result.survives).toBe(true);
  });
}

test("跨页面发布未完成时跳过回收，发布完成后自动补做", async ({
  page,
  context,
}) => {
  // Given：另一页面持有实际的同源共享发布锁。
  await loadCollector(page);
  const writer = await context.newPage();
  await loadCollector(writer);
  await writer.evaluate(async () => {
    const lease = await window.__assetGC.acquireAssetPublication();
    Object.defineProperty(window, "releasePublication", {
      value: lease.release,
    });
    const ref = await window.__assetStore.storeAsset(new Blob(["pending"]));
    Object.defineProperty(window, "pendingAsset", { value: ref.id });
  });
  const id: string = await writer.evaluate(() =>
    Reflect.get(window, "pendingAsset"),
  );
  // When：另一个上下文请求回收。
  const pending = await page.evaluate(
    async (id) => ({
      collection: await window.__assetGC.collectOrphanAssets(),
      survives: Boolean(await window.__assetStore.readAsset(id)),
    }),
    id,
  );
  // Then：在途 Blob 保留；明确放弃发布后不需要定时器也会删除。
  expect(pending).toEqual({ collection: { status: "busy" }, survives: true });
  await writer.evaluate(async () => {
    const release: unknown = Reflect.get(window, "releasePublication");
    if (typeof release === "function") await release();
  });
  await expect
    .poll(() =>
      page.evaluate(
        (id) => window.__assetStore.readAsset(id).then(Boolean),
        id,
      ),
    )
    .toBe(false);
});

test("回收事务中止时回滚删除且不报告成功", async ({ page }) => {
  // Given：真实删除请求提交后被中止。
  await loadCollector(page);
  const result = await page.evaluate(async () => {
    const ref = await window.__assetStore.storeAsset(new Blob(["orphan"]));
    const original = IDBObjectStore.prototype.delete;
    IDBObjectStore.prototype.delete = function (
      key: IDBValidKey | IDBKeyRange,
    ) {
      const request = original.call(this, key);
      this.transaction.abort();
      return request;
    };
    // When：回收事务失败。
    let collection;
    try {
      collection = await window.__assetGC.collectOrphanAssets();
    } finally {
      IDBObjectStore.prototype.delete = original;
    }
    return {
      collection,
      survives: Boolean(await window.__assetStore.readAsset(ref.id)),
    };
  });
  // Then：不存在部分成功，文件仍可读取。
  expect(result.collection.status).toBe("failed");
  expect(result.survives).toBe(true);
});

test("一个面板清空引用时，另一面板仍持有的截图不会误删", async ({
  page,
  context,
}) => {
  // Given：两个页面共享同一 Blob，各自持有内存引用。
  await loadCollector(page);
  const other = await context.newPage();
  await loadCollector(other);
  const id = await page.evaluate(async () => {
    const ref = await window.__assetStore.storeAsset(
      new Blob(["shared screenshot"]),
    );
    const pins = new window.__assetGC.AssetPins();
    await pins.retain([ref.id]);
    Object.defineProperty(window, "clearPins", { value: () => pins.clear() });
    return ref.id;
  });
  await other.evaluate(async (id) => {
    const pins = new window.__assetGC.AssetPins();
    await pins.retain([id]);
    Object.defineProperty(window, "clearPins", { value: () => pins.clear() });
  }, id);
  // When：第一个面板放弃引用并发起回收。
  await page.evaluate(async () => {
    const clear: unknown = Reflect.get(window, "clearPins");
    if (typeof clear === "function") await clear();
    await window.__assetGC.collectOrphanAssets();
  });
  // Then：另一个面板保护共享文件，最后一个引用释放才自动删除。
  expect(
    await page.evaluate(
      (id) => window.__assetStore.readAsset(id).then(Boolean),
      id,
    ),
  ).toBe(true);
  await other.evaluate(async () => {
    const clear: unknown = Reflect.get(window, "clearPins");
    if (typeof clear === "function") await clear();
  });
  await expect
    .poll(() =>
      page.evaluate(
        (id) => window.__assetStore.readAsset(id).then(Boolean),
        id,
      ),
    )
    .toBe(false);
});
