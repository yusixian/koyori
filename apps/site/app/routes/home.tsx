import type { MetaFunction } from "react-router";
import { Link } from "react-router";
import logoUrl from "../../../../brand/logo.png";
import { PageShell } from "../components/page-shell";
import { releaseManifest } from "../generated/release";
import { productVersion } from "../lib/version";

export const meta: MetaFunction = () => [
  { title: "Koyori · AI Native 个人工作台" },
  {
    name: "description",
    content: "Koyori 是面向 macOS 的 AI Native 个人工作台，目前处于首版工程建设阶段。",
  },
];

const principles = [
  ["看得见来源", "资源来自哪里、作用于哪个项目，先说明白再操作。"],
  ["修改可审阅", "计划、差异与恢复材料属于同一次操作，不用成功提示掩盖未知状态。"],
  ["边界留在本机", "本地核心不要求云账户，外部服务按账号与能力分别授权。"],
];

export default function HomePage() {
  const publicRelease = releaseManifest;

  return (
    <PageShell>
      <section className="hero section-wrap">
        <div className="hero-copy">
          <p className="eyebrow">AI Native · personal workbench</p>
          <h1>
            把散落的 AI 能力，
            <span>整理成自己的工作台。</span>
          </h1>
          <p className="hero-lead">
            Koyori 从 Skills 与个人 Agent 起步，面向
            macOS，帮助你自动发现本机能力、看清使用证据，再安全同步与恢复。
          </p>
          <div className="hero-actions">
            <Link className="button button-primary" to="/docs">
              阅读起步文档
            </Link>
            <Link className="button button-quiet" to="/download">
              查看发布状态
            </Link>
          </div>
          <p className="release-note">
            <span className="status-dot" />
            {publicRelease
              ? `${publicRelease.channel === "preview" ? "Preview" : "Stable"} v${publicRelease.version} · 可下载`
              : `开发候选 ${productVersion} · 尚未发布安装包`}
          </p>
        </div>
        <div className="hero-art">
          <div className="logo-frame">
            <img src={logoUrl} alt="白粉短发、绿眼睛的 Koyori Q 版角色" />
          </div>
          <p>把散落的能力，轻轻连在一起。</p>
        </div>
      </section>

      <section className="status-strip" aria-labelledby="now-title">
        <div className="section-wrap status-grid">
          <div>
            <p className="eyebrow">Current stage</p>
            <h2 id="now-title">Skills 自用闭环正在成形</h2>
          </div>
          <p>
            开发版已支持自动发现 Claude Code 与 Codex Skills、完整目录同步和本地恢复快照；Claude
            Code 使用证据可在开启后持续更新。个人 Agent 已支持自配模型文字会话和流式回复，
            {publicRelease
              ? publicRelease.installation === "automatic"
                ? "当前 Preview 支持应用内检查、下载和用户确认后的重启安装。"
                : "当前 Preview 可下载并手动更新。"
              : "安装包尚未公开发行。"}
          </p>
        </div>
      </section>

      <section className="section-wrap principle-section" aria-labelledby="principles-title">
        <div className="section-heading">
          <p className="eyebrow">Working agreements</p>
          <h2 id="principles-title">从第一版就守住的三件事</h2>
        </div>
        <div className="principle-grid">
          {principles.map(([title, text], index) => (
            <article key={title}>
              <span aria-hidden="true">0{index + 1}</span>
              <h3>{title}</h3>
              <p>{text}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="section-wrap route-card" aria-labelledby="route-title">
        <div>
          <p className="eyebrow">Start here</p>
          <h2 id="route-title">先从真实状态开始</h2>
          <p>从自动发现开始，先核对同步计划和兼容提示，再用本地快照保护每次替换。</p>
        </div>
        <div className="route-links">
          <Link to="/docs/skills-management">
            管理 Skills <span>↗</span>
          </Link>
          <Link to="/docs/skill-usage">
            查看使用证据 <span>↗</span>
          </Link>
          <Link to="/docs/agent">
            连接模型 <span>↗</span>
          </Link>
          <Link to="/docs/security">
            安全与数据 <span>↗</span>
          </Link>
        </div>
      </section>
    </PageShell>
  );
}
