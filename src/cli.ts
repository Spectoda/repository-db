#!/usr/bin/env bun
import path from "node:path";
import { initDataRepo } from "./init.ts";
import { RepositoryDb } from "./repositoryDb.ts";
import { RepositoryDbError } from "./types.ts";

const HELP = `repository-db — Git-backed YAML data layer

Usage:
  repository-db init --app <name> --remote <url> --branch <vN> --mount <path> \\
                     --schema-name <name> --schema-version <semver> \\
                     [--create-remote] [--visibility private|public]
  repository-db status   [--mount <path>] [--fetch] [--json]
  repository-db validate [--mount <path>]
  repository-db sync     [--mount <path>] [--json]
  repository-db publish  [--mount <path>] --actor <actor> --source <source>
                         [--summary <text>] [--entity <id>]... [--json]
  repository-db conflict [--mount <path>] [--abort | --resolved] [--json]

Notes:
  --mount defaults to the current working directory. Every command verifies
  the Git boundary (repo root, origin remote, branch) against repository-db.yaml
  before touching anything; commands refuse to run from a parent code repo.
  Publish = validate -> materialize generated -> pull --rebase --autostash ->
  one commit with Repository-Db-* trailers -> push.
`;

interface Args {
	command: string;
	flags: Map<string, string | boolean>;
	entities: string[];
}

function parseArgs(argv: string[]): Args {
	const [command = "help", ...rest] = argv;
	const flags = new Map<string, string | boolean>();
	const entities: string[] = [];
	for (let i = 0; i < rest.length; i += 1) {
		const arg = rest[i] ?? "";
		if (!arg.startsWith("--")) {
			throw new RepositoryDbError("invalid_args", `unexpected argument: ${arg}`);
		}
		const name = arg.slice(2);
		const boolFlags = new Set([
			"fetch",
			"json",
			"abort",
			"resolved",
			"create-remote",
		]);
		if (boolFlags.has(name)) {
			flags.set(name, true);
			continue;
		}
		const value = rest[i + 1];
		if (value === undefined || value.startsWith("--")) {
			throw new RepositoryDbError("invalid_args", `flag --${name} expects a value`);
		}
		if (name === "entity") entities.push(value);
		else flags.set(name, value);
		i += 1;
	}
	return { command, flags, entities };
}

function requireFlag(args: Args, name: string): string {
	const value = args.flags.get(name);
	if (typeof value !== "string" || !value) {
		throw new RepositoryDbError("invalid_args", `missing required flag --${name}`);
	}
	return value;
}

function mountPath(args: Args): string {
	const value = args.flags.get("mount");
	return path.resolve(typeof value === "string" ? value : process.cwd());
}

function emit(args: Args, value: unknown, human: () => string): void {
	if (args.flags.get("json")) {
		console.log(JSON.stringify(value, null, 2));
	} else {
		console.log(human());
	}
}

function main(argv: string[]): number {
	const args = parseArgs(argv);
	switch (args.command) {
		case "help":
		case "--help":
		case "-h": {
			console.log(HELP);
			return 0;
		}
		case "init": {
			const result = initDataRepo({
				app: requireFlag(args, "app"),
				remote: requireFlag(args, "remote"),
				branch: requireFlag(args, "branch"),
				mountPath: requireFlag(args, "mount"),
				schemaName: requireFlag(args, "schema-name"),
				schemaVersion: requireFlag(args, "schema-version"),
				createRemote: args.flags.get("create-remote") === true,
				visibility:
					args.flags.get("visibility") === "public" ? "public" : "private",
			});
			console.log(
				[
					`mount: ${result.mountPath}`,
					`remote created: ${result.created}`,
					`cloned: ${result.cloned}`,
					`bootstrapped: ${result.bootstrapped}`,
				].join("\n"),
			);
			return 0;
		}
		case "status": {
			const db = RepositoryDb.open(mountPath(args));
			const status = db.status({ fetch: args.flags.get("fetch") === true });
			emit(args, status, () =>
				[
					`state: ${status.state}`,
					`branch: ${status.branch}`,
					`ahead: ${status.ahead}, behind: ${status.behind}${status.fetched ? "" : " (run with --fetch for fresh remote state)"}`,
					status.dirtyPaths.length > 0
						? `draft paths:\n${status.dirtyPaths.map((p) => `  - ${p}`).join("\n")}`
						: "no local draft changes",
				].join("\n"),
			);
			return 0;
		}
		case "validate": {
			const db = RepositoryDb.open(mountPath(args));
			const ran = db.validate();
			console.log(
				ran.length > 0
					? `validate OK (${ran.length} command(s)):\n${ran.map((c) => `  - ${c}`).join("\n")}`
					: "validate OK (no validate commands configured)",
			);
			return 0;
		}
		case "sync": {
			const db = RepositoryDb.open(mountPath(args));
			const status = db.status({ fetch: true });
			emit(args, status, () =>
				[
					`fetched origin; state: ${status.state}`,
					`ahead: ${status.ahead}, behind: ${status.behind}`,
					status.behind > 0
						? "remote changes available — publish integrates them via pull --rebase, or pull manually when clean"
						: "checkout is up to date with the remote",
				].join("\n"),
			);
			return 0;
		}
		case "publish": {
			const db = RepositoryDb.open(mountPath(args));
			const result = db.publish({
				actor: requireFlag(args, "actor"),
				source: requireFlag(args, "source"),
				summary:
					typeof args.flags.get("summary") === "string"
						? (args.flags.get("summary") as string)
						: undefined,
				entities: args.entities.length > 0 ? args.entities : undefined,
			});
			emit(args, result, () =>
				result.state === "nothing_to_publish"
					? "nothing to publish (working tree clean)"
					: `published ${result.commit} (change ${result.changeId}) -> ${result.pushedTo}`,
			);
			return 0;
		}
		case "conflict": {
			const db = RepositoryDb.open(mountPath(args));
			if (args.flags.get("abort") === true) {
				db.abortConflict();
				console.log("conflict aborted; data repository restored to the pre-publish state");
				return 0;
			}
			if (args.flags.get("resolved") === true) {
				db.markConflictResolved();
				console.log("conflict state cleared; writes are allowed again");
				return 0;
			}
			const conflict = db.conflict();
			emit(args, conflict ?? null, () =>
				conflict
					? `ACTIVE CONFLICT (${conflict.operation}, detected ${conflict.detectedAt})\n${conflict.message}\n\n${conflict.handoff}`
					: "no active conflict",
			);
			return conflict ? 1 : 0;
		}
		default: {
			console.error(`unknown command: ${args.command}\n`);
			console.log(HELP);
			return 1;
		}
	}
}

try {
	process.exit(main(process.argv.slice(2)));
} catch (error) {
	if (error instanceof RepositoryDbError) {
		console.error(`repository-db error [${error.code}]: ${error.message}`);
		process.exit(2);
	}
	throw error;
}
