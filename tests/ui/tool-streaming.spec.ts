import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import type { AgentEvent, ChatMessage } from "../../src/agent/types";
import { emit, installHarness } from "../helpers/harness";
import { screenshotModules } from "../helpers/screenshot-modules";

function startAgent(provider: "openai" | "anthropic", permissionMode = "auto") {
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start: (controller) => { stream = controller; } });
  const events: AgentEvent[] = [];
  const requests: ChatMessage[][] = [];
  const executed: string[] = [];
  const encoder = new TextEncoder();
  const runtime = { exports: {} as { AgentLoop: typeof import("../../src/agent/loop").AgentLoop } };
  const modules = {
    ...screenshotModules(),
    "../tools/definitions": { toolDefinitions: [] },
    "../tools/types": { toOpenAiFunction: (tool: unknown) => tool, toAnthropicTool: (tool: unknown) => tool },
  } as Record<string, unknown>;
  runInNewContext(
    ts.transpileModule(readFileSync("src/agent/loop.ts", "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText,
    {
      exports: runtime.exports,
      require: (name: string) => {
        if (name in modules) return modules[name];
        throw new Error(`Unexpected module: ${name}`);
      },
      AbortController,
      TextDecoder,
      fetch: async (_url: string, init: { body: string }) => {
        requests.push(JSON.parse(init.body).messages);
        return new Response(requests.length === 1 ? body : "");
      },
    },
  );
  const agent = new runtime.exports.AgentLoop(
    {
      execute: async (_name: string, args: { label: string }) => {
        executed.push(args.label);
        return { success: true, data: args.label };
      },
    } as ConstructorParameters<typeof runtime.exports.AgentLoop>[0],
    {
      provider, baseUrl: "https://example.invalid", model: "test-model", apiKey: "test-key",
      permissionMode, enableScreenshotPruning: false,
    } as ConstructorParameters<typeof runtime.exports.AgentLoop>[1],
    (event) => events.push(event),
  );
  return {
    agent, events, requests, executed,
    result: agent.run([{ role: "user", content: "Run stream test" }]),
    write: (event: object) => stream.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`)),
    end: () => stream.close(),
  };
}

function openAiTool(index: number, args: string, name?: string) {
  return { choices: [{ delta: { tool_calls: [{
    index, id: name && `call-${index}`, function: { name, arguments: args },
  }] } }] };
}

test("OpenAI 分片交错时等待队首完整，授权期间仍读取后续工具", async () => {
  const run = startAgent("openai", "ask");
  run.write(openAiTool(0, '{"label":"', "first"));
  run.write(openAiTool(1, '{"label":"B"}', "second"));
  run.write(openAiTool(2, '{"label":"C"}', "third"));
  await expect.poll(() => run.events.filter((event) => event.type === "tool_call_streaming").length).toBe(3);
  expect(run.events.filter((event) => event.type === "tool_call")).toHaveLength(0);
  run.write(openAiTool(0, 'A"}'));
  const approvals = () => run.events.filter((event) =>
    event.type === "tool_call" && (event.data as { needsPermission: boolean }).needsPermission,
  ).map((event) => (event.data as { id: string }).id);
  await expect.poll(approvals).toEqual(["call-0"]);
  run.agent.resolvePermission(true, "call-1");
  expect(run.executed).toEqual([]);
  run.agent.resolvePermission(true, "call-0");
  await expect.poll(approvals).toEqual(["call-0", "call-1"]);
  expect(run.executed).toEqual(["A"]);
  run.agent.resolvePermission(true, "call-1");
  await expect.poll(() => run.executed).toEqual(["A", "B"]);
  expect(approvals()).toHaveLength(2);
  run.write({ choices: [{ delta: {}, finish_reason: "tool_calls" }] });
  run.end();
  await expect.poll(approvals).toEqual(["call-0", "call-1", "call-2"]);
  run.agent.resolvePermission(true, "call-2");
  await run.result;
  expect(run.executed).toEqual(["A", "B", "C"]);
  expect(run.requests[1].slice(-4).map((message) => message.role)).toEqual(["assistant", "tool", "tool", "tool"]);
});

test("OpenAI 截断时保留已执行调用及其结果", async () => {
  const run = startAgent("openai");
  run.write(openAiTool(0, '{"label":"A"}', "first"));
  run.write(openAiTool(1, '{"label":"', "second"));
  await expect.poll(() => run.executed).toEqual(["A"]);
  run.write({ choices: [{ finish_reason: "length" }] });
  run.end();
  const result = await run.result;
  expect(result.text).toContain("length");
  expect(run.requests).toHaveLength(1);
  expect(result.messages.at(-2)?.tool_calls?.map((call) => call.id)).toEqual(["call-0"]);
  expect(result.messages.at(-1)?.tool_call_id).toBe("call-0");
});

test("OpenAI 流断开时结束当前授权并取消后续工具", async () => {
  const run = startAgent("openai", "ask");
  run.write(openAiTool(0, '{"label":"A"}', "first"));
  run.write(openAiTool(1, '{"label":"B"}', "second"));
  run.write(openAiTool(2, '{"label":"C"}', "third"));
  await expect.poll(() => run.events.some((event) =>
    event.type === "tool_call" && (event.data as { needsPermission: boolean }).needsPermission,
  )).toBe(true);
  run.end();
  const result = await run.result;
  expect(result.text).toContain("连接中断");
  expect(run.executed).toEqual([]);
  expect(result.messages.at(-2)?.tool_calls?.map((call) => call.id)).toEqual(["call-0"]);
  expect(result.messages.at(-1)?.tool_call_id).toBe("call-0");
});

test("Anthropic 工具块结束后即可执行，等待消息结束再请求下一轮", async () => {
  const run = startAgent("anthropic");
  run.write({ type: "content_block_start", index: 0, content_block: {
    type: "tool_use", id: "call-a", name: "first", input: {},
  } });
  run.write({ type: "content_block_delta", index: 0, delta: {
    type: "input_json_delta", partial_json: '{"label":"A"}',
  } });
  run.write({ type: "content_block_stop", index: 0 });
  await expect.poll(() => run.executed).toEqual(["A"]);
  expect(run.requests).toHaveLength(1);
  run.write({ type: "message_delta", delta: { stop_reason: "tool_use" } });
  run.write({ type: "message_stop" });
  run.end();
  await run.result;
  expect(run.requests).toHaveLength(2);
});

test("侧栏在同一张卡片更新参数、排队、授权和结果", async ({ page }) => {
  await installHarness(page);
  await page.goto("/sidepanel.html");
  const first = { id: "call-a", name: "click", args: '{"selector":' };
  const second = { id: "call-b", name: "wait", args: '{"ms":100}' };
  const clickCard = page.getByRole("button", { name: /点击/ });
  await emit(page, "tool_call_streaming", { ...first, stage: "generating" });
  await expect(clickCard).toContainText("生成参数");
  await emit(page, "tool_call_streaming", { ...first, args: '{"selector":"#submit"}', stage: "queued" });
  await emit(page, "tool_call_streaming", { ...second, stage: "queued" });
  await expect(clickCard).toContainText("#submit");
  await expect(page.getByText("排队中")).toHaveCount(2);
  await emit(page, "tool_call", { ...first, args: '{"selector":"#submit"}', needsPermission: true });
  await expect(page.getByRole("button", { name: "允许" })).toBeVisible();
  await expect(clickCard).toHaveCount(1);
  await emit(page, "tool_result", { ...first, result: { success: true, data: "done" } });
  await expect(page.getByRole("button", { name: "允许" })).toBeHidden();
  await emit(page, "done", "");
  await expect(page.getByText("排队中")).toHaveCount(0);
});
