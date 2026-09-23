import type { MetaFunction } from "react-router";
import { PageShell } from "../components/page-shell";
import {
  releaseKind,
  releaseManifest,
  releaseMarkdown,
  releaseSourceFound,
} from "../generated/release";
import { productVersion } from "../lib/version";

export const meta: MetaFunction = () => [
  { title: "更新记录 · Koyori" },
  { name: "description", content: "Koyori 已公开版本与工程更新记录。" },
];

type Block =
  | { kind: "heading"; level: 2 | 3; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "list"; items: string[] };

function parseMarkdown(markdown: string): Block[] {
  const blocks: Block[] = [];
  const paragraphs: string[] = [];
  let list: string[] = [];

  const flushParagraph = () => {
    if (paragraphs.length > 0) {
      blocks.push({ kind: "paragraph", text: paragraphs.join(" ") });
      paragraphs.length = 0;
    }
  };
  const flushList = () => {
    if (list.length > 0) {
      blocks.push({ kind: "list", items: list });
      list = [];
    }
  };

  for (const rawLine of markdown.split("\n")) {
    const line = rawLine.trim();
    if (!line) {
      flushParagraph();
      flushList();
      continue;
    }
    const heading = /^(##|###)\s+(.+)$/.exec(line);
    if (heading) {
      flushParagraph();
      flushList();
      blocks.push({
        kind: "heading",
        level: heading[1] === "##" ? 2 : 3,
        text: heading[2],
      });
      continue;
    }
    if (/^[-*]\s+/.test(line)) {
      flushParagraph();
      list.push(line.replace(/^[-*]\s+/, ""));
      continue;
    }
    flushList();
    paragraphs.push(line.replace(/^#\s+/, ""));
  }
  flushParagraph();
  flushList();
  return blocks;
}

function renderInline(text: string) {
  return text
    .split(/(`[^`]+`)/g)
    .map((part, index) =>
      part.startsWith("`") && part.endsWith("`") ? (
        <code key={`${part}-${index}`}>{part.slice(1, -1)}</code>
      ) : (
        part
      ),
    );
}

export default function ChangelogPage() {
  const blocks = parseMarkdown(releaseMarkdown);
  const published = releaseKind === "published" && releaseManifest;

  return (
    <PageShell>
      <section className="page-hero section-wrap compact-hero">
        <p className="eyebrow">Changelog</p>
        <h1>{published ? `v${published.version} 更新记录。` : "更新记录正在积累。"}</h1>
        <p>
          {published
            ? "这份记录对应公开清单中的同一版本；安装包、commit 和完整说明以 GitHub Release 为准。"
            : `当前内容属于开发候选 ${productVersion} 的未发布草稿，不代表 GitHub Release 或安装包已经公开。`}
        </p>
      </section>
      <section
        className="section-wrap changelog-paper"
        aria-label={published ? "已发布更新记录" : "未发布更新草稿"}
      >
        <header>
          <div>
            <span className="badge">{published ? published.channel : "Unreleased"}</span>
            <h2>{published ? `v${published.version}` : productVersion}</h2>
          </div>
          <p>
            {releaseSourceFound
              ? published
                ? "同步自对应版本的唯一发布正文"
                : "同步自 docs/releases/unreleased.md"
              : "等待首份更新草稿"}
          </p>
        </header>
        <div className="release-copy">
          {blocks.map((block, index) => {
            if (block.kind === "heading") {
              return block.level === 2 ? (
                <h3 key={`${block.text}-${index}`}>{renderInline(block.text)}</h3>
              ) : (
                <h4 key={`${block.text}-${index}`}>{renderInline(block.text)}</h4>
              );
            }
            if (block.kind === "list") {
              return (
                <ul key={`list-${index}`}>
                  {block.items.map((item) => (
                    <li key={item}>{renderInline(item)}</li>
                  ))}
                </ul>
              );
            }
            return <p key={`paragraph-${index}`}>{renderInline(block.text)}</p>;
          })}
        </div>
        {published ? (
          <p className="release-external-link">
            <a href={published.releaseNotesUrl} target="_blank" rel="noreferrer">
              在 GitHub 查看完整发布说明 ↗
            </a>
          </p>
        ) : null}
      </section>
    </PageShell>
  );
}
