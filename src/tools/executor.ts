// Tool 执行器 — 将 tool 调用映射到具体 CDP 操作

import type { CdpManager } from "../background/cdp";
import { JsSandbox } from "./jsSandbox";
import type { ToolResult } from "./types";

export type ScreenshotScaleMode = "off" | "claude46" | "claude47" | "custom";

export class ToolExecutor {
  private sandbox = new JsSandbox();
  private codeExecutionEnabled = true;
  private codeExecutionTimeoutMs = 1000;
  private codeExecutionMaxOutputChars = 6000;

  constructor(private cdp: CdpManager) {}

  // ── 短引用（#n）支持 ──
  // 在一次对话中，read_page_interactive / find_element 返回的元素会附带 ref: "#n"；
  // 模型后续可以把 #n 用作 selector，executor 会把它还原为真实 CSS 选择器。
  private shortRefMap = new Map<string, string>();
  private shortRefCounter = 0;
  private shortRefsEnabled = false;
  // 截图缩放：将截图限制在 API 图像限制内，同时归一化高 DPI 坐标。
  // 模型看到的是"显示坐标空间"(视口×k)，执行时换算回视口坐标。
  private screenshotScaleMode: ScreenshotScaleMode = "claude46";
  private screenshotMaxLongEdge = 1568;
  private screenshotMaxPixels = 1_150_000;

  configureShortRefs(enabled: boolean): void {
    this.shortRefsEnabled = enabled;
  }
  configureScreenshotScaling(
    mode: ScreenshotScaleMode,
    maxLongEdge?: number,
    maxPixels?: number,
  ): void {
    this.screenshotScaleMode = mode;
    if (mode === "custom") {
      this.screenshotMaxLongEdge = Math.max(0, Math.round(maxLongEdge ?? 0));
      this.screenshotMaxPixels = Math.max(0, Math.round(maxPixels ?? 0));
    }
  }
  configureCodeExecution(options: {
    enabled?: boolean;
    timeoutMs?: number;
    maxOutputChars?: number;
  }): void {
    this.codeExecutionEnabled = options.enabled !== false;
    if (typeof options.timeoutMs === "number") {
      this.codeExecutionTimeoutMs = Math.max(50, Math.round(options.timeoutMs));
    }
    if (typeof options.maxOutputChars === "number") {
      this.codeExecutionMaxOutputChars = Math.max(256, Math.round(options.maxOutputChars));
    }
  }
  resetShortRefs(): void {
    this.shortRefMap.clear();
    this.shortRefCounter = 0;
  }
  private allocShortRef(selector: string): string {
    const id = `#${++this.shortRefCounter}`;
    this.shortRefMap.set(id, selector);
    return id;
  }
  /** 若 input 是对话内分配过的 #n 短引用，则还原为真实选择器；否则原样返回 */
  private resolveShortRef(selector: string): string {
    if (!this.shortRefsEnabled) return selector;
    if (/^#\d+$/.test(selector) && this.shortRefMap.has(selector)) {
      return this.shortRefMap.get(selector)!;
    }
    return selector;
  }

  /**
   * 对 readPageInteractive / findElement 返回的 YAML 文本做后处理：
   * 将每条列表项的 selector 值替换为分配到的 #n 短引用（真实 selector 保存在 shortRefMap，
   * 后续 click/keyboard_type 等调用时由 resolveShortRef 还原）。
   * 禁用短引用时直接返回原文。
   */
  private annotateShortRefs(text: string): string {
    if (!this.shortRefsEnabled) return text;
    const lines = text.split("\n");
    // 匹配形如 `- selector: "xxx"` 或 `  selector: "xxx"` 的行，捕获前缀与原值
    const re = /^(\s*-?\s*selector:\s*)(".*"|'.*'|\S.*)$/;
    return lines
      .map((line) => {
        const m = line.match(re);
        if (!m) return line;
        const prefix = m[1];
        const rawVal = m[2].trim();
        let selector: string;
        try {
          selector = JSON.parse(rawVal);
        } catch {
          if ((rawVal.startsWith('"') && rawVal.endsWith('"')) || (rawVal.startsWith("'") && rawVal.endsWith("'"))) {
            selector = rawVal.slice(1, -1);
          } else {
            selector = rawVal;
          }
        }
        if (!selector) return line;
        const ref = this.allocShortRef(selector);
        return `${prefix}${JSON.stringify(ref)}`;
      })
      .join("\n");
  }

  /** 安全执行 JS 表达式，检查 CDP exceptionDetails */
  private async evaluate<T = string>(expression: string): Promise<T> {
    const result = await this.cdp.send<{
      result: { value: T };
      exceptionDetails?: { exception?: { description?: string }; text?: string };
    }>("Runtime.evaluate", { expression, returnByValue: true });
    if (result.exceptionDetails) {
      const desc = result.exceptionDetails.exception?.description || result.exceptionDetails.text || "Unknown JS error";
      throw new Error(`Page script error: ${desc}`);
    }
    return result.result.value;
  }

  // ── 截图缩放与坐标空间换算 ──

  /** 当前模式下的缩放限制；null 表示不缩放 */
  private getScaleLimits(): { maxLongEdge: number; maxPixels: number } | null {
    switch (this.screenshotScaleMode) {
      case "off":
        return null;
      case "claude46":
        return { maxLongEdge: 1568, maxPixels: 1_150_000 };
      case "claude47":
        return { maxLongEdge: 2576, maxPixels: 3_750_000 };
      case "custom":
        return { maxLongEdge: this.screenshotMaxLongEdge, maxPixels: this.screenshotMaxPixels };
    }
  }

