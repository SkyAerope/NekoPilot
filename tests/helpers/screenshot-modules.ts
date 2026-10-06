import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";

/** VM 测试加载真实截图模块；无截图的测试不需要模拟 IndexedDB。 */
export function screenshotModules(): Record<string, unknown> {
  const assets = {};
  const history = {};
  const roots = {};
  const lifecycle = {};
  const compile = (path: string) =>
    ts.transpileModule(readFileSync(path, "utf8"), {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
      },
    }).outputText;
  const globals = { Blob, DOMException, atob, btoa, crypto, Uint8Array };
  runInNewContext(compile("src/shared/assets.ts"), {
    exports: assets,
    ...globals,
  });
  runInNewContext(compile("src/shared/asset-roots.ts"), {
    exports: roots,
    ...globals,
    require: () => assets,
  });
  runInNewContext(compile("src/shared/asset-lifecycle.ts"), {
    exports: lifecycle,
    ...globals,
    require: (name: string) => {
      if (name === "./assets") return assets;
      if (name === "./asset-roots") return roots;
      throw new Error(`Unexpected asset lifecycle dependency: ${name}`);
    },
  });
  runInNewContext(compile("src/agent/screenshot-history.ts"), {
    exports: history,
    ...globals,
    require: (name: string) => {
      if (name === "../shared/assets") return assets;
      throw new Error(`Unexpected screenshot dependency: ${name}`);
    },
  });
  return {
    "../shared/assets": assets,
    "../shared/asset-lifecycle": lifecycle,
    "./screenshot-history": history,
    "../agent/screenshot-history": history,
  };
}
