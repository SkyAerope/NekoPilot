import sharp from "sharp";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { resolve } from "node:path";

const outputDir =
  process.env.REPRO_OUTPUT || "artifacts/background-screenshot-repro";
await mkdir(outputDir, { recursive: true });
const profileDir = resolve(outputDir, `profile-${Date.now()}`);
// 独立配置目录避免触碰用户现有浏览器会话；直接连接 CDP 避免测试框架模拟页面可见性。
const chromeProcess = spawn(
  process.env.CHROME_PATH ||
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
  [
    `--user-data-dir=${profileDir}`,
    "--remote-debugging-port=0",
    "--no-first-run",
    "--no-default-browser-check",
    "--no-sandbox",
    "--disable-search-engine-choice-screen",
    "--window-size=1600,1000",
    "--disable-features=msEdgeFirstRunExperience",
    "about:blank",
  ],
  { windowsHide: true, stdio: "ignore" },
);
let socket;
let nextId = 0;
const pending = new Map();
async function send(method, params = {}, sessionId) {
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`超时: ${method}`));
    }, 15000);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method, params, sessionId }));
  });
}
try {
  let connection;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      connection = (
        await readFile(resolve(profileDir, "DevToolsActivePort"), "utf8")
      )
        .trim()
        .split(/\r?\n/);
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  if (!connection) throw new Error("无法连接复现浏览器");
  socket = new WebSocket(`ws://127.0.0.1:${connection[0]}${connection[1]}`);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve);
    socket.addEventListener("error", reject);
  });
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    clearTimeout(request.timer);
    if (message.error) request.reject(new Error(message.error.message));
    else request.resolve(message.result);
  });
  const html = `
    <style>
      body { margin: 0; background: white }
      section { height: 2000px; background: linear-gradient(#16a34a,#2563eb); color: white; font: 48px sans-serif }
      #marker { position: absolute; top: 950px; left: 30px }
    </style>
    <section>NEKOPILOT TARGET A<div id="marker">VIEWPORT AT 900px</div></section>
  `;
  const { targetId } = await send("Target.createTarget", {
    url: process.env.REPRO_URL || `data:text/html,${encodeURIComponent(html)}`,
  });
  const { sessionId } = await send("Target.attachToTarget", {
    targetId,
    flatten: true,
  });
  const cdp = { send: (method, params) => send(method, params, sessionId) };
  async function evaluate(expression) {
    return (
      await cdp.send("Runtime.evaluate", { expression, returnByValue: true })
    ).result.value;
  }
  await new Promise((resolve) =>
    setTimeout(resolve, process.env.REPRO_URL ? 6000 : 500),
  );
  const results = [];
  async function capture(label, extra = {}) {
    const beforeVisibility = await evaluate("document.visibilityState");
    const metrics = await cdp.send("Page.getLayoutMetrics");
    const {
      clientWidth: width,
      clientHeight: height,
      pageX,
      pageY,
    } = metrics.cssVisualViewport;
    const params = {
      format: "png",
      clip: { x: 0, y: 0, width, height, scale: 1 },
      ...extra,
    };
    const { data } = await cdp.send("Page.captureScreenshot", params);
    const buffer = Buffer.from(data, "base64");
    await writeFile(`${outputDir}/${label}.png`, buffer);
    const stats = await sharp(buffer).stats();
    const visibility = await evaluate("document.visibilityState");
    results.push({
      label,
      beforeVisibility,
      visibility,
      pageX,
      pageY,
      bytes: buffer.length,
      means: stats.channels.map((channel) => channel.mean),
      stdev: stats.channels.map((channel) => channel.stdev),
    });
    console.log(JSON.stringify(results.at(-1)));
  }
  await capture("active");
  await send("Target.createTarget", { url: "about:blank" });
  await new Promise((resolve) => setTimeout(resolve, 500));
  await capture("background");
  await capture("background-no-clip", { clip: undefined });
  const { cssVisualViewport: initialViewport } = await cdp.send(
    "Page.getLayoutMetrics",
  );
  await capture("background-half-scale", {
    clip: {
      x: 0,
      y: 0,
      width: initialViewport.clientWidth,
      height: initialViewport.clientHeight,
      scale: 0.5,
    },
  });
  await capture("background-without-beyond", { captureBeyondViewport: false });
  await capture("background-view", { fromSurface: false });
  await evaluate("window.scrollTo(0, 900)");
  await capture("background-scrolled");
  await capture("background-scrolled-without-beyond", {
    captureBeyondViewport: false,
  });
  await capture("background-scrolled-unclipped", { clip: undefined });
  async function captureWithOffset(label) {
    const { cssVisualViewport: viewport } = await cdp.send(
      "Page.getLayoutMetrics",
    );
    await capture(label, {
      clip: {
        x: viewport.pageX,
        y: viewport.pageY,
        width: viewport.clientWidth,
        height: viewport.clientHeight,
        scale: 1,
      },
    });
  }
  await captureWithOffset("background-scrolled-offset");
  await cdp.send("Page.bringToFront");
  await capture("foreground-scrolled");
  await captureWithOffset("foreground-scrolled-offset");
  await writeFile(
    `${outputDir}/results.json`,
    JSON.stringify(
      {
        browserVersion: await send("Browser.getVersion"),
        results,
      },
      null,
      2,
    ),
  );
} finally {
  if (socket?.readyState === WebSocket.OPEN) {
    await send("Browser.close").catch(() => {});
    socket.close();
  } else {
    chromeProcess.kill();
  }
}
