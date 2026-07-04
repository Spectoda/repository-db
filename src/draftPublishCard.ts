import type { SyncStatus } from "./types.ts";

/**
 * Public contract version for the framework-agnostic repository-db draft/publish card.
 *
 * Host v3 apps may render this through React, Vue, vanilla DOM, terminal UI, etc.,
 * but the state priority and action semantics should stay shared through this
 * contract so every repository-db app says the same thing about dirty drafts,
 * pending review, remote freshness and conflicts.
 */
export const DRAFT_PUBLISH_CARD_CONTRACT_VERSION =
	"repository-db.draft-publish-card.v1" as const;

export type DraftPublishCardTone =
	| "hidden"
	| "published"
	| "draft"
	| "pending"
	| "remote"
	| "conflict";

export type DraftPublishCardActionKind =
	| "open_review"
	| "publish"
	| "pull"
	| "resolve_conflict"
	| "details";

export interface DraftPublishCardAction {
	kind: DraftPublishCardActionKind;
	label: string;
	enabled: boolean;
	/** Machine-readable explanation when an action is disabled. */
	disabledReason?: string;
}

export interface DraftPublishCardFreshness {
	/** True when a fetched/polled remote branch has newer data than the local checkout. */
	newerAvailable?: boolean;
	/** True only when the host has proven pull/fast-forward is safe right now. */
	pullSafe?: boolean;
	/** Machine-readable reason why pull is unavailable or unsafe. */
	pullBlockedReason?: string | null;
	/** True when freshness could not be confirmed (offline, credential failure, timeout, …). */
	staleFreshness?: boolean;
}

export interface DraftPublishCardInput {
	status: SyncStatus | null;
	/** Expected generation branch from repository-db.yaml. Used by host status adapters. */
	expectedBranch?: string;
	/** Host-level pending review/proposal units (for apps with changeset approval flows). */
	pendingReviewCount?: number;
	/** Host-approved units that the card's primary Publish action can actually publish. */
	publishableChangeCount?: number;
	/** Optional remote-freshness evidence computed by a host/coordinator. */
	freshness?: DraftPublishCardFreshness | null;
	/** Show an explicit "published/up to date" card; default is silent clean state. */
	showPublished?: boolean;
	/** Limit path samples included in the card details. Defaults to 8. */
	dirtyPathLimit?: number;
}

export interface DraftPublishCardSnapshot {
	contractVersion: typeof DRAFT_PUBLISH_CARD_CONTRACT_VERSION;
	visible: boolean;
	tone: DraftPublishCardTone;
	label: string;
	detail: string;
	branch: string | null;
	expectedBranch: string | null;
	dirtyCount: number;
	pendingReviewCount: number;
	publishableChangeCount: number;
	ahead: number;
	behind: number;
	newerAvailable: boolean;
	pullSafe: boolean;
	pullBlockedReason: string | null;
	staleFreshness: boolean;
	conflict: boolean;
	dirtyPathSamples: string[];
	primaryAction: DraftPublishCardAction | null;
	actions: DraftPublishCardAction[];
}

function count(value: number | undefined): number {
	return Math.max(0, Math.trunc(value ?? 0));
}

function action(
	kind: DraftPublishCardActionKind,
	label: string,
	enabled: boolean,
	disabledReason?: string,
): DraftPublishCardAction {
	return { kind, label, enabled, disabledReason };
}

function cleanSnapshot(input: DraftPublishCardInput): DraftPublishCardSnapshot {
	return {
		contractVersion: DRAFT_PUBLISH_CARD_CONTRACT_VERSION,
		visible: input.showPublished === true,
		tone: input.showPublished === true ? "published" : "hidden",
		label: "Published",
		detail: "No local repository-db draft changes or newer remote data are visible.",
		branch: null,
		expectedBranch: input.expectedBranch ?? null,
		dirtyCount: 0,
		pendingReviewCount: count(input.pendingReviewCount),
		publishableChangeCount: count(input.publishableChangeCount),
		ahead: 0,
		behind: 0,
		newerAvailable: false,
		pullSafe: false,
		pullBlockedReason: null,
		staleFreshness: Boolean(input.freshness?.staleFreshness),
		conflict: false,
		dirtyPathSamples: [],
		primaryAction: null,
		actions: [action("details", "Details", true)],
	};
}

/**
 * Derive the shared v3 draft/publish card view-model from repository-db status.
 *
 * The helper is deliberately framework-agnostic. It does not fetch, publish or
 * pull; host apps wire the returned actions to their own API endpoints while
 * keeping the same state priority and labels across v3 apps.
 */
