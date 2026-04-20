// Tool 定义注册表

import type { ToolDefinition } from "./types";

export const toolDefinitions: ToolDefinition[] = [
  {
    name: "screenshot",
    description:
      "截取当前页面的屏幕截图，返回 base64 编码的 PNG 图片。",
    parameters: {},
  },
  {
    name: "read_page_text",
    description:
      "读取当前页面的纯文本内容（document.body.innerText）。",
    parameters: {},
  },
  {
    name: "read_page",
    description:
      "读取当前页面的简化 DOM 树，包含元素位置、role 和 ref 属性。",
    parameters: {},
  },
  {
    name: "read_page_interactive",
    description:
      "读取当前页面中所有可交互元素（input/button/a/select 等），包含位置和 ref。",
    parameters: {},
  },
  {
    name: "click",
    description: "在指定坐标处执行鼠标点击。",
    parameters: {
      x: { type: "number", description: "点击位置的 X 坐标" },
      y: { type: "number", description: "点击位置的 Y 坐标" },
    },
    required: ["x", "y"],
  },
  {
    name: "set_input",
    description: "聚焦指定元素并输入文本。",
    parameters: {
      selector: {
        type: "string",
        description: "目标元素的 CSS 选择器",
      },
      value: { type: "string", description: "要输入的文本" },
    },
    required: ["selector", "value"],
  },
  {
    name: "scroll",
    description: "在指定位置滚动页面。",
    parameters: {
      x: { type: "number", description: "滚动起始 X 坐标" },
      y: { type: "number", description: "滚动起始 Y 坐标" },
      deltaX: { type: "number", description: "水平滚动量" },
      deltaY: { type: "number", description: "垂直滚动量" },
    },
    required: ["x", "y", "deltaY"],
  },
  {
    name: "drag",
    description: "从起点拖拽到终点。",
    parameters: {
      startX: { type: "number", description: "起始 X 坐标" },
      startY: { type: "number", description: "起始 Y 坐标" },
      endX: { type: "number", description: "结束 X 坐标" },
      endY: { type: "number", description: "结束 Y 坐标" },
      steps: {
        type: "integer",
        description: "拖拽中间步数，默认 10",
      },
    },
    required: ["startX", "startY", "endX", "endY"],
  },
  {
    name: "navigate",
    description: "导航到指定 URL。",
    parameters: {
      url: { type: "string", description: "目标 URL" },
    },
    required: ["url"],
  },
  {
    name: "wait",
    description: "等待指定毫秒数。",
    parameters: {
      ms: { type: "integer", description: "等待时间（毫秒）" },
    },
    required: ["ms"],
  },
];
