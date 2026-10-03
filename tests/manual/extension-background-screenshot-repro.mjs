import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import sharp from "sharp";
import { chromium } from "@playwright/test";
import assert from "node:assert/strict";

const outputDir = resolve(
  process.env.REPRO_OUTPUT || "artifacts/extension-background-screenshot-repro",
);
await mkdir(outputDir, { recursive: true });
// 独立浏览器配置目录；使用扩展真实消息链路，避免测试框架模拟页面可见性。
const usePlaywrightTransport = process.env.REPRO_CHANNEL === "msedge";
const browser = usePlaywrightTransport
  ? await chromium.launch({
      channel: "msedge",
      headless: false,
      args: ["--enable-unsafe-extension-debugging", "--window-size=1600,1000"],
      ignoreDefaultArgs: [
        "--disable-extensions",
        "--disable-backgrounding-occluded-windows",
        "--disable-renderer-backgrounding",
        "--disable-background-timer-throttling",
      ],
    })
  : null;
const browserSession = browser ? await browser.newBrowserCDPSession() : null;
const chromeProcess = browser
  ? null
  : spawn(
      process.env.CHROME_PATH ||
        "C:/Program Files/Google/Chrome/Application/chrome.exe",
      [
        `--user-data-dir=${resolve(outputDir, `profile-${Date.now()}`)}`,
        "--remote-debugging-pipe",
        "--enable-unsafe-extension-debugging",
        "--enable-automation",
        "--no-startup-window",
        "--disable-features=msEdgeFirstRunExperience",
        "--no-first-run",
        "--no-default-browser-check",
        "--no-sandbox",
        "--disable-search-engine-choice-screen",
        "--window-size=1600,1000",
        "about:blank",
      ],
      {
        windowsHide: true,
        stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"],
      },
    );
