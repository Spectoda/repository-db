import { describe, expect, test } from "bun:test";
import {
	DRAFT_PUBLISH_CARD_CONTRACT_VERSION,
	deriveDraftPublishCard,
	type SyncStatus,
} from "../src/index.ts";

function status(overrides: Partial<SyncStatus> = {}): SyncStatus {
	return {
		state: "published",
		branch: "v3",
		ahead: 0,
		behind: 0,
		dirtyPaths: [],
		conflict: false,
		fetched: true,
		...overrides,
	};
}

describe("Draft Publish Card contract", () => {
	test("clean repository is silent by default but can render a published card", () => {
		const silent = deriveDraftPublishCard({ status: status(), expectedBranch: "v3" });
		expect(silent.contractVersion).toBe(DRAFT_PUBLISH_CARD_CONTRACT_VERSION);
		expect(silent.visible).toBe(false);
		expect(silent.tone).toBe("hidden");

		const visible = deriveDraftPublishCard({
			status: status(),
			expectedBranch: "v3",
			showPublished: true,
		});
		expect(visible.visible).toBe(true);
		expect(visible.tone).toBe("published");
		expect(visible.primaryAction).toBeNull();
	});

	test("dirty data checkout surfaces an unpublished draft and path samples", () => {
		const card = deriveDraftPublishCard({
			status: status({
				state: "draft",
				dirtyPaths: ["data/records/a.yaml", "generated/index.json"],
			}),
			expectedBranch: "v3",
			publishableChangeCount: 2,
		});

		expect(card.visible).toBe(true);
		expect(card.tone).toBe("draft");
		expect(card.dirtyCount).toBe(2);
		expect(card.primaryAction).toEqual({
			kind: "publish",
			label: "Publish",
			enabled: true,
			disabledReason: undefined,
		});
		expect(card.dirtyPathSamples).toEqual(["data/records/a.yaml", "generated/index.json"]);
	});

	test("dirty checkout without a publishable unit asks the host app to open review", () => {
		const card = deriveDraftPublishCard({
			status: status({ state: "draft", dirtyPaths: ["data/records/a.yaml"] }),
			expectedBranch: "v3",
		});

		expect(card.tone).toBe("draft");
		expect(card.primaryAction?.kind).toBe("open_review");
		expect(card.primaryAction?.label).toBe("Prepare review");
	});

	test("pending review can publish when the host marks changes publishable", () => {
		const card = deriveDraftPublishCard({
			status: status(),
			expectedBranch: "v3",
			pendingReviewCount: 3,
			publishableChangeCount: 1,
		});

		expect(card.tone).toBe("pending");
		expect(card.pendingReviewCount).toBe(3);
		expect(card.publishableChangeCount).toBe(1);
		expect(card.primaryAction?.kind).toBe("publish");
	});

	test("remote freshness shows a pull action only when host proved pull is safe", () => {
		const card = deriveDraftPublishCard({
			status: status({ state: "pull_needed", behind: 2 }),
			expectedBranch: "v3",
			freshness: {
				newerAvailable: true,
				pullSafe: false,
				pullBlockedReason: "dirty_working_tree",
			},
		});

		expect(card.tone).toBe("remote");
		expect(card.primaryAction).toEqual({
			kind: "pull",
			label: "Pull newer data",
			enabled: false,
			disabledReason: "dirty_working_tree",
		});
	});

	test("conflict state outranks draft, pending and remote freshness", () => {
		const card = deriveDraftPublishCard({
			status: status({
				state: "conflict",
				conflict: true,
				dirtyPaths: ["data/records/a.yaml"],
				behind: 4,
			}),
			expectedBranch: "v3",
			pendingReviewCount: 2,
			publishableChangeCount: 2,
			freshness: { newerAvailable: true, pullSafe: true },
		});

		expect(card.tone).toBe("conflict");
		expect(card.primaryAction?.kind).toBe("resolve_conflict");
		expect(card.conflict).toBe(true);
	});

	test("wrong branch is represented as a conflict even when generic status is clean", () => {
		const card = deriveDraftPublishCard({
			status: status({ branch: "main" }),
			expectedBranch: "v3",
		});

		expect(card.tone).toBe("conflict");
		expect(card.detail).toContain("expected v3");
	});
});
