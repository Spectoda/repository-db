import os from "node:os";
import { assertDataRepoBoundary } from "./boundary.ts";
import {
	assertNoActiveConflict,
	currentAutostashSha,
	writeConflictState,
} from "./conflict.ts";
import { assertCredentials } from "./credentials.ts";
import {
	gitAheadBehind,
	gitDirtyPaths,
	gitHeadCommit,
	gitOperationInProgress,
	gitUnmergedPaths,
	runGit,
	runGitOrThrow,
} from "./git.ts";
import {
	assertDeclaredGeneratedOnly,
	materializeGenerated,
	runValidateCommands,
} from "./generated.ts";
import { ENGINE_DIR, acquirePublishLock } from "./lock.ts";
import { buildCommitMessage, newChangeId } from "./trailers.ts";
import {
	type PublishOptions,
	type PublishResult,
	type RepositoryDbConfig,
	RepositoryDbError,
} from "./types.ts";

function defaultSubject(
	config: RepositoryDbConfig,
	dirtyPaths: string[],
	entities: string[] | undefined,
): string {
	const dataPrefix = `${config.layout.data}/`;
	const generatedPrefix = `${config.layout.generated}/`;
	const dataChanges = dirtyPaths.filter((p) => p.startsWith(dataPrefix)).length;
	const generatedChanges = dirtyPaths.filter((p) =>
		p.startsWith(generatedPrefix),
	).length;
	const otherChanges = dirtyPaths.length - dataChanges - generatedChanges;
	const parts: string[] = [];
	if (dataChanges > 0) parts.push(`${dataChanges} data file(s)`);
	if (generatedChanges > 0) parts.push(`${generatedChanges} generated file(s)`);
	if (otherChanges > 0) parts.push(`${otherChanges} other file(s)`);
	const entitySuffix =
		entities && entities.length > 0
			? ` [${entities.slice(0, 3).join(", ")}${entities.length > 3 ? ", …" : ""}]`
			: "";
	return `${config.app}: publish ${parts.join(", ") || "no changes"}${entitySuffix}`;
}

/**
 * Publish the current local draft batch as a single auditable commit:
 *
 *   boundary guard -> conflict guard -> credential preflight -> lock ->
 *   validate -> materialize generated -> generated policy check ->
 *   git pull --rebase --autostash -> git add (data, declared generated,
 *   scripts, config) -> single commit with deterministic trailers -> push.
 *
 * A rebase conflict stops the flow, records a conflict state with an agent
 * handoff and blocks further writes until explicit resolve/abort. The
 * default commit message is fully deterministic; an AI-assisted summary may
 * only replace `options.summary` upstream after explicit opt-in and never
 * touches the trailers.
 */
