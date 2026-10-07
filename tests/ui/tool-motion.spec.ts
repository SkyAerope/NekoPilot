import { expect, test, type Locator } from "@playwright/test";
import { emit, installHarness } from "../helpers/harness";

test("工具组内展开详情在不同宽度保持布局", async ({ page }, testInfo) => {
  // Given
  await installHarness(page);
  await page.goto("/sidepanel.html");
  await emit(page, "tool_call", {
    id: "responsive-click",
    name: "click",
    args: '{"selector":"#submit"}',
  });
  await emit(page, "tool_call", {
    id: "responsive-wait",
    name: "wait",
    args: '{"ms":100}',
  });
  await page.getByRole("button", { name: /点击/ }).click();
  await expect(page.locator("code:visible")).toContainText("#submit");
  for (const width of [375, 768, 1280]) {
    // When
    await page.setViewportSize({ width, height: 800 });
    // Then
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: testInfo.outputPath(`expanded-${width}.png`),
      animations: "disabled",
    });
  }
});

async function toggleWithMotion(trigger: Locator) {
  return trigger.evaluate((element) => {
    const root = element.closest('[data-slot="collapsible"]');
    return new Promise<{ middle: number; full: number } | null>((resolve) => {
      const timeout = setTimeout(() => {
        document.removeEventListener("animationstart", onStart);
        resolve(null);
      }, 1500);
      function onStart(event: AnimationEvent) {
        const content = event.target;
        if (
          !(content instanceof HTMLElement) ||
          content.closest('[data-slot="collapsible"]') !== root ||
          content.dataset.slot !== "collapsible-content"
        )
          return;
        const animation = content.getAnimations()[0];
        if (!animation?.effect) return;
        clearTimeout(timeout);
        document.removeEventListener("animationstart", onStart);
        animation.pause();
        animation.currentTime =
          Number(animation.effect.getTiming().duration) / 2;
        const middle = content.getBoundingClientRect().height;
        const full = Number.parseFloat(
          getComputedStyle(content).getPropertyValue(
            "--radix-collapsible-content-height",
          ),
        );
        animation.finish();
        resolve({ middle, full });
      }
      document.addEventListener("animationstart", onStart);
      if (element instanceof HTMLElement) element.click();
    });
  });
}

test("思考块双向折叠有动画，手动折叠后流式增量不重新展开", async ({
  page,
}, testInfo) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await installHarness(page);
  await page.goto("/sidepanel.html");
  await emit(page, "thinking", "正在分析页面\n\n".repeat(20));
  const trigger = page.getByRole("button", { name: /Thinking/ });
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
  const contentId = await trigger.getAttribute("aria-controls");
  const content = page.locator(`[id="${contentId}"]`);

  const closing = await toggleWithMotion(trigger);
  expect(closing).not.toBeNull();
  expect(closing?.middle).toBeGreaterThan(0);
  expect(closing?.middle).toBeLessThan(closing?.full ?? 0);
  await expect(content).toBeHidden();
  await emit(page, "thinking_delta", "继续分析页面");
  await expect(trigger).toHaveAttribute("aria-expanded", "false");

  const opening = await toggleWithMotion(trigger);
  expect(opening).not.toBeNull();
  expect(opening?.middle).toBeGreaterThan(0);
  expect(opening?.middle).toBeLessThan(opening?.full ?? 0);
  await expect(content).toContainText("继续分析页面");
  await page.screenshot({
    path: testInfo.outputPath("thinking-expanded.png"),
    animations: "disabled",
  });
});

test("减少动态效果时思考块关闭动画并正常切换", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await installHarness(page);
  await page.goto("/sidepanel.html");
  await emit(page, "thinking", "正在分析页面");
  const trigger = page.getByRole("button", { name: /Thinking/ });
  const contentId = await trigger.getAttribute("aria-controls");
  const content = page.locator(`[id="${contentId}"]`);
  await trigger.click();
  await expect(content).toBeHidden();
  await trigger.click();
  await expect(content).toBeVisible();
  expect(
    await content.evaluate(
      (element) => getComputedStyle(element).animationName,
    ),
  ).toBe("none");
});

for (const kind of ["工具", "工具组"] as const) {
  test(`${kind}展开与收折时存在中间高度，动画结束后隐藏内容`, async ({
    page,
  }) => {
    // Given
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await installHarness(page);
    await page.goto("/sidepanel.html");
    await emit(page, "tool_call", {
      id: "click-motion",
      name: "click",
      args: '{"selector":"#submit"}',
    });
    const trigger =
      kind === "工具"
        ? page.getByRole("button", { name: /点击/ })
        : page.getByRole("button", { name: "2 steps", exact: true });
    if (kind === "工具组") {
      await emit(page, "tool_call", {
        id: "wait-motion",
        name: "wait",
        args: '{"ms":100}',
      });
      await trigger.click();
      await expect(page.getByRole("button", { name: /点击/ })).toBeHidden();
    }

    // When / Then: 展开确实经过中间高度，而不是只淡入内容。
    const opening = await toggleWithMotion(trigger);
    expect(opening).not.toBeNull();
    expect(opening?.middle).toBeGreaterThan(0);
    expect(opening?.middle).toBeLessThan(opening?.full ?? 0);
    await expect(trigger).toHaveAttribute("aria-expanded", "true");
    const contentId = await trigger.getAttribute("aria-controls");
    const content = page.locator(`[id="${contentId}"]`);
    await expect(content).toBeVisible();

    // When / Then: 退出动画完成前内容仍在，之后隐藏。
    const closing = await toggleWithMotion(trigger);
    expect(closing).not.toBeNull();
    expect(closing?.middle).toBeGreaterThan(0);
    expect(closing?.middle).toBeLessThan(closing?.full ?? 0);
    await expect(content).toBeHidden();
  });
}

test("减少动态效果时工具与工具组立即切换，折叠详情不隐藏审批", async ({
  page,
}) => {
  // Given
  await page.emulateMedia({ reducedMotion: "reduce" });
  await installHarness(page);
  await page.goto("/sidepanel.html");
  await emit(page, "tool_call", {
    id: "approval-motion",
    name: "click",
    args: '{"selector":"#submit"}',
    needsPermission: true,
  });
  const trigger = page.getByRole("button", { name: /点击/ });
  await trigger.click();
  const contentId = await trigger.getAttribute("aria-controls");
  const content = page.locator(`[id="${contentId}"]`);
  await expect(content).toBeVisible();
  expect(
    await content.evaluate(
      (element) => getComputedStyle(element).animationName,
    ),
  ).toBe("none");

  // When
  await trigger.click();

  // Then
  await expect(content).toBeHidden();
  await expect(
    page.getByRole("button", { name: "允许", exact: true }),
  ).toBeVisible();
  await emit(page, "tool_call", {
    id: "wait-reduced",
    name: "wait",
    args: '{"ms":100}',
  });
  const group = page.getByRole("button", { name: "2 steps", exact: true });
  const groupId = await group.getAttribute("aria-controls");
  const groupContent = page.locator(`[id="${groupId}"]`);
  expect(
    await groupContent.evaluate(
      (element) => getComputedStyle(element).animationName,
    ),
  ).toBe("none");
  await group.click();
  await expect(groupContent).toBeHidden();
  await group.click();
  await expect(
    page.getByRole("button", { name: "允许", exact: true }),
  ).toBeVisible();
});
