# NekoPilot 🐱

> A Chrome side-panel browser-automation copilot powered by your favorite LLM.

NekoPilot 是一个运行在 Chrome 侧边栏的浏览器自动化助手。它通过 Chrome DevTools Protocol (CDP) 直接驱动当前标签页，把"看页面 → 思考 → 操作"的循环交给 LLM 完成。BYOK（自带 API Key），数据不经过任何第三方服务。

![manifest v3](https://img.shields.io/badge/Chrome-MV3-blue) ![license](https://img.shields.io/badge/license-Apache--2.0-green) ![pnpm](https://img.shields.io/badge/pnpm-required-orange)

<img width="180" height="60" alt="image" src="https://github.com/user-attachments/assets/e684377a-770c-421b-9428-35e959e22ea4" />

> Claude Fable 5 已将该插件与[Claude browser use 最佳实践](https://claude.com/blog/best-practices-for-computer-and-browser-use-with-claude)对齐

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

| 工具                                    | 作用                                               |
| --------------------------------------- | -------------------------------------------------- |
| `screenshot`                            | 截取当前视口（base64 PNG）                         |
| `read_page_text`                        | 读取 `body.innerText`，支持分页                    |
| `read_page`                             | 简化 DOM 树，含位置和 role                         |
| `read_page_interactive`                 | 列出所有可见可交互元素 + selector + center         |
| `find_element`                          | 按文本搜索元素，返回 selector 与坐标               |
| `get_element_text` / `get_element_rect` | 单元素细查                                         |
| `click`                                 | 坐标或 selector 点击，可切 CDP / `element.click()` |
| `set_input`                             | 聚焦并输入，可切 CDP `insertText` / 直接赋值       |
| `scroll` / `drag`                       | 鼠标滚轮 / 拖拽                                    |
| `navigate` / `wait`                     | URL 跳转、定时等待                                 |

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

输入框底部提供新建对话、执行模式、元素选择与附件等操作。输入框下方的标签页纸片显示操作目标；空对话会跟随浏览器切换标签页，出现第一条消息后固定目标，并跨消息保持。点击纸片会显示当前操作页和最近访问的四个其他标签页，也可按标题或链接搜索所有打开的标签页；选择后会激活该页并更新操作目标。任务执行或元素选择期间需先结束当前操作再切换。当前聚焦页与操作目标不一致时，元素选择按钮会禁用并提示返回操作页。

首次发送任务时，用户提示词会附带最多 100 字符的页面标题和最多 200 字符的链接；切换操作目标后的下一条提示词也会告知模型已切换页面。用户气泡下方的标签页纸片保存每条消息对应的页面，历史恢复时保留；图标缺失、加载中或加载失败时显示链接图标。

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
│   ├── App.tsx          # 事件处理与聊天状态
│   ├── model.ts         # 展示模型、分组与工具摘要
│   ├── timeline.tsx     # 思考 / 工具 / 审批时间线
│   ├── markdown.tsx     # Markdown 与流式公式兼容
│   └── controls.tsx     # 元素引用标签与通用控件
├── components/
│   ├── ui/              # shadcn/ui 基础组件
│   └── ai-elements/     # AI Elements 聊天组件
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
- **UI** — React 19 + shadcn/ui + AI Elements + Tailwind CSS 4
- **内容渲染** — Streamdown + remark-gfm / remark-math / KaTeX
- **主题** — shadcn/ui 默认 Neutral 配色，支持明亮、暗黑与跟随系统
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
pnpm test:ui     # 生产构建 + 浏览器 UI 回归检查
```

UI 检查默认使用已安装的 Chrome，模拟扩展消息与存储，并应用与扩展相同的脚本 CSP。覆盖审批、停止、重试、历史恢复、主题同步、附件标签、流式公式和窄侧边栏布局；真实 CDP 操作与模型 API 需在加载扩展后验证。可通过 `PLAYWRIGHT_CHANNEL` 选择其他已安装的浏览器通道。

组件源码直接保存在仓库中。`PromptInput` 的 `onFilesAdded` 接口让扩展沿用原始 `File` 状态；网页上的元素选择框和操作标记继续由原有 CDP 代码维护。当前附件沿用既有行为，仅在聊天中展示文件名，未增加文件内容上传协议。

提交信息使用 [Conventional Commits](https://www.conventionalcommits.org/zh-hans/v1.0.0/) 风格（`feat:` / `fix:` / `refactor:` ...）。

---

## 📄 License

[Apache License 2.0](LICENSE)
