import { Link, NavLink } from "react-router";
import logoUrl from "../../../../brand/logo.png";
import { SiteSearch } from "./site-search";

const links = [
  { href: "/docs", label: "文档" },
  { href: "/download", label: "下载" },
  { href: "/changelog", label: "更新" },
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
        <div className="header-actions">
          <nav className="desktop-nav" aria-label="主导航">
            <NavigationLinks />
          </nav>
          <SiteSearch className="header-search-trigger" />
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
      </div>
    </header>
  );
}
