import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const files = [
  ...new Set(
    execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
      encoding: "utf8",
    })
      .split("\0")
      .filter(Boolean),
  ),
];
const forbidden =
  /(^|\/)(?:\.env(?:\..*)?|HANDOFF\.md|\.lody|\.local)(\/|$)|\.(?:sqlite|db|p12|pfx|pem)$/i;
const checks = [
  ["private key", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ["GitHub token", /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b|github_pat_[A-Za-z0-9_]{40,}/],
  ["API key", /\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{32,}/],
  ["personal absolute path", /\/(?:Users|home)\/[A-Za-z0-9._-]+\//],
];
const findings = [];
for (const file of files) {
  if (forbidden.test(file) && file !== ".env.example")
    findings.push(`${file}: forbidden public file`);
  const buffer = readFileSync(file);
  if (buffer.includes(0)) continue;
  const text = buffer.toString("utf8");
  for (const [label, expression] of checks)
    if (expression.test(text)) findings.push(`${file}: ${label}`);
}
if (findings.length) {
  console.error(findings.join("\n"));
  process.exitCode = 1;
} else
  console.log(
    `Public-file checks passed (${files.length} files). This does not audit Git history.`,
  );
