import type { MetaFunction } from "react-router";
import { Link } from "react-router";
import logoUrl from "../../../../brand/logo.png";
import { PageShell } from "../components/page-shell";
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
            Koyori 从 Skills 与个人 Agent 起步，面向 macOS，帮助你看清来源、作用域和变更，再决定如何使用与整理。
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
            <span className="status-dot" /> 开发候选 {productVersion} · 尚未发布安装包
          </p>
        </div>
        <div className="hero-art" aria-label="Koyori 品牌角色">
          <div className="thread-line thread-line-one" />
          <div className="thread-line thread-line-two" />
          <div className="logo-frame">
            <img src={logoUrl} alt="白粉短发、绿眼睛的 Koyori Q 版角色" />
          </div>
          <p>糸连接散落的能力，葉记录持续生长。</p>
        </div>
      </section>

      <section className="status-strip" aria-labelledby="now-title">
        <div className="section-wrap status-grid">
          <div>
            <p className="eyebrow">Current stage</p>
            <h2 id="now-title">只读 Skills 工作台已可运行</h2>
          </div>
          <p>
            已支持选择目录、扫描、筛选和预览，并加入 Claude Code 本机调用统计与复查偏好。整理写入与个人 Agent 接入继续迭代；当前尚无公开发行版。
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
          <p>安装、开发和安全文档已经建立；功能使用指南会在对应能力实现并验证后加入。</p>
        </div>
        <div className="route-links">
          <Link to="/docs/installation">安装状态 <span>↗</span></Link>
          <Link to="/docs/development">本地开发 <span>↗</span></Link>
          <Link to="/docs/security">安全与数据 <span>↗</span></Link>
        </div>
      </section>
    </PageShell>
  );
}
