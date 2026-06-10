# Changelog

## 0.1.0 — 20260610

- Initial engine release for the DEV-6353 Deals v3 pilot.
- `repository-db.yaml` config contract (`repository-db.config.v1`): app, data
  repo remote/branch, schema name/version, layout, generated manifest,
  validate commands.
- Git boundary guard: mount must be its own repo root with matching origin
  remote and generation branch; refuses to operate from a parent code repo.
- Typed collections over YAML documents (one file per document, stable
  serialization, atomic writes, zod-compatible parser injection).
- Sync status model: conflict / draft / committed_not_pushed / pull_needed /
  published, remote detection via `git fetch` without webhooks.
- Publish flow: validate → materialize generated → `git pull --rebase
  --autostash` → single commit with parser-validated `Repository-Db-*`
  trailers → push; lock-file mutual exclusion; push-only recovery for
  committed-not-pushed states.
- Conflict safety: detects mid-rebase stops and conflicted autostash applies
  (git exits 0 there), records a conflict state with an agent handoff, blocks
  writes until explicit `conflict --resolved` / `conflict --abort`; abort
  restores the pre-publish draft from the autostash.
- Generated read-model policy: publish refuses undeclared generated diffs;
  `.repository-db/` is the ignored per-machine cache/lock layer.
- Credential preflight: gh credential store as the local default, ssh-agent /
  git credential helper as non-interactive fallbacks, hard failure before any
  working-tree mutation; no tokens ever stored in the repo.
- CLI: `init` (create/attach + bootstrap data repo, set default branch),
  `status`, `validate`, `sync`, `publish`, `conflict`.
