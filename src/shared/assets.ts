export type AssetRef = {
  readonly id: string;
  readonly mime: string;
  readonly size: number;
};

export type ScreenshotRef = AssetRef & {
  readonly width?: number;
  readonly height?: number;
};

export class AssetStorageError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AssetStorageError";
  }
}

let database: Promise<IDBDatabase> | undefined;

function openDatabase(): Promise<IDBDatabase> {
  if (database) return database;
  database = new Promise<IDBDatabase>((resolve, reject) => {
    let blocked = false;
    const request = indexedDB.open("nekopilot-assets", 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore("assets");
    };
    request.onerror = () =>
      reject(
        new AssetStorageError("无法打开附件数据库", { cause: request.error }),
      );
    request.onblocked = () => {
      blocked = true;
      reject(new AssetStorageError("附件数据库升级被其他页面阻塞"));
    };
    request.onsuccess = () => {
      const db = request.result;
      if (blocked) {
        db.close();
        return;
      }
      db.onversionchange = () => {
        db.close();
        database = undefined;
      };
      resolve(db);
    };
  }).catch((error: unknown) => {
    database = undefined;
    throw error;
  });
  return database;
}

/** 引用只有在事务提交后才可发布；调用方须用发布锁覆盖写入到引用保存的全过程。 */
export async function storeAsset(blob: Blob): Promise<AssetRef> {
  const bytes = await blob.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hash = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  const ref = { id: `${blob.type}:${hash}`, mime: blob.type, size: blob.size };
  const db = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction("assets", "readwrite");
    transaction.objectStore("assets").put(blob, ref.id);
    transaction.oncomplete = () => resolve();
    transaction.onabort = () =>
      reject(
        new AssetStorageError("附件写入失败", { cause: transaction.error }),
      );
    transaction.onerror = () =>
      reject(
        new AssetStorageError("附件写入失败", { cause: transaction.error }),
      );
  });
  return ref;
}

export async function readAsset(id: string): Promise<Blob | null> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction("assets", "readonly");
    const request = transaction.objectStore("assets").get(id);
    transaction.oncomplete = () => {
      const value: unknown = request.result;
      if (value === undefined) resolve(null);
      else if (value instanceof Blob) resolve(value);
      else reject(new AssetStorageError("附件记录损坏"));
    };
    transaction.onabort = () =>
      reject(
        new AssetStorageError("附件读取失败", { cause: transaction.error }),
      );
    transaction.onerror = () =>
      reject(
        new AssetStorageError("附件读取失败", { cause: transaction.error }),
      );
  });
}

/** 调用方必须持有回收锁，并传入完整的持久化及内存引用集合。 */
export async function deleteUnreferencedAssets(
  retained: ReadonlySet<string>,
): Promise<number> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    let deleted = 0;
    const transaction = db.transaction("assets", "readwrite");
    const request = transaction.objectStore("assets").openKeyCursor();
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      if (typeof cursor.key === "string" && !retained.has(cursor.key)) {
        transaction.objectStore("assets").delete(cursor.key);
        deleted++;
      }
      cursor.continue();
    };
    transaction.oncomplete = () => resolve(deleted);
    transaction.onabort = () =>
      reject(
        new AssetStorageError("附件回收失败", { cause: transaction.error }),
      );
    transaction.onerror = () =>
      reject(
        new AssetStorageError("附件回收失败", { cause: transaction.error }),
      );
  });
}

export function isScreenshotRef(value: unknown): value is ScreenshotRef {
  return (
    typeof value === "object" &&
    value !== null &&
    "id" in value &&
    typeof value.id === "string" &&
    "mime" in value &&
    typeof value.mime === "string" &&
    value.mime.startsWith("image/") &&
    "size" in value &&
    typeof value.size === "number" &&
    (!("width" in value) ||
      (typeof value.width === "number" && value.width > 0)) &&
    (!("height" in value) ||
      (typeof value.height === "number" && value.height > 0))
  );
}

export function parseLegacyScreenshot(
  value: unknown,
): { readonly data: string; readonly mime: string } | null {
  if (typeof value === "string") return { data: value, mime: "image/png" };
  if (
    typeof value === "object" &&
    value !== null &&
    "data" in value &&
    typeof value.data === "string"
  ) {
    return {
      data: value.data,
      mime:
        "mime" in value && typeof value.mime === "string"
          ? value.mime
          : "image/png",
    };
  }
  return null;
}

export async function storeScreenshot(shot: {
  readonly data: string;
  readonly mime: string;
}): Promise<ScreenshotRef> {
  const bytes = Uint8Array.from(atob(shot.data), (character) =>
    character.charCodeAt(0),
  );
  const ref = await storeAsset(new Blob([bytes], { type: shot.mime }));
  // 仅 PNG 有固定位置的尺寸头；其余格式在预览解码后获取尺寸。
  if (
    bytes.length >= 24 &&
    bytes[0] === 137 &&
    bytes[1] === 80 &&
    bytes[2] === 78 &&
    bytes[3] === 71
  ) {
    const view = new DataView(bytes.buffer);
    const width = view.getUint32(16);
    const height = view.getUint32(20);
    if (width > 0 && height > 0) return { ...ref, width, height };
  }
  return ref;
}

export async function assetDataUrl(ref: AssetRef): Promise<string | null> {
  const blob = await readAsset(ref.id);
  if (!blob) return null;
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const chunks: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 8192)));
  }
  return `data:${ref.mime};base64,${btoa(chunks.join(""))}`;
}
