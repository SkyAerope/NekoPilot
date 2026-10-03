import { expect, test } from "@playwright/test";

test("流式公式正文末尾不出现孤立美元符号", async ({ page }) => {
  await page.addInitScript(() => {
    const listeners = new Set<(message: unknown) => void>();
    const storage: Record<string, unknown> = {
      settings: {
        apiKey: "test-key",
        model: "custom-model",
        baseUrl: "https://example.invalid/v1",
      },
    };
    Object.defineProperty(window, "chrome", {
      value: {
        runtime: {
          onMessage: {
            addListener: (listener: (message: unknown) => void) =>
              listeners.add(listener),
            removeListener: (listener: (message: unknown) => void) =>
              listeners.delete(listener),
          },
          sendMessage: (
            message: { type: string },
            callback: (result: unknown) => void,
          ) => {
            queueMicrotask(() =>
              callback(message.type === "settings:get" ? storage.settings : {}),
            );
          },
        },
        storage: {
          onChanged: { addListener: () => {}, removeListener: () => {} },
          local: {
            onChanged: { addListener: () => {}, removeListener: () => {} },
            get: (
              keys: string | string[],
              callback: (result: unknown) => void,
            ) => {
              queueMicrotask(() =>
                callback(
                  Object.fromEntries(
                    (typeof keys === "string" ? [keys] : keys).map((key) => [
                      key,
                      storage[key],
                    ]),
                  ),
                ),
              );
            },
            set: (values: Record<string, unknown>) =>
              Object.assign(storage, values),
            remove: () => {},
          },
        },
      },
    });
    (
      window as unknown as { emitRepro: (type: string, data: unknown) => void }
    ).emitRepro = (type, data) =>
      listeners.forEach((listener) =>
        listener({ type: "agent:event", payload: { type, data } }),
      );
  });

  const cases = [
    { name: "普通行内公式", content: "公式：$x^2 + y^2$\n\n正文结束。" },
    {
      name: "普通块级公式",
      content: "公式：\n\n$$\nx^2 + y^2\n$$\n\n正文结束。",
    },
    {
      name: "三个美元定界符",
      content: "公式：\n\n$$$\nx^2 + y^2\n$$$\n\n正文结束。",
    },
    {
      name: "金额和公式混排",
      content: "价格 $20，公式：$x^2 + y^2$\n\n正文结束。",
    },
    {
      name: "单反引号代码和公式",
      content: "代码：`$20`\n\n公式：$x^2 + y^2$\n\n正文结束。",
      codeText: "$20",
    },
    {
      name: "双反引号代码和公式",
      content: "代码：``$20``\n\n公式：$x^2 + y^2$\n\n正文结束。",
      codeText: "$20",
    },
    {
      name: "行内代码含反引号与方括号",
      content: "代码：``$20 ` [x=1]``\n\n公式：$x^2 + y^2$\n\n正文结束。",
      codeText: "$20 ` [x=1]",
    },
    {
      name: "波浪代码围栏和公式",
      content:
        "~~~js\nconst price = '$20';\n~~~\n\n公式：$x^2 + y^2$\n\n正文结束。",
      codeText: "const price = '$20';",
    },
    {
      name: "长代码围栏内部含短围栏与方括号",
      content:
        "````text\n```\n$20 [x=1]\n```\n````\n\n公式：$x^2 + y^2$\n\n正文结束。",
      codeText: "```\n$20 [x=1]\n```",
    },
    {
      name: "列表内代码围栏和公式",
      content:
        "- 示例：\n  ```js\n  const price = '$20';\n  ```\n\n公式：$x^2 + y^2$\n\n正文结束。",
      codeText: "const price = '$20';",
    },
  ];

  for (const sample of cases) {
    await page.goto("/sidepanel.html");
    await page.getByRole("textbox", { name: "任务内容" }).fill("输出公式");
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "停止", exact: true }),
    ).toBeVisible();
    const emit = async (type: string, data: unknown) =>
      page.evaluate(
        ({ type, data }) => {
          (
            window as unknown as {
              emitRepro: (type: string, data: unknown) => void;
            }
          ).emitRepro(type, data);
        },
        { type, data },
      );
    await emit("message", "");
    const markdown = page.locator(".markdown").last();
    const endMarker = sample.content.indexOf("正文结束。");
    const mathStart = sample.content.lastIndexOf("$x^2");
    if (mathStart >= 0 && sample.name !== "金额和公式混排") {
      // 公式未闭合时仍应预览，确保修复没有直接禁用流式补全。
      const previewEnd = mathStart + "$x^2".length;
      await emit("message_delta", sample.content.slice(0, previewEnd));
      await expect(markdown.locator(".katex")).toHaveCount(1);
      await emit("message_delta", sample.content.slice(previewEnd, endMarker));
    } else {
      await emit("message_delta", sample.content.slice(0, endMarker));
    }
    await emit("message_delta", sample.content.slice(endMarker));
    await expect(markdown).toContainText("正文结束。");
    await expect(markdown).toHaveText(/正文结束。$/, { useInnerText: true });
    await expect(markdown.locator(".katex-error")).toHaveCount(0);
    if (sample.name !== "金额和公式混排") {
      await expect(markdown.locator(".katex")).toHaveCount(1);
    }
    if (sample.codeText) {
      await expect(markdown.locator("code")).toContainText(sample.codeText, {
        useInnerText: true,
      });
    }
    await emit("assistant_turn_done", {});
    await emit("done", {});
    await expect(
      page.getByRole("button", { name: "停止", exact: true }),
    ).toHaveCount(0);
    await expect(markdown).toHaveText(/正文结束。$/, { useInnerText: true });
  }
});
