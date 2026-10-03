import { expect, test, type Page } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";
import type { TargetTab } from "../../src/shared/target-tab";
import { emit, installHarness, screenshotData } from "../helpers/harness";

async function expectNoOverflow(page: Page) {
  await expect
    .poll(() =>
      page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    )
    .toBe(true);
}

test("输入区显示图标操作与标签页纸片，窄侧栏不溢出", async ({ page }) => {
  await installHarness(page, {
    autoMode: true,
    targetStatus: {
      target: {
        id: 1,
        title: "这是一个很长的操作标签页标题，用来检查单行截断和窄侧栏布局",
        url: "https://example.invalid",
        favIconUrl: screenshotData.replace(/^/, "data:image/png;base64,"),
      },
      active: {
        id: 1,
        title: "这是一个很长的操作标签页标题，用来检查单行截断和窄侧栏布局",
        url: "https://example.invalid",
      },
      missing: false,
      busy: false,
    },
  });
  await page.setViewportSize({ width: 320, height: 600 });
  await page.goto("/sidepanel.html");
  const mode = page.getByRole("button", { name: "自动模式", exact: true });
  await expect(mode).toHaveText("");
  await mode.hover();
  await expect(page.getByRole("tooltip")).toBeVisible();
  await mode.click();
  const automatic = page.getByRole("menuitemradio", { name: "自动执行" });
  const ask = page.getByRole("menuitemradio", { name: "需要审批" });
  await expect(automatic).toHaveAttribute("aria-checked", "true");
  await expect(ask).toHaveAttribute("aria-checked", "false");
  await ask.click();
  await expect
    .poll(() => page.evaluate(() => window.__harness.storage.autoMode))
    .toBe(false);
  const askMode = page.getByRole("button", { name: "询问模式", exact: true });
  await askMode.click();
  await expect(ask).toHaveAttribute("aria-checked", "true");
  await expect(automatic).toHaveAttribute("aria-checked", "false");
  await automatic.click();
  await expect
    .poll(() => page.evaluate(() => window.__harness.storage.autoMode))
    .toBe(true);
  await expect(mode).toBeVisible();
  await expect(page.getByRole("menuitemradio")).toHaveCount(0);
  const chip = page.getByRole("button", { name: "操作标签页", exact: true });
  await expect(chip.locator("img")).toBeVisible();
  expect(
    await chip
      .locator("span.truncate")
      .evaluate((element) => element.scrollWidth > element.clientWidth),
  ).toBe(true);
  const create = await page
    .getByRole("button", { name: "新建对话" })
    .boundingBox();
  const modeBox = await mode.boundingBox();
  const picker = await page
    .getByRole("button", { name: "选择页面元素" })
    .boundingBox();
  const settings = await page
    .getByRole("button", { name: "设置", exact: true })
    .boundingBox();
  expect(create!.x).toBeLessThan(modeBox!.x);
  expect(modeBox!.x).toBeLessThan(picker!.x);
  expect(settings!.y).toBeGreaterThan(picker!.y);
  await chip.click();
  await expect(page.getByRole("option")).toHaveAttribute(
    "data-target-selected",
    "true",
  );
  await page.keyboard.press("Escape");
  await expect(page.getByRole("option")).toHaveCount(0);
  await expectNoOverflow(page);
});

test("旧后台提示重新加载，恢复状态后自动清除提示", async ({ page }) => {
  await installHarness(page, {
    statusError: "Error: Unknown message type: target:status",
  });
  await page.goto("/sidepanel.html");
  await expect(page.getByRole("alert")).toContainText(
    "扩展后台仍是旧版本，请重新加载扩展。",
  );
  await expect(
    page.getByText("Error: Error: Unknown message type: target:status"),
  ).toHaveCount(0);
  await page.getByRole("textbox", { name: "任务内容" }).fill("执行任务");
  await expect(
    page.getByRole("button", { name: "发送消息", exact: true }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "重新加载扩展", exact: true }).click();
  expect(await page.evaluate(() => window.__harness.reloadCount)).toBe(1);
  await page.evaluate(() => {
    window.__harness.statusError = undefined;
    window.__harness.notifyTargetChanged();
  });
  await expect(
    page.getByRole("button", { name: "操作标签页", exact: true }),
  ).toHaveText("示例页面");
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "发送消息", exact: true }),
  ).toBeEnabled();
});

test("操作目标依赖状态通知刷新，空闲时不轮询，任务清理后恢复按钮", async ({
  page,
}) => {
  await installHarness(page);
  await page.goto("/sidepanel.html");
  const chip = page.getByRole("button", { name: "操作标签页", exact: true });
  const send = page.getByRole("button", { name: "发送消息", exact: true });
  await expect(chip).toHaveText("示例页面");
  await page.getByRole("textbox", { name: "任务内容" }).fill("执行任务");
  const count = () =>
    page.evaluate(
      () =>
        window.__harness.messages.filter(
          (message) => message.type === "target:status",
        ).length,
    );
  const initialCount = await count();
  await page.waitForTimeout(1200);
  expect(await count()).toBe(initialCount);
  await page.evaluate(() => {
    window.__harness.targetStatus.busy = true;
    window.__harness.notifyTargetChanged();
  });
  await expect(send).toBeDisabled();
  await page.evaluate(() => {
    window.__harness.emit({ type: "done", data: "" });
  });
  await expect(send).toBeDisabled();
  await page.evaluate(() => {
    window.__harness.targetStatus.busy = false;
    window.__harness.targetStatus.target!.title = "更新后的操作页";
    window.__harness.notifyTargetChanged();
  });
  await expect(chip).toHaveText("更新后的操作页");
  await expect(send).toBeEnabled();
});

test("状态查询期间的新通知丢弃旧响应，并合并重复通知", async ({ page }) => {
  await installHarness(page);
  await page.goto("/sidepanel.html");
  const chip = page.getByRole("button", { name: "操作标签页", exact: true });
  await expect(chip).toHaveText("示例页面");
  const initialCount = await page.evaluate(
    () =>
      window.__harness.messages.filter(
        (message) => message.type === "target:status",
      ).length,
  );
  await page.evaluate(() => {
    window.__harness.statusDelay = 250;
    window.__harness.targetStatus.target!.title = "过期页面";
    window.__harness.notifyTargetChanged();
  });
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          window.__harness.messages.filter(
            (message) => message.type === "target:status",
          ).length,
      ),
    )
    .toBe(initialCount + 1);
  await page.evaluate(() => {
    window.__harness.statusDelay = 0;
    window.__harness.targetStatus.target!.title = "最新页面";
    for (let index = 0; index < 5; index++)
      window.__harness.notifyTargetChanged();
    const records: string[] = [];
    new MutationObserver(() =>
      records.push(
        document.querySelector('[aria-label="操作标签页"]')?.textContent || "",
      ),
    ).observe(document.body, {
      subtree: true,
      childList: true,
      characterData: true,
    });
    Object.assign(window, { statusTitles: records });
  });
  await expect(chip).toHaveText("最新页面");
  expect(
    await page.evaluate(
      () =>
        window.__harness.messages.filter(
          (message) => message.type === "target:status",
        ).length,
    ),
  ).toBe(initialCount + 2);
  expect(
    await page.evaluate(
      () => (window as unknown as { statusTitles: string[] }).statusTitles,
    ),
  ).not.toContain("过期页面");
});

test("临时状态查询失败支持重试和恢复可见时刷新", async ({ page }) => {
  await installHarness(page, { statusError: "临时连接失败" });
  await page.goto("/sidepanel.html");
  await expect(page.getByRole("alert")).toContainText("临时连接失败");
  await page.evaluate(() => {
    window.__harness.statusError = undefined;
  });
  await page.getByRole("button", { name: "重试", exact: true }).click();
  const chip = page.getByRole("button", { name: "操作标签页", exact: true });
  await expect(chip).toHaveText("示例页面");
  await expect(page.getByRole("alert")).toHaveCount(0);
  await page.evaluate(() => {
    window.__harness.targetStatus.target!.title = "恢复后的页面";
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect(chip).toHaveText("恢复后的页面");
});

test("后台重置通知只查询状态，不因旧聊天记录重新固定操作目标", async ({
  page,
}) => {
  await installHarness(page, {
    chatLogs: [{ id: 1, type: "user", content: "旧任务", timestamp: 1 }],
  });
  await page.goto("/sidepanel.html");
  await expect(
    page.getByRole("button", { name: "操作标签页", exact: true }),
  ).toHaveText("示例页面");
  await page.evaluate(() => {
    window.__harness.messages.length = 0;
    window.__harness.notifyTargetChanged();
  });
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          window.__harness.messages.filter(
            (message) => message.type === "target:status",
          ).length,
      ),
    )
    .toBe(1);
  expect(
    await page.evaluate(
      () =>
        window.__harness.messages.find(
          (message) => message.type === "target:status",
        )?.payload?.hasMessages,
    ),
  ).toBe(false);
});

