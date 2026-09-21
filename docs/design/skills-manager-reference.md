# Skills Manager 参考调研

> 调研日期：2026-09-22
>
> 上游仓库：[xingkongliang/skills-manager](https://github.com/xingkongliang/skills-manager)
>
> 固定版本：[6ae02e39d9efea0faf75e643b8205f97833a593d](https://github.com/xingkongliang/skills-manager/tree/6ae02e39d9efea0faf75e643b8205f97833a593d)
> 方法：只读检查该提交的 README、源码和仓库内测试；未运行上游应用、测试或安装命令，也未向 Koyori 导入任何上游代码。

## 结论与边界

Skills Manager 是一个以中央技能库为中心的 Skills 安装、部署、Preset、项目工作区和备份工具。README 宣称支持统一技能库、项目/全局工作区、软链接或复制部署、自定义 Agent 目录及管理活动日志（[README.zh-CN.md#L55-L78](https://github.com/xingkongliang/skills-manager/blob/6ae02e39d9efea0faf75e643b8205f97833a593d/README.zh-CN.md#L55-L78)）。源码能确认其中若干底层机制和测试，但本次没有做运行时验收，不能把 README 的完整产品能力视为已验证事实。

它适合充当 Koyori 的 **Skills 文件兼容与安全操作参考**，不适合作为 Koyori 的产品蓝本。Koyori 使用 Electron/TypeScript，扩大版首版草案强调来源盘点、可追溯使用证据与可恢复整理，仍待审阅；Agent 与 cos-tool-bot 是另一条主线。上游则使用 React + Tauri 2 + Rust + SQLite（[package.json#L20-L59](https://github.com/xingkongliang/skills-manager/blob/6ae02e39d9efea0faf75e643b8205f97833a593d/package.json#L20-L59)、[Cargo.toml#L18-L56](https://github.com/xingkongliang/skills-manager/blob/6ae02e39d9efea0faf75e643b8205f97833a593d/src-tauri/Cargo.toml#L18-L56)），且产品中心是安装、跨 Agent 部署和同步。Koyori 应保持自己的信息架构、视觉和权限模型。

## 源码核对

### 客户端路径与自定义目录

- Adapter 把全局技能目录、客户端探测目录、额外发现目录、项目相对目录、是否递归扫描分成独立字段；额外目录只用于发现，不作为部署目标（[tool_adapters.rs#L17-L46](https://github.com/xingkongliang/skills-manager/blob/6ae02e39d9efea0faf75e643b8205f97833a593d/src-tauri/src/core/tool_adapters.rs#L17-L46)）。这种区分可以避免把“能看到”误当成“应写入”。
- 该提交把 Claude Code 主目录设为 `~/.claude/skills`，把 Codex 主目录设为 `~/.codex/skills`，同时把 `~/.agents/skills` 作为 Codex 的额外发现目录；源码注释明确它不是 Codex 的部署目标（[tool_adapters.rs#L161-L211](https://github.com/xingkongliang/skills-manager/blob/6ae02e39d9efea0faf75e643b8205f97833a593d/src-tauri/src/core/tool_adapters.rs#L161-L211)）。这是该提交的适配判断，不是 Koyori 可以继承的官方兼容保证。
- 用户提供的全局目录必须是绝对路径或 `~/` 路径；项目目录必须是相对路径且禁止 `..`（[tool_service.rs#L202-L250](https://github.com/xingkongliang/skills-manager/blob/6ae02e39d9efea0faf75e643b8205f97833a593d/src-tauri/src/core/tool_service.rs#L202-L250)）。内置 Agent key 与自定义 Agent key 冲突时保留内置项，仓库有对应测试（[tool_adapters.rs#L1055-L1112](https://github.com/xingkongliang/skills-manager/blob/6ae02e39d9efea0faf75e643b8205f97833a593d/src-tauri/src/core/tool_adapters.rs#L1055-L1112)）。

### 扫描、嵌套、软链接与重名

- `SKILL.md` 是首选入口，兼容小写 `skill.md`；`README.md` 和 `CLAUDE.md` 不构成 Skill 标记。实现与测试均覆盖这一规则（[skill_metadata.rs#L31-L88](https://github.com/xingkongliang/skills-manager/blob/6ae02e39d9efea0faf75e643b8205f97833a593d/src-tauri/src/core/skill_metadata.rs#L31-L88)、[skill_metadata.rs#L287-L315](https://github.com/xingkongliang/skills-manager/blob/6ae02e39d9efea0faf75e643b8205f97833a593d/src-tauri/src/core/skill_metadata.rs#L287-L315)）。仓库自己的格式说明把小写形式定位为 legacy compatibility，而非规范格式（[skill-format-detection-spec.md#L72-L100](https://github.com/xingkongliang/skills-manager/blob/6ae02e39d9efea0faf75e643b8205f97833a593d/docs/skill-format-detection-spec.md#L72-L100)）。
- 全局扫描默认只看直接子目录；只有 Adapter 明确开启 `recursive_scan` 才递归。递归扫描遇到一个 Skill 后停止下钻，跳过 `.git`、`.hub`、`node_modules`，并用 canonical path 集合防软链接循环（[scanner.rs#L33-L86](https://github.com/xingkongliang/skills-manager/blob/6ae02e39d9efea0faf75e643b8205f97833a593d/src-tauri/src/core/scanner.rs#L33-L86)）。测试覆盖嵌套 Skill、Skill 内嵌套、深层目录和软链接环（[scanner.rs#L276-L349](https://github.com/xingkongliang/skills-manager/blob/6ae02e39d9efea0faf75e643b8205f97833a593d/src-tauri/src/core/scanner.rs#L276-L349)）。
- 项目扫描保留 `relative_path`，递归时跳过隐藏目录和嵌入式 bundle 的 `skills` 子树；同一个真实目录可通过多个 Skill 叶子软链接分别呈现（[project_scanner.rs#L148-L241](https://github.com/xingkongliang/skills-manager/blob/6ae02e39d9efea0faf75e643b8205f97833a593d/src-tauri/src/core/project_scanner.rs#L148-L241)）。这是面向其产品布局的启发式规则，Koyori 需要用目标客户端样本重新确定跳过策略。
- 发现结果按“推断名称 + 内容指纹”分组：同名不同内容保留为两组，同名同内容合并多个位置（[scanner.rs#L217-L255](https://github.com/xingkongliang/skills-manager/blob/6ae02e39d9efea0faf75e643b8205f97833a593d/src-tauri/src/core/scanner.rs#L217-L255)、[scanner.rs#L412-L465](https://github.com/xingkongliang/skills-manager/blob/6ae02e39d9efea0faf75e643b8205f97833a593d/src-tauri/src/core/scanner.rs#L412-L465)）。Koyori 可借鉴“位置与逻辑资源分离”，但不能仅凭相同名称和 hash 永久合并身份；移动、分叉、来源及历史归因仍需单独记录。

### 导入、部署与删除

- 本地导入会清理目录名、为内容不同的同名 Skill 分配 `-2`、`-3` 后缀，并在复制时跳过 `.git`、`.DS_Store` 和源内软链接，避免把 Skill 目录外的内容带入中央库（[installer.rs#L82-L100](https://github.com/xingkongliang/skills-manager/blob/6ae02e39d9efea0faf75e643b8205f97833a593d/src-tauri/src/core/installer.rs#L82-L100)、[installer.rs#L220-L273](https://github.com/xingkongliang/skills-manager/blob/6ae02e39d9efea0faf75e643b8205f97833a593d/src-tauri/src/core/installer.rs#L220-L273)）。ZIP 解压使用 `enclosed_name` 防 Zip Slip（[installer.rs#L176-L217](https://github.com/xingkongliang/skills-manager/blob/6ae02e39d9efea0faf75e643b8205f97833a593d/src-tauri/src/core/installer.rs#L176-L217)）。
- 部署支持软链接和复制。写入前先分类目标、按策略决定是否允许替换，执行删除前再次检查，并按检查到的对象类型删除，避免检查后目标从链接变成真实目录时误删（[sync_engine.rs#L190-L258](https://github.com/xingkongliang/skills-manager/blob/6ae02e39d9efea0faf75e643b8205f97833a593d/src-tauri/src/core/sync_engine.rs#L190-L258)、[sync_engine.rs#L292-L326](https://github.com/xingkongliang/skills-manager/blob/6ae02e39d9efea0faf75e643b8205f97833a593d/src-tauri/src/core/sync_engine.rs#L292-L326)）。CLI 的部署/撤下支持 `--dry-run`，执行后重新核对目标记录和文件是否存在（[skills-manager-cli.rs#L1153-L1250](https://github.com/xingkongliang/skills-manager/blob/6ae02e39d9efea0faf75e643b8205f97833a593d/src-tauri/src/bin/skills-manager-cli.rs#L1153-L1250)、[skills-manager-cli.rs#L1253-L1345](https://github.com/xingkongliang/skills-manager/blob/6ae02e39d9efea0faf75e643b8205f97833a593d/src-tauri/src/bin/skills-manager-cli.rs#L1253-L1345)）。
- 删除路径不能整体照搬。CLI 删除要求 `--yes`，并提供 `--dry-run`（[skills-manager-cli.rs#L1815-L1857](https://github.com/xingkongliang/skills-manager/blob/6ae02e39d9efea0faf75e643b8205f97833a593d/src-tauri/src/bin/skills-manager-cli.rs#L1815-L1857)）；但最终 GUI/CLI 共用的删除函数对已记录目标调用无条件 `remove_target`，忽略目标和中央目录删除错误，随后仍删除数据库记录并写成功审计（[skills.rs#L743-L787](https://github.com/xingkongliang/skills-manager/blob/6ae02e39d9efea0faf75e643b8205f97833a593d/src-tauri/src/commands/skills.rs#L743-L787)）。同一仓库另有更安全的 `remove_recorded_target`，会在路径已被用户内容接管时保留它（[sync_engine.rs#L475-L510](https://github.com/xingkongliang/skills-manager/blob/6ae02e39d9efea0faf75e643b8205f97833a593d/src-tauri/src/core/sync_engine.rs#L475-L510)）。Koyori 未来写入必须统一走“计划 → revision/所有权复核 → 恢复材料 → 执行 → 回读”，且部分失败不能记成成功。

### “使用统计”的含义

上游 README 所称“活动日志”是安装、移除、更新、同步等管理操作（[README.zh-CN.md#L70-L77](https://github.com/xingkongliang/skills-manager/blob/6ae02e39d9efea0faf75e643b8205f97833a593d/README.zh-CN.md#L70-L77)）。`AuditEntry` 也只有 action、Skill、Agent、成功状态和详情，示例 action 是 `install`、`remove`、`enable`、`sync`（[audit_log.rs#L15-L41](https://github.com/xingkongliang/skills-manager/blob/6ae02e39d9efea0faf75e643b8205f97833a593d/src-tauri/src/core/audit_log.rs#L15-L41)）；写入点记录 install/update/remove/deploy/undeploy 等管理动作（[skills.rs#L791-L879](https://github.com/xingkongliang/skills-manager/blob/6ae02e39d9efea0faf75e643b8205f97833a593d/src-tauri/src/commands/skills.rs#L791-L879)）。没有发现模型实际加载或调用 Skill 的事件采集。

因此它不能替代 Koyori 的[使用账本](../skill-lifecycle.md)：管理活动、显式请求、加载证据、明确调用与任务结果必须分别建模；没有调用证据也不能显示成确定的 0 次。

## 对 Koyori 的具体借鉴

| 借鉴项 | Koyori 采用方式 | 证据与验收重点 |
| --- | --- | --- |
| Adapter 分离全局根、项目根、额外发现根与部署根 | 移植为 Electron/TS 的数据契约和适配器测试，不复制 Rust 类型 | 自定义路径、多个 Profile、共享根及“发现不等于可写” |
| `SKILL.md` 规范标记 + `skill.md` 兼容标记 | 作为可配置兼容规则；README/CLAUDE 不算 Skill | 大小写、坏 frontmatter、只有说明文件、带资源目录 |
| 递归策略由客户端决定 | 默认按已验证客户端语义扫描；循环检测、跳过目录和取消能力放在 scanner 核心 | 嵌套命名空间、软链接环、不可读目录、深目录与大目录 |
| 路径、来源、内容指纹与逻辑 ID 分离 | 同名不同内容不合并；同内容多位置显示共享关系，历史归因保留来源 | 移动、复制、分叉、共享链接、同名冲突 |
| 写入前分类、执行前复核、按类型删除、执行后回读 | 作为扩大版首版的受控写入切片独立实现；须独立验证计划、revision 和恢复 | 外部并发替换、链接变目录、部分成功、中断恢复 |
| 兼容性测试以临时目录验证真实文件行为 | 按客户端/版本建 fixture 和临时目录行为测试，而非只测 UI 映射 | 全局/项目路径、链接/复制、重名、越界、撤下后用户内容保留 |

这些属于**可移植规则**，可在 Koyori 中独立实现。若未来直接改写或翻译上游的具体函数、测试数据或 Adapter 表，则属于**选用代码**，必须进入来源映射与许可证流程。README 中“支持 54 个 Agent”、签名发布、备份同步等属于上游在该提交的产品声明，Koyori **不能直接继承其兼容保证**；每个拟支持客户端仍需依据官方资料和目标版本实测。

## 不应照搬

- 不把中央技能库、市场、Preset、跨设备 Git 备份和 54 Agent 覆盖一起塞进 Koyori 首版。这会淹没 Skills 使用证据与 Agent/cos-tool-bot 两条真实主线。
- 不复刻 Skills Manager 的页面结构、视觉、名称和交互文案。Koyori 保持自己的品牌与工作台定位。
- 不把 Rust/Tauri core 当作可直接复用模块。Electron/TypeScript 与其运行时、IPC、路径库和错误模型不同；优先移植契约、测试矩阵和安全不变量。只有某段实现显著降低风险时，才有选择地移植并记录来源。
- 不把管理审计日志当成 Skill 调用统计，也不把“已部署/可见”推断为“模型已加载或调用”。
- 不采用其无条件删除并吞错的最终删除路径；Koyori 的用户文件权威、revision、恢复和部分成功约束更严格。
- 不把固定提交里的客户端路径长期写死为事实。Adapter 数据应带依据、验证日期/版本与覆盖状态，并允许 Profile 级覆盖。

## 许可与来源记录

上游采用 MIT License，原版权为 `Copyright (c) 2026 Tianliang Zhang`（[LICENSE#L1-L13](https://github.com/xingkongliang/skills-manager/blob/6ae02e39d9efea0faf75e643b8205f97833a593d/LICENSE#L1-L13)）。截至本次调研，Koyori 仅参考设计和兼容性证据，**没有使用或分发其代码**，因此不能在 README 中写成“已基于其代码实现”。

若以后实际引入或改写上游代码，按 Koyori 项目要求同时完成：

1. README 明确列出上游仓库、固定来源 commit、用途及改动范围；
2. 在第三方许可证目录保留完整 MIT 文本和原版权声明；
3. 维护“上游文件/符号 → Koyori 本地文件/符号”的来源映射，便于审计、升级和替换；
4. 对实质性改写仍保留来源，不以改语言或重排结构规避归属；
5. 将兼容性验证与许可证归属分开：遵循 MIT 不代表客户端兼容已经验证。

## 本次未验证

- 未运行上游测试，文中“测试覆盖”仅表示固定提交中存在对应测试代码，不代表本机或 CI 已通过。
- 未启动 Tauri 应用或 CLI，未验证 README 的界面、安装包、签名、公证、备份同步或 54 Agent 实际兼容性。
- 未读取各 Agent 的最新官方实现来复核上游 Adapter 表；路径与行为可能在该提交之后变化。
- 未对上游全仓做安全审计；删除吞错是本次目标路径中确认的实现边界，不代表完整缺陷清单。
