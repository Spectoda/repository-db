import path from "node:path";
import { assertDataRepoBoundary } from "./boundary.ts";
import { Collection, type CollectionOptions } from "./collections.ts";
import {
	abortConflict,
	activeConflict,
	markConflictResolved,
} from "./conflict.ts";
import { loadRepositoryDbConfig } from "./config.ts";
import { gitFetch } from "./git.ts";
import { runValidateCommands } from "./generated.ts";
import { publish } from "./publish.ts";
import { deriveSyncStatus, type StatusOptions } from "./status.ts";
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

	status(options: StatusOptions = {}): SyncStatus {
		return deriveSyncStatus(this.mountRoot, this.config, options);
	}

	fetch(): void {
		assertDataRepoBoundary(this.mountRoot, this.config);
		gitFetch(this.mountRoot);
	}

	validate(): string[] {
		assertDataRepoBoundary(this.mountRoot, this.config);
		return runValidateCommands(this.mountRoot, this.config);
	}

	publish(options: PublishOptions): PublishResult {
		return publish(this.mountRoot, this.config, options);
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