test("用户气泡下方保存标签页纸片，图标加载时占位，切换与恢复不改旧纸片", async ({
  page,
}) => {
  const tabs: TargetTab[] = [
    {
      id: 1,
      title: "原页面 A",
      url: "https://example.invalid/a",
      favIconUrl: "https://example.invalid/tab-icon.png",
    },
    { id: 2, title: "新页面 B", url: "https://example.invalid/b" },
  ];
  let releaseIcon!: () => void;
  const iconReady = new Promise<void>((resolve) => {
    releaseIcon = resolve;
  });
  const icon = await readFile("dist/icons/icon-16.png");
  await page.route("https://example.invalid/tab-icon.png", async (route) => {
    await iconReady;
    await route.fulfill({ contentType: "image/png", body: icon });
  });
  await installHarness(page, {
    tabs,
    targetStatus: {
      target: tabs[0],
      active: tabs[0],
      missing: false,
      busy: false,
    },
  });
  await page.setViewportSize({ width: 320, height: 640 });
  await page.goto("/sidepanel.html", { waitUntil: "domcontentloaded" });
  await page.getByRole("textbox", { name: "任务内容" }).fill("检查页面 A");
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  const papers = page.locator('[data-slot="message-target-tab"]');
  await expect(papers).toHaveText(["原页面 A"]);
  await expect(papers.first().locator(".lucide-link")).toBeVisible();
  const bubble = page.locator(".is-user > div").first();
  await expect(bubble).toHaveText("检查页面 A");
  expect(await bubble.locator('[data-slot="message-target-tab"]').count()).toBe(
    0,
  );
  const bubbleBox = await bubble.boundingBox();
  const paperBox = await papers.first().boundingBox();
  expect(paperBox!.y).toBeGreaterThanOrEqual(bubbleBox!.y + bubbleBox!.height);
  releaseIcon();
  await expect(papers.first().locator(".lucide-link")).toHaveCount(0);
  await expect(papers.first().locator("img")).toBeVisible();
  await emit(page, "done", "");
  await page.getByRole("button", { name: "操作标签页", exact: true }).click();
  await page.getByRole("option", { name: "新页面 B", exact: true }).click();
  await expect(papers).toHaveText(["原页面 A"]);
  await page.getByRole("textbox", { name: "任务内容" }).fill("检查页面 B");
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  await expect(papers).toHaveText(["原页面 A", "新页面 B"]);
  await expect(papers.last().locator(".lucide-link")).toBeVisible();
  await expectNoOverflow(page);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window.__harness.storage.chatLogs as
              { targetTab?: TargetTab }[] | undefined
          )?.filter((entry) => entry.targetTab).length,
      ),
    )
    .toBe(2);
  const saved = await page.evaluate(() => window.__harness.storage.chatLogs);
  const reopened = await page.context().newPage();
  await installHarness(reopened, { chatLogs: saved });
  await reopened.goto("/sidepanel.html");
  await expect(reopened.locator('[data-slot="message-target-tab"]')).toHaveText(
    ["原页面 A", "新页面 B"],
  );
  await reopened.close();
});

test("后台绑定修正气泡页面快照，失败图标显示链接占位", async ({ page }) => {
  await page.route("https://example.invalid/missing-icon.png", (route) =>
    route.fulfill({ status: 404 }),
  );
  await installHarness(page);
  await page.goto("/sidepanel.html");
  await page.getByRole("textbox", { name: "任务内容" }).fill("检查实际页面");
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  await page.evaluate(() => {
    const messageId = window.__harness.messages.find(
      (message) => message.type === "agent:start",
    )!.payload!.messageId as number;
    window.__harness.bindTarget(messageId, {
      id: 3,
      title: "实际连接页面",
      url: "https://example.invalid/actual",
      favIconUrl: "https://example.invalid/missing-icon.png",
    });
  });
  const paper = page.locator('[data-slot="message-target-tab"]');
  await expect(paper).toHaveText("实际连接页面");
  await expect(paper.locator("img")).toHaveCount(0);
  await expect(paper.locator(".lucide-link")).toBeVisible();
});

test("连续消息只在首条和切页后的首条显示纸片，旧历史也按此规则恢复", async ({
  page,
}) => {
  const tabs: TargetTab[] = [
    { id: 1, title: "页面 A", url: "https://example.invalid/a" },
    { id: 2, title: "页面 B", url: "https://example.invalid/b" },
  ];
  await installHarness(page, {
    tabs,
    targetStatus: {
      target: tabs[0],
      active: tabs[0],
      missing: false,
      busy: false,
    },
  });
  await page.goto("/sidepanel.html");
  const send = async (text: string) => {
    await page.getByRole("textbox", { name: "任务内容" }).fill(text);
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    await emit(page, "done", "");
  };
  const papers = page.locator('[data-slot="message-target-tab"]');
  await send("第一条");
  await expect(papers).toHaveText(["页面 A"]);
  await send("第二条");
  await expect(papers).toHaveText(["页面 A"]);
  await page.getByRole("button", { name: "操作标签页", exact: true }).click();
  await page.getByRole("option", { name: "页面 B", exact: true }).click();
  await send("切换后第一条");
  await expect(papers).toHaveText(["页面 A", "页面 B"]);
  await send("切换后第二条");
  await expect(papers).toHaveText(["页面 A", "页面 B"]);
  const reopened = await page.context().newPage();
  await installHarness(reopened, {
    chatLogs: [0, 1, 2, 3].map((index) => ({
      id: index + 1,
      type: "user",
      content: `历史消息 ${index}`,
      timestamp: index,
      targetTab: tabs[index < 2 ? 0 : 1],
    })),
  });
  await reopened.goto("/sidepanel.html");
  await expect(reopened.locator('[data-slot="message-target-tab"]')).toHaveText(
    ["页面 A", "页面 B"],
  );
  await reopened.close();
});

test("标签页菜单置顶目标、显示四个最近页，并按标题链接搜索全部标签页", async ({
  page,
}) => {
  const tabs: TargetTab[] = Array.from({ length: 7 }, (_, index) => ({
    id: index + 1,
    title: index === 0 ? "当前操作页" : `页面 ${index + 1}`,
    url: `https://example.invalid/tab-${index + 1}/${"long-path/".repeat(8)}`,
    lastAccessed: index * 100,
  }));
  await installHarness(page, {
    tabs,
    targetStatus: {
      target: tabs[0],
      active: tabs[0],
      busy: false,
      missing: false,
    },
  });
  await page.setViewportSize({ width: 320, height: 600 });
  await page.goto("/sidepanel.html");
  expect(
    await page.evaluate(
      () =>
        window.__harness.messages.filter(
          (message) => message.type === "target:list",
        ).length,
    ),
  ).toBe(0);
  await page.getByRole("button", { name: "操作标签页", exact: true }).click();
  const options = page.getByRole("option");
  await expect(options).toHaveCount(5);
  expect(
    await options.evaluateAll((elements) =>
      elements.map((element) => element.getAttribute("aria-label")),
    ),
  ).toEqual(["当前操作页", "页面 7", "页面 6", "页面 5", "页面 4"]);
  await expect(
    options.first().locator('[data-slot="target-check"]'),
  ).toBeVisible();
  await expect(
    options.nth(1).locator('[data-slot="target-check"]'),
  ).toHaveCount(0);
  expect(
    await options
      .first()
      .locator("p")
      .evaluate((element) => element.scrollWidth > element.clientWidth),
  ).toBe(true);
  await expectNoOverflow(page);
  const search = page.getByRole("combobox", { name: "搜索标签页" });
  await expect(search).toBeFocused();
  await search.fill("页面 2");
  await expect(options).toHaveCount(1);
  await expect(options).toHaveAttribute("aria-label", "页面 2");
  await search.fill("TAB-3");
  await expect(options).toHaveCount(1);
  await expect(options).toHaveAttribute("aria-label", "页面 3");
  await search.fill("不存在的页面");
  await expect(page.getByText("没有匹配的标签页")).toBeVisible();
  await search.fill("tab-2/");
  await search.press("ArrowDown");
  await search.press("Enter");
  await expect(
    page.getByRole("button", { name: "操作标签页", exact: true }),
  ).toHaveText("页面 2");
  expect(
    await page.evaluate(
      () =>
        window.__harness.messages.filter(
          (message) => message.type === "target:list",
        ).length,
    ),
  ).toBe(1);
});

