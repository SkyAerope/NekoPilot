import { QuickJSWASMModule, shouldInterruptAfterDeadline } from "quickjs-emscripten-core";
import ModuleLoader from "@jitl/quickjs-wasmfile-release-sync/emscripten-module";
import { QuickJSFFI } from "@jitl/quickjs-wasmfile-release-sync/ffi";

const DEFAULT_MEMORY_LIMIT_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_CODE_CHARS = 12_000;

export interface ExecuteJsOptions {
  timeoutMs: number;
  maxOutputChars: number;
  maxCodeChars?: number;
}

export interface ExecuteJsResult {
  result: unknown;
  logs: string[];
  truncated: boolean;
  timeoutMs: number;
}

interface SandboxedEnvelope {
  ok: boolean;
  result?: unknown;
  logs?: string[];
  truncated?: boolean;
  error?: string;
}

export class JsSandbox {
  private quickJsPromise?: Promise<QuickJSWASMModule>;

  async execute(
    code: string,
    description: string,
    options: ExecuteJsOptions,
  ): Promise<ExecuteJsResult> {
    const trimmed = code.trim();
    if (!trimmed) {
      throw new Error("code 不能为空");
    }
    if (!description.trim()) {
      throw new Error("description 不能为空");
    }

    const maxCodeChars = options.maxCodeChars ?? DEFAULT_MAX_CODE_CHARS;
    if (trimmed.length > maxCodeChars) {
      throw new Error(`code 过长：最多允许 ${maxCodeChars} 个字符`);
    }

    this.prepareQuickJsHostEnvironment();
    const quickJs = await this.getQuickJs();
    const deadline = Date.now() + Math.max(50, options.timeoutMs);

    let raw: unknown;
    try {
      raw = quickJs.evalCode(
        this.buildWrappedCode(trimmed, Math.max(256, options.maxOutputChars)),
        {
          shouldInterrupt: shouldInterruptAfterDeadline(deadline),
          memoryLimitBytes: DEFAULT_MEMORY_LIMIT_BYTES,
        },
      );
    } catch (err) {
      throw new Error(this.formatExecutionError(err, options.timeoutMs));
    }

    if (typeof raw !== "string") {
      throw new Error("沙箱返回了未知结果类型");
    }

    let envelope: SandboxedEnvelope;
    try {
      envelope = JSON.parse(raw) as SandboxedEnvelope;
    } catch (err) {
      throw new Error(`沙箱结果解析失败: ${String(err)}`);
    }

    if (!envelope.ok) {
      throw new Error(this.normalizeVmError(envelope.error || "脚本执行失败"));
    }

    return {
      result: envelope.result,
      logs: Array.isArray(envelope.logs) ? envelope.logs.map((entry) => String(entry)) : [],
      truncated: envelope.truncated === true,
      timeoutMs: Math.max(50, options.timeoutMs),
    };
  }

  private getQuickJs(): Promise<QuickJSWASMModule> {
    if (!this.quickJsPromise) {
      this.quickJsPromise = this.createQuickJsModule();
    }
    return this.quickJsPromise;
  }

  private async createQuickJsModule(): Promise<QuickJSWASMModule> {
    const module = await ModuleLoader();
    module.type = "sync";
    return new QuickJSWASMModule(module, new QuickJSFFI(module));
  }

  private prepareQuickJsHostEnvironment(): void {
    const host = globalThis as typeof globalThis & {
      window?: unknown;
      WorkerGlobalScope?: unknown;
    };

    // Chrome MV3 background runs in a ServiceWorkerGlobalScope. Some Emscripten
    // builds only probe `window` / `WorkerGlobalScope`; if both identifiers are
    // missing they may throw before user code runs. Vite's dynamic import
    // preload error path may also call `window.dispatchEvent` in a service
    // worker, so expose only the tiny EventTarget-like surface it needs here.
    // This host shim is not injected into the QuickJS VM sandbox.
    if (!("window" in host)) {
      Object.defineProperty(host, "window", {
        configurable: true,
        enumerable: false,
        value: {
          addEventListener: () => undefined,
          dispatchEvent: () => true,
          removeEventListener: () => undefined,
        },
        writable: true,
      });
    }
    if (!("WorkerGlobalScope" in host)) {
      Object.defineProperty(host, "WorkerGlobalScope", {
        configurable: true,
        enumerable: false,
        value: function WorkerGlobalScope() {},
        writable: true,
      });
    }
  }

  private formatExecutionError(err: unknown, timeoutMs: number): string {
    const message = this.describeHostError(err);
    if (/interrupted/i.test(message)) {
      return `执行超时（>${timeoutMs}ms）`;
    }
    return `沙箱执行失败: ${message}`;
  }

