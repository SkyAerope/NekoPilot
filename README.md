# NekoPilot 🐱

> A Chrome side-panel browser-automation copilot powered by your favorite LLM.

NekoPilot 是一个运行在 Chrome 侧边栏的浏览器自动化助手。它通过 Chrome DevTools Protocol (CDP) 直接驱动当前标签页，把"看页面 → 思考 → 操作"的循环交给 LLM 完成。BYOK（自带 API Key），数据不经过任何第三方服务。

![manifest v3](https://img.shields.io/badge/Chrome-MV3-blue) ![license](https://img.shields.io/badge/license-Apache--2.0-green) ![pnpm](https://img.shields.io/badge/pnpm-required-orange)

---

## ✨ 特性

- **真实浏览器操控** — 通过 CDP 派发真实鼠标 / 键盘事件，避免被前端检测拦截。
- **视觉 + 结构混合感知** — 截图、可交互元素列表、简化 DOM 树、文本搜索多管齐下。
- **多供应商**
  - OpenAI 兼容 API（OpenAI / DeepSeek / Qwen / Moonshot / 本地 vLLM / Ollama 等）
  - Anthropic Messages API（Claude）
- **流式 UI**
  - 工具调用以时间线形式分组展示，可折叠
  - `<think>...</think>` 思考过程独立成步骤，并显示「已思考 N 秒」
  - 实时切换审批 / 自动模式
- **可控的危险操作** — 默认敏感工具（点击、导航、输入等）需要人工批准；自动模式下也可随时暂停。
- **完整中断** — 停止按钮立即切断流式连接并清理悬挂的工具调用，对话状态保持一致。
- **重试不丢失上下文** — 重试某条消息会回滚到该点，保留之前的全部历史。

---

## 🛠️ 工具集

| 工具 | 作用 |
| --- | --- |
| `screenshot` | 截取当前视口（base64 PNG） |
| `read_page_text` | 读取 `body.innerText`，支持分页 |
| `read_page` | 简化 DOM 树，含位置和 role |
| `read_page_interactive` | 列出所有可见可交互元素 + selector + center |
| `find_element` | 按文本搜索元素，返回 selector 与坐标 |
| `get_element_text` / `get_element_rect` | 单元素细查 |
| `click` | 坐标或 selector 点击，可切 CDP / `element.click()` |
| `set_input` | 聚焦并输入，可切 CDP `insertText` / 直接赋值 |
| `scroll` / `drag` | 鼠标滚轮 / 拖拽 |
| `navigate` / `wait` | URL 跳转、定时等待 |

工具定义见 [`src/tools/definitions.ts`](src/tools/definitions.ts)。

---

## 🚀 快速开始

### 1. 构建扩展

```bash
pnpm install
pnpm build
```

`dev` 模式（watch + 增量构建）：

```bash
pnpm dev
```

### 2. 加载到 Chrome

1. 打开 `chrome://extensions`
2. 右上角开启 **开发者模式**
3. 点击 **加载已解压的扩展程序**，选择仓库内的 `dist` 目录

### 3. 配置 API

点击扩展图标 → 进入设置（齿轮）：

- **Provider**：`openai-compatible` 或 `anthropic`
- **Base URL**：例如 `https://api.openai.com/v1`、`https://api.anthropic.com/v1`
- **API Key**：你的密钥
- **Model**：例如 `gpt-5.4`、`claude-sonnet-4.6`

### 4. 使用

在任意普通网页上打开侧边栏，输入指令开始：

> 「帮我把这个表单填好后提交」
> 「找到所有评论里的差评，摘抄给我」
> 「打开 GitHub trending，把前 5 个项目的标题列出来」

顶栏切换 **Ask（每步审批）/ Auto（自动）**；红色方块按钮立即停止。

---

## 🧱 项目结构

```
src/
├── background/         # MV3 Service Worker + CDP 会话管理
│   ├── index.ts
│   └── cdp.ts
├── agent/              # LLM Agent Loop（observe → think → act）
│   ├── loop.ts         # 流式调用 + 工具循环 + 中断控制
│   └── types.ts
├── tools/              # 工具系统
│   ├── definitions.ts  # JSON Schema 定义
│   ├── executor.ts     # CDP 实际执行
│   └── types.ts        # OpenAI / Anthropic schema 适配
├── sidepanel/          # 侧边栏 UI（聊天 / 时间线 / 思考块）
│   └── App.tsx
├── options/            # 设置页（BYOK 配置）
└── shared/             # 主题、消息通信、存储
```

数据流概览：

```
sidepanel  ──message──▶  background (Service Worker)
                              │
                              ├─▶ AgentLoop ──HTTP──▶ LLM Provider (SSE 流)
                              │       │
                              │       ▼
                              └─▶ ToolExecutor ──CDP──▶ Active Tab
```

---

## ⚙️ 技术栈

- **构建** — Vite 6 + TypeScript 5（严格模式）
- **UI** — React 19 + MUI 7 + react-markdown / remark-gfm
- **运行时** — Chrome MV3 Service Worker
- **包管理** — pnpm（必须）

---

## 🔒 隐私

- API Key 仅保存在 `chrome.storage.local`，绝不外传。
- 所有 LLM 请求由扩展直连你配置的 endpoint，**不经过任何中间服务器**。
- 截图、页面文本只发送给你选定的模型。

---

## 🤝 贡献

欢迎 issue 与 PR。提交前请：

```bash
pnpm build       # 必须通过 tsc 严格检查
```

提交信息使用 [Conventional Commits](https://www.conventionalcommits.org/zh-hans/v1.0.0/) 风格（`feat:` / `fix:` / `refactor:` ...）。

---

## 📄 License

[Apache License 2.0](LICENSE)
