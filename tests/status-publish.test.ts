import { describe, expect, test } from "bun:test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { RepositoryDb } from "../src/repositoryDb.ts";
import { parseCommitMessage } from "../src/trailers.ts";
import {
	cloneFixture,
	createFixtureRepo,
	git,
	writeFixtureDocument,
} from "./fixtures.ts";

describe("sync status model", () => {
	test("walks draft -> committed_not_pushed -> published -> pull_needed", () => {
		const fixture = createFixtureRepo();
		try {
			const db = RepositoryDb.open(fixture.mountPath);
			expect(db.status().state).toBe("published");

			writeFixtureDocument(fixture.mountPath, "thing-1", { name: "first" });
			const draft = db.status();
			expect(draft.state).toBe("draft");
			expect(draft.dirtyPaths).toContain(
				"data/things/thing-1.yaml",
			);

			git(fixture.mountPath, ["add", "--all"]);
			git(fixture.mountPath, ["commit", "--message", "local commit"]);
			expect(db.status().state).toBe("committed_not_pushed");

			git(fixture.mountPath, ["push", "origin", fixture.branch]);
			expect(db.status().state).toBe("published");

			// Someone else pushes…
			const second = cloneFixture(fixture);
			writeFixtureDocument(second, "thing-2", { name: "second" });
			git(second, ["add", "--all"]);
			git(second, ["commit", "--message", "remote commit"]);
			git(second, ["push", "origin", fixture.branch]);

			// …visible only after fetch, even without a webhook.
			expect(db.status().state).toBe("published");
			const fetched = db.status({ fetch: true });
			expect(fetched.state).toBe("pull_needed");
			expect(fetched.behind).toBe(1);
		} finally {
			rmSync(fixture.root, { recursive: true, force: true });
		}
	});
});