  private describeHostError(err: unknown): string {
    if (err instanceof Error) {
      return err.stack || err.message;
    }
    if (err && typeof err === "object") {
      const record = err as Record<string, unknown>;
      const name = typeof record.name === "string" ? record.name : "Error";
      const message = typeof record.message === "string" ? record.message : "";
      const stack = typeof record.stack === "string" ? record.stack : "";
      if (message || stack) {
        return `${name}${message ? `: ${message}` : ""}${stack ? `\n${stack}` : ""}`;
      }
      try {
        return JSON.stringify(record, null, 2);
      } catch {
        return Object.prototype.toString.call(err);
      }
    }
    return String(err);
  }

  private normalizeVmError(message: string): string {
    if (/\bwindow is not defined\b/i.test(message)) {
      return "脚本引用了 window，但 execute_js 运行在纯计算沙箱中，没有浏览器 window 对象";
    }
    if (/\bdocument is not defined\b/i.test(message)) {
      return "脚本引用了 document，但 execute_js 运行在纯计算沙箱中，没有 DOM";
    }
    if (/\bfetch is not defined\b/i.test(message)) {
      return "脚本引用了 fetch，但 execute_js 当前不提供网络访问能力";
    }
    if (/\bchrome is not defined\b/i.test(message)) {
      return "脚本引用了 chrome，但 execute_js 运行在纯计算沙箱中，没有扩展 API";
    }
    return message;
  }

  private buildWrappedCode(code: string, maxOutputChars: number): string {
    return [
      "(function () {",
      '  "use strict";',
      `  const __state = { remaining: ${maxOutputChars}, truncated: false };`,
      "  const __logs = [];",
      "  function __clip(text) {",
      "    const value = String(text);",
      "    if (__state.remaining <= 0) { __state.truncated = true; return ''; }",
      "    if (value.length <= __state.remaining) { __state.remaining -= value.length; return value; }",
      "    const clipped = value.slice(0, Math.max(0, __state.remaining));",
      "    __state.remaining = 0;",
      "    __state.truncated = true;",
      "    return clipped;",
      "  }",
      "  function __serialize(value, depth, seen) {",
      "    if (depth > 4) return '[MaxDepth]';",
      "    if (value === null || value === undefined) return value ?? null;",
      "    const type = typeof value;",
      "    if (type === 'string') return __clip(value);",
      "    if (type === 'number' || type === 'boolean') return value;",
      "    if (type === 'bigint') return __clip(String(value) + 'n');",
      "    if (type === 'symbol') return __clip(String(value));",
      "    if (type === 'function') return '[Function]';",
      "    if (Array.isArray(value)) return value.slice(0, 50).map((item) => __serialize(item, depth + 1, seen));",
      "    if (type === 'object') {",
      "      if (typeof value.then === 'function') throw new Error('execute_js 暂不支持 Promise/async 返回值');",
      "      if (seen.has(value)) return '[Circular]';",
      "      seen.add(value);",
      "      const out = {};",
      "      for (const [key, entry] of Object.entries(value).slice(0, 50)) {",
      "        out[__clip(key)] = __serialize(entry, depth + 1, seen);",
      "      }",
      "      seen.delete(value);",
      "      return out;",
      "    }",
      "    return __clip(String(value));",
      "  }",
      "  function __log(level, args) {",
      "    if (__logs.length >= 50) { __state.truncated = true; return; }",
      "    const rendered = args.map((arg) => {",
      "      try { return JSON.stringify(__serialize(arg, 0, new WeakSet())); }",
      "      catch (err) { return JSON.stringify(__clip(String(err))); }",
      "    }).join(' ');",
      "    __logs.push(__clip('[' + level + '] ' + rendered));",
      "  }",
      "  const console = {",
      "    log: (...args) => __log('log', args),",
      "    info: (...args) => __log('info', args),",
      "    warn: (...args) => __log('warn', args),",
      "    error: (...args) => __log('error', args),",
      "  };",
      "  try {",
      "    const __result = (function () {",
      code,
      "    })();",
      "    return JSON.stringify({",
      "      ok: true,",
      "      result: __serialize(__result, 0, new WeakSet()),",
      "      logs: __logs,",
      "      truncated: __state.truncated,",
      "    });",
      "  } catch (err) {",
      "    let message = String(err);",
      "    if (err && typeof err === 'object') {",
      "      const name = 'name' in err ? String(err.name) : 'Error';",
      "      const detail = 'message' in err ? String(err.message) : message;",
      "      const stack = 'stack' in err && err.stack ? String(err.stack) : '';",
      "      message = stack ? name + ': ' + detail + '\\n' + stack : name + ': ' + detail;",
      "    }",
      "    return JSON.stringify({ ok: false, error: __clip(message), logs: __logs, truncated: __state.truncated });",
      "  }",
      "})()",
    ].join("\n");
  }
}