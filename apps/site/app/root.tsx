import type { ReactNode } from "react";
import {
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  isRouteErrorResponse,
} from "react-router";
import { RootProvider } from "fumadocs-ui/provider/react-router";
import logoUrl from "../../../brand/logo.png";
import "./styles.css";

export function Layout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="theme-color" content="#fffaf8" />
        <link rel="icon" href={logoUrl} type="image/png" />
        <Meta />
        <Links />
      </head>
      <body>
        <a className="skip-link" href="#main-content">
          跳到主要内容
        </a>
        <RootProvider
          search={{ enabled: false }}
          theme={{
            defaultTheme: "light",
            enableSystem: false,
            forcedTheme: "light",
            hotKey: false,
          }}
        >
          {children}
        </RootProvider>
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function App() {
  return <Outlet />;
}

export function ErrorBoundary({ error }: { error: unknown }) {
  const message = isRouteErrorResponse(error)
    ? `${error.status} ${error.statusText}`
    : "页面暂时无法显示";

  return (
    <main id="main-content" className="error-shell">
      <p className="eyebrow">Koyori</p>
      <h1>{message}</h1>
      <p>请返回首页，或从文档目录重新开始。</p>
      <a className="button button-primary" href="/">
        返回首页
      </a>
    </main>
  );
}
