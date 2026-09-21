import { useMemo, useState } from "react";
import type { MetaFunction } from "react-router";
import { Link } from "react-router";
import { PageShell } from "../components/page-shell";
import { searchablePages } from "../lib/site-content";

export const meta: MetaFunction = () => [
  { title: "查找内容 · Koyori" },
  { name: "description", content: "查找 Koyori 公开文档与发布状态页面。" },
];

export default function SearchPage() {
  const [query, setQuery] = useState("");
  const results = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase("zh-CN");
    if (!normalized) return searchablePages;
    return searchablePages.filter((page) =>
      `${page.title} ${page.description} ${page.keywords}`
        .toLocaleLowerCase("zh-CN")
        .includes(normalized),
    );
  }, [query]);

  return (
    <PageShell>
      <section className="page-hero section-wrap search-hero">
        <p className="eyebrow">Find content</p>
        <h1>查找公开内容</h1>
        <label className="search-field">
          <span className="sr-only">输入关键词</span>
          <svg aria-hidden="true" viewBox="0 0 24 24"><circle cx="11" cy="11" r="6" /><path d="m16 16 4 4" /></svg>
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
            placeholder="试试：安装、安全、开发…"
            autoFocus
          />
        </label>
      </section>
      <section className="section-wrap search-results" aria-live="polite">
        <p className="result-count">{results.length} 项内容</p>
        {results.length > 0 ? (
          <div>
            {results.map((page) => (
              <Link key={page.href} to={page.href}>
                <span><strong>{page.title}</strong><small>{page.href}</small></span>
                <p>{page.description}</p>
                <i aria-hidden="true">↗</i>
              </Link>
            ))}
          </div>
        ) : (
          <div className="empty-result">
            <h2>没有找到对应内容</h2>
            <p>试试更短的关键词。功能文档只会在能力实现并验证后加入。</p>
          </div>
        )}
      </section>
    </PageShell>
  );
}
