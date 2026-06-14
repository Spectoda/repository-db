import { spawnSync } from "node:child_process";
import { CredentialsError } from "./types.ts";

/**
 * Credential preflight for private data repositories.
 *
 * First-phase policy (DEV-6353): the GitHub CLI credential store is the
 * default mechanism. repository-db never stores tokens, SSH keys or webhook
 * secrets in the code or data repository — it only verifies that an external
 * credential mechanism is present before any working-tree mutation.
 *
 * Non-interactive environments (CI, hosted Workspace Host, client cutover)
 * must configure an approved non-interactive provider instead: a GitHub App
 * installation, a deploy key via ssh-agent, or a preconfigured Git credential
 * helper. When none is detected the publish fails here, before any change.
 */

export interface CredentialCheck {
	ok: boolean;
	mechanism: "gh" | "ssh-agent" | "credential-helper" | "local-remote" | "none";
	detail: string;
}

function isGithubRemote(remote: string): boolean {
	return /github\.com/.test(remote);
}

function isLocalRemote(remote: string): boolean {
	return remote.startsWith("/") || remote.startsWith("file://") || remote.startsWith(".");
}

function ghBin(): string {
	return process.env.REPOSITORY_DB_GH_BIN || "gh";
}

function tryRun(cmd: string, args: string[]): { status: number; out: string } {
	// env is passed explicitly: Bun's spawnSync does not propagate runtime
	// process.env mutations to the child by default.
	const result = spawnSync(cmd, args, { encoding: "utf8", env: { ...process.env } });
	if (result.error) return { status: 127, out: result.error.message };
	return {
		status: result.status ?? 1,
		out: `${result.stdout ?? ""}${result.stderr ?? ""}`,
	};
}

function credentialFillInput(remote: string): string | null {
	try {
		const url = new URL(remote);
		if (url.protocol !== "https:" && url.protocol !== "http:") return null;
		const credentialPath = url.pathname.replace(/^\//, "");
		return `protocol=${url.protocol.slice(0, -1)}\nhost=${url.host}\npath=${credentialPath}\n\n`;
	} catch {
		return null;
	}
}

function checkCredentialHelper(remote: string, helperDetail: string): CredentialCheck {
	const input = credentialFillInput(remote);
	if (!input) {
		return {
			ok: false,
			mechanism: "none",
			detail: `git credential.helper is configured (${helperDetail}) but remote is not an HTTP(S) URL repository-db can preflight`,
		};
	}
	const result = spawnSync("git", ["credential", "fill"], {
		encoding: "utf8",
		input,
		env: {
			...process.env,
			GIT_TERMINAL_PROMPT: "0",
			GCM_INTERACTIVE: "Never",
		},
	});
	const stdout = result.stdout ?? "";
	if ((result.status ?? 1) === 0 && /^username=.+$/m.test(stdout) && /^password=.+$/m.test(stdout)) {
		return {
			ok: true,
			mechanism: "credential-helper",
			detail: `git credential.helper = ${helperDetail}; credential fill returned a non-interactive credential`,
		};
	}
	return {
		ok: false,
		mechanism: "none",
		detail: `git credential.helper is configured (${helperDetail}) but did not return a non-interactive credential for this remote`,
	};
}

export function checkCredentials(remote: string): CredentialCheck {
	if (isLocalRemote(remote)) {
		return {
			ok: true,
			mechanism: "local-remote",
			detail: "remote is a local path; no credentials required",
		};
	}
	if (!isGithubRemote(remote)) {
		// Non-GitHub remotes rely on the ambient git credential setup.
		const helper = tryRun("git", ["config", "--get", "credential.helper"]);
		if (helper.status === 0 && helper.out.trim()) {
			return {
				ok: true,
				mechanism: "credential-helper",
				detail: `git credential.helper = ${helper.out.trim()}`,
			};
		}
		return {
			ok: false,
			mechanism: "none",
			detail:
				"remote is not GitHub and no git credential.helper is configured; configure an approved credential mechanism first",
		};
	}

	const gh = tryRun(ghBin(), ["auth", "status"]);
	if (gh.status === 0) {
		return { ok: true, mechanism: "gh", detail: "gh auth status: authenticated" };
	}

	// Approved non-interactive fallbacks for hosted/client environments.
	if (remote.startsWith("git@") || remote.startsWith("ssh://")) {
		const ssh = tryRun("ssh-add", ["-l"]);
		if (ssh.status === 0 && ssh.out.trim() && !/no identities/i.test(ssh.out)) {
			return {
				ok: true,
				mechanism: "ssh-agent",
				detail: "ssh-agent holds at least one identity",
			};
		}
	}
	const helper = tryRun("git", ["config", "--get", "credential.helper"]);
	if (helper.status === 0 && helper.out.trim()) {
		return checkCredentialHelper(remote, helper.out.trim());
	}

	return {
		ok: false,
		mechanism: "none",
		detail:
			gh.status === 127
				? "GitHub CLI (gh) is not installed and no non-interactive credential provider was detected"
				: "GitHub CLI is installed but not authenticated (gh auth login), and no non-interactive credential provider was detected",
	};
}

/** Throw a {@link CredentialsError} before any working-tree mutation. */
export function assertCredentials(remote: string): CredentialCheck {
	const check = checkCredentials(remote);
	if (!check.ok) {
		throw new CredentialsError(
			`credential preflight failed for remote ${remote}: ${check.detail}. ` +
				"repository-db never stores tokens in the repo; authenticate gh (local default) " +
				"or configure an approved non-interactive provider (GitHub App, deploy key via ssh-agent, git credential helper).",
		);
	}
	return check;
}
