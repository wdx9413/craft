# Craft Datasec 子能力

独立的 TypeScript 脱敏核心、私有映射和宿主 hook 适配。没有 Context、Craft Store 或 MCP 依赖。

安装包配置和使用边界见 [插件说明](../../plugins/craft-datasec/README.md)。

- `rules.ts`：本地规则、重叠匹配选择及文本/JSON 脱敏。
- `vault.ts`：会话隔离的 HMAC 占位符和批量 SQLite 映射。
- `hook.ts`：Claude/Codex 契约及本地编辑还原。
- `../../bin/craft-datasec-hook.ts`：标准输入 JSON 到标准输出 JSON 的独立进程入口。
- `build.ts`：只构建 `plugins/craft-datasec/dist/hook.mjs`。

```sh
npm run build
npm run typecheck
npm run coverage
```

不会安装 `sanitize`，不会自动注册 hook，也不会修改已有插件或公司 PII 配置。
