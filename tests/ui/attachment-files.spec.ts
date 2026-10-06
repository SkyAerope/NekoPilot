import { expect, test } from "@playwright/test";
import { loadAttachments } from "../helpers/attachment-modules";

test.beforeEach(async ({ page }) => loadAttachments(page));

for (const extension of ["txt", "md", "json", "csv"]) {
  test(`空 MIME 的 UTF8 文件被正确准备：${extension}`, async ({ page }) => {
    // Given：浏览器未提供 MIME 的真实文件。
    const result = await page.evaluate(async (extension) => {
      // When：准备并从真实 IndexedDB 校验。
      const prepared = await window.attachmentFiles.prepareAttachments([
        new File(["薄荷\n"], `a.${extension}`),
      ]);
      try {
        return await window.attachmentFiles.validateStoredAttachments(
          prepared.attachments,
        );
      } finally {
        await prepared.release();
      }
    }, extension);
    // Then：正文不进入引用，大小按字节计。
    expect(result[0]).toMatchObject({
      kind: "text",
      name: `a.${extension}`,
      asset: { size: 7 },
    });
  });
}

for (const mime of ["image/png", "image/jpeg", "image/webp"]) {
  test(`真实可解码图片被接受：${mime}`, async ({ page }) => {
    // Given：由浏览器编码的真实图片字节。
    const result = await page.evaluate(async (mime) => {
      const canvas = document.createElement("canvas");
      canvas.width = 2;
      canvas.height = 3;
      const blob = await new Promise<Blob>((resolve, reject) =>
        canvas.toBlob(
          (blob) => (blob ? resolve(blob) : reject(new Error("编码失败"))),
          mime,
        ),
      );
      const extension = mime.split("/")[1];
      // When：MIME 缺省时根据扩展名准备。
      const prepared = await window.attachmentFiles.prepareAttachments([
        new File([blob], `a.${extension}`),
      ]);
      try {
        return await window.attachmentFiles.validateStoredAttachments(
          prepared.attachments,
        );
      } finally {
        await prepared.release();
      }
    }, mime);
    // Then：实际格式与引用 MIME 一致。
    expect(result[0]).toMatchObject({ kind: "image", asset: { mime } });
  });
}

const failures = [
  {
    name: "a.pdf",
    type: "application/pdf",
    bytes: [65],
    code: "unsupported_type",
  },
  { name: "a.txt", type: "", bytes: [], code: "empty_file" },
  { name: "a.txt", type: "", bytes: [0xc3, 0x28], code: "invalid_utf8" },
  { name: "a.md", type: "", bytes: [65, 0, 66], code: "nul_text" },
  { name: "a.png", type: "image/png", bytes: [65, 66], code: "mime_mismatch" },
  {
    name: "a.png",
    type: "image/png",
    bytes: [137, 80, 78, 71, 13, 10, 26, 10],
    code: "invalid_image",
  },
] as const;
for (const fixture of failures) {
  test(`拒绝不安全字节：${fixture.code}`, async ({ page }) => {
    // Given：不能作为允许附件发布的字节。
    const code = await page.evaluate(async (fixture) => {
      // When：验证草稿文件。
      try {
        await window.attachmentFiles.validateAttachmentDraft([
          new File([new Uint8Array(fixture.bytes)], fixture.name, {
            type: fixture.type,
          }),
        ]);
        return "accepted";
      } catch (error) {
        return error instanceof window.attachmentContract.AttachmentError
          ? error.code
          : "unexpected";
      }
    }, fixture);
    // Then：拒绝原因可由调用方程序化处理。
    expect(code).toBe(fixture.code);
  });
}

