# 参与 Koyori

先阅读 [工程约定](AGENTS.md) 和 [首版范围](docs/design/mvp-0.1.0.md)。当前以 macOS 自用体验为起点，大范围功能请先讨论。

## 开发

使用 `.node-version` 指定的 Node.js 和 `package.json` 的 pnpm 版本：

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm dev
pnpm dev:site
```

`pnpm koyori scan --client claude-code --root /path/to/skills` 只读扫描指定目录，输出 JSON。不要把命令输出中的私人路径或内容贴到公开 Issue。

## 验证

- `pnpm lint`、`pnpm typecheck`：格式、代码规则与类型检查。
- `pnpm test`：合成数据与临时目录的行为测试。
- `pnpm build`：桌面和独立站点构建。
- `pnpm test:desktop`：构建后通过 Playwright 在真实 Electron 中验收，只用临时目录。
- `pnpm package:mac`：在 macOS 生成本地候选安装包，默认不公证、不公开发布。
- `pnpm check:public`：检查待公开文件的基础隐私边界；不能替代人工历史审查。

日常只跑相关检查，完整验证交 CI。PR 不得包含会话原文、密钥、真实用户配置或私有 Bot 源码。不要修改用户目录来做测试。

## 发布

产品版本以根 `package.json` 为准；内部包不独立发布。更新说明唯一正文位于 `docs/releases`。本地候选包不等于公开发行；发布前须完成同一产物的安装验收、签名策略和公开检查，见 [发布基线](docs/design/release-foundation.md)。