const pending = new Map();
let nextId = 0;
let buffered = "";
function receive(message) {
  const request = pending.get(message.id);
  if (!request) return;
  pending.delete(message.id);
  clearTimeout(request.timer);
  if (message.error) request.reject(new Error(message.error.message));
  else request.resolve(message.result);
}
browserSession?.on("Target.receivedMessageFromTarget", (event) =>
  receive(JSON.parse(event.message)),
);
chromeProcess?.stdio[4].on("data", (chunk) => {
  buffered += chunk.toString();
  let separator;
  while ((separator = buffered.indexOf("\0")) !== -1) {
    const message = JSON.parse(buffered.slice(0, separator));
    buffered = buffered.slice(separator + 1);
    receive(message);
  }
});
function send(method, params = {}, sessionId) {
  if (browserSession && !sessionId) return browserSession.send(method, params);
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(
      () => {
        pending.delete(id);
        reject(new Error(`超时: ${method}`));
      },
      method === "Browser.getVersion" ? 60000 : 15000,
    );
    pending.set(id, { resolve, reject, timer });
    if (browserSession) {
      browserSession
        .send("Target.sendMessageToTarget", {
          sessionId,
          message: JSON.stringify({ id, method, params }),
        })
        .catch((error) => receive({ id, error: { message: error.message } }));
    } else {
      chromeProcess.stdio[3].write(
        `${JSON.stringify({ id, method, params, sessionId })}\0`,
      );
    }
  });
}
async function attach(targetId) {
  return (
    await send("Target.attachToTarget", { targetId, flatten: !browserSession })
  ).sessionId;
}
async function evaluate(sessionId, expression) {
  const result = await send(
    "Runtime.evaluate",
    {
      expression,
      returnByValue: true,
      awaitPromise: true,
    },
    sessionId,
  );
  if (result.exceptionDetails) {
    throw new Error(
      result.exceptionDetails.exception?.description ||
        result.exceptionDetails.text,
    );
  }
  return result.result.value;
}
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
try {
  console.log(JSON.stringify(await send("Browser.getVersion")));
  const { id: extensionId } = await send("Extensions.loadUnpacked", {
    path: resolve("dist"),
  });
  const { targetId: controlId } = await send("Target.createTarget", {
    url: `chrome-extension://${extensionId}/options.html`,
  });
  const controlSession = await attach(controlId);
  await pause(1000);
  async function message(type, payload) {
    return evaluate(
      controlSession,
      `chrome.runtime.sendMessage(${JSON.stringify({ type, payload })})`,
    );
  }
  const html = `<!doctype html><style>
    body { margin: 0; background: white }
    main { min-height: 2000px; background: linear-gradient(#16a34a,#2563eb); color: white; font: 48px sans-serif }
  </style><main>NEKOPILOT AT TOP</main>`;
  const targetUrl =
    process.env.REPRO_URL || `data:text/html,${encodeURIComponent(html)}`;
  const { targetId } = await send("Target.createTarget", { url: targetUrl });
  await pause(process.env.REPRO_URL ? 6000 : 500);
  const targetSession = await attach(targetId);
  if (process.env.REPRO_URL) {
    let loaded = false;
    for (let attempt = 0; attempt < 25; attempt++) {
      loaded = await evaluate(targetSession, "!!document.body && document.body.innerText.length > 100");
      if (loaded) break;
      await pause(1000);
    }
    assert.ok(loaded, "目标页面尚未加载内容，无法验证截图");
  }
  // 按调试目标 ID 查询，避免页面重定向或加载中的 URL 变化导致选错标签页。
  const tabId = await evaluate(
    controlSession,
    `(async () => (await chrome.debugger.getTargets()).find(target => target.id === ${JSON.stringify(targetId)})?.tabId)()`,
  );
  const selected = await message("target:switch", { tabId });
  if (selected.error) throw new Error(selected.error);
  const results = [];
  async function capture(label, params) {
    const state = await evaluate(
      targetSession,
      `({ visibility: document.visibilityState, scrollX, scrollY, readyState: document.readyState, devicePixelRatio, title: document.title, width: innerWidth, height: innerHeight })`,
    );
    const response = params
      ? {
          result: {
            success: true,
            data: await evaluate(
              controlSession,
              `chrome.debugger.sendCommand({ tabId: ${tabId} }, "Page.captureScreenshot", ${JSON.stringify(params)})`,
            ),
          },
        }
      : await message("tool:execute", { name: "screenshot", params: {} });
    if (!response.result?.success) throw new Error(JSON.stringify(response));
    const buffer = Buffer.from(response.result.data.data, "base64");
    await writeFile(resolve(outputDir, `${label}.png`), buffer);
    const stats = await sharp(buffer).stats();
    if (!params) {
      const metadata = await sharp(buffer).metadata();
      assert.ok(
        metadata.width * metadata.height <= 1150000,
        "截图超出像素预算",
      );
      assert.ok(
        Math.max(metadata.width, metadata.height) <= 1568,
        "截图超出长边限制",
      );
      assert.ok(
        stats.channels.slice(0, 3).some((channel) => channel.stdev > 1),
        "测试页面截图为空白",
      );
      if (label === "background-top") assert.equal(state.visibility, "hidden");
    }
    const result = {
      label,
      ...state,
      bytes: buffer.length,
      means: stats.channels.map((channel) => channel.mean),
      stdev: stats.channels.map((channel) => channel.stdev),
    };
    results.push(result);
    console.log(JSON.stringify(result));
  }
  await capture("foreground-top");
  await send("Target.createTarget", { url: "about:blank" });
  await pause(500);
  await capture("background-top");
  await capture("background-top-no-clip", { format: "png" });
  const metrics = await evaluate(
    controlSession,
    `chrome.debugger.sendCommand({ tabId: ${tabId} }, "Page.getLayoutMetrics")`,
  );
  const { clientWidth: width, clientHeight: height } =
    metrics.cssVisualViewport;
  for (const scale of [1, 0.5]) {
    await capture(`background-top-clip-${scale}`, {
      format: "png",
      clip: { x: 0, y: 0, width, height, scale },
    });
  }
  const original = await sharp(resolve(outputDir, "background-top-no-clip.png"))
    .resize(Math.round(width * 0.5), Math.round(height * 0.5))
    .png()
    .toFile(resolve(outputDir, "background-top-resized-after-capture.png"));
  console.log("本地缩放尺寸", original.width, original.height);
  const processed = await evaluate(
    controlSession,
    `(async () => {
    const { data } = await chrome.debugger.sendCommand({ tabId: ${tabId} }, 'Page.captureScreenshot', { format: 'png' });
    const source = Uint8Array.from(atob(data), character => character.charCodeAt(0));
    const bitmap = await createImageBitmap(new Blob([source], { type: 'image/png' }));
    const scale = Math.min(1, 1568 / Math.max(${width}, ${height}), Math.sqrt(1150000 / (${width} * ${height})));
    const canvas = new OffscreenCanvas(Math.max(1, Math.round(${width} * scale)), Math.max(1, Math.round(${height} * scale)));
    const context = canvas.getContext('2d');
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    const blob = await canvas.convertToBlob({ type: 'image/png' });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 32768) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
    }
    return { data: btoa(binary), width: canvas.width, height: canvas.height };
  })()`,
  );
  const processedBuffer = Buffer.from(processed.data, "base64");
  await writeFile(
    resolve(outputDir, "background-top-offscreen-resized.png"),
    processedBuffer,
  );
  const processedStats = await sharp(processedBuffer).stats();
  results.push({
    label: "background-top-offscreen-resized",
    width: processed.width,
    height: processed.height,
    stdev: processedStats.channels.map((channel) => channel.stdev),
  });
  console.log(JSON.stringify(results.at(-1)));
  await pause(3000);
  await capture("background-top-delayed");
  await send(
    "Page.navigate",
    {
      url: `data:text/html,${encodeURIComponent(html.replace("NEKOPILOT AT TOP", "NAVIGATED WHILE HIDDEN"))}`,
    },
    targetSession,
  );
  await pause(1000);
  await capture("background-top-after-navigation");
  const deferredHtml = `<!doctype html><style>body { margin: 0; background: white }</style>
    <canvas id="scene" width="700" height="500"></canvas>
    <script>
      window.frameCount = 0;
      requestAnimationFrame(() => requestAnimationFrame(() => {
        const context = document.getElementById('scene').getContext('2d');
        context.fillStyle = '#2563eb';
        context.fillRect(0, 0, 700, 500);
        context.fillStyle = 'white';
        context.font = '32px sans-serif';
        context.fillText('PAINTED AT TOP', 30, 100);
        window.frameCount = 2;
      }));
    </script>`;
  await send(
    "Page.navigate",
    {
      url: `data:text/html,${encodeURIComponent(deferredHtml)}`,
    },
    targetSession,
  );
  await pause(1000);
  await capture("background-top-deferred-paint");
  console.log(
    "后台绘制帧数",
    await evaluate(targetSession, "window.frameCount"),
  );
  await send("Page.bringToFront", {}, targetSession);
  await pause(500);
  await capture("foreground-top-deferred-paint");
  console.log(
    "前台绘制帧数",
    await evaluate(targetSession, "window.frameCount"),
  );
  await writeFile(
    resolve(outputDir, "results.json"),
    JSON.stringify(results, null, 2),
  );
} finally {
  if (browser) await browser.close();
  else await send("Browser.close").catch(() => chromeProcess.kill());
}