test("标签页菜单刷新时不闪现加载提示或改变高度，搜索长列表仍可滚动", async ({
  page,
}) => {
  const tabs: TargetTab[] = Array.from({ length: 12 }, (_, index) => ({
    id: index + 1,
    title: `页面 ${index + 1}`,
    url: `https://example.invalid/tab-${index + 1}`,
    lastAccessed: index * 100,
  }));
  await installHarness(page, {
    tabs,
    tabListDelay: 300,
    targetStatus: {
      target: tabs[0],
      active: tabs[0],
      busy: false,
      missing: false,
    },
  });
  await page.setViewportSize({ width: 320, height: 600 });
  await page.goto("/sidepanel.html");
  const chip = page.getByRole("button", { name: "操作标签页", exact: true });
  const list = page.locator('[data-slot="command-list"]');
  const menu = page.getByRole("dialog", { name: "选择操作标签页" });
  const overflow = () =>
    list.evaluate((element) => ({
      height: element.clientHeight,
      contentHeight: element.scrollHeight,
      overflowing: element.scrollHeight > element.clientHeight,
    }));
  await chip.click();
  await expect(list).toHaveAttribute("aria-busy", "true");
  await expect(page.getByText("正在获取标签页…")).toHaveCount(0);
  expect((await overflow()).overflowing).toBe(false);
  await expect(page.getByRole("option")).toHaveCount(5);
  await expect(list).toHaveAttribute("aria-busy", "false");
  expect((await overflow()).overflowing).toBe(false);
  const height = await menu.evaluate((element) => element.clientHeight);
  await page.keyboard.press("Escape");
  await chip.click();
  await expect(list).toHaveAttribute("aria-busy", "true");
  await expect(page.getByText("正在获取标签页…")).toHaveCount(0);
  expect(await menu.evaluate((element) => element.clientHeight)).toBe(height);
  expect(await overflow()).toMatchObject({ overflowing: false });
  await expect(list).toHaveAttribute("aria-busy", "false");
  expect(await menu.evaluate((element) => element.clientHeight)).toBe(height);
  expect((await overflow()).overflowing).toBe(false);
  await page.getByRole("combobox", { name: "搜索标签页" }).fill("tab-");
  await expect(page.getByRole("option")).toHaveCount(12);
  expect((await overflow()).overflowing).toBe(true);
  await list.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  expect(await list.evaluate((element) => element.scrollTop)).toBeGreaterThan(
    0,
  );
  await expectNoOverflow(page);
});

test("空对话切页更新纸片并清理元素引用，首条消息后保持目标", async ({
  page,
}) => {
  await installHarness(page, { followingActive: true });
  await page.goto("/sidepanel.html");
  const chip = page.getByRole("button", { name: "操作标签页", exact: true });
  await expect(chip).toHaveText("示例页面");
  await page.getByRole("button", { name: "选择页面元素" }).click();
  await expect(
    page.getByRole("button", { name: /移除 <button> 提交/ }),
  ).toBeVisible();
  await page.evaluate(() => {
    window.__harness.targetStatus.active = {
      id: 2,
      title: "页面 B",
      url: "https://example.invalid/b",
    };
    window.__harness.emitTabEvent("activated");
  });
  await expect(chip).toHaveText("页面 B");
  await expect(
    page.getByRole("button", { name: /移除 <button> 提交/ }),
  ).toHaveCount(0);
  await page.getByRole("textbox", { name: "任务内容" }).fill("开始任务");
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => window.__harness.followingActive))
    .toBe(false);
  await page.evaluate(() => {
    window.__harness.targetStatus.active = {
      id: 1,
      title: "页面 A",
      url: "https://example.invalid/a",
    };
  });
  await chip.click();
  await expect(
    page.getByRole("option", { name: "页面 A", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(chip).toHaveText("页面 B");
  await expect(
    page.getByRole("button", { name: "选择页面元素" }),
  ).toBeDisabled();
});

test("标签页不一致时禁用元素选择，切换后更新纸片与选中态", async ({ page }) => {
  const title = "这是一个超过二十个字符的操作标签页标题需要截断显示";
  await installHarness(page, {
    targetStatus: {
      target: { id: 1, title, url: "https://example.invalid/a" },
      active: { id: 2, title: "当前页面 B", url: "https://example.invalid/b" },
      missing: false,
      busy: false,
    },
  });
  await page.goto("/sidepanel.html");
  const picker = page.getByRole("button", { name: "选择页面元素" });
  await expect(picker).toBeDisabled();
  await picker.locator("..").hover();
  await expect(page.getByRole("tooltip")).toBeVisible();
  const chip = page.getByRole("button", { name: "操作标签页", exact: true });
  await expect(chip.locator("img")).toHaveCount(0);
  await chip.click();
  await expect(
    page.getByRole("combobox", { name: "搜索标签页" }),
  ).toBeVisible();
  const current = page.getByRole("option", { name: "当前页面 B", exact: true });
  await expect(current).toHaveAttribute("data-target-selected", "false");
  await current.click();
  await expect(chip).toHaveText("当前页面 B");
  await expect(picker).toBeEnabled();
  await chip.click();
  await expect(
    page.getByRole("option", { name: "当前页面 B", exact: true }),
  ).toHaveAttribute("data-target-selected", "true");
  expect(
    await page.evaluate(() =>
      window.__harness.messages.filter(
        (message) => message.type === "target:switch",
      ),
    ),
  ).toEqual([{ type: "target:switch", payload: { tabId: 2 } }]);
});

test("切换失败保留操作页，运行期间禁止切换和元素选择", async ({ page }) => {
  await installHarness(page, {
    targetStatus: {
      target: { id: 1, title: "操作页面 A", url: "https://example.invalid/a" },
      active: { id: 2, title: "当前页面 B", url: "https://example.invalid/b" },
      missing: false,
      busy: false,
    },
  });
  await page.goto("/sidepanel.html");
  await page.evaluate(() => {
    window.__harness.switchError = "连接标签页失败";
  });
  const chip = page.getByRole("button", { name: "操作标签页", exact: true });
  await chip.click();
  await page.getByRole("option", { name: "当前页面 B", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveText(/连接标签页失败/);
  await expect(chip).toHaveText("操作页面 A");
  await page.getByRole("textbox", { name: "任务内容" }).fill("执行任务");
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  await chip.click();
  await expect(page.getByText("请先停止任务，再切换标签页")).toBeVisible();
  await expect(
    page.getByRole("option", { name: "当前页面 B", exact: true }),
  ).toHaveAttribute("data-disabled", "true");
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("button", { name: "选择页面元素" }),
  ).toBeDisabled();
});

test("长对话仅在聊天区滚动，整页不会出现底部空白", async ({ page }) => {
  await installHarness(page, {
    chatLogs: Array.from({ length: 30 }, (_, index) => ({
      id: index + 1,
      type: index % 2 ? "assistant" : "user",
      content: `消息 ${index + 1}\n${"检查侧边栏滚动布局。\n".repeat(6)}`,
      timestamp: index + 1,
    })),
  });
  await page.goto("/sidepanel.html");
  await expect(page.getByText("消息 30", { exact: false })).toBeVisible();

  const chat = page.locator("#root > div > div");
  const expectPageWithinViewport = async () => {
    await expect
      .poll(() =>
        page.evaluate(
          () => document.documentElement.scrollHeight <= innerHeight,
        ),
      )
      .toBe(true);
  };

  await expectPageWithinViewport();
  expect(
    await chat.evaluate(
      (element) => element.scrollHeight > element.clientHeight,
    ),
  ).toBe(true);

  await chat.evaluate((element) => {
    element.scrollTop = 0;
  });
  await expect(page.getByText(/^消息 1\n/)).toBeInViewport();
  await expectPageWithinViewport();

  await page.setViewportSize({ width: 320, height: 600 });
  await chat.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect(page.getByText("消息 30", { exact: false })).toBeInViewport();
  await expectPageWithinViewport();

  await page.evaluate(() =>
    window.scrollTo(0, document.documentElement.scrollHeight),
  );
  expect(await page.evaluate(() => scrollY)).toBe(0);
  await expect(
    page.getByRole("textbox", { name: "任务内容" }),
  ).toBeInViewport();
});

for (const mode of ["正文", "思考", "思考框"] as const) {
  test(`${mode}流式输出时一次向上滚轮即可暂停跟随，回到底部后恢复`, async ({
    page,
  }) => {
    await installHarness(page, {
      chatLogs: Array.from({ length: 12 }, (_, index) => ({
        id: index + 1,
        type: index % 2 ? "assistant" : "user",
        content: `历史消息 ${index + 1}\n${"历史内容。\n\n".repeat(4)}`,
        timestamp: index + 1,
      })),
    });
    await page.goto("/sidepanel.html");
    await page.getByRole("textbox", { name: "任务内容" }).fill("继续输出");
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    await emit(page, "message", "");
    const content = "流式内容。\n\n".repeat(30);
    await emit(
      page,
      "message_delta",
      mode === "正文" ? content : `<think>${content}`,
    );

    const chat = page.locator("#root > div > div");
    const scroller =
      mode === "思考框" ? chat.locator(".overflow-y-auto") : chat;
    const distanceToBottom = () =>
      scroller.evaluate(
        (element) =>
          element.scrollHeight - element.clientHeight - element.scrollTop,
      );
    await expect.poll(distanceToBottom).toBeLessThanOrEqual(1);
    expect(
      await scroller.evaluate(
        (element) => element.scrollHeight - element.clientHeight,
      ),
    ).toBeGreaterThan(100);
    await scroller.hover();
    await page.mouse.wheel(0, -24);
    await expect.poll(distanceToBottom).toBeGreaterThan(10);
    const pausedTop = await scroller.evaluate((element) => element.scrollTop);
    for (let index = 0; index < 5; index++) {
      await emit(page, "message_delta", `新增段落 ${index}。\n\n`);
      await page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          ),
      );
      expect(
        await scroller.evaluate((element) => element.scrollTop),
      ).toBeCloseTo(pausedTop, 0);
    }

    await page.mouse.wheel(0, 10000);
    await expect.poll(distanceToBottom).toBeLessThanOrEqual(1);
    await emit(page, "message_delta", "恢复跟随。\n\n".repeat(4));
    await expect.poll(distanceToBottom).toBeLessThanOrEqual(1);
    if (mode === "思考框") {
      await emit(
        page,
        "message_delta",
        `</think>${"后续正文。\n\n".repeat(30)}`,
      );
      await expect
        .poll(() =>
          chat.evaluate(
            (element) =>
              element.scrollHeight - element.clientHeight - element.scrollTop,
          ),
        )
        .toBeLessThanOrEqual(1);
    }
  });
}