export function deriveDraftPublishCard(
	input: DraftPublishCardInput,
): DraftPublishCardSnapshot {
	const status = input.status;
	if (!status) return cleanSnapshot(input);

	const dirtyCount = status.dirtyPaths.length;
	const pendingReviewCount = count(input.pendingReviewCount);
	const publishableChangeCount = count(input.publishableChangeCount);
	const ahead = count(status.ahead);
	const behind = count(status.behind);
	const expectedBranch = input.expectedBranch ?? null;
	const wrongBranch = Boolean(expectedBranch && status.branch !== expectedBranch);
	const diverged = ahead > 0 && behind > 0;
	const conflict = status.conflict || status.state === "conflict" || wrongBranch || diverged;
	const newerAvailable = Boolean(input.freshness?.newerAvailable ?? behind > 0);
	const pullSafe = Boolean(input.freshness?.pullSafe);
	const pullBlockedReason = input.freshness?.pullBlockedReason ?? null;
	const staleFreshness = Boolean(input.freshness?.staleFreshness);
	const dirtyPathLimit = count(input.dirtyPathLimit ?? 8);

	const base = {
		contractVersion: DRAFT_PUBLISH_CARD_CONTRACT_VERSION,
		branch: status.branch,
		expectedBranch,
		dirtyCount,
		pendingReviewCount,
		publishableChangeCount,
		ahead,
		behind,
		newerAvailable,
		pullSafe,
		pullBlockedReason,
		staleFreshness,
		conflict,
		dirtyPathSamples: status.dirtyPaths.slice(0, dirtyPathLimit),
	};

	if (conflict) {
		const detail = wrongBranch
			? `Data checkout is on branch ${status.branch}; expected ${expectedBranch}. Resolve the checkout before publishing.`
			: diverged
				? `Local and remote repository-db history diverged (ahead=${ahead}, behind=${behind}). Resolve manually before publishing or pulling.`
				: "Repository-db reports a conflict. Resolve or abort the conflict before publishing.";
		const actions = [
			action("resolve_conflict", "Resolve conflict", true),
			action("details", "Details", true),
		];
		return {
			...base,
			visible: true,
			tone: "conflict",
			label: "Repository conflict",
			detail,
			primaryAction: actions[0] ?? null,
			actions,
		};
	}

	if (dirtyCount > 0) {
		const publishEnabled = publishableChangeCount > 0;
		const actions = [
			action(
				publishEnabled ? "publish" : "open_review",
				publishEnabled ? "Publish" : "Prepare review",
				true,
			),
			action("details", "Details", true),
		];
		return {
			...base,
			visible: true,
			tone: "draft",
			label: "Unpublished draft",
			detail: `${dirtyCount} repository-db path${dirtyCount === 1 ? "" : "s"} changed locally and not yet published.`,
			primaryAction: actions[0] ?? null,
			actions,
		};
	}

	if (pendingReviewCount > 0) {
		const publishEnabled = publishableChangeCount > 0;
		const actions = [
			action(
				publishEnabled ? "publish" : "open_review",
				publishEnabled ? "Publish" : "Open review",
				true,
			),
			action("details", "Details", true),
		];
		return {
			...base,
			visible: true,
			tone: "pending",
			label: "Changes waiting for publish",
			detail: `${pendingReviewCount} review item${pendingReviewCount === 1 ? "" : "s"} waiting in the repository-db publish flow.`,
			primaryAction: actions[0] ?? null,
			actions,
		};
	}

	if (status.state === "committed_not_pushed" || ahead > 0) {
		const actions = [
			action("publish", "Push published commit", true),
			action("details", "Details", true),
		];
		return {
			...base,
			visible: true,
			tone: "pending",
			label: "Commit waiting for push",
			detail: `${ahead} local commit${ahead === 1 ? "" : "s"} still need to reach origin/${expectedBranch ?? status.branch}.`,
			primaryAction: actions[0] ?? null,
			actions,
		};
	}

	if (newerAvailable) {
		const actions = [
			action(
				"pull",
				"Pull newer data",
				pullSafe,
				pullSafe ? undefined : (pullBlockedReason ?? "pull_not_proven_safe"),
			),
			action("details", "Details", true),
		];
		return {
			...base,
			visible: true,
			tone: "remote",
			label: staleFreshness ? "Remote freshness unknown" : "Newer data available",
			detail: staleFreshness
				? "Remote freshness could not be confirmed; do not assume the visible data is current."
				: `${behind} remote commit${behind === 1 ? "" : "s"} available for this repository-db branch.`,
			primaryAction: actions[0] ?? null,
			actions,
		};
	}

	return {
		...base,
		visible: input.showPublished === true,
		tone: input.showPublished === true ? "published" : "hidden",
		label: "Published",
		detail: "The repository-db checkout is clean and up to date with the last known remote state.",
		primaryAction: null,
		actions: [action("details", "Details", true)],
	};
}
