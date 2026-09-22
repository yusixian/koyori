export const searchablePages = [
  {
    title: "文档起点",
    href: "/docs",
    description: "了解 Koyori 当前阶段、文档边界和阅读顺序。",
    keywords: "开始 状态 文档 工作台",
  },
  {
    title: "安装",
    href: "/docs/installation",
    description: "当前安装状态，以及首个安装包发布后的核验原则。",
    keywords: "安装 macOS 下载 安装包 签名 公证",
  },
  {
    title: "Skills 发现、同步与备份",
    href: "/docs/skills-management",
    description: "自动发现 Claude Code 与 Codex 目录，预览完整目录同步并恢复快照。",
    keywords: "Skills 自动发现 同步 备份 恢复 Git Codex Claude 目录 冲突 CLI",
  },
  {
    title: "Skills 使用统计",
    href: "/docs/skill-usage",
    description: "连接 Claude Code 历史，核对调用证据、覆盖和整理偏好。",
    keywords: "Skills Claude 调用 使用 次数 账本 证据 规则 保留 复查 CLI",
  },
  {
    title: "本地开发",
    href: "/docs/development",
    description: "Node、pnpm、文档站与桌面工程的开发起点。",
    keywords: "开发 Node pnpm 5174 build typecheck",
  },
  {
    title: "安全与数据",
    href: "/docs/security",
    description: "本地数据、凭据、授权和安全报告的当前边界。",
    keywords: "安全 数据 凭据 权限 隐私",
  },
  {
    title: "下载",
    href: "/download",
    description: "查看发布状态；当前没有可下载的 Koyori 安装包。",
    keywords: "下载 release preview stable 版本",
  },
  {
    title: "更新记录",
    href: "/changelog",
    description: "查看未发布的工程进展；当前没有公开版本记录。",
    keywords: "更新 changelog release 未发布",
  },
] as const;