  /** CSS 视口尺寸（CSS px，与页面脚本 getBoundingClientRect 同一坐标系） */
  private async getViewportSize(): Promise<{ width: number; height: number }> {
    const metrics = await this.cdp.send<{
      cssVisualViewport?: { clientWidth: number; clientHeight: number };
      cssLayoutViewport?: { clientWidth: number; clientHeight: number };
    }>("Page.getLayoutMetrics", {});
    const vp = metrics.cssVisualViewport ?? metrics.cssLayoutViewport;
    if (!vp || !vp.clientWidth || !vp.clientHeight) {
      throw new Error("Failed to get viewport size from Page.getLayoutMetrics");
    }
    return { width: vp.clientWidth, height: vp.clientHeight };
  }

  /** 计算缩放系数 k（≤1）：显示坐标 = 视口坐标 × k；0 表示该项无限制 */
  private computeScale(width: number, height: number): number {
    const limits = this.getScaleLimits();
    if (!limits) return 1;
    let k = 1;
    if (limits.maxPixels > 0) {
      k = Math.min(k, Math.sqrt(limits.maxPixels / (width * height)));
    }
    if (limits.maxLongEdge > 0) {
      k = Math.min(k, limits.maxLongEdge / Math.max(width, height));
    }
    return Math.min(1, k);
  }

  /** 按当前视口即时计算缩放系数 */
  private async getScaleFactor(): Promise<number> {
    if (this.screenshotScaleMode === "off") return 1;
    const { width, height } = await this.getViewportSize();
    return this.computeScale(width, height);
  }