test("思考框上划后，延迟到达的底部滚动事件不会重新开启吸附", async ({
  page,
}) => {
  await installHarness(page);
  await page.goto("/sidepanel.html");
  await emit(page, "thinking", "思考内容。\n\n".repeat(30));
  const scroller = page.locator(".max-h-50.overflow-y-auto");
  await expect
    .poll(() =>
      scroller.evaluate(
        (element) =>
          element.scrollHeight - element.clientHeight - element.scrollTop,
      ),
    )
    .toBeLessThanOrEqual(1);
  await scroller.evaluate((element) => {
    // 模拟旧滚动操作的事件晚于新滚轮输入到达。
    element.scrollTop -= 1;
    element.dispatchEvent(new Event("scroll"));
    element.dispatchEvent(
      new WheelEvent("wheel", { deltaY: -24, bubbles: true }),
    );
    element.scrollTop = element.scrollHeight;
    element.dispatchEvent(new Event("scroll"));
  });
  const pausedTop = await scroller.evaluate((element) => element.scrollTop);
  await emit(page, "thinking_delta", "新的思考段落。\n\n".repeat(5));
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  expect(await scroller.evaluate((element) => element.scrollTop)).toBeCloseTo(
    pausedTop,
    0,
  );
});

test("设置保留自由模型名、自动保存和条件字段", async ({ page }) => {
  await installHarness(page);
  await page.goto("/options.html");
  await page.getByLabel("模型", { exact: true }).fill("private-custom-model");
  await expect
    .poll(() =>
      page.evaluate(
        () => (window.__harness.storage.settings as { model: string }).model,
      ),
    )
    .toBe("private-custom-model");
  await page.getByLabel("提供商", { exact: true }).click();
  await page.getByRole("option", { name: "Anthropic", exact: true }).click();
  await expect(
    page.getByRole("switch", { name: "启用提示缓存 (Prompt Caching)" }),
  ).toBeVisible();
  await page
    .getByRole("switch", { name: "启用 execute_js 沙箱代码执行" })
    .click();
  await expect(page.getByText("execute_js 超时", { exact: true })).toHaveCount(
    0,
  );
  await page.getByLabel("截图缩放", { exact: true }).click();
  await page.getByRole("option", { name: "自定义", exact: true }).click();
  await expect(page.getByLabel("最长边像素", { exact: true })).toBeVisible();
  await page.setViewportSize({ width: 320, height: 800 });
  await expectNoOverflow(page);
});

test("模型自动补全支持过滤、输入框键盘选择、自由输入和焦点管理", async ({
  page,
}) => {
  await installHarness(page);
  await page.route("https://example.invalid/v1/models", (route) =>
    route.fulfill({
      json: { data: [{ id: "beta-model" }, { id: "alpha-model" }] },
    }),
  );
  await page.goto("/options.html");
  const input = page.getByRole("combobox", { name: "模型", exact: true });
  await expect(input).toHaveValue("custom-model");
  await page
    .getByRole("button", { name: "从 API 获取模型列表", exact: true })
    .click();
  await input.focus();
  await expect(input).toBeFocused();
  await expect(page.getByRole("option")).toHaveText([
    "alpha-model",
    "beta-model",
  ]);
  await page.getByRole("option", { name: "beta-model", exact: true }).click();
  await expect(input).toHaveValue("beta-model");
  await expect(input).toBeFocused();
  await expect(input).toHaveAttribute("aria-expanded", "false");

  await input.fill("ALPHA");
  await expect(page.getByRole("option")).toHaveText(["alpha-model"]);
  await input.dispatchEvent("keydown", { key: "Enter", isComposing: true });
  await expect(input).toHaveValue("ALPHA");
  await input.press("ArrowDown");
  await input.press("Enter");
  await expect(input).toHaveValue("alpha-model");
  await expect(input).toBeFocused();
  await expect(input).toHaveAttribute("aria-expanded", "false");
  await expect
    .poll(() =>
      page.evaluate(
        () => (window.__harness.storage.settings as { model: string }).model,
      ),
    )
    .toBe("alpha-model");

  await input.fill("private-custom-model");
  await expect(page.getByRole("option")).toHaveCount(0);
  await input.press("Enter");
  await expect(input).toHaveValue("private-custom-model");
  await expect
    .poll(() =>
      page.evaluate(
        () => (window.__harness.storage.settings as { model: string }).model,
      ),
    )
    .toBe("private-custom-model");
  await input.press("Escape");
  await expect(input).toHaveAttribute("aria-expanded", "false");
  await input.press("ArrowDown");
  await expect(input).toHaveAttribute("aria-expanded", "true");
  await input.press("Tab");
  await expect(input).toHaveAttribute("aria-expanded", "false");

  await page.setViewportSize({ width: 320, height: 800 });
  await input.focus();
  await expect(page.getByRole("option")).toHaveCount(2);
  await expectNoOverflow(page);
});

