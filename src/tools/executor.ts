// Tool 执行器 — 将 tool 调用映射到具体 CDP 操作

import type { CdpManager } from "../background/cdp";
import type { ToolResult } from "./types";

export class ToolExecutor {
  constructor(private cdp: CdpManager) {}

  // ── 短引用（#n）支持 ──
  // 在一次对话中，read_page_interactive / find_element 返回的元素会附带 ref: "#n"；
  // 模型后续可以把 #n 用作 selector，executor 会把它还原为真实 CSS 选择器。
  private shortRefMap = new Map<string, string>();
  private shortRefCounter = 0;
  private shortRefsEnabled = false;
  private screenshotQuality = 80;

  configureShortRefs(enabled: boolean): void {
    this.shortRefsEnabled = enabled;
  }
  configureScreenshotQuality(quality: number): void {
    this.screenshotQuality = Math.max(10, Math.min(100, Math.round(quality)));
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
   * 后续 click/set_input 等调用时由 resolveShortRef 还原）。
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
        return this.click(
          params.x as number | undefined,
          params.y as number | undefined,
          params.selector as string | undefined,
          (params.jsClick as boolean | undefined) ?? false,
        );
      case "set_input":
        return this.setInput(
          params.selector as string,
          params.value as string,
          (params.jsSet as boolean | undefined) ?? false,
        );
      case "scroll":
        return this.scroll(
          params.x as number,
          params.y as number,
          (params.deltaX as number) ?? 0,
          params.deltaY as number
        );
      case "drag":
        return this.drag(
          params.startX as number,
          params.startY as number,
          params.endX as number,
          params.endY as number,
          (params.steps as number) ?? 10
        );
      case "navigate":
        return this.navigate(params.url as string);
      case "wait":
        return this.wait(params.ms as number);
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
    const expression = `
      (function() {
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
      expression: "document.getElementById('__nekopilot-click-marker')?.remove();document.getElementById('__nekopilot-click-marker-style')?.remove();document.getElementById('__nekopilot-input-marker')?.remove();",
    });
  }

  /** 在目标输入框周围显示脉动高亮框 */
  async showInputMarker(selector: string): Promise<void> {
    selector = this.resolveShortRef(selector);
    const selJson = JSON.stringify(selector);
    const expression = `
      (function() {
        const old = document.getElementById('__nekopilot-input-marker');
        if (old) old.remove();
        const el = document.querySelector(${selJson});
        if (!el) return;
        const r = el.getBoundingClientRect();
        const m = document.createElement('div');
        m.id = '__nekopilot-input-marker';
        m.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;'
          + 'left:' + (r.left - 4) + 'px;top:' + (r.top - 4) + 'px;'
          + 'width:' + (r.width + 8) + 'px;height:' + (r.height + 8) + 'px;'
          + 'border:2px solid #a78bfa;border-radius:6px;'
          + 'background:rgba(167,139,250,0.12);'
          + 'box-shadow:0 0 0 4px rgba(167,139,250,0.15);'
          + 'animation:__neko-input-pulse 1.2s ease-in-out infinite;';
        let style = document.getElementById('__nekopilot-click-marker-style');
        if (!style) {
          style = document.createElement('style');
          style.id = '__nekopilot-click-marker-style';
          document.head.appendChild(style);
        }
        const rule = '@keyframes __neko-input-pulse{0%,100%{opacity:1}50%{opacity:0.5}}';
        if (!style.textContent?.includes('__neko-input-pulse')) {
          style.textContent = (style.textContent || '') + rule;
        }
        document.body.appendChild(m);
      })()
    `;
    await this.cdp.send("Runtime.evaluate", { expression });
  }

  /** 显示 scroll 位置标记（带方向箭头） */
  async showScrollMarker(x: number, y: number, deltaX: number, deltaY: number): Promise<void> {
    // 计算箭头方向：以最大分量为准；若两轴均为 0 则按向下处理
    const absX = Math.abs(deltaX);
    const absY = Math.abs(deltaY);
    let arrow = "↓";
    if (absX > absY) arrow = deltaX > 0 ? "→" : "←";
    else if (absY > 0) arrow = deltaY > 0 ? "↓" : "↑";
    const expression = `
      (function() {
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
    const useJpeg = this.screenshotQuality < 100;
    const params: Record<string, unknown> = useJpeg
      ? { format: "jpeg", quality: this.screenshotQuality }
      : { format: "png" };
    const result = await this.cdp.send<{ data: string }>(
      "Page.captureScreenshot",
      params
    );
    return { data: result.data, mime: useJpeg ? "image/jpeg" : "image/png" };
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
    const expression = `
      (function() {
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
            rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
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
    const expression = `
      (function() {
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
            lines.push('  position: {x: ' + rect.x.toFixed(0) + ', y: ' + rect.y.toFixed(0) + ', width: ' + rect.width.toFixed(0) + ', height: ' + rect.height.toFixed(0) + '}');
            lines.push('  center: {x: ' + (rect.x + rect.width / 2).toFixed(0) + ', y: ' + (rect.y + rect.height / 2).toFixed(0) + '}');
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

    // 场景 2: 使用坐标 —— 用 elementFromPoint 获取元素后 scrollIntoViewIfNeeded
    if (x !== undefined && y !== undefined) {
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

  private async setInput(selector: string, value: string, jsSet = false): Promise<void> {
    selector = this.resolveShortRef(selector);
    const selJson = JSON.stringify(selector);
    // 先 scrollIntoViewIfNeeded + focus
    const prepExpr = `(function() {
      const el = document.querySelector(${selJson});
      if (!el) return false;
      if (typeof el.scrollIntoViewIfNeeded === 'function') {
        el.scrollIntoViewIfNeeded();
      } else {
        el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      }
      el.focus();
      return true;
    })()`;
    const ok = await this.evaluate<boolean>(prepExpr);
    if (!ok) throw new Error(`Element not found: ${selector}`);

    if (jsSet) {
      // 纯 JS 赋值 + 派发事件（适合受控框架或非标准组件）
      const setExpr = `(function() {
        const el = document.querySelector(${selJson});
        if (!el) return false;
        el.value = ${JSON.stringify(value)};
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      })()`;
      await this.evaluate<boolean>(setExpr);
      return;
    }

    // CDP 路径：清空 → insertText → 派发 input
    await this.cdp.send("Runtime.evaluate", {
      expression: `document.querySelector(${selJson}).value = ''`,
    });
    await this.cdp.send("Input.insertText", { text: value });
    await this.cdp.send("Runtime.evaluate", {
      expression: `document.querySelector(${selJson}).dispatchEvent(new Event('input', { bubbles: true }))`,
    });
  }

  private async scroll(
    x: number,
    y: number,
    deltaX: number,
    deltaY: number
  ): Promise<void> {
    await this.cdp.send("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x,
      y,
      deltaX,
      deltaY,
    });
  }

  private async drag(
    startX: number,
    startY: number,
    endX: number,
    endY: number,
    steps: number
  ): Promise<void> {
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
    const expression = `
      (function() {
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
          results.push({ tag: el.tagName.toLowerCase(), text: textDisplay, selector, rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) } });
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
    const expression = `
      (function() {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return 'error: Element not found';
        const r = el.getBoundingClientRect();
        const x = Math.round(r.x), y = Math.round(r.y);
        const w = Math.round(r.width), h = Math.round(r.height);
        return 'position: {x: ' + x + ', y: ' + y + ', width: ' + w + ', height: ' + h + '}'
          + '\\ncenter: {x: ' + Math.round(x + w/2) + ', y: ' + Math.round(y + h/2) + '}';
      })()
    `;
    return this.evaluate(expression);
  }
}