  async execute(
    name: string,
    params: Record<string, unknown>
  ): Promise<ToolResult> {
    try {
      const data = await this.dispatch(name, params);
      return { success: true, data };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  }

  private async dispatch(
    name: string,
    params: Record<string, unknown>
  ): Promise<unknown> {
    switch (name) {
      case "execute_js":
        return this.executeJs(
          params.description as string,
          params.code as string,
        );
      case "screenshot":
        return this.screenshot();
      case "read_page_text":
        return this.readPageText(
          (params.limit as number) ?? 4096,
          (params.offset as number) ?? 0
        );
      case "read_page":
        return this.readPage();
      case "read_page_interactive":
        return this.readPageInteractive();
      case "click":
        await this.click(
          params.x as number | undefined,
          params.y as number | undefined,
          params.selector as string | undefined,
          (params.jsClick as boolean | undefined) ?? false,
        );
        return "done";
      case "keyboard_type":
        await this.keyboardType(
          params.text as string | undefined,
          params.key as string | undefined,
          params.selector as string | undefined,
          params.method as "js" | "key" | undefined,
          (params.pressEnter as boolean | undefined) ?? false,
          (params.clear as boolean | undefined) ?? true,
        );
        return "done";
      case "scroll":
        await this.scroll(
          params.x as number,
          params.y as number,
          (params.deltaX as number) ?? 0,
          params.deltaY as number
        );
        return "done";
      case "drag":
        await this.drag(
          params.startX as number,
          params.startY as number,
          params.endX as number,
          params.endY as number,
          (params.steps as number) ?? 10
        );
        return "done";
      case "navigate":
        await this.navigate(params.url as string);
        return "done";
      case "wait":
        await this.wait(params.ms as number);
        return "done";
      case "find_element":
        return this.findElement(
          params.text as string,
          (params.limit as number) ?? 10,
          (params.tagFilter as string) ?? ""
        );
      case "get_element_text":
        return this.getElementText(
          params.selector as string,
          (params.limit as number) ?? 2048,
          (params.offset as number) ?? 0
        );
      case "hover":
        await this.hover(
          params.x as number | undefined,
          params.y as number | undefined,
          params.selector as string | undefined,
        );
        return "done";
      case "handle_dialog":
        await this.handleDialog(
          (params.accept as boolean | undefined) ?? true,
          params.promptText as string | undefined,
        );
        return "done";
      case "get_element_rect":
        return this.getElementRect(params.selector as string);
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  }

  /** 检查 CSS 选择器是否能匹配到可见元素，返回 true/false */
  async checkElement(selector: string): Promise<boolean> {
    selector = this.resolveShortRef(selector);
    const expr = `(function() {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 || r.height > 0;
    })()`;
    return this.evaluate<boolean>(expr);
  }

  /** 解析 CSS 选择器为元素中心点坐标，元素不存在返回 null */
  async resolveSelectorCenter(selector: string): Promise<{ x: number; y: number } | null> {
    selector = this.resolveShortRef(selector);
    const expr = `(function() {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    })()`;
    return this.evaluate<{ x: number; y: number } | null>(expr);
  }

  // ── Click 坐标标记 ──

  async showClickMarker(x: number, y: number): Promise<void> {
    // 传入的是模型（显示空间）坐标，换算回视口坐标
    const k = await this.getScaleFactor();
    x = Math.round(x / k);
    y = Math.round(y / k);
    const expression = `
      (function() {
        // 递增 token 让任何残留的 anchored marker rAF 循环停止
        window.__nekopilotMarkerToken = (window.__nekopilotMarkerToken || 0) + 1;
        let m = document.getElementById('__nekopilot-click-marker');
        if (m) m.remove();
        m = document.createElement('div');
        m.id = '__nekopilot-click-marker';
        m.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;'
          + 'left:' + (${x} - 12) + 'px;top:' + (${y} - 12) + 'px;'
          + 'width:24px;height:24px;border-radius:50%;'
          + 'border:2px solid #ef4444;background:rgba(239,68,68,0.2);'
          + 'box-shadow:0 0 0 4px rgba(239,68,68,0.1);'
          + 'animation:__neko-pulse 1s ease-in-out infinite;';
        const style = document.createElement('style');
        style.id = '__nekopilot-click-marker-style';
        style.textContent = '@keyframes __neko-pulse{0%,100%{transform:scale(1);opacity:1}50%{transform:scale(1.4);opacity:0.6}}';
        document.head.appendChild(style);
        const dot = document.createElement('div');
        dot.style.cssText = 'position:absolute;left:50%;top:50%;width:6px;height:6px;border-radius:50%;background:#ef4444;transform:translate(-50%,-50%);';
        m.appendChild(dot);
        document.body.appendChild(m);
      })()
    `;
    await this.cdp.send("Runtime.evaluate", { expression });
  }

  async removeClickMarker(): Promise<void> {
    await this.cdp.send("Runtime.evaluate", {
      expression: "(function(){window.__nekopilotMarkerToken=(window.__nekopilotMarkerToken||0)+1;document.getElementById('__nekopilot-click-marker')?.remove();document.getElementById('__nekopilot-click-marker-style')?.remove();document.getElementById('__nekopilot-input-marker')?.remove();})()",
    });
  }

  /** 给 selector 指向的元素绑定一个跟随位置的高亮 marker。variant 控制外观。 */
  private async showAnchoredMarker(selector: string, variant: "click" | "input"): Promise<void> {
    selector = this.resolveShortRef(selector);
    const selJson = JSON.stringify(selector);
    const isClick = variant === "click";
    const expression = `
      (function() {
        // 每次调用都递增 token，旧的 rAF 循环检测到不等就自动停。
        const token = ((window.__nekopilotMarkerToken || 0) + 1);
        window.__nekopilotMarkerToken = token;

        const markerId = ${isClick ? "'__nekopilot-click-marker'" : "'__nekopilot-input-marker'"};
        const old = document.getElementById(markerId);
        if (old) old.remove();

        // 公用 keyframes 样式容器
        let style = document.getElementById('__nekopilot-click-marker-style');
        if (!style) {
          style = document.createElement('style');
          style.id = '__nekopilot-click-marker-style';
          document.head.appendChild(style);
        }
        const keyframes = [
          '@keyframes __neko-pulse{0%,100%{transform:scale(1);opacity:1}50%{transform:scale(1.4);opacity:0.6}}',
          '@keyframes __neko-input-pulse{0%,100%{opacity:1}50%{opacity:0.5}}',
        ].filter(k => !(style.textContent || '').includes(k.split('{')[0]));
        if (keyframes.length) style.textContent = (style.textContent || '') + keyframes.join('');

        const m = document.createElement('div');
        m.id = markerId;
        if (${isClick}) {
          m.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;'
            + 'width:24px;height:24px;border-radius:50%;'
            + 'border:2px solid #ef4444;background:rgba(239,68,68,0.2);'
            + 'box-shadow:0 0 0 4px rgba(239,68,68,0.1);'
            + 'animation:__neko-pulse 1s ease-in-out infinite;'
            + 'left:-9999px;top:-9999px;';
          const dot = document.createElement('div');
          dot.style.cssText = 'position:absolute;left:50%;top:50%;width:6px;height:6px;border-radius:50%;background:#ef4444;transform:translate(-50%,-50%);';
          m.appendChild(dot);
        } else {
          m.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;'
            + 'border:2px solid #a78bfa;border-radius:6px;'
            + 'background:rgba(167,139,250,0.12);'
            + 'box-shadow:0 0 0 4px rgba(167,139,250,0.15);'
            + 'animation:__neko-input-pulse 1.2s ease-in-out infinite;'
            + 'left:-9999px;top:-9999px;width:0;height:0;';
        }
        document.body.appendChild(m);

        function update() {
          // token 变化说明有新 marker 或被主动 remove，旧循环停止
          if (window.__nekopilotMarkerToken !== token) return;
          const el = document.querySelector(${selJson});
          if (!el || !document.contains(m)) {
            m.remove();
            return;
          }
          const r = el.getBoundingClientRect();
          if (r.width === 0 && r.height === 0) {
            // 元素暂时不可见，先藏起来但保留循环
            m.style.left = '-9999px';
            m.style.top = '-9999px';
          } else if (${isClick}) {
            const cx = r.left + r.width / 2;
            const cy = r.top + r.height / 2;
            m.style.left = (cx - 12) + 'px';
            m.style.top = (cy - 12) + 'px';
          } else {
            m.style.left = (r.left - 4) + 'px';
            m.style.top = (r.top - 4) + 'px';
            m.style.width = (r.width + 8) + 'px';
            m.style.height = (r.height + 8) + 'px';
          }
          requestAnimationFrame(update);
        }
        requestAnimationFrame(update);
      })()
    `;
    await this.cdp.send("Runtime.evaluate", { expression });
  }

  /** 在目标输入框周围显示跟随元素位置的脉动高亮框 */
  async showInputMarker(selector: string): Promise<void> {
    return this.showAnchoredMarker(selector, "input");
  }

  /** 在目标点击元素中心显示跟随位置的红色 marker */
  async showAnchoredClickMarker(selector: string): Promise<void> {
    return this.showAnchoredMarker(selector, "click");
  }

  /** 显示 scroll 位置标记（带方向箭头） */
  async showScrollMarker(x: number, y: number, deltaX: number, deltaY: number): Promise<void> {
    // 传入的是模型（显示空间）坐标，换算回视口坐标；delta 仅用于箭头方向无需换算
    const k = await this.getScaleFactor();
    x = Math.round(x / k);
    y = Math.round(y / k);
    // 计算箭头方向：以最大分量为准；若两轴均为 0 则按向下处理
    const absX = Math.abs(deltaX);
    const absY = Math.abs(deltaY);
    let arrow = "↓";
    if (absX > absY) arrow = deltaX > 0 ? "→" : "←";
    else if (absY > 0) arrow = deltaY > 0 ? "↓" : "↑";
    const expression = `
      (function() {
        window.__nekopilotMarkerToken = (window.__nekopilotMarkerToken || 0) + 1;
        let m = document.getElementById('__nekopilot-click-marker');
        if (m) m.remove();
        m = document.createElement('div');
        m.id = '__nekopilot-click-marker';
        m.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;'
          + 'left:' + (${x} - 18) + 'px;top:' + (${y} - 18) + 'px;'
          + 'width:36px;height:36px;border-radius:50%;'
          + 'border:2px solid #3b82f6;background:rgba(59,130,246,0.18);'
          + 'box-shadow:0 0 0 4px rgba(59,130,246,0.1);'
          + 'display:flex;align-items:center;justify-content:center;'
          + 'font:bold 20px/1 system-ui,sans-serif;color:#3b82f6;'
          + 'animation:__neko-scroll-pulse 1s ease-in-out infinite;';
        const style = document.createElement('style');
        style.id = '__nekopilot-click-marker-style';
        style.textContent = '@keyframes __neko-scroll-pulse{0%,100%{transform:scale(1);opacity:1}50%{transform:scale(1.15);opacity:0.7}}';
        document.head.appendChild(style);
        m.textContent = ${JSON.stringify(arrow)};
        document.body.appendChild(m);
      })()
    `;
    await this.cdp.send("Runtime.evaluate", { expression });
  }

  // ── 具体 Tool 实现 ──

  private async screenshot(): Promise<{ data: string; mime: string }> {
    if (this.screenshotScaleMode === "off") {
      const result = await this.cdp.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
      return { data: result.data, mime: "image/png" };
    }
    // clip 以 CSS px 为单位：同时完成高 DPI 归一化（DPR>1 时输出不再是设备像素）
    // 与降采样到 API 图像限制内（scale=k）。
    const { width, height } = await this.getViewportSize();
    const k = this.computeScale(width, height);
    const result = await this.cdp.send<{ data: string }>("Page.captureScreenshot", {
      format: "png",
      clip: { x: 0, y: 0, width, height, scale: k },
    });
    return { data: result.data, mime: "image/png" };
  }

  private async executeJs(description: string, code: string): Promise<{
    result: unknown;
    logs: string[];
    truncated: boolean;
    timeoutMs: number;
  }> {
    if (!this.codeExecutionEnabled) {
      throw new Error("代码执行工具当前已禁用");
    }
    return this.sandbox.execute(code, description, {
      timeoutMs: this.codeExecutionTimeoutMs,
      maxOutputChars: this.codeExecutionMaxOutputChars,
    });
  }

  private async readPageText(limit: number, offset: number): Promise<string> {
    const expression = `
      (function() {
        const full = document.body.innerText;
        const text = full.slice(${offset}, ${offset} + ${limit});
        return 'text: |\\n  ' + text.replace(/\\n/g, '\\n  ')
          + '\\ntotalLength: ' + full.length
          + '\\noffset: ' + ${offset}
          + '\\nlimit: ' + ${limit};
      })()
    `;
    return this.evaluate(expression);
  }

  private async readPage(): Promise<string> {
    // 输出坐标乘以缩放系数，与截图坐标空间保持一致
    const K = await this.getScaleFactor();
    const expression = `
      (function() {
        const K = ${K};
        function simplify(el, depth) {
          if (depth > 6) return null;
          const rect = el.getBoundingClientRect();
          const tag = el.tagName.toLowerCase();
          const role = el.getAttribute('role') || '';
          const text = el.childNodes.length === 1 && el.childNodes[0].nodeType === 3
            ? (function() { var t = el.childNodes[0].textContent?.trim() || ''; return t.length > 80 ? t.slice(0, 80) + '...(+' + (t.length - 80) + ' chars)' : t; })() : '';
          const children = Array.from(el.children)
            .map(c => simplify(c, depth + 1))
            .filter(Boolean);
          if (!role && !text && children.length === 0 && !['input','button','a','select','textarea','img'].includes(tag)) return null;
          return { tag, role, text,
            ref: tag + '[' + Array.from(el.parentElement?.children || []).indexOf(el) + ']',
            rect: { x: Math.round(rect.x * K), y: Math.round(rect.y * K), w: Math.round(rect.width * K), h: Math.round(rect.height * K) },
            children: children.length ? children : undefined
          };
        }
        function toYaml(obj, indent) {
          if (obj === null || obj === undefined) return 'null';
          const pad = '  '.repeat(indent);
          if (Array.isArray(obj)) {
            if (obj.length === 0) return '[]';
            return obj.map(item => pad + '- ' + toYaml(item, indent + 1).trimStart()).join('\\n');
          }
          if (typeof obj === 'object') {
            const entries = Object.entries(obj).filter(([,v]) => v !== undefined && v !== '');
            if (entries.length === 0) return '{}';
            return entries.map(([k, v]) => {
              if (typeof v === 'object' && v !== null) {
                return pad + k + ':\\n' + toYaml(v, indent + 1);
              }
              return pad + k + ': ' + v;
            }).join('\\n');
          }
          return String(obj);
        }
        return toYaml(simplify(document.body, 0), 0);
      })()
    `;
    return this.evaluate(expression);
  }

  private async readPageInteractive(): Promise<string> {
    // 输出坐标乘以缩放系数，与截图坐标空间保持一致
    const K = await this.getScaleFactor();
    const expression = `
      (function() {
        const K = ${K};
        const selectors = 'a, button, input, select, textarea, [role="button"], [role="link"], [role="checkbox"], [role="radio"], [tabindex], [onclick]';
        const elements = document.querySelectorAll(selectors);
        const lines = [];
        elements.forEach((el, i) => {
          try {
            const rect = el.getBoundingClientRect();
            if (rect.width === 0 && rect.height === 0) return;
            const tag = el.tagName.toLowerCase();
            const type = el.getAttribute('type') || '';
            const role = el.getAttribute('role') || '';
            const rawText = (el.textContent || '').trim();
            const text = rawText.length > 80 ? rawText.slice(0, 80) + '...(+' + (rawText.length - 80) + ' chars)' : rawText;
            const ph = el.getAttribute('placeholder') || '';
            const val = ('value' in el && typeof el.value === 'string') ? el.value : '';
            // 生成唯一 CSS 选择器
            var selector = '';
            if (el.id) { selector = '#' + CSS.escape(el.id); }
            else {
              var parts = [];
              var cur = el;
              while (cur && cur !== document.body && cur !== document.documentElement) {
                var parent = cur.parentElement;
                if (!parent) break;
                var idx = Array.from(parent.children).indexOf(cur) + 1;
                parts.unshift(cur.tagName.toLowerCase() + ':nth-child(' + idx + ')');
                cur = parent;
              }
              selector = parts.length > 0 ? parts.join(' > ') : tag;
            }
            lines.push('- selector: ' + JSON.stringify(selector));
            lines.push('  tag: ' + tag);
            if (type) lines.push('  type: ' + JSON.stringify(type));
            if (role) lines.push('  role: ' + JSON.stringify(role));
            if (text) lines.push('  text: ' + JSON.stringify(text));
            if (ph) lines.push('  placeholder: ' + JSON.stringify(ph));
            if (val) lines.push('  value: ' + JSON.stringify(val));
            lines.push('  position: {x: ' + (rect.x * K).toFixed(0) + ', y: ' + (rect.y * K).toFixed(0) + ', width: ' + (rect.width * K).toFixed(0) + ', height: ' + (rect.height * K).toFixed(0) + '}');
            lines.push('  center: {x: ' + ((rect.x + rect.width / 2) * K).toFixed(0) + ', y: ' + ((rect.y + rect.height / 2) * K).toFixed(0) + '}');
          } catch(e) { /* 跳过异常元素 */ }
        });
        if (lines.length === 0) return 'no_results: 当前页面没有可见的可交互元素';
        return lines.join('\\n');
      })()
    `;
    const raw = await this.evaluate<string>(expression);
    return this.annotateShortRefs(raw);
  }

  private async click(x?: number, y?: number, selector?: string, jsClick = false): Promise<void> {
    // 场景 1: 使用 selector —— 先 scrollIntoViewIfNeeded，再按 jsClick 分派
    if (selector) {
      selector = this.resolveShortRef(selector);
      const selJson = JSON.stringify(selector);
      const prepExpr = `(function() {
        const el = document.querySelector(${selJson});
        if (!el) return null;
        if (typeof el.scrollIntoViewIfNeeded === 'function') {
          el.scrollIntoViewIfNeeded();
        } else {
          el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        }
        const r = el.getBoundingClientRect();
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
      })()`;
      const pos = await this.evaluate<{ x: number; y: number } | null>(prepExpr);
      if (!pos) throw new Error(`Element not found: ${selector}`);

      if (jsClick) {
        // 用页面端 element.click() 触发
        const clickExpr = `(function() {
          const el = document.querySelector(${selJson});
          if (!el) return false;
          el.click();
          return true;
        })()`;
        await this.evaluate<boolean>(clickExpr);
        return;
      }
      await this.dispatchMouseClick(pos.x, pos.y);
      return;
    }

    // 场景 2: 使用坐标 —— 模型坐标基于缩放后的截图，先换算回视口坐标
    if (x !== undefined && y !== undefined) {
      const k = await this.getScaleFactor();
      x = Math.round(x / k);
      y = Math.round(y / k);
      const prepExpr = `(function() {
        const el = document.elementFromPoint(${x}, ${y});
        if (el && typeof el.scrollIntoViewIfNeeded === 'function') {
          el.scrollIntoViewIfNeeded();
        }
        return true;
      })()`;
      await this.evaluate<boolean>(prepExpr).catch(() => {/* 忽略 prep 阶段异常 */});

      if (jsClick) {
        const clickExpr = `(function() {
          const el = document.elementFromPoint(${x}, ${y});
          if (!el) return false;
          el.click();
          return true;
        })()`;
        const ok = await this.evaluate<boolean>(clickExpr);
        if (!ok) throw new Error(`No element at (${x}, ${y})`);
        return;
      }
      await this.dispatchMouseClick(x, y);
      return;
    }

    throw new Error("click requires either (x, y) or selector");
  }

  private async dispatchMouseClick(x: number, y: number): Promise<void> {
    const common = { x, y, button: "left" as const, clickCount: 1 };
    await this.cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", ...common });
    await this.cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...common });
  }

