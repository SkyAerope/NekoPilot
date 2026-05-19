// Tool 定义注册表

import type { ToolDefinition } from "./types";

export const toolDefinitions: ToolDefinition[] = [
  {
    name: "execute_js",
    description:
      "在独立沙箱中执行一段纯 JavaScript 计算代码。必须同时提供 description 和 code。code 以函数体形式提供，可直接通过 return 返回结果。该工具没有 DOM、网络或 Chrome 扩展 API。",
    parameters: {
      description: {
        type: "string",
        description: "本段代码的用途说明，要求清楚描述要做什么、输入假设和期望输出",
      },
      code: {
        type: "string",
        description: "要执行的 JavaScript 函数体代码；通过 return 返回结果。不要使用 window、document、fetch、chrome 等宿主能力",
      },
    },
    required: ["description", "code"],
  },
  {
    name: "screenshot",
    description:
      "截取当前页面的屏幕截图，返回 base64 编码的图片。",
    parameters: {},
  },
  {
    name: "read_page_text",
    description:
      "读取当前页面的纯文本内容（document.body.innerText）。",
    parameters: {
      limit: {
        type: "integer",
        description: "返回文本的最大字符数，默认 4096",
      },
      offset: {
        type: "integer",
        description: "文本起始偏移量（字符数），默认 0",
      },
    },
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
      "读取当前页面中所有可见的可交互元素（a/button/input/select/textarea/[role]/[onclick] 等）。每项包含：selector（可直接传给 click / keyboard_type / get_element_text / get_element_rect 的 selector 参数；启用短引用时为形如 \"#1\"、\"#2\" 的短引用，否则为真实 CSS 选择器）、tag、type、role、text、placeholder、value、position（视口坐标与尺寸）、center（中心点坐标，可作 click 的 x/y）。",
    parameters: {},
  },
  {
    name: "click",
    description: "在指定坐标或选择器指定的元素中央执行点击。点击前会自动滚动页面至元素可见的位置。坐标与选择器二选一。",
    parameters: {
      x: { type: "number", description: "点击位置的 X 坐标（与 selector 二选一）" },
      y: { type: "number", description: "点击位置的 Y 坐标（与 selector 二选一）" },
      selector: { type: "string", description: "目标元素的 CSS 选择器；也接受 read_page_interactive / find_element 返回的 #n 短引用" },
      jsClick: {
        type: "boolean",
        description: "默认 false，使用 CDP 派发真实鼠标事件；设为 true 时改用页面端 element.click()，适合被遮挡或非标准事件处理的元素",
      },
    },
  },
  {
    name: "keyboard_type",
    description: "向页面发送键盘输入。text 与 key 二选一：text 用于输入文本（如搜索词、表单填写），key 用于发送按键（如 Enter 提交、Escape 关闭、Tab 切换焦点、组合键 Control+a 等）。",
    parameters: {
      text: {
        type: "string",
        description: "要输入的文本内容（与 key 二选一）",
      },
      key: {
        type: "string",
        description: "要按下的键名（与 text 二选一）。支持单键（\"Enter\"、\"Tab\"、\"Escape\"、\"ArrowDown\"、\"Backspace\"）和组合键（\"Control+a\"、\"Shift+Enter\"）。键名遵循 KeyboardEvent.key 规范。",
      },
      selector: {
        type: "string",
        description: "可选：先聚焦此元素再输入/按键。CSS 选择器或 #n 短引用。不提供则对当前聚焦元素操作。",
      },
      method: {
        type: "string",
        description: "输入方式（仅 text 模式有效）。不填（默认）= CDP Input.insertText 模拟键盘输入；\"js\" = 直接赋值 element.value 并派发 input/change 事件，适合受控组件；\"key\" = 通过 CDP Input.dispatchKeyEvent 逐字符派发 keyDown/keyUp，适合需要触发完整键盘事件的场景。",
        enum: ["js", "key"],
      },
      pressEnter: {
        type: "boolean",
        description: "默认 false；设为 true 时输入完成后自动按下 Enter 键（适合搜索框、表单提交等场景）。仅 text 模式有效。",
      },
      clear: {
        type: "boolean",
        description: "默认 true；输入前是否清空已有内容。设为 false 可追加输入。仅 text 模式有效。",
      },
    },
  },
  {
    name: "scroll",
    description: "在指定位置滚动页面。",
    parameters: {
      x: { type: "number", description: "滚动起始 X 坐标" },
      y: { type: "number", description: "滚动起始 Y 坐标" },
      deltaX: { type: "number", description: "水平滚动坐标量，正为右" },
      deltaY: { type: "number", description: "垂直滚动坐标量，正为下" },
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
  {
    name: "find_element",
    description:
      "根据文本内容搜索页面中的元素。返回匹配元素列表，每项包含：tag（标签名）、text（截断文本）、selector（可直接传给 click / keyboard_type / get_element_text / get_element_rect 的 selector 参数；启用短引用时为形如 \"#1\"、\"#2\" 的短引用，否则为真实 CSS 选择器）、position（元素在视口内的位置与尺寸，单位 px）、center（元素中心点坐标，可直接作为 click 的 x/y）。",
    parameters: {
      text: {
        type: "string",
        description: "要搜索的文本内容（支持部分匹配）",
      },
      limit: {
        type: "integer",
        description: "最多返回的匹配结果数，默认 10",
      },
      tagFilter: {
        type: "string",
        description: "可选的元素类型过滤（如 'a'、'button'、'div' 等），仅返回匹配该标签的元素",
      },
    },
    required: ["text"],
  },
  {
    name: "get_element_text",
    description:
      "获取指定元素的文本内容。可通过 limit 和 offset 控制返回的文本范围。",
    parameters: {
      selector: {
        type: "string",
        description: "目标元素的 CSS 选择器；也接受 read_page_interactive / find_element 返回的 #n 短引用",
      },
      limit: {
        type: "integer",
        description: "返回文本的最大字符数，默认 2048",
      },
      offset: {
        type: "integer",
        description: "文本起始偏移量（字符数），默认 0",
      },
    },
    required: ["selector"],
  },
  {
    name: "hover",
    description: "将鼠标移动到指定坐标或选择器指定的元素中央，触发 hover 效果（如下拉菜单、tooltip 等）。操作前会自动滚动至元素可见的位置。坐标与选择器二选一。",
    parameters: {
      x: { type: "number", description: "悬停位置的 X 坐标（与 selector 二选一）" },
      y: { type: "number", description: "悬停位置的 Y 坐标（与 selector 二选一）" },
      selector: { type: "string", description: "目标元素的 CSS 选择器；也接受 #n 短引用" },
    },
  },
  {
    name: "handle_dialog",
    description: "处理浏览器原生弹窗（alert、confirm、prompt）和 beforeunload 对话框。在弹窗出现后调用此工具进行响应。",
    parameters: {
      accept: {
        type: "boolean",
        description: "true 表示接受（确定/OK），false 表示拒绝（取消/Cancel）。默认 true。",
      },
      promptText: {
        type: "string",
        description: "仅对 prompt 弹窗有效：要填入的文本。",
      },
    },
  },
  {
    name: "get_element_rect",
    description:
      "获取指定元素的坐标和尺寸信息（x, y, width, height）。",
    parameters: {
      selector: {
        type: "string",
        description: "目标元素的 CSS 选择器；也接受 read_page_interactive / find_element 返回的 #n 短引用",
      },
    },
    required: ["selector"],
  },
];
