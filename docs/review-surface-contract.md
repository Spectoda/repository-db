# Review Surface contracts

Repository DB owns Git/YAML status, conflict detection and publish gating. Host
applications can add domain interpretation through a Review Surface adapter, but
the shared contract stays application-agnostic: Repository DB talks about
resources, changes, structural fields, route targets, reviewed state and publish
readiness, not about any one business schema.

This first slice defines only TypeScript contracts and guidance. It does not add
an adapter registry, UI, persistence or publish behavior change.

## Core contract pieces

- `ReviewableResource` is the user-facing unit shown in draft/review UI.
  It has a stable resource id, a required human-readable `label`, an optional
  host-app `routeTarget`, one or more `ResourceChange` rows, a `reviewState`, a
  fallback ladder and optional publish-readiness references.
- `ResourceChange` is the technical/source change attached to a resource. It
  covers `created`, `modified`, `deleted`, `generated` and `unknown` changes.
- `ReviewFieldSummary` is the structural field summary used by review lists and
  inline highlights. It uses parsed-record paths such as `details.status`, not
  filesystem paths.
- `ReviewTechnicalReference` keeps data-repo paths available for developer
  details, Git review and agent handoff. These paths are technical metadata and
  must not be the primary normal-user label.
- `ReviewSurfaceAdapter` is the app-provided bridge from generic repository
  changes to reviewable resources. A later registry can match adapters by path
  globs and call `toReviewableResources`.

## Identity and labels

A reviewable resource must expose both a stable machine identity and a readable
human label:

```ts
const resource = {
  appId: "fixture-app",
  resourceType: "fixture-record",
  stableResourceId: "fixture-record:alpha",
  label: "Fixture Alpha",
  routeTarget: { href: "/fixture/records/alpha?review=1" },
  changes: [],
  reviewState: { value: "unreviewed" },
  fallback: { activeLevel: "resource_adapter", steps: [] },
};
```

The `label` is the primary review UI text. A data-repo path such as
`data/fixture-records/fixture-alpha.yaml` belongs in `technicalRefs`, a technical
details disclosure or an agent/Git handoff. It is never the default button/link
label for normal app users.

## Change kinds

`ResourceChangeKind` intentionally stays coarse:

| Kind | Meaning |
| --- | --- |
| `created` | A canonical resource or file was added. |
| `modified` | Existing parsed data changed. |
| `deleted` | A canonical resource or file was removed. |
| `generated` | A declared generated read model changed. |
| `unknown` | Repository DB cannot map the path to a richer resource/schema yet. |

Unknown changes still appear in review and publish readiness. They degrade to a
technical diff; they must not disappear just because no adapter exists.

## Fallback ladder

`ReviewFallbackLevel` is ordered from richest to most technical:

1. `resource_adapter` — the host app maps paths to a stable resource id, readable
   label, route target and field summaries.
2. `generic_schema_diff` — Repository DB or a generic parser can show structural
   field changes without app-specific route/anchor metadata.
3. `technical_file_diff` — only raw path/diff evidence is known. This is valid
   for agents and developer details, not a rich normal-user label.
4. `unknown` — the path is visible but no safe classification exists yet.

Review surfaces should render the active level and keep the ladder available for
diagnostics. A missing adapter is a degraded review state, not a hidden change.

## Reviewed-state invalidation key

`ReviewedStateKey` is designed for local repository-db metadata. Persisted review
marks should include:

- `baselineHead` — HEAD used when the draft representation was computed;
- `stableResourceId` — the app/resource id, not a path;
- `resourcePaths` — technical paths only for move/rename invalidation;
- `draftContentHash` — hash of the review representation or backing draft data;
- `reviewContractVersion` — usually `REVIEW_SURFACE_CONTRACT_VERSION`;
- `adapterVersion` and `schemaVersion` when provided by the host adapter.

If any of those values changes, an old `reviewed` mark can become stale and
should not satisfy a required review gate.

## Adapter/schema version policy

Adapter and schema versions are semantic review-representation versions, not
build counters.

Bump `adapterVersion` or `schemaVersion` when a change can make an existing
review mark misleading, for example:

- a field id or field meaning changes;
- a route target now opens a different review context;
- diff normalization changes before/after summaries materially;
- UI anchor semantics change enough that an inline highlight would point at the
  wrong control;
- `REVIEW_SURFACE_CONTRACT_VERSION` changes incompatibly.

Do not bump only for non-invalidating changes, for example:

- adding an optional field label that does not alter existing summaries;
- cosmetic wording changes in helper copy;
- adding a non-blocking metadata field;
- adding a route label while `href` and resource identity stay the same.

## Publish readiness references

`PublishReadinessReference` lets the final publish summary point to blocking and
non-blocking evidence. The generic kinds cover:

- `schema_error` — parsed data failed a schema/adapter validation;
- `conflict` — repository conflict state blocks writes or publish;
- `unreviewed_change` — a required review mark is missing or stale;
- `validation_error` — a configured validation command failed;
- `generated_policy` — generated output policy needs attention;
- `unknown` — a visible issue has no richer classification yet.

References can point at `changeIds`, `stableResourceIds` and `technicalRefs` so a
review panel, app row and publish summary can talk about the same draft change.