  private async keyboardType(
    text?: string,
    key?: string,
    selector?: string,
    method?: "js" | "key",
    pressEnter = false,
    clear = true,
  ): Promise<void> {
    if (!text && !key) throw new Error("keyboard_type requires either text or key");

    // ── 可选：先聚焦目标元素 ──
    if (selector) {
      selector = this.resolveShortRef(selector);
      const selJson = JSON.stringify(selector);
      const ok = await this.evaluate<boolean>(`(function() {
        const el = document.querySelector(${selJson});
        if (!el) return false;
        if (typeof el.scrollIntoViewIfNeeded === 'function') el.scrollIntoViewIfNeeded();
        else el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        el.focus();
        return true;
      })()`);
      if (!ok) throw new Error(`Element not found: ${selector}`);
    }

    // ── key 模式：发送按键 ──
    if (key) {
      await this.pressKeyCombo(key);
      return;
    }

    // ── text 模式：输入文本 ──
    const value = text!;
    const resolvedSelector = selector ? this.resolveShortRef(selector) : null;
    const selJson = resolvedSelector ? JSON.stringify(resolvedSelector) : null;

    if (method === "js") {
      // JS 赋值 + 派发事件
      if (!selJson) throw new Error("method 'js' requires selector");
      const setExpr = `(function() {
        const el = document.querySelector(${selJson});
        if (!el) return false;
        el.value = ${JSON.stringify(value)};
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      })()`;
      await this.evaluate<boolean>(setExpr);
    } else if (method === "key") {
      // 逐字符 dispatchKeyEvent
      if (clear && selJson) {
        await this.cdp.send("Runtime.evaluate", {
          expression: `document.querySelector(${selJson}).value = ''`,
        });
      }
      for (const char of value) {
        await this.dispatchChar(char);
      }
    } else {
      // 默认：CDP Input.insertText
      if (clear && selJson) {
        await this.cdp.send("Runtime.evaluate", {
          expression: `document.querySelector(${selJson}).value = ''`,
        });
      }
      await this.cdp.send("Input.insertText", { text: value });
      if (selJson) {
        await this.cdp.send("Runtime.evaluate", {
          expression: `document.querySelector(${selJson}).dispatchEvent(new Event('input', { bubbles: true }))`,
        });
      }
    }

    if (pressEnter) {
      await this.dispatchKey("Enter", "Enter", 13, "\r");
    }
  }

