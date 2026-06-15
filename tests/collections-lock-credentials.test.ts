import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkCredentials } from "../src/credentials.ts";
import { acquirePublishLock } from "../src/lock.ts";
import { parseRepositoryDbConfig } from "../src/config.ts";
import { RepositoryDb } from "../src/repositoryDb.ts";
import { toStableYaml } from "../src/yamlIo.ts";
import {
	createFixtureRepo,
	fakeFailingGh,
	fixtureConfigValue,
	git,
} from "./fixtures.ts";

describe("collections", () => {
	test("put/get/list roundtrip with envelope validation", () => {
		const fixture = createFixtureRepo();
		try {
			const db = RepositoryDb.open(fixture.mountPath);
			const things = db.collection<{ name: string; price?: number }>("things", {
				schemaVersion: "thing.v3",
			});
			things.put("thing a/1", { name: "first", price: 10 });
			things.put("thing-2", { name: "second" });

			expect(things.listIds()).toEqual(["thing a/1", "thing-2"]);
			expect(things.get("thing a/1")?.record.name).toBe("first");
			expect(things.has("thing-404")).toBe(false);
			expect(things.list()).toHaveLength(2);

			// Id is URL-encoded in the filename.
			expect(
				existsSync(
					path.join(
						fixture.mountPath,
						"data/things",
						"thing%20a%2F1.yaml",
					),
				),
			).toBe(true);

			expect(things.remove("thing-2")).toBe(true);
			expect(things.remove("thing-2")).toBe(false);
		} finally {
			rmSync(fixture.root, { recursive: true, force: true });
		}
	});

	test("parser rejection propagates and nothing is written", () => {
		const fixture = createFixtureRepo();
		try {
			const db = RepositoryDb.open(fixture.mountPath);
			const strict = db.collection<{ name: string }>("things", {
				schemaVersion: "thing.v3",
				parser: {
					parse(value: unknown): { name: string } {
						const record = value as { name?: unknown };
						if (typeof record?.name !== "string") {
							throw new Error("name must be a string");
						}
						return { name: record.name };
					},
				},
			});
			expect(() =>
				strict.put("bad", { name: 42 as unknown as string }),
			).toThrow(/name must be a string/);
			expect(strict.has("bad")).toBe(false);
		} finally {
			rmSync(fixture.root, { recursive: true, force: true });
		}
	});

	test("schemaVersion mismatch is refused on read", () => {
		const fixture = createFixtureRepo();
		try {
			const db = RepositoryDb.open(fixture.mountPath);
			const filePath = path.join(fixture.mountPath, "data/things/old.yaml");
			mkdirSync(path.dirname(filePath), { recursive: true });
			writeFileSync(
				filePath,
				toStableYaml({ schemaVersion: "thing.v2", id: "old", record: {} }),
				"utf8",
			);
			const things = db.collection("things", { schemaVersion: "thing.v3" });
			expect(() => things.get("old")).toThrow(/schemaVersion "thing.v2"/);
		} finally {
			rmSync(fixture.root, { recursive: true, force: true });
		}
	});
});

describe("publish lock", () => {
	test("second acquire fails while the lock is held, then succeeds after release", () => {
		const root = path.join(os.tmpdir(), `repository-db-lock-${process.pid}`);
		mkdirSync(root, { recursive: true });
		try {
			const release = acquirePublishLock(root);
			expect(() => acquirePublishLock(root)).toThrow(/publish is already running/);
			release();
			const release2 = acquirePublishLock(root);
			release2();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("stale lock from a dead process is reclaimed", () => {
		const root = path.join(os.tmpdir(), `repository-db-stale-${process.pid}`);
		mkdirSync(path.join(root, ".repository-db"), { recursive: true });
		try {
			writeFileSync(
				path.join(root, ".repository-db", "publish.lock"),
				JSON.stringify({
					pid: 999999999,
					hostname: os.hostname(),
					acquiredAt: new Date(0).toISOString(),
				}),
				"utf8",
			);
			const release = acquirePublishLock(root);
			release();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("credential preflight", () => {
	const savedEnv = { ...process.env };

	afterEach(() => {
		process.env.REPOSITORY_DB_GH_BIN = savedEnv.REPOSITORY_DB_GH_BIN;
		process.env.GIT_CONFIG_GLOBAL = savedEnv.GIT_CONFIG_GLOBAL;
		process.env.GIT_CONFIG_SYSTEM = savedEnv.GIT_CONFIG_SYSTEM;
		if (savedEnv.REPOSITORY_DB_GH_BIN === undefined)
			delete process.env.REPOSITORY_DB_GH_BIN;
		if (savedEnv.GIT_CONFIG_GLOBAL === undefined)
			delete process.env.GIT_CONFIG_GLOBAL;
		if (savedEnv.GIT_CONFIG_SYSTEM === undefined)
			delete process.env.GIT_CONFIG_SYSTEM;
	});

	test("non-GitHub HTTPS helper must fill credentials, not merely exist", () => {
		const root = path.join(os.tmpdir(), `repository-db-credentials-${process.pid}`);
		rmSync(root, { recursive: true, force: true });
		mkdirSync(root, { recursive: true });
		try {
			const gitConfig = path.join(root, "gitconfig");
			writeFileSync(
				gitConfig,
				'[credential]\n	helper = "!f() { exit 0; }; f"\n',
				"utf8",
			);
			process.env.GIT_CONFIG_GLOBAL = gitConfig;
			process.env.GIT_CONFIG_SYSTEM = "/dev/null";

			const check = checkCredentials("https://gitlab.com/example/private-data.git");

			expect(check.ok).toBe(false);
			expect(check.mechanism).toBe("none");
			expect(check.detail).toMatch(/did not return a non-interactive credential/);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("publish fails before any mutation when gh auth is unavailable", async () => {
		const fixture = createFixtureRepo();
		try {
			// Point the config at a GitHub-https remote so the gh preflight
			// applies, while git operations still talk to the local origin.
			const configPath = path.join(fixture.mountPath, "repository-db.yaml");
			writeFileSync(
				configPath,
				toStableYaml(
					fixtureConfigValue("https://github.com/Spectoda/fixture-data.git", fixture.branch),
				),
				"utf8",
			);
			git(fixture.mountPath, [
				"remote",
				"set-url",
				"origin",
				"https://github.com/Spectoda/fixture-data.git",
			]);
			git(fixture.mountPath, ["add", "--all"]);
			git(fixture.mountPath, ["commit", "--message", "retarget remote"]);

			process.env.REPOSITORY_DB_GH_BIN = fakeFailingGh(fixture.root);
			process.env.GIT_CONFIG_GLOBAL = "/dev/null";
			process.env.GIT_CONFIG_SYSTEM = "/dev/null";

			const db = RepositoryDb.open(fixture.mountPath);
			const headBefore = git(fixture.mountPath, ["rev-parse", "HEAD"]).trim();
			const config = parseRepositoryDbConfig(
				fixtureConfigValue("https://github.com/Spectoda/fixture-data.git", fixture.branch),
			);
			void config;

			await expect(
				db.publish({ actor: "a <a@a>", source: "test" }),
			).rejects.toThrow(/credential preflight failed/);

			// Nothing was committed or modified by the failed preflight.
			const headAfter = git(fixture.mountPath, ["rev-parse", "HEAD"]).trim();
			expect(headAfter).toBe(headBefore);
		} finally {
			rmSync(fixture.root, { recursive: true, force: true });
		}
	});
});