test("获取模型失败时仍允许输入，并可刷新后选择模型", async ({ page }) => {
  await installHarness(page);
  let failing = true;
  await page.route("https://example.invalid/v1/models", (route) =>
    route.fulfill(
      failing
        ? { status: 503, body: "unavailable" }
        : { json: { data: [{ id: "recovered-model" }] } },
    ),
  );
  await page.goto("/options.html");
  await page
    .getByRole("button", { name: "从 API 获取模型列表", exact: true })
    .click();
  await page.getByLabel("模型", { exact: true }).focus();
  await expect(page.getByRole("alert", { includeHidden: true })).toContainText(
    "HTTP 503",
  );
  await page.keyboard.press("Escape");
  await page.getByLabel("模型", { exact: true }).fill("manual-model");
  await expect
    .poll(() =>
      page.evaluate(
        () => (window.__harness.storage.settings as { model: string }).model,
      ),
    )
    .toBe("manual-model");
  failing = false;
  await page
    .getByRole("button", { name: "从 API 获取模型列表", exact: true })
    .click();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await page.getByLabel("模型", { exact: true }).focus();
  await page
    .getByRole("option", { name: "recovered-model", exact: true })
    .click();
  await expect(page.getByLabel("模型", { exact: true })).toHaveValue(
    "recovered-model",
  );
});

test("主题跟随系统并响应存储同步", async ({ page }) => {
  await installHarness(page, { themeMode: "auto" });
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto("/options.html");
  await expect(page.locator("html")).not.toHaveClass(/dark/);
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator("html")).toHaveClass(/dark/);
  await page.getByRole("button", { name: "切换主题" }).click();
  await page.getByRole("menuitemradio", { name: "明亮模式" }).click();
  await expect(page.locator("html")).not.toHaveClass(/dark/);
  await page.evaluate(() =>
    (window.chrome.storage.local.set as unknown as (values: object) => void)({
      themeMode: "dark",
    }),
  );
  await expect(page.locator("html")).toHaveClass(/dark/);
});

test("输入提交、Shift Enter 换行和停止", async ({ page }) => {
  await installHarness(page);
  await page.goto("/sidepanel.html");
  const input = page.getByRole("textbox", { name: "任务内容" });
  await input.fill("读取页面");
  await input.press("Shift+Enter");
  await expect(input).toHaveValue("读取页面\n");
  await input.press("Enter");
  await expect(
    page.getByRole("button", { name: "停止", exact: true }),
  ).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          window.__harness.messages.filter(
            (message) => message.type === "agent:start",
          ).length,
      ),
    )
    .toBe(1);
  await page.getByRole("button", { name: "停止", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "发送消息", exact: true }),
  ).toBeVisible();
});

test("工具审批与参数展示不依赖 AI SDK 后端", async ({ page }) => {
  await installHarness(page);
  await page.goto("/sidepanel.html");
  await emit(page, "tool_call", {
    id: "click-1",
    name: "click",
    args: '{"selector":"#submit"}',
    needsPermission: true,
  });
  await expect(
    page.getByRole("button", { name: "允许", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: /Click/ }).click();
  await expect(page.locator("code:visible")).toContainText("#submit");
  await page.getByRole("button", { name: "允许", exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.__harness.messages.some(
          (message) => message.type === "agent:approve",
        ),
      ),
    )
    .toBe(true);
  await expect(
    page.getByRole("button", { name: "允许", exact: true }),
  ).toHaveCount(0);
  await emit(page, "tool_result", {
    id: "click-1",
    name: "click",
    result: { success: true, data: "已点击" },
  });
  await expect(page.locator("code:visible")).toContainText("已点击");
  await emit(page, "tool_call", {
    id: "navigate-1",
    name: "navigate",
    args: '{"url":"https://example.invalid/very/long/url/for/layout"}',
    needsPermission: true,
  });
  await page.getByRole("button", { name: "拒绝", exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.__harness.messages.some(
          (message) => message.type === "agent:reject",
        ),
      ),
    )
    .toBe(true);
  await expectNoOverflow(page);
});

test("完成标记工具隐藏标签页但保留失败结果", async ({ page }) => {
  await installHarness(page);
  await page.goto("/sidepanel.html");
  await emit(page, "tool_call", {
    id: "wait-1",
    name: "wait",
    args: '{"ms":200}',
    needsPermission: false,
  });
  await page.getByRole("button", { name: /Wait/ }).click();
  await expect(page.locator("code:visible")).toContainText('"ms": 200');
  await expect(page.getByRole("tab")).toHaveCount(0);
  await emit(page, "tool_result", {
    id: "wait-1",
    name: "wait",
    result: { success: true, data: "done" },
  });
  await expect(page.getByRole("tab")).toHaveCount(0);
  await expect(page.locator("code:visible")).toContainText('"ms": 200');
  await emit(page, "tool_call", {
    id: "click-1",
    name: "click",
    args: '{"selector":"#missing"}',
    needsPermission: false,
  });
  await page.getByRole("button", { name: /Click/ }).click();
  await expect(page.getByRole("tab")).toHaveCount(0);
  await emit(page, "tool_result", {
    id: "click-1",
    name: "click",
    result: { success: false, error: "未找到目标元素" },
  });
  await expect(
    page.getByRole("tab", { name: "结果", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("code:visible").last()).toContainText(
    "未找到目标元素",
  );
  await expectNoOverflow(page);
});

test("恢复历史、截图裁剪标记与重试回滚", async ({ page }) => {
  await installHarness(page, {
    chatLogs: [
      { id: 1, type: "user", content: "检查页面", timestamp: 1 },
      {
        id: 2,
        type: "tool_call",
        content: "{}",
        toolName: "screenshot",
        toolCallId: "shot-1",
        toolResult: "done",
        toolSuccess: true,
        screenshotData,
        screenshotMime: "image/png",
        timestamp: 2,
      },
      { id: 3, type: "assistant", content: "页面已检查", timestamp: 3 },
    ],
  });
  await page.goto("/sidepanel.html");
  await expect(page.getByText("页面已检查", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: /Take screenshot/ }).click();
  await expect(page.getByAltText("浏览器截图")).toBeVisible();
  await expect(page.getByRole("tab")).toHaveCount(0);
  await emit(page, "screenshots_pruned", { ids: ["shot-1"] });
  await expect(page.getByText("已从上下文删除", { exact: true })).toBeVisible();
  await expect(page.getByAltText("浏览器截图")).toHaveClass(/grayscale/);
  await page.getByRole("button", { name: "重试", exact: true }).last().click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          window.__harness.messages.find(
            (message) => message.type === "agent:truncateBeforeUserTurn",
          )?.payload?.turnIndex,
      ),
    )
    .toBe(0);
});

test("Markdown 表格、公式、代码与无效公式兼容", async ({ page }) => {
  await installHarness(page, {
    chatLogs: [
      {
        id: 1,
        type: "assistant",
        content:
          '| 字段 | 值 |\n| --- | --- |\n| 状态 | 正常 |\n\n公式：$x^2 + y^2$\n\n\\[\\frac{1}{2}\\]\n\n```js\nconst price = "$20";\n```\n\n无效公式：$\\notARealCommand{a}$',
        timestamp: 1,
      },
    ],
  });
  await page.goto("/sidepanel.html");
  await expect(page.getByRole("table")).toBeVisible();
  await expect(page.locator(".katex")).toHaveCount(2);
  await expect(page.locator("code")).toContainText('const price = "$20";');
  await expect(page.locator(".katex-error")).toHaveCount(0);
  await expectNoOverflow(page);
});

test("流式思考、步骤分组和手动折叠", async ({ page }) => {
  await installHarness(page);
  await page.goto("/sidepanel.html");
  await emit(page, "thinking", "正在分析页面");
  await expect(page.getByText("正在分析页面", { exact: true })).toBeVisible();
  await emit(page, "tool_call", {
    id: "read-1",
    name: "read_page",
    args: "{}",
    needsPermission: false,
  });
  await expect(
    page.getByRole("button", { name: "2 steps", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "2 steps", exact: true }).click();
  await emit(page, "tool_result", {
    id: "read-1",
    name: "read_page",
    result: { success: true, data: "页面结构" },
  });
  await expect(
    page.getByRole("button", { name: /Read page structure/ }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "2 steps", exact: true }).click();
  await expect(
    page.getByRole("button", { name: /Read page structure/ }),
  ).toBeVisible();
});

test("空白正文合并前后步骤，后续流式正文仍能显示", async ({ page }) => {
  await installHarness(page);
  await page.goto("/sidepanel.html");
  await emit(page, "tool_call", {
    id: "read-blank",
    name: "read_page",
    args: "{}",
  });
  for (const content of ["", " \n\t", "\u00a0\u3000"]) {
    await emit(page, "message", content);
  }
  await emit(page, "tool_call", {
    id: "wait-blank",
    name: "wait",
    args: '{"ms":1}',
  });
  const group = page.getByRole("button", { name: "2 steps", exact: true });
  await expect(group).toHaveCount(1);
  await expect(group).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator(".is-assistant")).toHaveCount(1);
  await expect(
    page.getByRole("button", { name: /Read page structure/ }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: /Wait/ })).toBeVisible();

  await emit(page, "message_delta", "页面分析完成");
  await expect(page.getByText("页面分析完成", { exact: true })).toBeVisible();
  await expect(group).toHaveCount(0);
});