  private async scroll(
    x: number,
    y: number,
    deltaX: number,
    deltaY: number
  ): Promise<void> {
    // 模型坐标/滚动量基于缩放后的截图，换算回视口坐标系
    const k = await this.getScaleFactor();
    await this.cdp.send("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x: Math.round(x / k),
      y: Math.round(y / k),
      deltaX: Math.round(deltaX / k),
      deltaY: Math.round(deltaY / k),
    });
  }

  private async drag(
    startX: number,
    startY: number,
    endX: number,
    endY: number,
    steps: number
  ): Promise<void> {
    // 模型坐标基于缩放后的截图，换算回视口坐标系
    const k = await this.getScaleFactor();
    startX = Math.round(startX / k);
    startY = Math.round(startY / k);
    endX = Math.round(endX / k);
    endY = Math.round(endY / k);
    await this.cdp.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: startX,
      y: startY,
      button: "left",
    });
    for (let i = 1; i <= steps; i++) {
      const ratio = i / steps;
      await this.cdp.send("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: startX + (endX - startX) * ratio,
        y: startY + (endY - startY) * ratio,
        button: "left",
      });
    }
    await this.cdp.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: endX,
      y: endY,
      button: "left",
    });
  }

  private async navigate(url: string): Promise<void> {
    await this.cdp.send("Page.navigate", { url });
    // 等待页面加载
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  private async wait(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  private async findElement(
    text: string,
    limit: number,
    tagFilter: string
  ): Promise<string> {
    // 输出坐标乘以缩放系数，与截图坐标空间保持一致
    const K = await this.getScaleFactor();
    const expression = `
      (function() {
        const K = ${K};
        const text = ${JSON.stringify(text)}.toLowerCase();
        const limit = ${limit};
        const tagFilter = ${JSON.stringify(tagFilter)}.toLowerCase();
        const seen = new Set();
        const results = [];

        function addEl(el) {
          if (seen.has(el)) return;
          seen.add(el);
          if (tagFilter && el.tagName.toLowerCase() !== tagFilter) return;
          const rect = el.getBoundingClientRect();
          if (rect.width === 0 && rect.height === 0) return;
          let selector = el.tagName.toLowerCase();
          if (el.id) selector = '#' + CSS.escape(el.id);
          else {
            // 生成从 body 到目标的 nth-child 路径
            var parts = [];
            var cur = el;
            while (cur && cur !== document.body && cur !== document.documentElement) {
              var parent = cur.parentElement;
              if (!parent) break;
              var idx = Array.from(parent.children).indexOf(cur) + 1;
              parts.unshift(cur.tagName.toLowerCase() + ':nth-child(' + idx + ')');
              cur = parent;
            }
            if (parts.length > 0) selector = parts.join(' > ');
          }
          const rawText = (el.textContent || '').trim();
          const textDisplay = rawText.length > 120 ? rawText.slice(0, 120) + '...(+' + (rawText.length - 120) + ' chars)' : rawText;
          results.push({ tag: el.tagName.toLowerCase(), text: textDisplay, selector, rect: { x: Math.round(rect.x * K), y: Math.round(rect.y * K), w: Math.round(rect.width * K), h: Math.round(rect.height * K) } });
        }

        // 1. TreeWalker 遍历所有文本节点
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        while (walker.nextNode() && results.length < limit) {
          const node = walker.currentNode;
          if (!node.textContent?.toLowerCase().includes(text)) continue;
          const el = node.parentElement;
          if (el) addEl(el);
        }

        // 2. 若 TreeWalker 未找到，用 querySelectorAll + innerText 兜底
        //    处理文本跨子元素分布的场景
        if (results.length === 0) {
          const all = document.body.querySelectorAll('*');
          for (const el of all) {
            if (results.length >= limit) break;
            if ((el.innerText || '').toLowerCase().includes(text)) {
              addEl(el);
            }
          }
        }

        if (results.length === 0) return 'no_results: 未找到包含 "' + ${JSON.stringify(text)} + '" 的可见元素';
        return results.map(r => {
          var cx = r.rect.x + Math.round(r.rect.w / 2);
          var cy = r.rect.y + Math.round(r.rect.h / 2);
          return '- tag: ' + r.tag
            + '\\n  text: ' + JSON.stringify(r.text)
            + '\\n  selector: ' + JSON.stringify(r.selector)
            + '\\n  position: {x: ' + r.rect.x + ', y: ' + r.rect.y + ', width: ' + r.rect.w + ', height: ' + r.rect.h + '}'
            + '\\n  center: {x: ' + cx + ', y: ' + cy + '}';
        }).join('\\n');
      })()
    `;
    const raw = await this.evaluate<string>(expression);
    return this.annotateShortRefs(raw);
  }

  private async getElementText(
    selector: string,
    limit: number,
    offset: number
  ): Promise<string> {
    selector = this.resolveShortRef(selector);
    const expression = `
      (function() {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return 'error: Element not found';
        const full = (el.textContent || '').trim();
        const text = full.slice(${offset}, ${offset} + ${limit});
        return 'text: |\\n  ' + text.replace(/\\n/g, '\\n  ')
          + '\\ntotalLength: ' + full.length
          + '\\noffset: ' + ${offset}
          + '\\nlimit: ' + ${limit};
      })()
    `;
    return this.evaluate(expression);
  }

  private async getElementRect(selector: string): Promise<string> {
    selector = this.resolveShortRef(selector);
    // 输出坐标乘以缩放系数，与截图坐标空间保持一致
    const K = await this.getScaleFactor();
    const expression = `
      (function() {
        const K = ${K};
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return 'error: Element not found';
        const r = el.getBoundingClientRect();
        const x = Math.round(r.x * K), y = Math.round(r.y * K);
        const w = Math.round(r.width * K), h = Math.round(r.height * K);
        return 'position: {x: ' + x + ', y: ' + y + ', width: ' + w + ', height: ' + h + '}'
          + '\\ncenter: {x: ' + Math.round(x + w/2) + ', y: ' + Math.round(y + h/2) + '}';
      })()
    `;
    return this.evaluate(expression);
  }

  // ── Hover ──

  private async hover(x?: number, y?: number, selector?: string): Promise<void> {
    if (selector) {
      selector = this.resolveShortRef(selector);
      const selJson = JSON.stringify(selector);
      const prepExpr = `(function() {
        const el = document.querySelector(${selJson});
        if (!el) return null;
        if (typeof el.scrollIntoViewIfNeeded === 'function') {
          el.scrollIntoViewIfNeeded();
        } else {
          el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        }
        const r = el.getBoundingClientRect();
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
      })()`;
      const pos = await this.evaluate<{ x: number; y: number } | null>(prepExpr);
      if (!pos) throw new Error(`Element not found: ${selector}`);
      await this.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: pos.x, y: pos.y });
      return;
    }
    if (x !== undefined && y !== undefined) {
      const k = await this.getScaleFactor();
      await this.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: Math.round(x / k), y: Math.round(y / k) });
      return;
    }
    throw new Error("hover requires either (x, y) or selector");
  }

  // ── Press Key ──

  /** 键名映射表：key → { code, keyCode, text? }（用于 press_key 风格的命名键） */
  private static readonly KEY_MAP: Record<string, { code: string; keyCode: number; text?: string }> = {
    Enter:      { code: "Enter",       keyCode: 13, text: "\r" },
    Tab:        { code: "Tab",         keyCode: 9 },
    Escape:     { code: "Escape",      keyCode: 27 },
    Backspace:  { code: "Backspace",   keyCode: 8 },
    Delete:     { code: "Delete",      keyCode: 46 },
    ArrowUp:    { code: "ArrowUp",     keyCode: 38 },
    ArrowDown:  { code: "ArrowDown",   keyCode: 40 },
    ArrowLeft:  { code: "ArrowLeft",   keyCode: 37 },
    ArrowRight: { code: "ArrowRight",  keyCode: 39 },
    Home:       { code: "Home",        keyCode: 36 },
    End:        { code: "End",         keyCode: 35 },
    PageUp:     { code: "PageUp",      keyCode: 33 },
    PageDown:   { code: "PageDown",    keyCode: 34 },
    " ":        { code: "Space",       keyCode: 32, text: " " },
    Space:      { code: "Space",       keyCode: 32, text: " " },
  };

  /**
   * 字符→物理键映射（US QWERTY 布局）。
   * shift 为 true 表示该字符需要 Shift 修饰。
   * 未列出的小写字母 a-z 和数字 0-9 在 dispatchChar 中动态处理。
   */
  private static readonly CHAR_MAP: Record<string, { code: string; keyCode: number; shift?: boolean }> = {
    // 数字行上档符号
    "!": { code: "Digit1",      keyCode: 49, shift: true },
    "@": { code: "Digit2",      keyCode: 50, shift: true },
    "#": { code: "Digit3",      keyCode: 51, shift: true },
    "$": { code: "Digit4",      keyCode: 52, shift: true },
    "%": { code: "Digit5",      keyCode: 53, shift: true },
    "^": { code: "Digit6",      keyCode: 54, shift: true },
    "&": { code: "Digit7",      keyCode: 55, shift: true },
    "*": { code: "Digit8",      keyCode: 56, shift: true },
    "(": { code: "Digit9",      keyCode: 57, shift: true },
    ")": { code: "Digit0",      keyCode: 48, shift: true },
    // 符号键（无 Shift）
    "-": { code: "Minus",        keyCode: 189 },
    "=": { code: "Equal",        keyCode: 187 },
    "[": { code: "BracketLeft",  keyCode: 219 },
    "]": { code: "BracketRight", keyCode: 221 },
    "\\": { code: "Backslash",   keyCode: 220 },
    ";": { code: "Semicolon",    keyCode: 186 },
    "'": { code: "Quote",        keyCode: 222 },
    ",": { code: "Comma",        keyCode: 188 },
    ".": { code: "Period",       keyCode: 190 },
    "/": { code: "Slash",        keyCode: 191 },
    "`": { code: "Backquote",    keyCode: 192 },
    // 符号键（Shift）
    "_": { code: "Minus",        keyCode: 189, shift: true },
    "+": { code: "Equal",        keyCode: 187, shift: true },
    "{": { code: "BracketLeft",  keyCode: 219, shift: true },
    "}": { code: "BracketRight", keyCode: 221, shift: true },
    "|": { code: "Backslash",    keyCode: 220, shift: true },
    ":": { code: "Semicolon",    keyCode: 186, shift: true },
    '"': { code: "Quote",        keyCode: 222, shift: true },
    "<": { code: "Comma",        keyCode: 188, shift: true },
    ">": { code: "Period",       keyCode: 190, shift: true },
    "?": { code: "Slash",        keyCode: 191, shift: true },
    "~": { code: "Backquote",    keyCode: 192, shift: true },
    " ": { code: "Space",        keyCode: 32 },
  };

  /**
   * 解析 key 描述（支持 "Control+a"、"Shift+Enter" 等组合键）并通过 CDP 派发。
   */
  private async pressKeyCombo(key: string): Promise<void> {
    // 解析修饰键
    const parts = key.split("+");
    const mainKey = parts.pop()!;
    const modifiers: { ctrl: boolean; alt: boolean; shift: boolean; meta: boolean } = {
      ctrl: false, alt: false, shift: false, meta: false,
    };
    for (const mod of parts) {
      const m = mod.toLowerCase();
      if (m === "control" || m === "ctrl") modifiers.ctrl = true;
      else if (m === "alt") modifiers.alt = true;
      else if (m === "shift") modifiers.shift = true;
      else if (m === "meta" || m === "command" || m === "cmd") modifiers.meta = true;
    }

    const mapped = ToolExecutor.KEY_MAP[mainKey];
    const code = mapped?.code ?? `Key${mainKey.toUpperCase()}`;
    const keyCode = mapped?.keyCode ?? mainKey.toUpperCase().charCodeAt(0);
    const text = mapped?.text ?? (mainKey.length === 1 ? mainKey : undefined);

    await this.dispatchKey(mainKey, code, keyCode, text, modifiers);
  }

  /** 底层 CDP 按键派发（keyDown + keyUp） */
  private async dispatchKey(
    key: string,
    code: string,
    keyCode: number,
    text?: string,
    modifiers?: { ctrl: boolean; alt: boolean; shift: boolean; meta: boolean },
  ): Promise<void> {
    const modFlag =
      ((modifiers?.alt ? 1 : 0)) |
      ((modifiers?.ctrl ? 2 : 0)) |
      ((modifiers?.meta ? 4 : 0)) |
      ((modifiers?.shift ? 8 : 0));
    const common = {
      key,
      code,
      windowsVirtualKeyCode: keyCode,
      nativeVirtualKeyCode: keyCode,
      modifiers: modFlag,
    };
    await this.cdp.send("Input.dispatchKeyEvent", {
      type: text ? "keyDown" : "rawKeyDown",
      ...common,
      text,
    });
    await this.cdp.send("Input.dispatchKeyEvent", {
      type: "keyUp",
      ...common,
    });
  }

  /**
   * 派发单个可打印字符的完整键盘事件序列（keyDown + keyUp），
   * 自动查找正确的 code / keyCode / shift 修饰。
   */
  private async dispatchChar(char: string): Promise<void> {
    // 1. 查 CHAR_MAP（符号、空格）
    const mapped = ToolExecutor.CHAR_MAP[char];
    if (mapped) {
      const mods = mapped.shift
        ? { ctrl: false, alt: false, shift: true, meta: false }
        : undefined;
      await this.dispatchKey(char, mapped.code, mapped.keyCode, char, mods);
      return;
    }

    // 2. 数字 0-9
    if (char >= "0" && char <= "9") {
      const keyCode = 48 + (char.charCodeAt(0) - 48);
      await this.dispatchKey(char, `Digit${char}`, keyCode, char);
      return;
    }

    // 3. 字母 a-z / A-Z
    const lower = char.toLowerCase();
    if (lower >= "a" && lower <= "z") {
      const isUpper = char !== lower;
      const code = `Key${lower.toUpperCase()}`;
      const keyCode = lower.toUpperCase().charCodeAt(0); // A=65 .. Z=90
      const mods = isUpper
        ? { ctrl: false, alt: false, shift: true, meta: false }
        : undefined;
      await this.dispatchKey(char, code, keyCode, char, mods);
      return;
    }

    // 4. 其他字符（Unicode 等）：用 charCode 近似处理
    const keyCode = char.charCodeAt(0);
    await this.dispatchKey(char, `Unidentified`, keyCode, char);
  }

  // ── Handle Dialog ──

  /**
   * 启用 dialog 自动拦截。应在 CDP attach 后调用一次。
   * 页面弹出 alert/confirm/prompt/beforeunload 时，CDP 会暂停页面并发送 Page.javascriptDialogOpening 事件。
   * 我们把它存起来，等 agent 调用 handle_dialog 工具时再响应。
   */
  async enableDialogInterception(): Promise<void> {
    // 注册 CDP 事件监听（通过 Runtime.evaluate 不行，需要 CDP 事件）
    // chrome.debugger.onEvent 已在 CdpManager 外部，这里用轮询方案替代：
    // 实际上我们不需要事件驱动——当 dialog 出现时页面会阻塞，
    // agent 的 screenshot/read_page 等工具也会被阻塞或返回异常，
    // 从而提示 agent 调用 handle_dialog。
  }

  private async handleDialog(accept: boolean, promptText?: string): Promise<void> {
    const params: Record<string, unknown> = { accept };
    if (promptText !== undefined) {
      params.promptText = promptText;
    }
    await this.cdp.send("Page.handleJavaScriptDialog", params);
  }
}
