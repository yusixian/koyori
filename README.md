# Koyori · こより

<img src="brand/logo.png" width="180" alt="Koyori Logo：白粉短发、绿眼睛的 Q 版美少女，樱花粉底" align="right" />

**把散落的 AI 能力，整理成自己的工作台。**

Koyori 是自用优先、从首版按开源方式建设的 AI Native 个人工作台。AI 资源管理与个人服务接入是当前探索方向。基于 Electron，首版面向 macOS，先支持 Claude Code 与 Codex，也为其他人的目录、项目和 Profile 保留可配置能力。

名字取自「こより」（纸捻），寄托把零散工具、能力与想法串起来的意象；视觉沿用 Astro Koharu 的樱粉、纸白、薄荷和柔和圆角，采用日系美少女 IP。

## 当前状态

**Skills 管理与自配模型文字对话已进入 Preview。** 当前公开版为 v0.1.0-alpha.4，使用 Apple Development 签名、未公证；安装包和更新方式见[下载页](https://koyori.cosine.ren/download/)。桌面端可自动发现 Claude Code 与 Codex Skills、核对使用证据，预览并执行完整目录同步、项目级受管部署与撤销、本地快照和恢复。Git 备份已通过隔离仓库往返验收。

个人 Agent 支持 OpenAI-compatible 模型连接、本地会话、流式回复与取消，不自动发送 Skills 或日志。选定 Skill 后可在 Agent 中预览并确认“始终保留”或“30 天后复查”本地操作卡。“我的服务”可在本机保存常用入口，并由系统默认浏览器打开 HTTPS 或本机回环 HTTP 地址；Bot 配对、通用工具操作卡和语音仍待实现。[文档站](https://koyori.cosine.ren/)已通过正式 HTTPS 检查；验证记录与剩余范围见[实施状态](docs/implementation-status.md)。

选中一项 Skill 后，可将使用证据与覆盖缺口生成摘要，预览并加入 Agent 草稿，再手动发送讨论。摘要不自动携带 Skill 正文、描述、路径或原始会话，已有草稿会保留。

## macOS 首次打开

从[下载页](https://koyori.cosine.ren/download/)获取 DMG，把 Koyori 拖入“应用程序”后打开。当前 Preview 尚未经过 Apple 公证。如果 macOS 提示“Koyori.app 已损坏，无法打开”（或 “Koyori.app is damaged and can't be opened”），先确认 DMG 来自本项目的 GitHub Release，并与下载页的 SHA-256 一致。退出 Koyori 后，在终端运行：

```sh
sudo xattr -r -d com.apple.quarantine /Applications/Koyori.app
```

这只移除该应用的下载隔离属性，不会为它补上公证；仅在核对下载来源和摘要后使用。随后从“应用程序”重新打开 Koyori。其他安装与更新说明见[安装指南](https://koyori.cosine.ren/docs/installation)。

## 本地开发

使用 `.node-version` 指定的 Node.js 与 `package.json` 指定的 pnpm：

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm dev
```

`pnpm dev:site` 启动独立文档站；`pnpm koyori --help` 查看 CLI。首次启动会检测 Claude Code 与 Codex 的已知目录；项目目录只在你登记项目后检查，系统目录保持只读。同步和恢复始终先预览计划，使用统计默认关闭。开发与检查命令见 [贡献指南](CONTRIBUTING.md)，当前结果与下一步见 [实施状态](docs/implementation-status.md)。

## 维护者发版

在支持项目 Skills 的 Codex 会话中使用 [`$oneshot`](.agents/skills/oneshot/SKILL.md)，例如“`$oneshot 发布下一个 Preview`”或“`$oneshot 继续 v<版本号>`”。它会准备版本说明，等 main CI 通过后接着触发受保护的 macOS Release，再更新下载页和文档站；中断后从远端已完成的步骤继续。日常验收由 CI 和发布工作流完成。它是代理工作流，**不是** `pnpm` 命令。具体构建模式与恢复规则见 [macOS 签名与发布](docs/release-signing.md)。

## 计划管理什么

| 资源 | 目标能力 |
| --- | --- |
| MCP | 发现和编辑配置、按作用域启用/禁用；区分配置状态、连接状态和本应用拥有的进程启停 |
| Skills | 自动发现新增和变更、按项目启用；明确全局来源对可见性的影响 |
| Claude commands | 统一浏览、编辑和管理自定义命令 |
| 指令与文档 | 扫描全局、项目及嵌套 AGENTS.md / CLAUDE.md，以及项目 Markdown |
| Agent 与 CLI | 自配模型文字对话与本地会话；个人 Bot 连接、工具操作卡和明确偏好后续接入；CLI 共用核心查询/计划，ACP 后续评估 |

自动发现会在启动和运行期间检查已知目录；用户开启后，Claude Code Skills 使用证据随检查增量更新，并保留覆盖、规则与到期复查。同步、恢复和本地快照已经使用同一套计划与 revision 边界；个人 Agent 当前只把当前会话文字交给用户选定的模型服务，不自动附加 Skills、使用账本或日志。推荐不会直接触发删除。

## MVP 路线

当前首版方案见 [0.1 MVP 审阅草案](docs/design/mvp-0.1.0.md)：以 **Skills + 个人 Agent** 为两条主线：资源清单、使用证据与可恢复整理，自配模型文字会话；个人 Bot 的原生对话和操作卡仍是后续范围，配套文档站与安装包。**方向已确认，工程起点已建立；完整 0.1 尚未交付。** 下列内容保留为长期模块方向，不是 0.1 的全部交付要求。

工程起步同时建立版本管理、Dokploy 文档站配置、下载页、更新说明与安装包验收；这些不再推迟到 MVP 之后。首条流程为选择目录、只读扫描和预览，以下资源能力按切片推进。

1. **看得全**：注册项目与客户端 Profile，扫描资源并显示来源、作用域和变化。
2. **改得稳**：实现 Skills 按项目启用、MCP 配置管理、文档编辑，提供差异预览和恢复。
3. **用得久**：CLI、应用专属缓存清理、反馈入口，以及发布所需的更新与分发能力。

先验证真实自用流程；内部 API 和 schema 在 MVP 期间允许调整。文件写入、恢复和清理边界仍需针对性验证。

## 数据与操作原则

- 用户原始文件是权威来源，写入前核对版本，避免覆盖外部修改。
- 自动发现不等于自动启用、上传、运行或删除。
- GUI、CLI 和 AI 共用核心操作与权限边界。
- 清缓存只涉及本应用可重建数据，保护 Skills、配置、凭据和草稿。
- Agent 连接按连接身份隔离，密钥使用系统安全存储加密后保存在本机；模型请求只包含当前会话文字，不自动携带 Skills、账本或日志。
- 本地核心无需云账户；专业版、可选云服务与团队能力留作后续扩展。

## 文档与继续开发

- [产品范围](docs/product.md)：目标、MVP、自动发现与 AI Native。
- [0.1 MVP 审阅草案](docs/design/mvp-0.1.0.md)：界面草图、首版边界、验收、发布和 Sol 编码分工。
- [个人 Agent 与 Bot 接入](docs/design/personal-agent.md)：角色、记忆、语音候选与私有服务接入边界。
- [自配模型与文字对话](apps/site/content/docs/agent.mdx)：OpenAI-compatible 连接、本地会话、流式回复、取消与数据边界。
- [Skills Manager 参考](docs/design/skills-manager-reference.md)：实现/兼容性调研、选择性复用与许可要求。
- [Skills 发现、同步与备份](apps/site/content/docs/skills-management.mdx)：自动检测范围、安全同步、本地快照与恢复。
- [使用统计指南](apps/site/content/docs/skill-usage.mdx) · [账本实现与限制](docs/design/usage-ledger.md)。
- [Skills 使用统计与整理建议](docs/skill-lifecycle.md)：调用证据、闲置规则、到期提醒与 AI 推荐候选。
- [架构与数据](docs/architecture.md)：核心进程、领域模型、SQLite、缓存与恢复。
- [路线图与分发](docs/roadmap.md)：官网、反馈、更新、商业化预留。
- [发布与开源基线](docs/design/release-foundation.md)：首版版本化、Dokploy 文档站、安装包与验收发布约定。
- [macOS 签名配置](docs/release-signing.md)：Developer ID、公证凭据、GitHub 发布环境与 Preview 更新流程。
- [研究依据](docs/research.md)：官方资料、Lody 和现成工具的参考边界。
- [品牌说明](brand/README.md) · [工程约定](AGENTS.md)。

## 仓库与来源

仓库：[yusixian/koyori](https://github.com/yusixian/koyori)。代码和文档采用 [MIT License](LICENSE)，品牌说明见 [brand/README.md](brand/README.md)，第三方来源见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。安全问题请使用 [私密报告入口](SECURITY.md)。

## 致谢与第三方代码

Skills 模块参考 [xingkongliang/skills-manager](https://github.com/xingkongliang/skills-manager) 的实现与客户端兼容处理，计划在评估后选择性复用或改编适合的代码。感谢原作者 Tianliang Zhang；该项目采用 [MIT License](https://github.com/xingkongliang/skills-manager/blob/6ae02e39d9efea0faf75e643b8205f97833a593d/LICENSE)。

**当前仅完成调研，尚未引入其代码。** 实际引入时，将在本节明确列出使用/改编范围，并同步记录上游 commit、本地文件映射、修改说明，保留原版权声明及完整 MIT 许可文本，随源码和安装包分发；不以一句致谢替代许可声明。

Koyori 保持自己的个人工作台定位、角色品牌、界面与 Agent 交互；不会把参考项目的完整产品、客户端支持数量或验证结果直接视为 Koyori 的能力。cos-tool-bot 的接入计划采用独立服务接口，私有实现不随 Koyori 开源或打包。
