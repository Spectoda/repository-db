import { describe, expect, test } from "bun:test";
import {
	REVIEW_SURFACE_CONTRACT_VERSION,
	type PublishReadinessReference,
	type ResourceChange,
	type ResourceChangeKind,
	type ReviewFallbackLevel,
	type ReviewableResource,
	type ReviewedStateKey,
	type ReviewStateValue,
	type ReviewSurfaceAdapter,
} from "../src/index.ts";

const fixturePath = "data/fixture-records/fixture-alpha.yaml";
const generatedPath = "generated/fixture-index.json";
const stableResourceId = "fixture-record:alpha";

const changeKinds = [
	"created",
	"modified",
	"deleted",
	"generated",
	"unknown",
] satisfies ResourceChangeKind[];

const fallbackLevels = [
	"resource_adapter",
	"generic_schema_diff",
	"technical_file_diff",
	"unknown",
] satisfies ReviewFallbackLevel[];

const reviewStates = [
	"unreviewed",
	"reviewed",
	"stale",
	"blocked",
	"not_required",
] satisfies ReviewStateValue[];

const readinessReferences = [
	{
		kind: "schema_error",
		blocking: true,
		message: "Fixture schema validation failed.",
		stableResourceIds: [stableResourceId],
		technicalRefs: [{ path: fixturePath, kind: "canonical_data_path" }],
	},
	{
		kind: "conflict",
		blocking: true,
		message: "Fixture draft has an unresolved repository conflict.",
		technicalRefs: [{ path: fixturePath, kind: "canonical_data_path" }],
	},
	{
		kind: "unreviewed_change",
		blocking: true,
		message: "Fixture resource has not been reviewed yet.",
		changeIds: ["fixture-change:modified"],
		stableResourceIds: [stableResourceId],
	},
	{
		kind: "validation_error",
		blocking: true,
		message: "Fixture validation command reported a blocking issue.",
	},
	{
		kind: "generated_policy",
		blocking: false,
		message: "Fixture generated output is declared and review-visible.",
		changeIds: ["fixture-change:generated"],
		technicalRefs: [{ path: generatedPath, kind: "generated_path" }],
	},
	{
		kind: "unknown",
		blocking: false,
		message: "Fixture unknown path remains visible through technical review.",
	},
] satisfies PublishReadinessReference[];

const changes = [
	{
		changeId: "fixture-change:created",
		kind: "created",
		summary: "Fixture resource was created.",
		technicalRefs: [{ path: fixturePath, kind: "canonical_data_path" }],
		fields: [
			{
				fieldPath: "title",
				label: "Title",
				changeKind: "created",
				afterSummary: "Fixture Alpha",
				uiAnchor: { id: "fixture-title-field" },
			},
		],
		draftContentHash: "sha256:created-fixture",
	},
	{
		changeId: "fixture-change:modified",
		kind: "modified",
		summary: "Fixture resource has one modified field.",
		technicalRefs: [{ path: fixturePath, kind: "canonical_data_path" }],
		fields: [
			{
				fieldPath: "details.status",
				label: "Status",
				changeKind: "modified",
				beforeSummary: "Draft",
				afterSummary: "Ready for review",
				uiAnchor: {
					id: "fixture-status-field",
					routeTarget: {
						href: "/fixture/records/alpha?review=details.status",
					},
				},
			},
		],
		draftContentHash: "sha256:modified-fixture",
	},
	{
		changeId: "fixture-change:deleted",
		kind: "deleted",
		summary: "Fixture resource was deleted.",
		technicalRefs: [{ path: fixturePath, kind: "canonical_data_path" }],
		fields: [
			{
				fieldPath: "title",
				label: "Title",
				changeKind: "deleted",
				beforeSummary: "Fixture Alpha",
			},
		],
		draftContentHash: "sha256:deleted-fixture",
	},
	{
		changeId: "fixture-change:generated",
		kind: "generated",
		summary: "Generated fixture index changed.",
		technicalRefs: [{ path: generatedPath, kind: "generated_path" }],
		fields: [],
		draftContentHash: "sha256:generated-fixture",
		generatedFrom: [{ path: fixturePath, kind: "canonical_data_path" }],
	},
	{
		changeId: "fixture-change:unknown",
		kind: "unknown",
		summary: "Unknown fixture-side file changed.",
		technicalRefs: [{ path: "notes/fixture-sidecar.txt", kind: "unknown_path" }],
		fields: [],
		draftContentHash: "sha256:unknown-fixture",
	},
] satisfies ResourceChange[];