test("截图详情只展示结果，等待和失败时也没有标签页", async ({ page }) => {
  await installHarness(page);
  await page.goto("/sidepanel.html");
  await emit(page, "tool_call", {
    id: "shot-only",
    name: "screenshot",
    args: "{}",
  });
  await page.getByRole("button", { name: /Take screenshot/ }).click();
  await expect(page.getByText("正在截屏…", { exact: true })).toBeVisible();
  await expect(page.getByRole("tab")).toHaveCount(0);
  await emit(page, "tool_result", {
    id: "shot-only",
    name: "screenshot",
    result: { success: true, data: screenshotData },
  });
  await expect(page.getByAltText("浏览器截图")).toBeVisible();
  await expect(page.getByRole("tab")).toHaveCount(0);
  await emit(page, "tool_result", {
    id: "shot-only",
    name: "screenshot",
    result: { success: false, error: "截图失败" },
  });
  await expect(page.locator("code:visible")).toContainText("截图失败");
  await expect(page.getByRole("tab")).toHaveCount(0);
});

for (const eventType of [
  "message",
  "tool_call_streaming",
  "tool_call",
  "assistant_turn_done",
  "error",
  "done",
]) {
  test(`思考在 ${eventType} 后停止转圈且重复收尾不改变耗时`, async ({
    page,
  }) => {
    await installHarness(page);
    await page.goto("/sidepanel.html");
    const startedAt = new Date("2026-01-01T00:00:00Z");
    await page.clock.setFixedTime(startedAt);
    await emit(page, "thinking", "检查页面");
    await expect(page.getByRole("button", { name: /Thinking/ })).toBeVisible();
    await page.clock.setFixedTime(new Date(startedAt.getTime() + 3000));
    await emit(
      page,
      eventType,
      eventType === "tool_call"
        ? { name: "read_page", args: "{}", id: "thinking-tool" }
        : "下一阶段",
    );
    const completed = page.getByRole("button", { name: /已思考/ });
    await expect(completed).toHaveCount(1);
    await expect(completed.locator("svg.animate-spin")).toHaveCount(0);
    const label = await completed.textContent();
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (
              window.__harness.storage.chatLogs as {
                type: string;
                thinkSeconds?: number;
              }[]
            )?.find((entry) => entry.type === "thinking")?.thinkSeconds,
        ),
      )
      .toBe(3);
    await page.clock.setFixedTime(new Date(startedAt.getTime() + 10000));
    await emit(page, "assistant_turn_done", "");
    await emit(page, "done", "");
    await expect(completed).toHaveText(label!);
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (
              window.__harness.storage.chatLogs as {
                type: string;
                thinkSeconds?: number;
              }[]
            )?.find((entry) => entry.type === "thinking")?.thinkSeconds,
        ),
      )
      .toBe(3);
    await expect(page.getByRole("button", { name: /Thinking/ })).toHaveCount(0);
  });
}

test("主动停止思考不依赖后台发送完成事件", async ({ page }) => {
  await installHarness(page);
  await page.goto("/sidepanel.html");
  await page.getByRole("textbox", { name: "任务内容" }).fill("检查页面");
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  await emit(page, "thinking", "正在检查");
  await page.getByRole("button", { name: "停止", exact: true }).click();
  await expect(page.getByRole("button", { name: /Thinking/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /已思考/ })).toHaveCount(1);
  expect(
    await page.evaluate(() =>
      window.__harness.messages.some(
        (message) => message.type === "agent:stop",
      ),
    ),
  ).toBe(true);
});

test("新思考关闭上一条且标签思考能跨增量继续", async ({ page }) => {
  await installHarness(page);
  await page.goto("/sidepanel.html");
  await emit(page, "thinking", "第一段");
  await emit(page, "thinking", "第二段");
  await expect(page.getByRole("button", { name: /已思考/ })).toHaveCount(1);
  await expect(page.getByRole("button", { name: /Thinking/ })).toHaveCount(1);
  await emit(page, "message", "");
  await emit(page, "message_delta", "<think>第三段");
  await emit(page, "message_delta", "仍在思考");
  await expect(page.getByRole("button", { name: /Thinking/ })).toHaveCount(1);
  await expect(page.getByText("第三段仍在思考", { exact: true })).toBeVisible();
  await emit(page, "assistant_turn_done", "");
  await expect(page.getByRole("button", { name: /Thinking/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /已思考/ })).toHaveCount(3);
});

test("思考转圈和完成勾选保持在同一位置", async ({ page }) => {
  await installHarness(page);
  await page.goto("/sidepanel.html");
  await emit(page, "thinking", "检查页面");
  const thinking = page.getByRole("button", { name: /Thinking/ });
  const spinner = await thinking.locator("svg.animate-spin").boundingBox();
  expect(spinner).not.toBeNull();
  await emit(page, "assistant_turn_done", {});
  const completed = page.getByRole("button", { name: /已思考/ });
  await expect(completed.locator("svg.animate-spin")).toHaveCount(0);
  const check = await completed.locator("svg").first().boundingBox();
  expect(check).not.toBeNull();
  expect(
    Math.abs(spinner!.x + spinner!.width / 2 - check!.x - check!.width / 2),
  ).toBeLessThan(1);
});

test("页面元素引用、附件删除与窄侧边栏布局", async ({ page }) => {
  await installHarness(page);
  await page.setViewportSize({ width: 320, height: 800 });
  await page.goto("/sidepanel.html");
  for (const label of ["选择页面元素", "添加附件"]) {
    const button = page.getByRole("button", { name: label, exact: true });
    await button.hover();
    await expect(page.getByRole("tooltip")).toBeVisible();
    await page.mouse.move(0, 0, { steps: 5 });
    await expect(page.getByRole("tooltip")).toBeHidden();
  }
  await page.getByRole("button", { name: "选择页面元素", exact: true }).click();
  await expect(page.getByText("<button> 提交", { exact: true })).toBeVisible();
  await page
    .locator('input[type="file"]')
    .last()
    .setInputFiles({
      name: "context.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("测试附件"),
    });
  await expect(page.getByText("context.txt", { exact: true })).toBeVisible();
  await page
    .getByRole("button", { name: "移除 context.txt", exact: true })
    .click();
  await expect(page.getByText("context.txt", { exact: true })).toHaveCount(0);
  await page.locator('input[type="file"]').last().setInputFiles([
    {
      name: "context, notes.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("测试附件"),
    },
    {
      name: "data.csv",
      mimeType: "text/csv",
      buffer: Buffer.from("name,value"),
    },
  ]);
  await page.getByRole("textbox", { name: "任务内容" }).fill("检查元素和文件");
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          window.__harness.messages.find(
            (message) => message.type === "agent:start",
          )?.payload?.userMessage,
      ),
    )
    .toContain('selector="#submit"');
  const message = page.locator(".is-user");
  const bubble = message.locator(":scope > div").first();
  await expect(bubble).toHaveText("检查元素和文件");
  const tab = message.locator('[data-slot="message-target-tab"]');
  const elements = message.locator('[data-slot="message-picked-elements"]');
  const files = message.locator('[data-slot="message-attachments"]');
  await expect(elements).toHaveText("<button> 提交");
  await expect(files.locator('[data-slot="badge"]')).toHaveText([
    "context, notes.txt",
    "data.csv",
  ]);
  for (const [above, below] of [
    [bubble, tab],
    [tab, elements],
    [elements, files],
  ]) {
    const aboveBox = await above.boundingBox();
    const belowBox = await below.boundingBox();
    expect(belowBox!.y).toBeGreaterThanOrEqual(aboveBox!.y + aboveBox!.height);
  }
  await expectNoOverflow(page);
});

