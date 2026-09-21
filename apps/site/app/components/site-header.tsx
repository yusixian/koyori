import { Link, NavLink } from "react-router";
import logoUrl from "../../../../brand/logo.png";

const links = [
  { href: "/docs", label: "文档" },
  { href: "/download", label: "下载" },
  { href: "/changelog", label: "更新" },
  { href: "/search", label: "查找" },
];

function NavigationLinks({ mobile = false }: { mobile?: boolean }) {
  return links.map((link) => (
    <NavLink
      key={link.href}
      to={link.href}
      className={({ isActive }) => (isActive ? "is-active" : undefined)}
      data-mobile={mobile || undefined}
    >
      {link.label}
    </NavLink>
  ));
}

export function SiteHeader() {
  return (
    <header className="site-header">
      <div className="header-inner">
        <Link className="wordmark" to="/" aria-label="Koyori 首页">
          <img src={logoUrl} alt="" width="42" height="42" />
          <span>
            <strong>Koyori</strong>
            <small>こより</small>
          </span>
        </Link>
        <nav className="desktop-nav" aria-label="主导航">
          <NavigationLinks />
        </nav>
        <details className="mobile-menu">
          <summary aria-label="打开导航">
            <span />
            <span />
            <span />
          </summary>
          <nav aria-label="移动导航">
            <NavigationLinks mobile />
          </nav>
        </details>
      </div>
    </header>
  );
}
