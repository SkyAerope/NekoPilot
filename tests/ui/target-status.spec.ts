import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import ts from "typescript";
import { screenshotModules } from "../helpers/screenshot-modules";

// 执行真实后台消息处理，只替换浏览器接口、CDP 和模型请求。
async function createBackground() {
  const source = await readFile("src/background/index.ts", "utf8");
  const notifications: {
    agentBusy: boolean;
    targetChanging: boolean;
    pickerBusy: boolean;
  }[] = [];
  let failAttach = false;
  let finishRun: ((failed?: boolean) => void) | undefined;
  const tab = {
    id: 1,
    title: "示例页面",
    url: "https://example.invalid",
    windowId: 1,
  };
  const storage: Record<string, unknown> = {};
  class CdpManager {
    async attach() {
      if (failAttach) throw new Error("连接失败");
    }
    async detach() {}
    async send() {
      return { result: { value: null } };
    }
  }
  class ToolExecutor {
    resetShortRefs() {}
    configureShortRefs() {}
    configureScreenshotScaling() {}
    configureCodeExecution() {}
    async removeClickMarker() {}
  }
  class AgentLoop {
    run(messages: unknown[]) {
      return new Promise((resolve, reject) => {
        finishRun = (failed = false) =>
          failed
            ? reject(new Error("模型失败"))
            : resolve({ text: "完成", messages });
      });
    }
    abort() {
      finishRun?.();
    }
  }
  const runtime = {} as {
    handleMessage: (message: {
      type: string;
      payload?: unknown;
    }) => Promise<unknown>;
    snapshot: () => (typeof notifications)[number];
  };
  const chrome = {
    storage: {
      session: {
        get: async () => storage,
        set: async (values: Record<string, unknown>) => {
          Object.assign(storage, values);
        },
        remove: async (keys: string[]) => {
          for (const key of keys) delete storage[key];
        },
      },
    },
    action: { onClicked: { addListener() {} } },
    runtime: {
      onMessage: { addListener() {} },
      sendMessage: async (message: { type: string }) => {
        if (message.type === "target:changed")
          notifications.push(runtime.snapshot());
      },
    },
    tabs: {
      query: async () => [tab],
      get: async () => tab,
      update: async () => tab,
    },
    windows: { update: async () => ({}) },
  };
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  const screenshots = screenshotModules();
  vm.runInNewContext(
    `${compiled}\nexports.handleMessage = handleMessage;\nexports.snapshot = () => ({ agentBusy, targetChanging, pickerBusy });`,
    {
      exports: runtime,
      require: (name: string) => screenshots[name] ?? ({
        CdpManager,
        ToolExecutor,
        AgentLoop,
        prependPageContext: (message: string) => message,
      }),
      chrome,
      __DEV_RELOAD__: false,
      queueMicrotask,
      setTimeout,
      console: { error() {} },
    },
  );
  return {
    runtime,
    notifications,
    failAttach: () => {
      failAttach = true;
    },
    finish: (failed = false) => finishRun?.(failed),
    ready: () => Boolean(finishRun),
  };
}

for (const outcome of ["完成", "失败", "停止"]) {
  test(`后台在任务${outcome}清理后通知空闲状态`, async () => {
    const background = await createBackground();
    const request = background.runtime.handleMessage({
      type: "agent:start",
      payload: { userMessage: "测试", config: {} },
    });
    // 立即挂接异常处理，避免模拟失败产生未处理的 Promise 拒绝。
    const settled = request.catch(() => undefined);
    await expect.poll(background.ready).toBe(true);
    expect(background.notifications.some((state) => state.agentBusy)).toBe(
      true,
    );
    if (outcome === "停止")
      await background.runtime.handleMessage({ type: "agent:stop" });
    else background.finish(outcome === "失败");
    await settled;
    expect(background.notifications.at(-1)?.agentBusy).toBe(false);
  });
}

for (const operation of ["target:switch", "agent:reset", "pick:start"]) {
  test(`后台${operation}异常或结束后仍通知状态恢复`, async () => {
    const background = await createBackground();
    if (operation !== "agent:reset") background.failAttach();
    await background.runtime
      .handleMessage({ type: operation, payload: { tabId: 1 } })
      .catch(() => undefined);
    const field = operation === "pick:start" ? "pickerBusy" : "targetChanging";
    expect(background.notifications.some((state) => state[field])).toBe(true);
    expect(background.notifications.at(-1)?.[field]).toBe(false);
  });
}
