import { expect, test } from "@playwright/test";
import { installHarness } from "../helpers/harness";

const chatLogs = [
  { id: 1, type: "user", content: "第一轮任务", timestamp: 1 },
  { id: 2, type: "assistant", content: "第一轮回复", timestamp: 2 },
  {
    id: 3,
    type: "user",
    content: "原始任务\n[附件: notes.txt]",
    attachmentNames: ["notes.txt"],
    pickedElements: [
      {
        id: 10,
        tag: "button",
        selector: "#submit",
        text: "提交",
        rect: { x: 10, y: 20, w: 30, h: 40 },
      },
    ],
    timestamp: 3,
  },
  { id: 4, type: "assistant", content: "原始回复", timestamp: 4 },
  { id: 5, type: "user", content: "后续任务", timestamp: 5 },
];

test("气泡原地编辑，取消和 Esc 保留对话与底部草稿", async ({ page }) => {
  await installHarness(page, { chatLogs });
  await page.goto("/sidepanel.html");
  const composer = page.getByRole("textbox", { name: "任务内容", exact: true });
  await composer.fill("底部草稿");
  await page.getByRole("button", { name: "编辑", exact: true }).nth(1).click();
  const editor = page.getByRole("textbox", { name: "编辑消息内容" });
  await expect(editor).toHaveValue("原始任务");
  await expect(editor).toBeFocused();
  await expect(composer).toHaveValue("底部草稿");
  await expect(page.getByText("原始回复", { exact: true })).toBeVisible();
  await editor.fill("未提交的修改");
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await expect(editor).toHaveCount(0);
  await expect(page.getByText("原始任务", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "编辑", exact: true }).nth(1).click();
  await editor.press("Escape");
  expect(
    await page.evaluate(() =>
      window.__harness.messages.filter(({ type }) =>
        ["agent:reset", "agent:truncateBeforeUserTurn", "agent:start"].includes(
          type,
        ),
      ),
    ),
  ).toEqual([]);
});

test("保存编辑回滚到对应轮次，保留此前对话、附件、元素引用和底部草稿", async ({
  page,
}) => {
  await installHarness(page, { chatLogs });
  await page.setViewportSize({ width: 320, height: 800 });
  await page.goto("/sidepanel.html");
  const composer = page.getByRole("textbox", { name: "任务内容", exact: true });
  await composer.fill("底部草稿");
  await page.getByRole("button", { name: "编辑", exact: true }).nth(1).click();
  const editor = page.getByRole("textbox", { name: "编辑消息内容" });
  await editor.fill("修改后的任务\n第二行");
  await expect(page.getByText("notes.txt", { exact: true })).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.getByRole("button", { name: "保存并重新发送" }).click();
  await expect(editor).toHaveCount(0);
  await expect(page.getByText("第一轮回复", { exact: true })).toBeVisible();
  await expect(page.getByText("原始回复", { exact: true })).toHaveCount(0);
  await expect(page.getByText("后续任务", { exact: true })).toHaveCount(0);
  await expect(composer).toHaveValue("底部草稿");
  await expect(page.getByText("notes.txt", { exact: true })).toBeVisible();
  const messages = await page.evaluate(() => window.__harness.messages);
  expect(
    messages.find(({ type }) => type === "agent:truncateBeforeUserTurn")
      ?.payload?.turnIndex,
  ).toBe(1);
  expect(
    messages.find(({ type }) => type === "agent:start")?.payload?.userMessage,
  ).toBe(
    '修改后的任务\n第二行\n[元素: <button> selector="#submit" text="提交" rect=(10,20,30x40) center=(25,40)]',
  );
  expect(messages.some(({ type }) => type === "agent:reset")).toBe(false);
});

test("空文本不可保存，Enter 换行，Ctrl+Enter 提交", async ({ page }) => {
  await installHarness(page, { chatLogs: chatLogs.slice(0, 2) });
  await page.goto("/sidepanel.html");
  await page.getByRole("button", { name: "编辑", exact: true }).click();
  const editor = page.getByRole("textbox", { name: "编辑消息内容" });
  await editor.fill("   ");
  await expect(
    page.getByRole("button", { name: "保存并重新发送" }),
  ).toBeDisabled();
  await editor.fill("新任务");
  await editor.press("End");
  await editor.press("Enter");
  await expect(editor).toHaveValue("新任务\n");
  await editor.press("Control+Enter");
  await expect(editor).toHaveCount(0);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          window.__harness.messages.filter(({ type }) => type === "agent:start")
            .length,
      ),
    )
    .toBe(1);
});

test("缺少 API Key 时保留编辑草稿和原有回复", async ({ page }) => {
  await installHarness(page, { chatLogs, settings: {} });
  await page.goto("/sidepanel.html");
  await page.getByRole("button", { name: "编辑", exact: true }).nth(1).click();
  const editor = page.getByRole("textbox", { name: "编辑消息内容" });
  await editor.fill("修改草稿");
  await page.getByRole("button", { name: "保存并重新发送" }).click();
  await expect(
    page.getByText("请先配置 API Key", { exact: true }),
  ).toBeVisible();
  await expect(editor).toHaveValue("修改草稿");
  await expect(page.getByText("原始回复", { exact: true })).toBeVisible();
  expect(
    await page.evaluate(() =>
      window.__harness.messages.some(
        ({ type }) => type === "agent:truncateBeforeUserTurn",
      ),
    ),
  ).toBe(false);
});
