import type { Page } from "@playwright/test";
import { existsSync, readFileSync } from "node:fs";
import ts from "typescript";

declare global {
  interface Window {
    attachmentContract: typeof import("../../src/shared/attachments");
    attachmentFiles: typeof import("../../src/shared/attachment-files");
    attachmentStore: typeof import("../../src/shared/assets");
    attachmentLifecycle: typeof import("../../src/shared/asset-lifecycle");
    attachmentMessaging: typeof import("../../src/shared/messaging");
    attachmentSent: unknown[];
  }
}

export async function loadAttachments(page: Page): Promise<void> {
  const paths = [
    "assets",
    "asset-roots",
    "asset-lifecycle",
    "attachments",
    "attachment-files",
    "messaging",
  ];
  const modules = paths.map((name) => {
    const path = `src/shared/${name}.ts`;
    // 缺失的新模块加载为空，让红灯指向缺失的行为 API。
    return {
      name,
      code: existsSync(path)
        ? ts.transpileModule(readFileSync(path, "utf8"), {
            compilerOptions: {
              module: ts.ModuleKind.CommonJS,
              target: ts.ScriptTarget.ES2022,
            },
          }).outputText
        : "",
    };
  });
  await page.route("**/attachment-test", (route) =>
    route.fulfill({ body: "<title>附件测试</title>" }),
  );
  await page.goto("/attachment-test");
  await page.evaluate((modules) => {
    window.attachmentSent = [];
    Object.defineProperty(window, "chrome", {
      configurable: true,
      value: {
        runtime: {
          sendMessage: (
            message: unknown,
            callback: (value: unknown) => void,
          ) => {
            window.attachmentSent.push(message);
            callback({ ok: true });
          },
        },
        storage: {
          local: { get: async () => ({}) },
          session: { get: async () => ({}) },
        },
      },
    });
    const loaded = new Map<string, unknown>();
    for (const { name } of modules) loaded.set(`./${name}`, {});
    for (const { name, code } of modules) {
      loaded.set(
        `./${name}`,
        new Function("exports", "require", `${code}; return exports;`)(
          loaded.get(`./${name}`),
          (path: string) => loaded.get(path),
        ),
      );
    }
    window.attachmentContract = new Function("value", "return value")(
      loaded.get("./attachments"),
    );
    window.attachmentFiles = new Function("value", "return value")(
      loaded.get("./attachment-files"),
    );
    window.attachmentStore = new Function("value", "return value")(
      loaded.get("./assets"),
    );
    window.attachmentLifecycle = new Function("value", "return value")(
      loaded.get("./asset-lifecycle"),
    );
    window.attachmentMessaging = new Function("value", "return value")(
      loaded.get("./messaging"),
    );
  }, modules);
}
