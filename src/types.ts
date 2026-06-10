/**
 * Shared types of the repository-db engine.
 *
 * The engine is intentionally domain-agnostic: it knows about Git, YAML
 * documents, collections, generated read models and the publish lifecycle.
 * Domain schemas (e.g. Deals) are injected by the host application through
 * the {@link DocumentParser} contract, which is structurally compatible with
 * Zod schemas without depending on Zod.
 */

/** Structurally compatible with `zod` schemas (`schema.parse(value)`). */
export interface DocumentParser<T> {
	parse(value: unknown): T;
}

export interface RepositoryDbLayout {
	/** Directory with canonical collection data, relative to the mount root. */
	data: string;
	/** Directory with committed generated read models, relative to the mount root. */
	generated: string;
	/** Directory with data-repo-local maintenance scripts, relative to the mount root. */
	scripts: string;
}

export interface GeneratedManifestEntry {
	/** Path of the committed generated artifact, relative to the mount root. */
	path: string;
	/** Command materializing the artifact, executed with cwd = mount root. */
	materializer?: string;
	/** Human note about what the artifact contains. */
	note?: string;
}

export interface RepositoryDbConfig {
	schemaVersion: string;
	/** Application name owning this data repo, e.g. `deals`. */
	app: string;
	dataRepo: {
		/** Expected remote URL of the data repository. */
		remote: string;
		/** Expected major-generation branch, e.g. `v3`. */
		branch: string;
	};
	schema: {
		/** Data-shape contract name, e.g. `deals-data`. */
		name: string;
		/** Data-shape contract version, e.g. `3.0.0-alpha.0`. */
		version: string;
	};
	layout: RepositoryDbLayout;
	/**
	 * Declared committed generated read models. Generated diffs outside these
	 * paths are refused by publish.
	 */
	generatedManifest: GeneratedManifestEntry[];
	/** Validation commands executed by `repository-db validate` (cwd = mount root). */
	validate: string[];
}

export type SyncState =
	| "conflict"
	| "draft"
	| "committed_not_pushed"
	| "pull_needed"
	| "published";

export interface SyncStatus {
	/** Highest-priority state; see individual flags for the full picture. */
	state: SyncState;
	branch: string;
	/** Local commits not pushed to the remote branch. */
	ahead: number;
	/** Remote commits not present locally (as of the last fetch). */
	behind: number;
	/** Uncommitted (draft) paths relative to the mount root. */
	dirtyPaths: string[];
	/** True when a rebase/merge is in progress or a conflict state is recorded. */
	conflict: boolean;
	/** True when `git fetch` was executed as part of this status call. */
	fetched: boolean;
}

export interface CommitTrailers {
	app: string;
	dataRepo: string;
	branch: string;
	schemaVersion: string;
	actor: string;
	machine: string;
	source: string;
	changeId: string;
	entities?: string[];
}

export interface PublishOptions {
	/** Human actor recorded in the commit trailers, e.g. `Jana <jana@firma.cz>`. */
	actor: string;
	/** Producing surface, e.g. `deals-app-v3` or `repository-db-cli`. */
	source: string;
	/** Optional human summary used as the first commit-message line. */
	summary?: string;
	/** Optional entity identifiers recorded in the optional trailer. */
	entities?: string[];
	/** Skip the validate step (used by tests and trusted callers only). */
	skipValidate?: boolean;
	/** Skip materializer commands (used when the caller already materialized). */
	skipMaterialize?: boolean;
}

export interface PublishResult {
	/** `published` on success. */
	state: "published" | "nothing_to_publish";
	commit?: string;
	changeId?: string;
	pushedTo?: string;
}

export interface ConflictState {
	schemaVersion: "repository-db.conflict.v1";
	detectedAt: string;
	operation: string;
	gitState: string;
	message: string;
	handoff: string;
	/** HEAD commit before the failed operation; used by safe abort/recovery. */
	preOperationHead?: string;
}

export class RepositoryDbError extends Error {
	readonly code: string;

	constructor(code: string, message: string) {
		super(message);
		this.name = "RepositoryDbError";
		this.code = code;
	}
}

export class BoundaryViolationError extends RepositoryDbError {
	constructor(message: string) {
		super("boundary_violation", message);
		this.name = "BoundaryViolationError";
	}
}

export class ConflictActiveError extends RepositoryDbError {
	constructor(message: string) {
		super("conflict_active", message);
		this.name = "ConflictActiveError";
	}
}

export class PublishLockedError extends RepositoryDbError {
	constructor(message: string) {
		super("publish_locked", message);
		this.name = "PublishLockedError";
	}
}

export class CredentialsError extends RepositoryDbError {
	constructor(message: string) {
		super("credentials", message);
		this.name = "CredentialsError";
	}
}

export class ValidationFailedError extends RepositoryDbError {
	constructor(message: string) {
		super("validation_failed", message);
		this.name = "ValidationFailedError";
	}
}
