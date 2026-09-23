import type { MetaFunction } from "react-router";
import { Link } from "react-router";
import { PageShell } from "../components/page-shell";
import { releaseManifest } from "../generated/release";
import { productVersion } from "../lib/version";

export const meta: MetaFunction = () => [
  { title: "下载 · Koyori" },
  { name: "description", content: "Koyori Preview 安装包与应用内更新说明。" },
];

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "medium",
    timeZone: "Asia/Shanghai",
  }).format(new Date(value));
}

function formatBytes(value: number): string {
  if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MiB`;
  if (value >= 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${value} bytes`;
}

function signingLabel(signing: "unsigned" | "signed" | "notarized"): string {
  if (signing === "notarized") return "已签名并公证";
  if (signing === "signed") return "已签名，未公证";
  return "未签名、未公证";
}

function installationLabel(installation: "automatic" | "manual"): string {
  return installation === "automatic"
    ? "应用内下载，用户确认后重启安装"
    : "浏览器下载 DMG，手动替换应用";
}

export default function DownloadPage() {
  if (releaseManifest) {
    return (
      <PageShell>
        <section className="page-hero section-wrap compact-hero">
          <p className="eyebrow">Download · Preview</p>
          <h1>下载 Koyori Preview。</h1>
          <p>
            当前公开版本为 v{releaseManifest.version}，面向 macOS{" "}
            {releaseManifest.minimumSystemVersion}+ Apple Silicon。
            {releaseManifest.installation === "automatic"
              ? "安装本版后，可以在应用内检查、下载并在确认后重启安装后续版本。"
              : "下载后退出旧版本，再手动替换应用。"}
          </p>
        </section>

        <section className="section-wrap release-panel" aria-labelledby="release-status">
          <div className="release-panel-head">
            <div>
              <span className="badge">{releaseManifest.channel}</span>
              <h2 id="release-status">v{releaseManifest.version}</h2>
            </div>
            <p className="availability">可下载</p>
          </div>
          <dl className="release-facts">
            <div>
              <dt>发布时间</dt>
              <dd>{formatDate(releaseManifest.publishedAt)}</dd>
            </div>
            <div>
              <dt>平台</dt>
              <dd>macOS {releaseManifest.minimumSystemVersion}+ · arm64</dd>
            </div>
            <div>
              <dt>安装方式</dt>
              <dd>{installationLabel(releaseManifest.installation)}</dd>
            </div>
            <div>
              <dt>签名状态</dt>
              <dd>{signingLabel(releaseManifest.signing)}</dd>
            </div>
          </dl>
          <div className="release-actions">
            <a
              className="button button-primary"
              href={releaseManifest.download.url}
              target="_blank"
              rel="noreferrer"
            >
              下载 DMG
            </a>
            <a
              className="button button-quiet"
              href={releaseManifest.releaseNotesUrl}
              target="_blank"
              rel="noreferrer"
            >
              查看 GitHub Release
            </a>
          </div>
          <dl className="release-integrity">
            <div>
              <dt>文件大小</dt>
              <dd>
                {formatBytes(releaseManifest.download.bytes)}（
                {releaseManifest.download.bytes.toLocaleString("en-US")} bytes）
              </dd>
            </div>
            <div>
              <dt>SHA-256</dt>
              <dd>
                <code>{releaseManifest.download.sha256}</code>
              </dd>
            </div>
            <div>
              <dt>构建 commit</dt>
              <dd>
                <code>{releaseManifest.commit}</code>
              </dd>
            </div>
          </dl>
        </section>

        <section className="section-wrap prose-card download-steps">
          <h2>{releaseManifest.installation === "automatic" ? "应用内更新" : "手动安装与更新"}</h2>
          {releaseManifest.installation === "automatic" ? (
            <ol>
              <li>
                首次安装或从手动更新版迁移时，先下载 DMG，将 Koyori 拖入 Applications 并替换旧版。
              </li>
              <li>在侧栏打开“更新”页面，查看自动检查结果或点击“检查更新”。</li>
              <li>看到新版本后，点击下载并等待应用完成下载。</li>
              <li>确认重启安装；应用只会在你的操作后退出并替换为新版本。</li>
            </ol>
          ) : (
            <ol>
              <li>点击上面的“下载 DMG”，等待浏览器下载完成。</li>
              <li>退出当前运行的 Koyori，再打开 DMG，把 Koyori 拖到 Applications 并替换旧版本。</li>
              <li>从 Applications 启动新版本。</li>
              <li>按 macOS 提示完成首次打开。</li>
            </ol>
          )}
          {releaseManifest.installation === "automatic" && (
            <p>
              应用会自动检查新版；下载和重启安装由你触发，普通退出不会安装更新。当前任务未结束时，应用会提示稍后再安装。
            </p>
          )}
          <p>
            下载前可先查看 <Link to="/docs/installation">安装说明</Link> 和{" "}
            <Link to="/changelog">更新记录</Link>。
          </p>
        </section>

        {releaseManifest.signing !== "notarized" && (
          <section className="section-wrap prose-card" aria-labelledby="damaged-app">
            <h2 id="damaged-app">提示“Koyori.app 已损坏，无法打开”？</h2>
            <p>
              当前 Preview 未经过 Apple 公证，macOS 可能显示此提示（英文为 “Koyori.app is damaged
              and can't be opened”）。请先确认 DMG 来自上方的 GitHub Release，并核对下载文件的
              SHA-256 与本页一致；摘要不一致时请重新下载。
            </p>
            <ol>
              <li>退出 Koyori，把 DMG 中的应用拖入“应用程序”。</li>
              <li>打开“终端”，对已安装的 Koyori 运行下面的命令：</li>
            </ol>
            <pre className="installation-command">
              <code>sudo xattr -r -d com.apple.quarantine /Applications/Koyori.app</code>
            </pre>
            <p>
              这只移除该应用的下载隔离属性，不会为它补上公证。运行后，从“应用程序”重新打开 Koyori。
            </p>
          </section>
        )}
      </PageShell>
    );
  }

  return (
    <PageShell>
      <section className="page-hero section-wrap compact-hero">
        <p className="eyebrow">Download</p>
        <h1>下载入口正在准备。</h1>
        <p>首个 macOS Preview 正在准备。完成安装与产物校验后，会按实际签名状态在这里开放下载。</p>
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
          <div>
            <dt>Stable</dt>
            <dd>暂无</dd>
          </div>
          <div>
            <dt>Preview</dt>
            <dd>暂无</dd>
          </div>
          <div>
            <dt>目标平台</dt>
            <dd>macOS（首版）</dd>
          </div>
          <div>
            <dt>签名状态</dt>
            <dd>准备中</dd>
          </div>
        </dl>
      </section>

      <section className="section-wrap prose-card">
        <h2>下载页会显示什么</h2>
        <ul>
          <li>真实版本、发布时间、macOS 最低版本和 Apple Silicon 架构。</li>
          <li>DMG 下载地址、文件大小、SHA-256 摘要和对应 GitHub Release。</li>
          <li>签名、公证与安装限制会按实际状态说明。</li>
          <li>安装后的更新支持检查、下载，以及由你确认的重启安装。</li>
        </ul>
        <p>
          想跟进当前工程状态，可以阅读 <Link to="/changelog">更新记录</Link> 或
          <Link to="/docs/development"> 本地开发说明</Link>。
        </p>
      </section>
    </PageShell>
  );
}