test("输入法组合输入不会提前提交", async ({ page }) => {
  await installHarness(page);
  await page.goto("/sidepanel.html");
  const input = page.getByRole("textbox", { name: "任务内容" });
  await input.fill("中文任务");
  await input.dispatchEvent("compositionstart");
  await input.press("Enter");
  expect(
    await page.evaluate(
      () =>
        window.__harness.messages.filter(
          (message) => message.type === "agent:start",
        ).length,
    ),
  ).toBe(0);
  await input.dispatchEvent("compositionend");
  await input.press("Enter");
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          window.__harness.messages.filter(
            (message) => message.type === "agent:start",
          ).length,
      ),
    )
    .toBe(1);
});

test("粘贴附件使用同一份附件状态并保留文件名展示", async ({ page }) => {
  await installHarness(page);
  await page.goto("/sidepanel.html");
  const input = page.getByRole("textbox", { name: "任务内容" });
  await input.evaluate((element) => {
    const clipboard = new DataTransfer();
    clipboard.items.add(
      new File(["粘贴的上下文"], "pasted.txt", { type: "text/plain" }),
    );
    element.dispatchEvent(
      new ClipboardEvent("paste", {
        clipboardData: clipboard,
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  await expect(page.getByText("pasted.txt", { exact: true })).toBeVisible();
  await input.fill("读取附件");
  await input.press("Enter");
  await expect(page.locator(".is-user > div").first()).toHaveText("读取附件");
  await expect(page.locator('[data-slot="message-attachments"]')).toHaveText(
    "pasted.txt",
  );
});

test("旧消息的附件文本恢复为气泡外的文件纸片", async ({ page }) => {
  await installHarness(page, {
    chatLogs: [
      {
        id: 1,
        type: "user",
        content: "读取文件\n[附件: context.txt, data.csv]",
        timestamp: Date.now(),
      },
      {
        id: 2,
        type: "user",
        content: "\n[附件: only.txt]",
        timestamp: Date.now(),
      },
    ],
  });
  await page.goto("/sidepanel.html");
  await expect(
    page.locator(".is-user").first().locator(":scope > div").first(),
  ).toHaveText("读取文件");
  await expect(
    page.locator('[data-slot="message-attachments"] [data-slot="badge"]'),
  ).toHaveText(["context.txt", "data.csv", "only.txt"]);
  await expect(page.locator(".is-user").last().locator("p")).toHaveCount(0);
});

test("流式公式结束后完整渲染且不产生页面错误", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await installHarness(page);
  await page.goto("/sidepanel.html");
  await page.getByRole("textbox", { name: "任务内容" }).fill("输出公式");
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "停止", exact: true }),
  ).toBeVisible();
  await emit(page, "message", "");
  await emit(page, "message_delta", "结果：$x^");
  await expect(page.locator(".katex-error")).toHaveCount(0);
  await emit(page, "message_delta", "2 + y^2$\n\n$$\n\\frac{1}{2}");
  await expect(page.locator(".katex-error")).toHaveCount(0);
  await emit(page, "message_delta", "\n$$");
  await emit(page, "assistant_turn_done", {});
  await emit(page, "done", {});
  await expect(page.locator(".katex")).toHaveCount(2);
  expect(errors).toEqual([]);
});

test("思考过程与多步工具的混合时间线展示", async ({ page }) => {
  await installHarness(page, {
    themeMode: "light",
    chatLogs: [
      {
        id: 1,
        type: "user",
        content: "核对订单总额，确认后提交订单。",
        timestamp: 1,
      },
      {
        id: 2,
        type: "thinking",
        content:
          "先读取订单信息，再核对金额。\n\n提交会修改页面数据，需要等待你的批准。",
        thinkingDone: true,
        thinkSeconds: 2,
        timestamp: 2,
      },
      {
        id: 3,
        type: "tool_call",
        toolName: "read_page_interactive",
        toolCallId: "read-1",
        content: "{}",
        toolResult: "找到 3 笔订单和提交按钮。",
        toolSuccess: true,
        timestamp: 3,
      },
      {
        id: 4,
        type: "tool_call",
        toolName: "execute_js",
        toolCallId: "js-1",
        content: JSON.stringify({
          description: "核对订单总额",
          code: "const total = [25, 30, 45]\n  .reduce((sum, value) => sum + value, 0);\nconsole.log({ total });",
        }),
        toolResult: '{"total":100,"count":3}',
        toolSuccess: true,
        timestamp: 4,
      },
      {
        id: 5,
        type: "tool_call",
        toolName: "click",
        toolCallId: "click-1",
        content: '{"selector":"#submit-order"}',
        needsPermission: true,
        timestamp: 5,
      },
    ],
  });
  await page.setViewportSize({ width: 390, height: 1000 });
  await page.goto("/sidepanel.html");
  const group = page.getByRole("button", { name: "4 steps", exact: true });
  if ((await group.getAttribute("aria-expanded")) === "false")
    await group.click();
  await page.getByRole("button", { name: /已思考 2 秒/ }).click();
  await expect(
    page.getByText("先读取订单信息，再核对金额。", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: /Run JS/ }).click();
  await expect(
    page.getByRole("tab", { name: "结果", exact: true }),
  ).toBeVisible();
  await expect(page.locator("code:visible")).toContainText('"total": 100');
  await expect(
    page.getByRole("button", { name: "允许", exact: true }),
  ).toBeVisible();
  await expect(group).not.toContainText("待审批");
  await expect(page.getByText("待审批", { exact: true })).toHaveCount(1);
  await expectNoOverflow(page);
});

for (const description of [
  "核对订单总额",
  "检查订单条目并计算总额。".repeat(10),
]) {
  test(`Run JS 描述收起时显示摘要，展开时只显示完整详情：${description.length}`, async ({
    page,
  }) => {
    await installHarness(page, {
      chatLogs: [
        {
          id: 1,
          type: "tool_call",
          toolName: "execute_js",
          toolCallId: "description-repro",
          content: JSON.stringify({ description, code: "console.log(100);" }),
          toolResult: '{"total":100}',
          toolSuccess: true,
          timestamp: 1,
        },
      ],
    });
    await page.goto("/sidepanel.html");
    const header = page.getByRole("button", { name: /Run JS/ });
    const summary = header.locator("span.truncate");
    await expect(summary).toHaveText(description);
    await expect(summary).toHaveAttribute("title", description);
    await header.click();
    await expect(summary).toHaveText("");
    await expect(summary).not.toHaveAttribute("title");
    await expect(page.getByText(description, { exact: true })).toBeVisible();
    await expect(
      page.getByRole("tab", { name: "结果", exact: true }),
    ).toHaveAttribute("data-state", "active");
    await page.getByRole("tab", { name: "代码", exact: true }).click();
    await expect(page.getByText(description, { exact: true })).toBeVisible();
    await expect(summary).toHaveText("");
    await header.click();
    await expect(summary).toHaveText(description);
    await expect(
      page.locator("p").filter({ hasText: description }),
    ).toHaveCount(0);
    await expectNoOverflow(page);
  });
}

for (const toolName of ["read_page", "execute_js"]) {
  test(`工具详情复制按钮与分段按钮同行，并复制当前内容：${toolName}`, async ({
    page,
  }) => {
    const input =
      toolName === "execute_js"
        ? { code: 'console.log("alpha");', timeout: 1000 }
        : { selector: "#sample", limit: 100 };
    const result = { value: "beta" };
    await installHarness(page, {
      chatLogs: [
        {
          id: 1,
          type: "tool_call",
          toolName,
          toolCallId: "copy-toolbar",
          content: JSON.stringify(input),
          toolResult: JSON.stringify(result),
          toolSuccess: true,
          timestamp: 1,
        },
      ],
    });
    await page.addInitScript(() => {
      const copiedTexts: string[] = [];
      Object.defineProperty(navigator, "clipboard", {
        value: {
          writeText: async (text: string) => {
            copiedTexts.push(text);
          },
        },
        configurable: true,
      });
      Object.assign(window, { copiedTexts });
    });
    await page.goto("/sidepanel.html");
    await page
      .getByRole("button", {
        name: toolName === "execute_js" ? /Run JS/ : /Read page structure/,
      })
      .click();
    const tabs = page.getByRole("tablist", { name: "工具详情" });
    const copyResult = page.getByRole("button", {
      name: "复制结果",
      exact: true,
    });
    const tabsBox = (await tabs.boundingBox())!;
    const copyBox = (await copyResult.boundingBox())!;
    expect(copyBox.x).toBeGreaterThan(tabsBox.x + tabsBox.width);
    expect(
      Math.abs(copyBox.y + copyBox.height / 2 - tabsBox.y - tabsBox.height / 2),
    ).toBeLessThan(1);
    await copyResult.click();
    await page
      .getByRole("tab", {
        name: toolName === "execute_js" ? "代码" : "参数",
        exact: true,
      })
      .click();
    await page
      .getByRole("button", {
        name: toolName === "execute_js" ? "复制代码" : "复制参数",
        exact: true,
      })
      .click();
    expect(
      await page.evaluate(
        () => (window as unknown as { copiedTexts: string[] }).copiedTexts,
      ),
    ).toEqual([
      JSON.stringify(result, null, 2),
      toolName === "execute_js"
        ? `${input.code}\n\n${JSON.stringify({ timeout: 1000 }, null, 2)}`
        : JSON.stringify(input, null, 2),
    ]);
    await expect(page.locator("pre").locator("button")).toHaveCount(0);
    await expectNoOverflow(page);
  });
}

for (const theme of ["light", "dark"] as const) {
  for (const tab of ["代码", "参数", "结果"]) {
    test(`空闲工具详情拖选保持选区：${tab} ${theme}`, async ({
      page,
    }, testInfo) => {
      await page.emulateMedia({ colorScheme: theme });
      await installHarness(page, {
        chatLogs: [
          {
            id: 1,
            type: "tool_call",
            toolName: tab === "参数" ? "read_page" : "execute_js",
            toolCallId: "selection-repro",
            content: JSON.stringify(
              tab === "参数"
                ? {
                    selector: "#sample",
                    options: { firstValue: "alpha", secondValue: "beta" },
                  }
                : {
                    code: 'const firstValue = "alpha";\nconst secondValue = "beta";\nconst thirdValue = "gamma";\nconsole.log(firstValue, secondValue, thirdValue);',
                  },
            ),
            toolResult: JSON.stringify({
              firstValue: "alpha",
              secondValue: "beta",
              thirdValue: "gamma",
            }),
            toolSuccess: true,
            timestamp: 1,
          },
        ],
      });
      await page.goto("/sidepanel.html");
      await page
        .getByRole("button", {
          name: tab === "参数" ? /Read page structure/ : /Run JS/,
        })
        .click();
      await page.getByRole("tab", { name: tab, exact: true }).click();
      const code = page.locator("pre.shiki:visible code");
      await expect(code).toBeVisible();
      await code.evaluate((element) => {
        const records: unknown[] = [];
        const originalNode = element.firstChild;
        const sample = (type: string) => {
          const selection = window.getSelection();
          records.push({
            type,
            time: performance.now(),
            text: selection?.toString(),
            anchorOffset: selection?.anchorOffset,
            focusOffset: selection?.focusOffset,
            originalNodeConnected: originalNode?.isConnected,
          });
        };
        document.addEventListener("selectionchange", () => sample("selection"));
        new MutationObserver(() => sample("mutation")).observe(
          element.parentElement!.parentElement!,
          { childList: true, subtree: true },
        );
        Object.assign(window, { selectionRecords: records });
      });
      const box = (await code.boundingBox())!;
      await page.mouse.move(box.x + 10, box.y + 8);
      await page.mouse.down();
      await page.mouse.move(box.x + 125, box.y + 40, { steps: 15 });
      const before = await page.evaluate(() =>
        window.getSelection()?.toString(),
      );
      expect(before?.length).toBeGreaterThan(0);
      // 无关状态刷新也不能重写代码节点或清除正在拖动的选区。
      await page.evaluate(() => window.__harness.notifyTargetChanged());
      await page.waitForTimeout(2200);
      const after = await page.evaluate(() =>
        window.getSelection()?.toString(),
      );
      await page.mouse.move(box.x + 160, box.y + 57, { steps: 10 });
      await page.mouse.up();
      const continued = await page.evaluate(() =>
        window.getSelection()?.toString(),
      );
      await page.evaluate(() => window.__harness.notifyTargetChanged());
      await page.waitForTimeout(1100);
      expect(await page.evaluate(() => window.getSelection()?.toString())).toBe(
        continued,
      );
      const records = await page.evaluate(
        () =>
          (window as unknown as { selectionRecords: unknown[] })
            .selectionRecords,
      );
      const evidence = JSON.stringify(
        { tab, before, after, continued, records },
        null,
        2,
      );
      await writeFile(testInfo.outputPath("selection-events.json"), evidence);
      await testInfo.attach("selection-events", {
        body: evidence,
        contentType: "application/json",
      });
      expect(after).toBe(before);
    });
  }
}

for (const theme of ["light", "dark"]) {
  test(`多步工具详情标签页与审批布局：${theme}`, async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await installHarness(page, {
      themeMode: theme,
      chatLogs: [
        {
          id: 1,
          type: "user",
          content: "汇总订单金额，然后点击提交订单。",
          timestamp: 1,
        },
        {
          id: 2,
          type: "tool_call",
          toolName: "read_page_interactive",
          toolCallId: "read-1",
          content: "{}",
          toolResult: "找到 3 笔订单和提交按钮。",
          toolSuccess: true,
          timestamp: 2,
        },
        {
          id: 3,
          type: "tool_call",
          toolName: "find_element",
          toolCallId: "find-1",
          content: '{"text":"提交订单"}',
          toolResult: '{"selector":"#submit-order","text":"提交订单"}',
          toolSuccess: true,
          timestamp: 3,
        },
        {
          id: 4,
          type: "tool_call",
          toolName: "execute_js",
          toolCallId: "js-1",
          content: JSON.stringify({
            description: "汇总 3 笔订单金额",
            code: "const amounts = [25, 30, 45];\nconst total = amounts.reduce(\n  (sum, amount) => sum + amount,\n  0,\n);\nconsole.log({ total });",
          }),
          toolResult: '{"total":100,"count":3}',
          toolSuccess: true,
          timestamp: 4,
        },
        {
          id: 5,
          type: "tool_call",
          toolName: "click",
          toolCallId: "click-1",
          content: '{"selector":"#submit-order"}',
          needsPermission: true,
          timestamp: 5,
        },
      ],
    });
    await page.setViewportSize({ width: 390, height: 1000 });
    await page.goto("/sidepanel.html");
    const group = page.getByRole("button", { name: "4 steps", exact: true });
    if ((await group.getAttribute("aria-expanded")) === "false")
      await group.click();
    await page.getByRole("button", { name: /Run JS/ }).click();
    await expect(
      page.getByRole("tab", { name: "结果", exact: true }),
    ).toHaveAttribute("aria-selected", "true");
    await page.getByRole("tab", { name: "代码", exact: true }).click();
    await expect(page.locator("code:visible")).toContainText("const amounts");
    await page.getByRole("button", { name: /Click/ }).click();
    await expect(
      page.getByRole("button", { name: "允许", exact: true }),
    ).toBeVisible();
    await expect(group).not.toContainText("待审批");
    await expect(page.getByText("待审批", { exact: true })).toHaveCount(1);
    await expectNoOverflow(page);
    await page.getByRole("tab", { name: "代码", exact: true }).focus();
    await page.keyboard.press("ArrowRight");
    await expect(
      page.getByRole("tab", { name: "结果", exact: true }).first(),
    ).toHaveAttribute("aria-selected", "true");
    await page.setViewportSize({ width: 320, height: 800 });
    await expectNoOverflow(page);
    await group.click();
    await expect(page.getByRole("button", { name: /Run JS/ })).toHaveCount(0);
    await expect(group).toContainText("待审批");
    await expect(page.getByText("待审批", { exact: true })).toHaveCount(1);
    expect(errors).toEqual([]);
  });
}
