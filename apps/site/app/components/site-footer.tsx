import { Link } from "react-router";

export function SiteFooter() {
  return (
    <footer className="site-footer">
      <div>
        <p className="footer-name">Koyori · 把散落的 AI 能力整理成自己的工作台</p>
        <p>项目正在建设，页面只记录已经确认的范围与当前状态。</p>
      </div>
      <nav aria-label="页脚导航">
        <Link to="/docs/security">安全与数据</Link>
        <a href="https://github.com/yusixian/koyori">GitHub</a>
      </nav>
    </footer>
  );
}
