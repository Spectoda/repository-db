import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { RepositoryDbError } from "./types.ts";

export interface GitResult {
	status: number;
	stdout: string;
	stderr: string;
}

/**
 * Run git scoped to a repository root. Every engine git call goes through
 * here so the boundary guard can rely on `-C <repoRoot>` being present.
 */
export function runGit(repoRoot: string, args: string[]): GitResult {
	const result = spawnSync("git", ["-C", repoRoot, ...args], {
		encoding: "utf8",
		env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
	});
	if (result.error) {
		throw new RepositoryDbError(
			"git_unavailable",
			`git could not be executed: ${result.error.message}`,
		);
	}
	return {
		status: result.status ?? 1,
		stdout: result.stdout ?? "",
		stderr: result.stderr ?? "",
	};
}

export function runGitOrThrow(repoRoot: string, args: string[]): string {
	const result = runGit(repoRoot, args);
	if (result.status !== 0) {
		throw new RepositoryDbError(
			"git_failed",
			`git ${args.join(" ")} failed (${result.status}): ${result.stderr.trim() || result.stdout.trim()}`,
		);
	}
	return result.stdout;
}

export function gitToplevel(repoRoot: string): string | undefined {
	const result = runGit(repoRoot, ["rev-parse", "--show-toplevel"]);
	if (result.status !== 0) return undefined;
	return result.stdout.trim() || undefined;
}

export function gitCurrentBranch(repoRoot: string): string {
	return runGitOrThrow(repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"]).trim();
}

export function gitRemoteUrl(repoRoot: string, remote = "origin"): string | undefined {
	const result = runGit(repoRoot, ["remote", "get-url", remote]);
	if (result.status !== 0) return undefined;
	return result.stdout.trim() || undefined;
}

/**
 * Parse NUL-delimited `git status --porcelain -z` output into [xy, path]
 * pairs. The -z form is used everywhere so paths with tabs, quotes or
 * non-ASCII characters arrive verbatim instead of C-escaped — the generated
 * policy check and the conflict detector must never mis-read a path.
 */
function gitStatusEntries(repoRoot: string, extraArgs: string[]): Array<[string, string]> {
	const output = runGitOrThrow(repoRoot, [
		"status",
		"--porcelain=v1",
		"-z",
		...extraArgs,
	]);
	const tokens = output.split("\0").filter((token) => token.length > 0);
	const entries: Array<[string, string]> = [];
	for (let index = 0; index < tokens.length; index += 1) {
		const token = tokens[index] ?? "";
		if (token.length < 4) continue;
		const xy = token.slice(0, 2);
		const path = token.slice(3);
		entries.push([xy, path]);
		// Renames/copies emit the original path as the next NUL token.
		if (xy.includes("R") || xy.includes("C")) index += 1;
	}
	return entries;
}

/** Porcelain dirty paths relative to the repo root (staged, unstaged and untracked). */
export function gitDirtyPaths(repoRoot: string): string[] {
	return gitStatusEntries(repoRoot, ["--untracked-files=all"]).map(
		([, path]) => path,
	);
}

export interface AheadBehind {
	ahead: number;
	behind: number;
}

export function gitAheadBehind(repoRoot: string, branch: string): AheadBehind {
	const result = runGit(repoRoot, [
		"rev-list",
		"--left-right",
		"--count",
		`${branch}...origin/${branch}`,
	]);
	if (result.status !== 0) {
		// No upstream yet (fresh data repo before the first push).
		return { ahead: 0, behind: 0 };
	}
	const [ahead = "0", behind = "0"] = result.stdout.trim().split(/\s+/);
	return { ahead: Number(ahead) || 0, behind: Number(behind) || 0 };
}

/**
 * Paths with unresolved merge conflicts (porcelain XY containing U, or
 * AA/DD). Crucially this also catches the `pull --rebase --autostash` case
 * where git exits 0 but leaves the autostash applied with conflict markers.
 */
export function gitUnmergedPaths(repoRoot: string): string[] {
	return gitStatusEntries(repoRoot, [])
		.filter(([xy]) => xy.includes("U") || xy === "AA" || xy === "DD")
		.map(([, path]) => path);
}

/** True when a rebase or merge is in progress inside the repository. */
export function gitOperationInProgress(repoRoot: string): string | undefined {
	const gitDir = runGitOrThrow(repoRoot, ["rev-parse", "--absolute-git-dir"]).trim();
	if (existsSync(`${gitDir}/rebase-merge`)) return "rebase-merge";
	if (existsSync(`${gitDir}/rebase-apply`)) return "rebase-apply";
	if (existsSync(`${gitDir}/MERGE_HEAD`)) return "merge";
	return undefined;
}

export function gitFetch(repoRoot: string): void {
	runGitOrThrow(repoRoot, ["fetch", "--quiet", "origin"]);
}

export function gitHeadCommit(repoRoot: string): string | undefined {
	const result = runGit(repoRoot, ["rev-parse", "HEAD"]);
	if (result.status !== 0) return undefined;
	return result.stdout.trim();
}
