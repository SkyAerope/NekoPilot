import type { Page } from "@playwright/test";

export async function assetKeys(page: Page): Promise<IDBValidKey[]> {
  return page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("nekopilot-assets", 1);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
    });
    try {
      return await new Promise<IDBValidKey[]>((resolve, reject) => {
        const transaction = database.transaction("assets", "readonly");
        const request = transaction.objectStore("assets").getAllKeys();
        transaction.oncomplete = () => resolve(request.result);
        transaction.onabort = () => reject(transaction.error);
      });
    } finally {
      database.close();
    }
  });
}

export async function seedOrphan(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("nekopilot-assets", 1);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
    });
    const id = `orphan:${crypto.randomUUID()}`;
    try {
      await new Promise<void>((resolve, reject) => {
        const transaction = database.transaction("assets", "readwrite");
        transaction.objectStore("assets").put(new Blob(["orphan fixture"]), id);
        transaction.oncomplete = () => resolve();
        transaction.onabort = () => reject(transaction.error);
      });
      return id;
    } finally {
      database.close();
    }
  });
}
