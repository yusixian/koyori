import { type RouteConfig, index, route } from "@react-router/dev/routes";

export default [
  index("routes/home.tsx"),
  route("docs/*", "routes/docs.tsx"),
  route("download", "routes/download.tsx"),
  route("changelog", "routes/changelog.tsx"),
  route("search", "routes/search.tsx"),
  route("*", "routes/not-found.tsx"),
] satisfies RouteConfig;
