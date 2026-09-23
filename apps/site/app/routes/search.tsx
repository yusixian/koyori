import type { MetaFunction } from "react-router";
import HomePage from "./home";

export const meta: MetaFunction = () => [
  { title: "查找 · Koyori" },
  { name: "description", content: "查找 Koyori 公开文档、下载与更新内容。" },
];

export default function SearchPage() {
  return <HomePage />;
}
