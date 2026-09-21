import type { MetaFunction } from "react-router";
import { Link } from "react-router";
import { PageShell } from "../components/page-shell";
import { productVersion } from "../lib/version";

export const meta: MetaFunction = () => [
  { title: "下载 · Koyori" },
  { name: "description", content: "Koyori 当前发布与安装包状态。" },
];

export default function DownloadPage() {
  return (
    <PageShell>
      <section className="page-hero section-wrap compact-hero">
        <p className="eyebrow">Download</p>
        <h1>安装包还没有发布。</h1>
        <p>当前提供源码构建，公开安装包将在验收后发布。</p>
      </section>

      <section className="section-wrap release-panel" aria-labelledby="release-status">
        <div className="release-panel-head">
          <div>
            <span className="badge">开发候选</span>
            <h2 id="release-status">{productVersion}</h2>
          </div>
          <p className="availability">未发布</p>
        </div>
        <dl className="release-facts">
          <div><dt>Stable</dt><dd>暂无</dd></div>
          <div><dt>Preview</dt><dd>暂无</dd></div>
          <div><dt>目标平台</dt><dd>macOS（首版）</dd></div>
          <div><dt>签名与公证</dt><dd>尚未验收</dd></div>
        </dl>
      </section>

      <section className="section-wrap prose-card">
        <h2>第一个下载会满足什么条件</h2>
        <ul>
          <li>安装包绑定明确的版本、commit 和 SHA-256 摘要。</li>
          <li>候选产物经过安装、启动、核心流程和版本显示验收。</li>
          <li>签名、公证与已知限制会按实际状态说明。</li>
          <li>发行物可用后，下载入口才会在这里出现。</li>
        </ul>
        <p>
          想跟进当前工程状态，可以阅读 <Link to="/changelog">未发布更新</Link> 或
          <Link to="/docs/development"> 本地开发说明</Link>。
        </p>
      </section>
    </PageShell>
  );
}
