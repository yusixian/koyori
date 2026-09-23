import { DocsLayout } from "fumadocs-ui/layouts/docs";
import { DocsBody, DocsDescription, DocsPage, DocsTitle } from "fumadocs-ui/layouts/docs/page";
import type { MetaFunction } from "react-router";
import { Link, useParams } from "react-router";
import { getMdxComponents } from "../components/mdx";
import { SiteSearch } from "../components/site-search";
import { source } from "../lib/source";

export const meta: MetaFunction = ({ params }) => {
  const slugs = params["*"]?.split("/").filter(Boolean) ?? [];
  const page = source.getPage(slugs);
  return [
    { title: page ? `${page.data.title} · Koyori 文档` : "Koyori 文档" },
    ...(page?.data.description ? [{ name: "description", content: page.data.description }] : []),
  ];
};

export default function DocsRoute() {
  const params = useParams();
  const slugs = params["*"]?.split("/").filter(Boolean) ?? [];
  const page = source.getPage(slugs);

  if (!page) {
    return (
      <main id="main-content" className="error-shell">
        <p className="eyebrow">404 · docs</p>
        <h1>没有这篇文档</h1>
        <p>这条路径可能尚未发布，或文档已经移动。</p>
        <Link className="button button-primary" to="/docs">
          返回文档目录
        </Link>
      </main>
    );
  }

  const Mdx = page.data.body;

  return (
    <div id="main-content">
      <DocsLayout
        tree={source.pageTree}
        nav={{
          title: (
            <span className="docs-wordmark">
              Koyori <small>こより</small>
            </span>
          ),
        }}
        links={[
          { text: "下载", url: "/download" },
          { text: "更新", url: "/changelog" },
        ]}
        searchToggle={{ enabled: false }}
        themeSwitch={{ enabled: false }}
        githubUrl="https://github.com/yusixian/koyori"
      >
        <DocsPage toc={page.data.toc}>
          <DocsTitle>{page.data.title}</DocsTitle>
          {page.data.description ? (
            <DocsDescription>{page.data.description}</DocsDescription>
          ) : null}
          <DocsBody>
            <Mdx components={getMdxComponents()} />
          </DocsBody>
        </DocsPage>
      </DocsLayout>
      <div className="docs-search-dock">
        <SiteSearch className="docs-search-trigger" />
      </div>
    </div>
  );
}
