import type { MetaFunction } from "react-router";
import { Link } from "react-router";
import { PageShell } from "../components/page-shell";

export const meta: MetaFunction = () => [{ title: "页面不存在 · Koyori" }];

export default function NotFoundPage() {
  return (
    <PageShell>
      <section className="not-found section-wrap">
        <p className="not-found-code">404</p>
        <p className="eyebrow">Loose thread</p>
        <h1>这根线没有连到页面。</h1>
        <p>地址可能写错了，或者内容还没有公开。</p>
        <div className="hero-actions">
          <Link className="button button-primary" to="/">返回首页</Link>
          <Link className="button button-quiet" to="/search">查找内容</Link>
        </div>
      </section>
    </PageShell>
  );
}
