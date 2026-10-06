import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";

/** VM 测试加载真实截图模块；无截图的测试不需要模拟 IndexedDB。 */
export function screenshotModules(): Record<string, unknown> {
  const assets = {};
  const history = {};
  const roots = {};
  const lifecycle = {};
  const attachments = {};
  const attachmentFiles = {};
  const attachmentHistory = {};
  const compile = (path: string) =>
    ts.transpileModule(readFileSync(path, "utf8"), {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
      },
    }).outputText;
  const globals = { Blob, DOMException, atob, btoa, crypto, Uint8Array, TextDecoder, TextEncoder };
  runInNewContext(compile("src/shared/assets.ts"), {
    exports: assets,
    ...globals,
  });
  runInNewContext(compile("src/shared/asset-roots.ts"), {
    exports: roots,
    ...globals,
    require: (name: string) => name === "./attachments" ? attachments : assets,
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
  runInNewContext(compile("src/shared/attachments.ts"), { exports: attachments, ...globals });
  runInNewContext(compile("src/shared/attachment-files.ts"), {
    exports: attachmentFiles, ...globals,
    require: (name: string) => {
      if (name === "./assets") return assets;
      if (name === "./attachments") return attachments;
      if (name === "./asset-lifecycle") return lifecycle;
      throw new Error(`Unexpected attachment dependency: ${name}`);
    },
  });
  runInNewContext(compile("src/agent/attachment-history.ts"), {
    exports: attachmentHistory, ...globals,
    require: (name: string) => {
      if (name === "../shared/assets") return assets;
      if (name === "../shared/attachments") return attachments;
      if (name === "../shared/attachment-files") return attachmentFiles;
      throw new Error(`Unexpected attachment history dependency: ${name}`);
    },
  });
  return {
    "../shared/assets": assets,
    "../shared/asset-lifecycle": lifecycle,
    "./screenshot-history": history,
    "../agent/screenshot-history": history,
    "./attachment-history": attachmentHistory,
    "../shared/attachments": attachments,
    "../shared/attachment-files": attachmentFiles,
  };
}
