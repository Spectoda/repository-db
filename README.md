# @spectoda/repository-db

Git-backed YAML repository database engine. A thick client gets a local,
serverless data layer: canonical YAML documents in a Git "data repo", typed
collection CRUD, an explicit draft → publish lifecycle, deterministic
generated read models and hard guards against operating in the wrong Git
repository.

The engine is domain-agnostic. Application schemas are injected by the host app
through a zod-compatible parser contract; the engine itself depends only on
`yaml`.

## Model

- **Data repo** — a standalone (typically private) Git repository holding
  `data/` (canonical YAML collections), `generated/` (committed deterministic
  read models), `scripts/` (repo-local materializers/validators) and
  `repository-db.yaml` (the config contract). It is mounted into an
  app-specific path (e.g. `modules/sample-app/db/`) and managed by this engine —
  not by workspace sync tooling.
- **Major data generation = Git branch** (`v3`, `v4`, …). A later generation
  starts as a clean orphan branch migrated from the previous generation's
  worktree; the repo's default branch tracks the current generation.
- **Draft** — an uncommitted change in the data repo working tree. Reads and
  writes are plain filesystem operations; nothing commits on keypress.
- **Publish** — one explicit action turning the current draft batch into a
  single audited commit:
  `validate → materialize generated → rebase already-fetched origin/<branch>
  with autostash → one commit with Repository-Db-* trailers → push`.
- **Conflict** — any rebase/merge stop or conflicted autostash apply. The
  engine records a conflict state with an agent handoff and refuses further
  writes and publishes until an explicit `conflict --resolved` or
  `conflict --abort`.

## Sync states

`status` derives: `conflict` > `draft` > `committed_not_pushed` >
`pull_needed` > `published`, plus raw flags (`ahead`, `behind`, `dirtyPaths`).
Remote changes are detected via `git fetch` (`status --fetch`, `sync`) — no
inbound webhook is required; webhooks are only a faster signal where a host
can accept them.

## Review Surface contracts

Repository DB exposes app-agnostic TypeScript contracts for a future Review
Surface: `ReviewableResource`, `ResourceChange`, `ReviewSurfaceAdapter`, review
state, fallback levels, raw input changes, top-level review snapshots and
publish-readiness summaries. Host apps provide adapters that map technical
data-repo changes to stable resource ids, readable labels, app route targets and
structural field summaries. Data-repo paths remain available as technical
metadata for Git review and agent handoff, but they are not the primary
normal-user label.

See [`docs/review-surface-contract.md`](docs/review-surface-contract.md) for the
contract shape, fallback ladder and adapter/schema versioning policy.

## CLI

```bash
repository-db init --app sample --remote git@github.com:example/repository-data.git \
  --branch v1 --mount ../sample/db --schema-name sample-data --schema-version 1.0.0 \
  [--create-remote] [--visibility private]
repository-db status [--fetch] [--json]
repository-db validate
repository-db sync
repository-db publish --actor "Example User <user@example.com>" --source sample-app-v1 \
  [--summary "…"] [--entity record-123]...
repository-db conflict [--abort | --resolved]
```

Every command verifies the Git boundary first: the mount path must be the
repository root, `origin` must match `data_repo.remote`, and the checkout must
be on `data_repo.branch`. Commands refuse to run from a parent code repository
— the data checkout is typically nested inside an app module repo.

## Commit contract

Publish commits carry deterministic, parser-validated Git trailers:
`Repository-Db-App`, `Repository-Db-Data-Repo`, `Repository-Db-Branch`,
`Repository-Db-Schema-Version`, `Repository-Db-Actor`, `Repository-Db-Machine`,
`Repository-Db-Source`, `Repository-Db-Change-Id` (+ optional
`Repository-Db-Entities`). The default subject is generated from the change
summary with no AI involvement; an AI-suggested human summary is strictly
opt-in, never required for publish, and never touches the trailers.

## Generated read models

Committed generated artifacts must be declared in the `generated_manifest`
of `repository-db.yaml`; publish refuses undeclared generated diffs.
Declared materializers must be byte-deterministic: stable sort by canonical
id, stable YAML/JSON serialization (LF, UTF-8), no wall-clock timestamps, no
host paths, no per-machine values. Per-machine caches belong to the ignored
`.repository-db/` directory.

## Credentials

The engine never stores tokens, SSH keys or webhook secrets in the code or
data repository. The local default mechanism is the GitHub CLI credential
store (`gh auth status` is verified before any mutation). Non-interactive
environments (CI, hosted, client deployments) must provide an approved
provider — GitHub App installation, deploy key via ssh-agent, or a
preconfigured Git credential helper — otherwise publish fails in preflight,
before touching the working tree.

## Library usage

```ts
import { RepositoryDb } from "@spectoda/repository-db";

const db = RepositoryDb.open("/path/to/app/db");
const records = db.collection("records", {
  schemaVersion: "record.v1",
  parser: recordSchema, // any zod-compatible { parse(value) } object
});

records.put("record-123", record);      // local draft (no commit)
const status = await db.statusAsync({ fetch: true });
const result = await db.publish({ actor: "Example User <user@example.com>", source: "sample-app-v1" });
```

## Development

```bash
bun install
bun test
bunx tsc --noEmit
```
