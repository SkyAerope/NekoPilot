import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import type { AgentEvent } from "../../src/agent/types";
import { screenshotModules } from "../helpers/screenshot-modules";

for (const provider of ["openai", "anthropic"] as const) {
  for (const outcome of ["done", "error", "abort"] as const) {
    test(`${provider} 流 ${outcome} 时恰好发送一次思考收尾事件`, async () => {
      const source = await readFile("src/agent/loop.ts", "utf8");
      const events: AgentEvent[] = [];
      let reads = 0;
      let signal: AbortSignal;
      const chunk =
        provider === "openai"
          ? { choices: [{ delta: { reasoning_content: "正在思考" } }] }
          : {
              type: "content_block_delta",
              delta: { type: "text_delta", text: "<think>正在思考" },
            };
      const runtime = { exports: {} as { AgentLoop: any } };
      const screenshots = screenshotModules();
      runInNewContext(
        ts.transpileModule(source, {
          compilerOptions: {
            module: ts.ModuleKind.CommonJS,
            target: ts.ScriptTarget.ES2022,
          },
        }).outputText,
        {
          exports: runtime.exports,
          require: (name: string) => {
            if (name in screenshots) return screenshots[name];
            if (name === "../tools/definitions") return { toolDefinitions: [] };
            if (name === "../tools/types") {
              return {
                toOpenAiFunction: (tool: unknown) => tool,
                toAnthropicTool: (tool: unknown) => tool,
              };
            }
            throw new Error(`Unexpected module: ${name}`);
          },
          AbortController,
          TextDecoder,
          fetch: async (_url: string, init: { signal: AbortSignal }) => {
            signal = init.signal;
            return {
              ok: true,
              body: {
                getReader: () => ({
                  read: async () => {
                    if (reads++ === 0) {
                      return {
                        done: false,
                        value: new TextEncoder().encode(
                          `data: ${JSON.stringify(chunk)}\n\n`,
                        ),
                      };
                    }
                    if (outcome === "abort") {
                      expect(signal.aborted).toBe(true);
                      throw new Error("AbortError");
                    }
                    if (outcome === "error") throw new Error("流读取失败");
                    return { done: true };
                  },
                }),
              },
            };
          },
        },
      );
      const loop = new runtime.exports.AgentLoop(
        {},
        {
          provider,
          baseUrl: "https://example.invalid",
          apiKey: "test-key",
          model: "test-model",
          enableScreenshotPruning: false,
        },
        (event: AgentEvent) => {
          events.push(event);
          if (
            outcome === "abort" &&
            ["thinking_delta", "message_delta"].includes(event.type)
          ) {
            loop.abort();
          }
        },
      );
      await loop.run([{ role: "user", content: "检查页面" }]);
      expect(
        events.filter((event) => event.type === "assistant_turn_done"),
      ).toHaveLength(1);
      expect(events.at(-1)?.type).toBe("done");
      const turnDoneIndex = events.findIndex(
        (event) => event.type === "assistant_turn_done",
      );
      const deltaIndex = events.findIndex((event) =>
        ["thinking_delta", "message_delta"].includes(event.type),
      );
      expect(deltaIndex).toBeGreaterThanOrEqual(0);
      expect(turnDoneIndex).toBeGreaterThan(deltaIndex);
      expect(events.some((event) => event.type === "error")).toBe(
        outcome === "error",
      );
    });
  }
}
