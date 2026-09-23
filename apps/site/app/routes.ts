import { index, type RouteConfig, route } from "@react-router/dev/routes";

export default [
  index("routes/home.tsx"),
  route("docs/*", "routes/docs.tsx"),
  route("download", "routes/download.tsx"),
  route("changelog", "routes/changelog.tsx"),
  route("*", "routes/not-found.tsx"),
] satisfies RouteConfig;
