import path from "node:path";
import { assertDataRepoBoundary } from "./boundary.ts";
import { Collection, type CollectionOptions } from "./collections.ts";
import {
	abortConflict,
	activeConflict,
	markConflictResolved,
} from "./conflict.ts";
import { loadRepositoryDbConfig } from "./config.ts";
import { gitFetchAsync } from "./git.ts";
import { runValidateCommands } from "./generated.ts";
import { publish, pullRemote, type PullResult } from "./publish.ts";
import {
	deriveSyncStatus,
	deriveSyncStatusAsync,
	type StatusOptions,
} from "./status.ts";
import type {
	ConflictState,
	PublishOptions,
	PublishResult,
	RepositoryDbConfig,
	SyncStatus,
} from "./types.ts";

/**
 * Facade over one mounted repository-db data checkout.
 *
 * Reading is plain filesystem access (thick client, serverless). Writing
 * produces local drafts in the Git working tree; `publish()` turns the
 * current draft batch into one pushed commit. All operations enforce the
 * Git boundary guard so they can never run against a parent code repo.
 */
export class RepositoryDb {
	readonly mountRoot: string;
	readonly config: RepositoryDbConfig;

	private constructor(mountRoot: string, config: RepositoryDbConfig) {
		this.mountRoot = mountRoot;
		this.config = config;
	}

	static open(mountRoot: string): RepositoryDb {
		const resolved = path.resolve(mountRoot);
		const config = loadRepositoryDbConfig(resolved);
		assertDataRepoBoundary(resolved, config);
		return new RepositoryDb(resolved, config);
	}

	collection<T>(name: string, options: CollectionOptions<T>): Collection<T> {
		return new Collection<T>(this.mountRoot, this.config, name, options);
	}

	/** Local sync state (no network). Use {@link statusAsync} for a fresh `behind`. */
	status(): SyncStatus {
		return deriveSyncStatus(this.mountRoot, this.config);
	}

	/** Sync state, optionally running an async `git fetch` first. */
	statusAsync(options: StatusOptions = {}): Promise<SyncStatus> {
		return deriveSyncStatusAsync(this.mountRoot, this.config, options);
	}

	async fetchAsync(): Promise<void> {
		assertDataRepoBoundary(this.mountRoot, this.config);
		await gitFetchAsync(this.mountRoot);
	}

	validate(): string[] {
		assertDataRepoBoundary(this.mountRoot, this.config);
		return runValidateCommands(this.mountRoot, this.config);
	}

	publish(options: PublishOptions): Promise<PublishResult> {
		return publish(this.mountRoot, this.config, options);
	}

	/** Fetch + integrate remote changes (autostash-safe, conflict-guarded). */
	pull(): Promise<PullResult> {
		return pullRemote(this.mountRoot, this.config);
	}

	conflict(): ConflictState | undefined {
		return activeConflict(this.mountRoot);
	}

	abortConflict(): void {
		abortConflict(this.mountRoot);
	}

	markConflictResolved(): void {
		markConflictResolved(this.mountRoot);
	}
}