export function publish(
	mountRoot: string,
	config: RepositoryDbConfig,
	options: PublishOptions,
): PublishResult {
	if (!options.actor?.trim()) {
		throw new RepositoryDbError("invalid_publish", "publish requires an actor");
	}
	if (!options.source?.trim()) {
		throw new RepositoryDbError("invalid_publish", "publish requires a source");
	}

	assertDataRepoBoundary(mountRoot, config);
	assertNoActiveConflict(mountRoot);
	assertCredentials(config.dataRepo.remote);

	const releaseLock = acquirePublishLock(mountRoot);
	try {
		if (!options.skipValidate) {
			runValidateCommands(mountRoot, config);
		}
		if (!options.skipMaterialize) {
			materializeGenerated(mountRoot, config);
		}
		assertDeclaredGeneratedOnly(mountRoot, config);

		const dirtyPaths = gitDirtyPaths(mountRoot).filter(
			(entry) => !entry.startsWith(`${ENGINE_DIR}/`),
		);
		if (dirtyPaths.length === 0) {
			// Recovery path: a previous publish committed but could not push
			// (or a conflict was resolved into a local commit). Just push.
			const { ahead } = gitAheadBehind(mountRoot, config.dataRepo.branch);
			if (ahead > 0) {
				const pushOnly = runGit(mountRoot, [
					"push",
					"origin",
					`${config.dataRepo.branch}:${config.dataRepo.branch}`,
				]);
				if (pushOnly.status !== 0) {
					throw new RepositoryDbError(
						"publish_push_failed",
						`git push failed; local commits stay unpushed (committed_not_pushed). Detail: ${pushOnly.stderr.trim()}`,
					);
				}
				return {
					state: "published",
					commit: gitHeadCommit(mountRoot),
					pushedTo: `${config.dataRepo.remote}#${config.dataRepo.branch}`,
				};
			}
			return { state: "nothing_to_publish" };
		}

		// Integrate remote changes before committing the local batch.
		const headBefore = gitHeadCommit(mountRoot);
		const pull = runGit(mountRoot, [
			"pull",
			"--rebase",
			"--autostash",
			"origin",
			config.dataRepo.branch,
		]);
		// CAUTION: git exits 0 even when applying the autostash produced
		// conflicts ("Applying autostash resulted in conflicts."). Committing
		// that working tree would persist conflict markers into canonical
		// data, so conflicts are detected from the repository state instead
		// of the exit code.
		const midOperation = gitOperationInProgress(mountRoot);
		const unmerged = gitUnmergedPaths(mountRoot);
		if (pull.status !== 0 || midOperation || unmerged.length > 0) {
			const state = writeConflictState(mountRoot, {
				detectedAt: new Date().toISOString(),
				operation: "publish:pull--rebase--autostash",
				gitState:
					[
						midOperation ? `in-progress: ${midOperation}` : undefined,
						unmerged.length > 0 ? `unmerged: ${unmerged.join(", ")}` : undefined,
						pull.stderr.trim() || pull.stdout.trim(),
					]
						.filter(Boolean)
						.join("\n") || "unknown",
				message:
					"publish stopped: conflict while integrating remote changes (pull --rebase --autostash)",
				preOperationHead: headBefore,
				autostashSha: currentAutostashSha(mountRoot),
			});
			throw new RepositoryDbError(
				"publish_conflict",
				`${state.message}\n\n${state.handoff}`,
			);
		}

		// Stage the whole batch. ENGINE_DIR is gitignored in the data repo;
		// undeclared generated diffs were already refused above.
		runGitOrThrow(mountRoot, ["add", "--all"]);

		const staged = runGitOrThrow(mountRoot, ["diff", "--cached", "--name-only"])
			.split("\n")
			.filter(Boolean);
		if (staged.length === 0) {
			return { state: "nothing_to_publish" };
		}

		const changeId = newChangeId();
		const message = buildCommitMessage(
			options.summary?.trim() ||
				defaultSubject(config, dirtyPaths, options.entities),
			{
				app: config.app,
				dataRepo: config.dataRepo.remote,
				branch: config.dataRepo.branch,
				schemaVersion: `${config.schema.name}@${config.schema.version}`,
				actor: options.actor,
				machine: os.hostname(),
				source: options.source,
				changeId,
				entities: options.entities,
			},
		);
		runGitOrThrow(mountRoot, ["commit", "--message", message]);

		const push = runGit(mountRoot, [
			"push",
			"origin",
			`${config.dataRepo.branch}:${config.dataRepo.branch}`,
		]);
		if (push.status !== 0) {
			// Not a conflict: the batch is committed locally and the next
			// publish retries pull --rebase + push. Writes stay allowed.
			throw new RepositoryDbError(
				"publish_push_failed",
				`git push failed; the publish batch stays local (committed_not_pushed). ` +
					`Re-run publish to retry. Detail: ${push.stderr.trim() || push.stdout.trim()}`,
			);
		}

		return {
			state: "published",
			commit: gitHeadCommit(mountRoot),
			changeId,
			pushedTo: `${config.dataRepo.remote}#${config.dataRepo.branch}`,
		};
	} finally {
		releaseLock();
	}
}
