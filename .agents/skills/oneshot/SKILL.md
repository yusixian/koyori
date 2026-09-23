---
name: oneshot
description: "One-shot Koyori Preview release delivery: prepare version and notes, merge through CI, trigger the protected macOS Release, and update the docs/download site. Use for a full release or resuming one; not for notes-only requests."
---

# Koyori oneshot

Use this project Skill when asked to publish a Koyori Preview and update its documentation and download page. `$oneshot 发布下一个 Preview` starts the flow; `$oneshot 继续 v<VERSION>` resumes it. It is an agent workflow, not a shell command. Read `AGENTS.md`, `docs/release-signing.md`, the current workflows, and the latest Release before acting. Current repository state wins over examples here.

## Start or resume

1. Check relevant worktrees, `origin/main`, PRs, CI, existing tags/Releases (including drafts), and the deployed site. Preserve unrelated edits; use an isolated feature worktree. Check `gh` authentication before remote mutations.
2. Track only the useful checkpoints: version and merge SHA, main CI run, Release run/tag, site commit and deployment. On resume, read back each checkpoint from GitHub, Dokploy, or the public site and continue from the first missing one. If another release has appeared, reassess version and scope.
3. Infer the next SemVer Preview from root `package.json` and published Releases, and check the intended changes. Use `development-signed` only when it remains the intended Apple Development Preview channel; `signed` requires the Developer ID/notarization path; `manual` is explicitly manual install. Never silently change mode or promise in-app updates for `manual`. Resolve a material version/mode ambiguity with the user while doing independent preparation. Apply existing session authorization and protected-environment policy; ask for any missing permission only after preparing the concrete candidate.

## Prepare the release commit

- Set the next version in root `package.json` (the single version source) and create `docs/releases/v<VERSION>.md` from the actual changes since the previous public tag. Include user-visible changes, compatibility/install notes, and known limitations. `docs/releases/unreleased.md` contains historical material: inspect it, but never copy it wholesale or silently claim every entry shipped. Update affected public guides before the release. Keep README, installation guide, and other **current public version** text on the old version until the new Release is public.
- Review history and staged public files for private data. Run focused checks for the changed code/docs and `pnpm check:public`. Use the repository PR flow; verify PR CI, merge, then verify the exact main merge SHA and a successful `ci.yml` **push** run for that SHA. As soon as this gate passes, continue to release without asking for another routine acceptance. PR CI alone does not satisfy the protected workflow's main CI gate.

## Publish the immutable application

- Dispatch `.github/workflows/release-preview.yml` on `main` with the chosen `distribution` only after the exact main SHA passes its push CI. Capture the newly created workflow run ID and check its `headSha` matches the intended commit. The workflow builds once, accepts the DMG and ZIP from that candidate, verifies the tag/draft/assets, then publishes. Watch the full run and inspect failures, not just its initial start.
- Before any retry, inspect the workflow jobs, accepted artifact, draft Release, tag, and assets. If `build` failed **before an accepted artifact exists** and no tag/draft conflict exists, fix the cause and rerun that failed job in the same run; its new candidate must pass the full archive acceptance before publishing. If build/acceptance succeeded and only `publish` failed, rerun **failed jobs of that same run** so the accepted artifact is reused. Do not redispatch the same version, rebuild to replace already accepted or published bytes, move a published tag, or overwrite a public Release. If the accepted artifact expired or identities conflict, stop and report the exact conflict.
- The protected workflow's archive acceptance and successful publish job are the normal release acceptance; do not repeat local installation or an application upgrade E2E for every version. Read back the public non-draft Release, tag commit, and asset list once before updating the site. Keep Apple Development's unnotarized status explicit.

## Promote documentation and download

- After publication, on a branch from current `origin/main`, run `pnpm install --frozen-lockfile` and `pnpm --filter @koyori/site promote:release --tag v<VERSION>`. The helper already verifies the public assets and atomically writes `apps/site/public/releases/preview-mac-arm64.json`; never copy the Actions artifact or hand-edit the manifest. Update README, `apps/site/content/docs/installation.mdx`, and other current-status copy to the published version. The changelog page is generated from the versioned notes and manifest.
- Build the site and run `pnpm check:public`; PR, verify CI, merge, and deploy the authorized Dokploy docs app from the merged commit. Read back the deployment status and check that public `/download/` and `/changelog/` show the new version and Release link. The promotion helper provides the asset digest check; do not redownload the DMG solely to repeat it. If the updater, signing mode, or data migration changed, run a focused isolated upgrade check and record its result; ordinary releases use the CI and release workflow gates.

## Finish and recovery

Report the version, main CI and Release run, site deployment, and live download page. If any stage stops, report the last proven stage and next safe action. A site failure resumes at promotion/deployment; it never rebuilds the published app. Do not call CI alone a published Release or mark the flow complete while the download page is stale.
