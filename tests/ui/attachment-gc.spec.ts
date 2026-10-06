import { expect, test } from "@playwright/test";
import { loadCollector } from "../helpers/asset-gc";

for (const root of ["local", "session"] as const) {
  test(`附件仅在 ${root} 中引用时不被回收`, async ({ page }) => {
    // Given
    await loadCollector(page);
    const result = await page.evaluate(async (root) => {
      const asset = await window.__assetStore.storeAsset(
        new Blob(["retained text"], { type: "text/plain" }),
      );
      const attachment = { kind: "text", name: "notes.txt", asset };
      if (root === "local")
        window.__assetRoots.local = {
          chatLogs: [{ attachments: [attachment] }],
        };
      else
        window.__assetRoots.session = {
          conversationState: {
            conversationHistory: [
              { role: "user", content: [{ type: "attachment", attachment }] },
            ],
          },
        };
      // When
      const collection = await window.__assetGC.collectOrphanAssets();
      // Then
      return {
        collection,
        text: await (await window.__assetStore.readAsset(asset.id))?.text(),
      };
    }, root);
    expect(result.collection.status).toBe("collected");
    expect(result.text).toBe("retained text");
  });
}
