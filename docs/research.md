# 研究依据与验证边界

> 资料核对：2026-09-09。网页/源码支持不等于本机集成验证；实施时固定版本。本文仅保留当前有用结论，不继承旧研究中已放弃的范围。

## 客户端原生能力

- [Codex Skills](https://learn.chatgpt.com/docs/build-skills)：项目 .agents/skills、用户级 Skills、符号链接及按路径禁用；手动调用策略不直接等于零发现成本。全局禁用与项目链接的路径规范化/优先级仍需验证。
- [Codex MCP](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)：受信任项目配置和 enabled 开关；配置启用不等于现有会话进程控制。
- [Claude Skills](https://code.claude.com/docs/en/skills)：普通 Skill 的可见性覆盖与项目设置，插件另管；需要验证目标客户端版本及全局/项目合并行为。
- [Claude MCP](https://code.claude.com/docs/en/mcp)：作用域与按项目禁用；部分 list/get 操作可能健康检查，不归纯静态扫描。
- [Claude 设置](https://code.claude.com/docs/en/settings)：设置作用域与优先级参考。

## 可借鉴的现成工具

| 项目 | 参考能力 | 未证实部分 |
| --- | --- | --- |
| [Skills Manager](https://github.com/xingkongliang/skills-manager) | Project Workspaces、项目批量启停、库与链接/复制 | 两客户端多 Profile 全局隐藏组合 |
| [vercel-labs/skills](https://github.com/vercel-labs/skills) | 项目部署、指定客户端、移除 | 全局残留治理与运行状态 |
| [mode-io/skill-manager](https://github.com/mode-io/skill-manager) | Skills/MCP 标准化、按客户端管理 | 项目及多配置根组合 |
| [CC Switch](https://github.com/farion1231/cc-switch/blob/main/docs/user-manual/en/3-extensions/3.1-mcp.md) | MCP 同步与应用开关 | 现有会话进程控制 |
| [agentctl](https://github.com/liangquanzhou/agentctl) | plan/apply/drift/rollback 思路 | 长期可靠性与配置无损性 |

本次新仓库未安装或引入上述工具。优先参考成熟概念，不默认 fork。

## Lody 与 ACP

- [Lody](https://github.com/LodyAI/Lody)：Electron/CLI 与平台协议分层，参考运行时管理，不引入其团队/远程全套范围。
- [能力探测](https://github.com/LodyAI/Lody/blob/main/apps/cli/src/agent/acp-capabilities.ts)：临时启动 Agent、认证与能力归一化、finally 清理。探测可能有进程副作用。
- [ACP runner](https://github.com/LodyAI/Lody/blob/main/apps/cli/src/agent/acp-runner.ts)：参考启动监测、环境、权限与事件职责；仅定向读取，非完整审计。
- [发布流程](https://github.com/LodyAI/Lody/blob/main/.github/workflows/release-electron.yml)：tag 版本、签名与平台产物；Lody 的具体 updater 组合不直接作为选型结论。
- [公共边界](https://github.com/LodyAI/Lody/blob/main/AGENTS.md)：公开桌面/CLI 与私有托管实现分离。
- [价格页](https://lody.ai/price/)：工作区协作/成员收费，用户自带模型账户；不据此决定本项目套餐。
- [ACP 协议](https://agentclientprotocol.com/protocol/v1/overview)：会话、能力、权限、更新与取消，不是统一配置管理协议。
- [Codex ACP](https://github.com/agentclientprotocol/codex-acp)：当前通过 Codex App Server；旧 Zed 仓库已归档。
- [Claude ACP](https://github.com/agentclientprotocol/claude-agent-acp)：通过 Claude Agent SDK。认证与 Profile 继承需隔离验证。

## Skills 用量证据补充

- [Claude Code hooks](https://code.claude.com/docs/en/hooks)：会话 transcript_path 与工具事件可作为采集入口；直接命令展开与模型调用 Skill 工具需分别处理，按客户端版本验证。
- [OpenAI Docs：Codex App Server](https://learn.chatgpt.com/docs/app-server)：skills/list 提供资源列表，thread/list、thread/read 提供可访问历史，skill 输入项表达显式请求；不能据此推断存在完整 Skill 次数统计接口。
- 本次只核对文档及本机 Codex 0.153.4 的 CLI help，未扫描个人历史、连接历史接口或安装采集 hooks。日志保留、字段与自动调用归因仍待隔离样本验证。产品候选见 [Skills 使用统计与整理建议](skill-lifecycle.md)。

## 基础设施

- [SQLite 适用场景](https://www.sqlite.org/whentouse.html)、[WAL](https://www.sqlite.org/wal.html)：本地数据与容量维护。
- [Electron 安全](https://www.electronjs.org/docs/latest/tutorial/security)、[utilityProcess](https://www.electronjs.org/docs/latest/api/utility-process)、[更新](https://www.electronjs.org/docs/latest/tutorial/updates)：进程、权限和分发。
- [Chokidar](https://github.com/paulmillr/chokidar)：文件监听候选，须补足事件合并和重新核对。
- [Dokploy Applications](https://docs.dokploy.com/docs/core/applications)：未来官网部署与域名。