for (const scenario of [
  "count",
  "image_size",
  "text_size",
  "combined",
  "dimensions",
] as const) {
  test(`附件策略限制：${scenario}`, async ({ page }) => {
    // Given：恰好超过一项策略的文件集合。
    const code = await page.evaluate(async (scenario) => {
      let files: File[];
      switch (scenario) {
        case "count":
          files = Array.from({ length: 5 }, () => new File(["a"], "a.txt"));
          break;
        case "image_size":
          files = [new File([new Uint8Array(4 * 1024 * 1024 + 1)], "a.png")];
          break;
        case "text_size":
          files = [new File([new Uint8Array(128 * 1024 + 1)], "a.txt")];
          break;
        case "combined":
          files = Array.from(
            { length: 3 },
            () => new File([new Uint8Array(3 * 1024 * 1024)], "a.png"),
          );
          break;
        case "dimensions": {
          const canvas = document.createElement("canvas");
          canvas.width = 8001;
          canvas.height = 1;
          const blob = await new Promise<Blob>((resolve, reject) =>
            canvas.toBlob((blob) =>
              blob ? resolve(blob) : reject(new Error("编码失败")),
            ),
          );
          files = [new File([blob], "a.png")];
          break;
        }
      }
      // When：准备前校验策略。
      try {
        await window.attachmentFiles.validateAttachmentDraft(files);
        return "accepted";
      } catch (error) {
        return error instanceof window.attachmentContract.AttachmentError
          ? error.code
          : "unexpected";
      }
    }, scenario);
    // Then：限制不会被伪造内容或 MIME 绕过。
    expect(code).toBe(
      scenario === "count"
        ? "too_many_files"
        : scenario === "combined"
          ? "total_too_large"
          : scenario === "dimensions"
            ? "image_dimensions"
            : "file_too_large",
    );
  });
}

test("存储字节与引用不匹配时拒绝", async ({ page }) => {
  // Given：真实存储内容与伪造 size 元数据。
  const code = await page.evaluate(async () => {
    const prepared = await window.attachmentFiles.prepareAttachments([
      new File(["safe"], "a.txt"),
    ]);
    try {
      const attachments = prepared.attachments.map((attachment) => ({
        ...attachment,
        asset: { ...attachment.asset, size: 1 },
      }));
      // When：接收端读取实际存储。
      try {
        await window.attachmentFiles.validateStoredAttachments(attachments);
        return "accepted";
      } catch (error) {
        return error instanceof window.attachmentContract.AttachmentError
          ? error.code
          : "unexpected";
      }
    } finally {
      await prepared.release();
    }
  });
  // Then：不能信任传输元数据。
  expect(code).toBe("invalid_reference");
});

test("发布完成时已有 pin，明确释放后允许回收", async ({ page }) => {
  // Given：未持久化到根集合的附件。
  const result = await page.evaluate(async () => {
    const prepared = await window.attachmentFiles.prepareAttachments([
      new File(["safe"], "a.txt"),
    ]);
    const id = prepared.attachments[0]?.asset.id;
    if (!id) throw new Error("缺少附件");
    // When：分别在持有和释放期间执行真实回收。
    await window.attachmentLifecycle.collectOrphanAssets();
    const pinned = Boolean(await window.attachmentStore.readAsset(id));
    await prepared.release();
    await window.attachmentLifecycle.collectOrphanAssets();
    return {
      pinned,
      released: await window.attachmentStore.readAsset(id),
      held: (await navigator.locks.query()).held,
    };
  });
  // Then：独立 pin 所有权覆盖发布后的窗口。
  expect(result.pinned).toBe(true);
  expect(result.released).toBeNull();
  expect(
    result.held?.filter((lock) => lock.name.startsWith("nekopilot-asset-pin:")),
  ).toEqual([]);
});

test("第二次存储事务失败会释放已获得的 pins", async ({ page }) => {
  // Given：第一个事务正常提交，第二个事务中止。
  const result = await page.evaluate(async () => {
    const original = IDBObjectStore.prototype.put;
    let writes = 0;
    IDBObjectStore.prototype.put = function (
      value: unknown,
      key?: IDBValidKey,
    ) {
      const request = original.call(this, value, key);
      if (++writes === 2) this.transaction.abort();
      return request;
    };
    let code = "accepted";
    try {
      // When：批量准备遇到部分失败。
      await window.attachmentFiles.prepareAttachments([
        new File(["one"], "a.txt"),
        new File(["two"], "b.txt"),
      ]);
    } catch (error) {
      code =
        error instanceof window.attachmentContract.AttachmentError
          ? error.code
          : "unexpected";
    } finally {
      IDBObjectStore.prototype.put = original;
    }
    return {
      code,
      pins: (await navigator.locks.query()).held?.filter((lock) =>
        lock.name.startsWith("nekopilot-asset-pin:"),
      ),
    };
  });
  // Then：失败不会留下无人拥有的租约。
  expect(result).toEqual({ code: "storage_failed", pins: [] });
});
