import type { Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import ts from "typescript";

export function compile(path: string) {
  return ts.transpileModule(readFileSync(path, "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
}

declare global {
  interface Window {
    __assetGC: typeof import("../../src/shared/asset-lifecycle");
    __assetStore: typeof import("../../src/shared/assets");
    __assetRoots: {
      local: Record<string, unknown>;
      session: Record<string, unknown>;
      failRead?: boolean;
    };
  }
}

export async function loadCollector(page: Page) {
  await page.route("**/asset-test", (route) =>
    route.fulfill({ body: "<title>gc</title>" }),
  );
  await page.goto("/asset-test");
  await page.evaluate(
    ({ assets, roots, lifecycle }) => {
      const state: Window["__assetRoots"] = { local: {}, session: {} };
      const chromeMock = {
        storage: {
          local: {
            get: async () => {
              if (state.failRead) throw new Error("storage unavailable");
              return state.local;
            },
          },
          session: { get: async () => state.session },
        },
      };
      Object.defineProperty(window, "chrome", {
        value: chromeMock,
        configurable: true,
      });
      const store = new Function("exports", `${assets}; return exports;`)({});
      const rootModule = new Function(
        "exports",
        "require",
        `${roots}; return exports;`,
      )({}, () => store);
      const api = new Function(
        "exports",
        "require",
        `${lifecycle}; return exports;`,
      )({}, (name: string) => (name === "./assets" ? store : rootModule));
      window.__assetStore = store;
      window.__assetGC = api;
      window.__assetRoots = state;
    },
    {
      assets: compile("src/shared/assets.ts"),
      roots: compile("src/shared/asset-roots.ts"),
      lifecycle: compile("src/shared/asset-lifecycle.ts"),
    },
  );
}
