import { assertDataRepoBoundary } from "./boundary.ts";
import { activeConflict } from "./conflict.ts";
import {
	gitAheadBehind,
	gitCurrentBranch,
	gitDirtyPaths,
	gitFetch,
} from "./git.ts";
import { ENGINE_DIR } from "./lock.ts";
import type { RepositoryDbConfig, SyncStatus } from "./types.ts";

export interface StatusOptions {
	/** Run `git fetch origin` first so `behind` reflects the actual remote. */
	fetch?: boolean;
}

/**
 * Derive the user-facing sync state of a data checkout.
 *
 * Priority: conflict > draft > committed_not_pushed > pull_needed > published.
 * The individual flags stay available so a UI can show combined situations
 * (e.g. local draft while remote changes are waiting).
 */
export function deriveSyncStatus(
	mountRoot: string,
	config: RepositoryDbConfig,
	options: StatusOptions = {},
): SyncStatus {
	assertDataRepoBoundary(mountRoot, config);

	let fetched = false;
	if (options.fetch) {
		gitFetch(mountRoot);
		fetched = true;
	}

	const conflict = activeConflict(mountRoot);
	const branch = gitCurrentBranch(mountRoot);
	const dirtyPaths = gitDirtyPaths(mountRoot).filter(
		(entry) => !entry.startsWith(`${ENGINE_DIR}/`),
	);
	const { ahead, behind } = gitAheadBehind(mountRoot, config.dataRepo.branch);

	const state = conflict
		? "conflict"
		: dirtyPaths.length > 0
			? "draft"
			: ahead > 0
				? "committed_not_pushed"
				: behind > 0
					? "pull_needed"
					: "published";

	return {
		state,
		branch,
		ahead,
		behind,
		dirtyPaths,
		conflict: Boolean(conflict),
		fetched,
	};
}