describe("publish flow", () => {
	test("publishes one commit per batch with valid trailers", () => {
		const fixture = createFixtureRepo();
		try {
			const db = RepositoryDb.open(fixture.mountPath);
			writeFixtureDocument(fixture.mountPath, "thing-1", { name: "first" });
			writeFixtureDocument(fixture.mountPath, "thing-2", { name: "second" });

			const result = db.publish({
				actor: "Test Actor <test@spectoda.com>",
				source: "repository-db-test",
				entities: ["thing-1", "thing-2"],
			});
			expect(result.state).toBe("published");
			expect(result.commit).toBeTruthy();

			// Single commit for the whole batch, pushed to origin.
			const localLog = git(fixture.mountPath, ["log", "--oneline"]).trim().split("\n");
			expect(localLog).toHaveLength(2); // bootstrap + publish

			const message = git(fixture.mountPath, [
				"log",
				"-1",
				"--format=%B",
			]);
			const parsed = parseCommitMessage(message);
			expect(parsed.trailers.app).toBe("fixture");
			expect(parsed.trailers.branch).toBe(fixture.branch);
			expect(parsed.trailers.actor).toBe("Test Actor <test@spectoda.com>");
			expect(parsed.trailers.source).toBe("repository-db-test");
			expect(parsed.trailers.entities).toEqual(["thing-1", "thing-2"]);
			expect(parsed.subject).toContain("2 data file(s)");

			const originHead = git(fixture.originPath, [
				"rev-parse",
				fixture.branch,
			]).trim();
			expect(originHead).toBe(result.commit ?? "");

			expect(db.status().state).toBe("published");
		} finally {
			rmSync(fixture.root, { recursive: true, force: true });
		}
	});

	test("publish integrates non-conflicting remote changes via rebase", () => {
		const fixture = createFixtureRepo();
		try {
			const second = cloneFixture(fixture);
			writeFixtureDocument(second, "thing-remote", { name: "remote" });
			git(second, ["add", "--all"]);
			git(second, ["commit", "--message", "remote change"]);
			git(second, ["push", "origin", fixture.branch]);

			const db = RepositoryDb.open(fixture.mountPath);
			writeFixtureDocument(fixture.mountPath, "thing-local", { name: "local" });
			const result = db.publish({
				actor: "Test Actor <test@spectoda.com>",
				source: "repository-db-test",
			});
			expect(result.state).toBe("published");
			const status = db.status({ fetch: true });
			expect(status.state).toBe("published");
			expect(status.behind).toBe(0);
		} finally {
			rmSync(fixture.root, { recursive: true, force: true });
		}
	});

	test("pull integrates remote changes and preserves the local draft (autostash)", () => {
		const fixture = createFixtureRepo();
		try {
			const db = RepositoryDb.open(fixture.mountPath);

			// Remote publishes one document…
			const second = cloneFixture(fixture);
			writeFixtureDocument(second, "thing-remote", { name: "remote" });
			git(second, ["add", "--all"]);
			git(second, ["commit", "--message", "remote change"]);
			git(second, ["push", "origin", fixture.branch]);

			// …while a local draft on a different document is in progress.
			writeFixtureDocument(fixture.mountPath, "thing-local", { name: "draft" });

			const result = db.pull();
			expect(result).toEqual({ state: "pulled", behind: 1 });

			// Remote document arrived, local draft survived uncommitted.
			expect(
				readFileSync(
					path.join(fixture.mountPath, "data/things/thing-remote.yaml"),
					"utf8",
				),
			).toContain("remote");
			const status = db.status();
			expect(status.state).toBe("draft");
			expect(status.dirtyPaths).toContain("data/things/thing-local.yaml");
			expect(status.behind).toBe(0);

			expect(db.pull()).toEqual({ state: "up_to_date", behind: 0 });
		} finally {
			rmSync(fixture.root, { recursive: true, force: true });
		}
	});

	test("pull conflict records recovery state and blocks writes", () => {
		const fixture = createFixtureRepo();
		try {
			const db = RepositoryDb.open(fixture.mountPath);
			writeFixtureDocument(fixture.mountPath, "thing-1", { name: "seed" });
			git(fixture.mountPath, ["add", "--all"]);
			git(fixture.mountPath, ["commit", "--message", "seed"]);
			git(fixture.mountPath, ["push", "origin", fixture.branch]);

			const second = cloneFixture(fixture, "second-pull");
			writeFixtureDocument(second, "thing-1", { name: "remote-version" });
			git(second, ["add", "--all"]);
			git(second, ["commit", "--message", "remote edit"]);
			git(second, ["push", "origin", fixture.branch]);

			writeFixtureDocument(fixture.mountPath, "thing-1", { name: "local-version" });
			expect(() => db.pull()).toThrow(/pull stopped: conflict/);
			expect(db.status().state).toBe("conflict");

			db.abortConflict();
			expect(db.status().state).toBe("draft");
		} finally {
			rmSync(fixture.root, { recursive: true, force: true });
		}
	});

	test("nothing_to_publish on a clean tree", () => {
		const fixture = createFixtureRepo();
		try {
			const db = RepositoryDb.open(fixture.mountPath);
			expect(
				db.publish({ actor: "a <a@a>", source: "test" }).state,
			).toBe("nothing_to_publish");
		} finally {
			rmSync(fixture.root, { recursive: true, force: true });
		}
	});

	test("refuses undeclared generated diffs and accepts declared ones", () => {
		const fixture = createFixtureRepo();
		try {
			const db = RepositoryDb.open(fixture.mountPath);
			writeFileSync(
				path.join(fixture.mountPath, "generated/rogue.json"),
				"{}\n",
				"utf8",
			);
			expect(() =>
				db.publish({ actor: "a <a@a>", source: "test" }),
			).toThrow(/undeclared generated diffs/);

			// Declare it in the manifest -> publish passes.
			const configPath = path.join(fixture.mountPath, "repository-db.yaml");
			const config = readFileSync(configPath, "utf8").replace(
				"generated_manifest: []",
				'generated_manifest:\n  - path: generated/rogue.json\n    note: "test artifact"',
			);
			writeFileSync(configPath, config, "utf8");
			const db2 = RepositoryDb.open(fixture.mountPath);
			const result = db2.publish({ actor: "a <a@a>", source: "test" });
			expect(result.state).toBe("published");
		} finally {
			rmSync(fixture.root, { recursive: true, force: true });
		}
	});
});