const reviewKey = {
	baselineHead: "0123456789abcdef0123456789abcdef01234567",
	stableResourceId,
	resourcePaths: [fixturePath],
	draftContentHash: "sha256:review-fixture",
	reviewContractVersion: REVIEW_SURFACE_CONTRACT_VERSION,
	adapterVersion: "1.0.0",
	schemaVersion: "fixture.schema.v1",
} satisfies ReviewedStateKey;

const resource = {
	appId: "fixture-app",
	resourceType: "fixture-record",
	stableResourceId,
	label: "Fixture Alpha",
	routeTarget: {
		href: "/fixture/records/alpha?review=1",
		label: "Open fixture",
		params: { id: "alpha" },
		context: { review: true },
	},
	changes,
	reviewState: {
		value: "unreviewed",
		key: reviewKey,
	},
	fallback: {
		activeLevel: "resource_adapter",
		steps: [
			{ level: "resource_adapter", label: "Fixture resource adapter" },
			{ level: "generic_schema_diff", label: "Generic structural diff" },
			{
				level: "technical_file_diff",
				label: "Technical file diff",
				technicalRefs: [{ path: fixturePath, kind: "canonical_data_path" }],
			},
			{ level: "unknown", label: "Unknown changed file" },
		],
	},
	publishReadiness: readinessReferences,
	metadata: { fixtureOnly: true },
} satisfies ReviewableResource;

const adapter = {
	id: "fixture-review-adapter",
	appId: "fixture-app",
	contractVersion: REVIEW_SURFACE_CONTRACT_VERSION,
	adapterVersion: "1.0.0",
	schemaVersion: "fixture.schema.v1",
	supportedPathGlobs: ["data/fixture-records/*.yaml"],
	toReviewableResources(inputChanges) {
		return [{ ...resource, changes: [...inputChanges] }];
	},
} satisfies ReviewSurfaceAdapter;

describe("Review Surface contract types", () => {
	test("cover generic change kinds, fallback levels and review states", () => {
		expect(changeKinds).toEqual([
			"created",
			"modified",
			"deleted",
			"generated",
			"unknown",
		]);
		expect(fallbackLevels).toEqual([
			"resource_adapter",
			"generic_schema_diff",
			"technical_file_diff",
			"unknown",
		]);
		expect(reviewStates).toContain("reviewed");
		expect(reviewStates).toContain("not_required");
	});

	test("keeps technical paths out of the primary user-facing label", () => {
		expect(resource.label).toBe("Fixture Alpha");
		expect(resource.label).not.toContain("data/");
		expect(resource.stableResourceId).toBe(stableResourceId);
		expect(resource.routeTarget?.href).toBe("/fixture/records/alpha?review=1");
		expect(resource.changes.map((change) => change.kind)).toEqual(changeKinds);
		expect(resource.changes[0]?.technicalRefs[0]?.path).toBe(fixturePath);
		expect(resource.changes[1]?.fields[0]?.fieldPath).toBe("details.status");
	});

	test("allows publish readiness to point at blocking and non-blocking review evidence", () => {
		expect(resource.publishReadiness?.map((ref) => ref.kind)).toEqual([
			"schema_error",
			"conflict",
			"unreviewed_change",
			"validation_error",
			"generated_policy",
			"unknown",
		]);
		expect(resource.publishReadiness?.filter((ref) => ref.blocking)).toHaveLength(4);
		expect(resource.reviewState.key?.reviewContractVersion).toBe(
			REVIEW_SURFACE_CONTRACT_VERSION,
		);
	});

	test("lets a synthetic app adapter resolve generic changes to reviewable resources", async () => {
		const resolved = await adapter.toReviewableResources(changes);

		expect(adapter.supportedPathGlobs).toEqual(["data/fixture-records/*.yaml"]);
		expect(resolved).toHaveLength(1);
		expect(resolved[0]?.appId).toBe("fixture-app");
		expect(resolved[0]?.fallback.activeLevel).toBe("resource_adapter");
		expect(resolved[0]?.changes.map((change) => change.changeId)).toEqual(
			changes.map((change) => change.changeId),
		);
	});
});
