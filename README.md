# NekoPilot 🐱

AI-powered browser automation assistant，使用 Chrome Debugger Protocol (CDP) 控制浏览器。

## 功能

- 🤖 通过自然语言指令自动化浏览器操作
- 📸 页面截图、DOM 读取、元素交互
- 🔧 BYOK（Bring Your Own Key）— 支持 OpenAI 兼容 API
- 💬 实时显示 Agent 思考过程与操作日志

## 开发

```bash
pnpm install
pnpm dev
```

构建后在 Chrome 中加载 `dist` 目录作为解压扩展。

## 项目结构

```
src/
├── background/     # Service Worker + CDP 管理
│   ├── index.ts    # 消息路由
│   └── cdp.ts      # CDP 连接封装
├── agent/          # LLM Agent Loop
│   ├── loop.ts     # observe → think → act 循环
│   └── types.ts    # 类型定义
├── tools/          # Tool 系统
│   ├── definitions.ts  # Tool 注册表
│   ├── executor.ts     # Tool → CDP 执行
│   └── types.ts        # Tool 类型
├── sidepanel/      # Side Panel UI（聊天界面）
├── options/        # 设置页（BYOK 配置）
└── shared/         # 共享模块（主题、消息通信）
```

## License

MIT
