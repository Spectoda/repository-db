import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { RepositoryDb } from "../src/repositoryDb.ts";
import {
	cloneFixture,
	createFixtureRepo,
	git,
	writeFixtureDocument,
} from "./fixtures.ts";

/** Seed a shared document and push a conflicting remote edit. */
function seedAndDivergeRemote(
	fixture: ReturnType<typeof createFixtureRepo>,
): void {
	writeFixtureDocument(fixture.mountPath, "thing-1", { name: "seed" });
	git(fixture.mountPath, ["add", "--all"]);
	git(fixture.mountPath, ["commit", "--message", "seed"]);
	git(fixture.mountPath, ["push", "origin", fixture.branch]);

	const second = cloneFixture(fixture);
	writeFixtureDocument(second, "thing-1", { name: "remote-version" });
	git(second, ["add", "--all"]);
	git(second, ["commit", "--message", "remote edit"]);
	git(second, ["push", "origin", fixture.branch]);
}

describe("conflict handling", () => {
	test("conflicted autostash apply (git exit 0) is detected, blocks writes and aborts cleanly", async () => {
		const fixture = createFixtureRepo();
		try {
			const db = RepositoryDb.open(fixture.mountPath);
			seedAndDivergeRemote(fixture);
			// Local uncommitted draft on the same document.
			writeFixtureDocument(fixture.mountPath, "thing-1", { name: "local-version" });

			await expect(
				db.publish({ actor: "a <a@a>", source: "test" }),
			).rejects.toThrow(/publish stopped: conflict/);

			// Conflict state exists and is surfaced by status.
			const conflict = db.conflict();
			expect(conflict).toBeDefined();
			expect(conflict?.handoff).toContain("repository-db conflict --resolved");
			expect(db.status().state).toBe("conflict");

			// No conflict markers were committed.
			const headFile = git(fixture.mountPath, [
				"show",
				"HEAD:data/things/thing-1.yaml",
			]);
			expect(headFile).not.toContain("<<<<<<<");

			// Writes are blocked until explicit resolve/abort.
			const things = db.collection<{ name: string }>("things", {
				schemaVersion: "thing.v3",
			});
			expect(() => things.put("thing-9", { name: "blocked" })).toThrow(
				/conflict/i,
			);
			await expect(
				db.publish({ actor: "a <a@a>", source: "test" }),
			).rejects.toThrow(/conflict/i);

			// Abort restores the pre-publish state: draft back in the tree.
			db.abortConflict();
			expect(db.conflict()).toBeUndefined();
			expect(
				existsSync(
					path.join(fixture.mountPath, ".repository-db", "conflict.json"),
				),
			).toBe(false);
			const restored = readFileSync(
				path.join(fixture.mountPath, "data/things/thing-1.yaml"),
				"utf8",
			);
			expect(restored).toContain("local-version");
			expect(restored).not.toContain("<<<<<<<");
			expect(db.status().state).toBe("draft");
			things.put("thing-9", { name: "allowed-again" });
		} finally {
			rmSync(fixture.root, { recursive: true, force: true });
		}
	});

	test("autostash conflict can be resolved manually and republished", async () => {
		const fixture = createFixtureRepo();
		try {
			const db = RepositoryDb.open(fixture.mountPath);
			seedAndDivergeRemote(fixture);
			writeFixtureDocument(fixture.mountPath, "thing-1", { name: "local-version" });
			await expect(
				db.publish({ actor: "a <a@a>", source: "test" }),
			).rejects.toThrow(/publish stopped: conflict/);

			// markConflictResolved refuses while conflict markers remain.
			expect(() => db.markConflictResolved()).toThrow(/unresolved conflict markers/);

			// Resolve manually: write the merged version and stage it.
			writeFixtureDocument(fixture.mountPath, "thing-1", { name: "merged-version" });
			git(fixture.mountPath, ["add", "--all"]);
			db.markConflictResolved();
			expect(db.conflict()).toBeUndefined();

			const result = await db.publish({ actor: "a <a@a>", source: "test" });
			expect(result.state).toBe("published");
			const status = await db.statusAsync({ fetch: true });
			expect(status.state).toBe("published");
			expect(status.behind).toBe(0);
			const published = git(fixture.mountPath, [
				"show",
				"HEAD:data/things/thing-1.yaml",
			]);
			expect(published).toContain("merged-version");
		} finally {
			rmSync(fixture.root, { recursive: true, force: true });
		}
	});

	test("abort pops the recorded autostash and never touches a user stash", async () => {
		const fixture = createFixtureRepo();
		try {
			const db = RepositoryDb.open(fixture.mountPath);
			// Pre-existing user stash with a misleading message that the old
			// substring heuristic would have popped by mistake.
			writeFixtureDocument(fixture.mountPath, "thing-user", { name: "user-work" });
			git(fixture.mountPath, [
				"stash",
				"push",
				"--include-untracked",
				"-m",
				"my autostash backup",
			]);

			seedAndDivergeRemote(fixture);
			writeFixtureDocument(fixture.mountPath, "thing-1", { name: "local-version" });
			await expect(
				db.publish({ actor: "a <a@a>", source: "test" }),
			).rejects.toThrow(/publish stopped: conflict/);

			// Conflict state recorded the autostash commit for deterministic abort.
			const state = JSON.parse(
				readFileSync(
					path.join(fixture.mountPath, ".repository-db", "conflict.json"),
					"utf8",
				),
			) as { autostashSha?: string };
			expect(state.autostashSha).toMatch(/^[0-9a-f]{7,40}$/);

			db.abortConflict();
			const restored = readFileSync(
				path.join(fixture.mountPath, "data/things/thing-1.yaml"),
				"utf8",
			);
			expect(restored).toContain("local-version");
			// The user stash must stay untouched in the stash list.
			const stashes = git(fixture.mountPath, ["stash", "list", "--format=%gs"]);
			expect(stashes).toContain("my autostash backup");
		} finally {
			rmSync(fixture.root, { recursive: true, force: true });
		}
	});

	test("abort refuses a tampered preOperationHead instead of resetting blindly", async () => {
		const fixture = createFixtureRepo();
		try {
			const db = RepositoryDb.open(fixture.mountPath);
			seedAndDivergeRemote(fixture);
			writeFixtureDocument(fixture.mountPath, "thing-1", { name: "local-version" });
			await expect(
				db.publish({ actor: "a <a@a>", source: "test" }),
			).rejects.toThrow(/publish stopped: conflict/);

			const conflictFile = path.join(
				fixture.mountPath,
				".repository-db",
				"conflict.json",
			);
			const state = JSON.parse(readFileSync(conflictFile, "utf8"));
			state.preOperationHead = "HEAD~100";
			writeFileSync(conflictFile, JSON.stringify(state), "utf8");

			expect(() => db.abortConflict()).toThrow(/unexpected format/);
		} finally {
			rmSync(fixture.root, { recursive: true, force: true });
		}
	});

	test("mid-rebase conflict on committed local changes stops publish and rebase --abort recovers", async () => {
		const fixture = createFixtureRepo();
		try {
			const db = RepositoryDb.open(fixture.mountPath);
			seedAndDivergeRemote(fixture);
			// Local COMMITTED conflicting change (not pushed).
			writeFixtureDocument(fixture.mountPath, "thing-1", { name: "local-committed" });
			git(fixture.mountPath, ["add", "--all"]);
			git(fixture.mountPath, ["commit", "--message", "local committed edit"]);
			// Plus a fresh draft so publish takes the full path.
			writeFixtureDocument(fixture.mountPath, "thing-2", { name: "draft" });

			await expect(
				db.publish({ actor: "a <a@a>", source: "test" }),
			).rejects.toThrow(/publish stopped: conflict/);
			expect(db.status().state).toBe("conflict");

			db.abortConflict();
			expect(db.conflict()).toBeUndefined();
			// Local commit and draft both survived the abort.
			const log = git(fixture.mountPath, ["log", "--format=%s", fixture.branch]);
			expect(log).toContain("local committed edit");
			expect(
				readFileSync(
					path.join(fixture.mountPath, "data/things/thing-2.yaml"),
					"utf8",
				),
			).toContain("draft");
		} finally {
			rmSync(fixture.root, { recursive: true, force: true });
		}
	});
});
