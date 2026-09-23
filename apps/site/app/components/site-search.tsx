import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router";
import { searchablePages } from "../lib/site-content";

export function SiteSearch({ className = "" }: { className?: string }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const followingResultRef = useRef(false);
  const location = useLocation();
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const normalized = query.trim().toLocaleLowerCase("zh-CN");
  const results = useMemo(
    () =>
      normalized
        ? searchablePages.filter((page) =>
            `${page.title} ${page.description} ${page.keywords}`
              .toLocaleLowerCase("zh-CN")
              .includes(normalized),
          )
        : searchablePages.slice(0, 4),
    [normalized],
  );

  useEffect(() => {
    if (location.pathname === "/search") {
      if (!dialogRef.current?.open) dialogRef.current?.showModal();
    }
  }, [location.pathname]);

  function close() {
    dialogRef.current?.close();
  }

  function handleClose() {
    setQuery("");
    if (followingResultRef.current) {
      followingResultRef.current = false;
      return;
    }
    if (location.pathname === "/search") {
      navigate("/", { replace: true });
    }
  }

  return (
    <>
      <button className={className} type="button" onClick={() => dialogRef.current?.showModal()}>
        查找
      </button>
      <dialog
        className="site-search-dialog"
        ref={dialogRef}
        aria-label="查找站内内容"
        onClose={handleClose}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            close();
          }
        }}
        onClick={(event) => {
          if (event.target === dialogRef.current) close();
        }}
      >
        <div className="site-search-panel">
          <div className="site-search-input-row">
            <svg aria-hidden="true" viewBox="0 0 24 24">
              <circle cx="11" cy="11" r="6" />
              <path d="m16 16 4 4" />
            </svg>
            <input
              type="search"
              aria-label="输入关键词"
              placeholder="搜索文档、安装、Skills…"
              value={query}
              onChange={(event) => setQuery(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "ArrowDown") {
                  event.preventDefault();
                  dialogRef.current
                    ?.querySelector<HTMLAnchorElement>(".site-search-results a")
                    ?.focus();
                }
              }}
              autoFocus
            />
            <button
              className="site-search-close"
              type="button"
              onClick={close}
              aria-label="关闭查找"
            >
              <span aria-hidden="true">×</span>
            </button>
          </div>
          <div className="site-search-body" aria-live="polite">
            <p className="site-search-caption">
              {normalized ? `找到 ${results.length} 项内容` : "常用入口"}
            </p>
            {results.length > 0 ? (
              <div className="site-search-results">
                {results.map((page) => (
                  <Link
                    key={page.href}
                    to={page.href}
                    onClick={() => {
                      followingResultRef.current = true;
                      close();
                    }}
                  >
                    <span>
                      <strong>{page.title}</strong>
                      <small>{page.description}</small>
                    </span>
                    <span aria-hidden="true">↗</span>
                  </Link>
                ))}
              </div>
            ) : (
              <p className="site-search-empty">没有找到对应内容，试试更短的关键词。</p>
            )}
          </div>
          <p className="site-search-hint">输入关键词查找 · Esc 关闭</p>
        </div>
      </dialog>
    </>
  );
}
