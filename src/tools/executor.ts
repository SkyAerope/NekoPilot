// Tool 执行器 — 将 tool 调用映射到具体 CDP 操作

import type { CdpManager } from "../background/cdp";
import type { ToolResult } from "./types";

export class ToolExecutor {
  constructor(private cdp: CdpManager) {}

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
        return this.click(params.x as number | undefined, params.y as number | undefined, params.selector as string | undefined);
      case "set_input":
        return this.setInput(
          params.selector as string,
          params.value as string
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

  // ── 具体 Tool 实现 ──

  private async screenshot(): Promise<string> {
    const result = await this.cdp.send<{ data: string }>(
      "Page.captureScreenshot",
      { format: "png" }
    );
    return result.data; // base64
  }

  private async readPageText(limit: number, offset: number): Promise<string> {
    const expression = `
      (function() {
        const full = document.body.innerText;
        return JSON.stringify({
          text: full.slice(${offset}, ${offset} + ${limit}),
          totalLength: full.length,
          offset: ${offset},
          limit: ${limit},
        });
      })()
    `;
    const result = await this.cdp.send<{ result: { value: string } }>(
      "Runtime.evaluate",
      { expression, returnByValue: true }
    );
    return result.result.value;
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
            ? el.childNodes[0].textContent?.trim().slice(0, 80) : '';
          const children = Array.from(el.children)
            .map(c => simplify(c, depth + 1))
            .filter(Boolean);
          if (!role && !text && children.length === 0 && !['input','button','a','select','textarea','img'].includes(tag)) return null;
          return {
            tag, role, text,
            ref: tag + '[' + Array.from(el.parentElement?.children || []).indexOf(el) + ']',
            rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
            children: children.length ? children : undefined
          };
        }
        return JSON.stringify(simplify(document.body, 0), null, 2);
      })()
    `;
    const result = await this.cdp.send<{ result: { value: string } }>(
      "Runtime.evaluate",
      { expression, returnByValue: true }
    );
    return result.result.value;
  }

  private async readPageInteractive(): Promise<string> {
    const expression = `
      (function() {
        const selectors = 'a, button, input, select, textarea, [role="button"], [role="link"], [role="checkbox"], [role="radio"], [tabindex]';
        const elements = document.querySelectorAll(selectors);
        const results = [];
        elements.forEach((el, i) => {
          const rect = el.getBoundingClientRect();
          if (rect.width === 0 && rect.height === 0) return;
          results.push({
            ref: 'interactive[' + i + ']',
            tag: el.tagName.toLowerCase(),
            type: el.getAttribute('type') || '',
            role: el.getAttribute('role') || '',
            text: (el.textContent || '').trim().slice(0, 80),
            placeholder: el.getAttribute('placeholder') || '',
            value: el.value || '',
            rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
          });
        });
        return JSON.stringify(results, null, 2);
      })()
    `;
    const result = await this.cdp.send<{ result: { value: string } }>(
      "Runtime.evaluate",
      { expression, returnByValue: true }
    );
    return result.result.value;
  }

  private async click(x?: number, y?: number, selector?: string): Promise<void> {
    let cx: number;
    let cy: number;
    if (selector) {
      const expr = `(function() {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      })()`;
      const res = await this.cdp.send<{ result: { value: { x: number; y: number } | null } }>(
        "Runtime.evaluate",
        { expression: expr, returnByValue: true }
      );
      if (!res.result.value) throw new Error(`Element not found: ${selector}`);
      cx = res.result.value.x;
      cy = res.result.value.y;
    } else if (x !== undefined && y !== undefined) {
      cx = x;
      cy = y;
    } else {
      throw new Error("click requires either (x, y) or selector");
    }
    const common = { x: cx, y: cy, button: "left" as const, clickCount: 1 };
    await this.cdp.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      ...common,
    });
    await this.cdp.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      ...common,
    });
  }

  private async setInput(selector: string, value: string): Promise<void> {
    // 先聚焦元素
    await this.cdp.send("Runtime.evaluate", {
      expression: `document.querySelector(${JSON.stringify(selector)}).focus()`,
    });
    // 清除已有内容
    await this.cdp.send("Runtime.evaluate", {
      expression: `document.querySelector(${JSON.stringify(selector)}).value = ''`,
    });
    // 使用 Input.insertText 输入
    await this.cdp.send("Input.insertText", { text: value });
    // 触发 input 事件
    await this.cdp.send("Runtime.evaluate", {
      expression: `document.querySelector(${JSON.stringify(selector)}).dispatchEvent(new Event('input', {bubbles: true}))`,
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
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        const seen = new Set();
        const results = [];
        while (walker.nextNode()) {
          const node = walker.currentNode;
          if (!node.textContent?.toLowerCase().includes(text)) continue;
          const el = node.parentElement;
          if (!el || seen.has(el)) continue;
          seen.add(el);
          if (tagFilter && el.tagName.toLowerCase() !== tagFilter) continue;
          const rect = el.getBoundingClientRect();
          if (rect.width === 0 && rect.height === 0) continue;
          let selector = el.tagName.toLowerCase();
          if (el.id) selector = '#' + el.id;
          else if (el.className && typeof el.className === 'string') selector += '.' + el.className.trim().split(/\\s+/).join('.');
          results.push({
            tag: el.tagName.toLowerCase(),
            text: (el.textContent || '').trim().slice(0, 120),
            selector: selector,
            rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
          });
          if (results.length >= limit) break;
        }
        return JSON.stringify(results, null, 2);
      })()
    `;
    const result = await this.cdp.send<{ result: { value: string } }>(
      "Runtime.evaluate",
      { expression, returnByValue: true }
    );
    return result.result.value;
  }

  private async getElementText(
    selector: string,
    limit: number,
    offset: number
  ): Promise<string> {
    const expression = `
      (function() {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return JSON.stringify({ error: 'Element not found' });
        const full = (el.textContent || '').trim();
        return JSON.stringify({
          text: full.slice(${offset}, ${offset} + ${limit}),
          totalLength: full.length,
          offset: ${offset},
          limit: ${limit},
        });
      })()
    `;
    const result = await this.cdp.send<{ result: { value: string } }>(
      "Runtime.evaluate",
      { expression, returnByValue: true }
    );
    return result.result.value;
  }

  private async getElementRect(selector: string): Promise<string> {
    const expression = `
      (function() {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return 'error: Element not found';
        const r = el.getBoundingClientRect();
        const x = Math.round(r.x), y = Math.round(r.y);
        const w = Math.round(r.width), h = Math.round(r.height);
        return 'x: ' + x + '\\ny: ' + y + '\\nwidth: ' + w + '\\nheight: ' + h + '\\ncenter: (' + Math.round(x + w/2) + ', ' + Math.round(y + h/2) + ')';
      })()
    `;
    const result = await this.cdp.send<{ result: { value: string } }>(
      "Runtime.evaluate",
      { expression, returnByValue: true }
    );
    return result.result.value;
  }
}
