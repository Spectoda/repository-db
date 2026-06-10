import { randomBytes } from "node:crypto";
import { RepositoryDbError, type CommitTrailers } from "./types.ts";

/**
 * Deterministic commit-message contract for repository-db publishes.
 *
 * Required Git trailers (key: value, one per line, trailing block):
 *   Repository-Db-App, Repository-Db-Data-Repo, Repository-Db-Branch,
 *   Repository-Db-Schema-Version, Repository-Db-Actor, Repository-Db-Machine,
 *   Repository-Db-Source, Repository-Db-Change-Id
 * Optional:
 *   Repository-Db-Entities (comma-separated entity ids)
 *
 * The default subject line is generated from the validated change summary —
 * no AI involvement. An optional AI-improved human summary may replace the
 * subject only after explicit opt-in, and must never alter the trailers.
 */

export const REQUIRED_TRAILER_KEYS = [
	"Repository-Db-App",
	"Repository-Db-Data-Repo",
	"Repository-Db-Branch",
	"Repository-Db-Schema-Version",
	"Repository-Db-Actor",
	"Repository-Db-Machine",
	"Repository-Db-Source",
	"Repository-Db-Change-Id",
] as const;

export const OPTIONAL_TRAILER_KEYS = ["Repository-Db-Entities"] as const;

const TRAILER_LINE_RE = /^([A-Za-z0-9-]+):[ ](.+)$/;
const CHANGE_ID_RE = /^[a-z0-9]{8}-[a-f0-9]{12}$/;

export function newChangeId(): string {
	const time = Date.now().toString(36).padStart(8, "0").slice(-8);
	return `${time}-${randomBytes(6).toString("hex")}`;
}

function sanitizeTrailerValue(value: string, key: string): string {
	const collapsed = value.replace(/\s+/g, " ").trim();
	if (!collapsed) {
		throw new RepositoryDbError(
			"invalid_trailer",
			`commit trailer ${key} must not be empty`,
		);
	}
	return collapsed;
}

export function buildCommitMessage(
	subject: string,
	trailers: CommitTrailers,
	body?: string,
): string {
	const subjectLine = subject.replace(/\s+/g, " ").trim();
	if (!subjectLine) {
		throw new RepositoryDbError("invalid_commit", "commit subject must not be empty");
	}
	if (!CHANGE_ID_RE.test(trailers.changeId)) {
		throw new RepositoryDbError(
			"invalid_trailer",
			`Repository-Db-Change-Id has unexpected format: ${trailers.changeId}`,
		);
	}
	const lines = [
		`Repository-Db-App: ${sanitizeTrailerValue(trailers.app, "Repository-Db-App")}`,
		`Repository-Db-Data-Repo: ${sanitizeTrailerValue(trailers.dataRepo, "Repository-Db-Data-Repo")}`,
		`Repository-Db-Branch: ${sanitizeTrailerValue(trailers.branch, "Repository-Db-Branch")}`,
		`Repository-Db-Schema-Version: ${sanitizeTrailerValue(trailers.schemaVersion, "Repository-Db-Schema-Version")}`,
		`Repository-Db-Actor: ${sanitizeTrailerValue(trailers.actor, "Repository-Db-Actor")}`,
		`Repository-Db-Machine: ${sanitizeTrailerValue(trailers.machine, "Repository-Db-Machine")}`,
		`Repository-Db-Source: ${sanitizeTrailerValue(trailers.source, "Repository-Db-Source")}`,
		`Repository-Db-Change-Id: ${trailers.changeId}`,
	];
	if (trailers.entities && trailers.entities.length > 0) {
		const value = trailers.entities
			.map((entity) => sanitizeTrailerValue(entity, "Repository-Db-Entities"))
			.join(", ");
		lines.push(`Repository-Db-Entities: ${value}`);
	}
	const bodyBlock = body?.trim() ? `${body.trim()}\n\n` : "";
	return `${subjectLine}\n\n${bodyBlock}${lines.join("\n")}\n`;
}

export interface ParsedCommitMessage {
	subject: string;
	trailers: CommitTrailers;
}

/**
 * Parse and validate a publish commit message. Throws when any required
 * trailer is missing, duplicated or malformed — this parser is the formal
 * validator referenced by the commit contract.
 */
export function parseCommitMessage(message: string): ParsedCommitMessage {
	const lines = message.replace(/\r\n/g, "\n").trimEnd().split("\n");
	const subject = (lines[0] ?? "").trim();
	if (!subject) {
		throw new RepositoryDbError("invalid_commit", "commit message has no subject");
	}

	const found = new Map<string, string>();
	for (const line of lines.slice(1)) {
		const match = line.match(TRAILER_LINE_RE);
		if (!match) continue;
		const key = match[1] ?? "";
		if (!key.startsWith("Repository-Db-")) continue;
		if (found.has(key)) {
			throw new RepositoryDbError(
				"invalid_trailer",
				`duplicate commit trailer: ${key}`,
			);
		}
		found.set(key, (match[2] ?? "").trim());
	}

	for (const key of REQUIRED_TRAILER_KEYS) {
		if (!found.get(key)) {
			throw new RepositoryDbError(
				"invalid_trailer",
				`missing required commit trailer: ${key}`,
			);
		}
	}
	const changeId = found.get("Repository-Db-Change-Id") ?? "";
	if (!CHANGE_ID_RE.test(changeId)) {
		throw new RepositoryDbError(
			"invalid_trailer",
			`Repository-Db-Change-Id has unexpected format: ${changeId}`,
		);
	}

	const entitiesRaw = found.get("Repository-Db-Entities");
	return {
		subject,
		trailers: {
			app: found.get("Repository-Db-App") ?? "",
			dataRepo: found.get("Repository-Db-Data-Repo") ?? "",
			branch: found.get("Repository-Db-Branch") ?? "",
			schemaVersion: found.get("Repository-Db-Schema-Version") ?? "",
			actor: found.get("Repository-Db-Actor") ?? "",
			machine: found.get("Repository-Db-Machine") ?? "",
			source: found.get("Repository-Db-Source") ?? "",
			changeId,
			entities: entitiesRaw
				? entitiesRaw.split(",").map((value) => value.trim()).filter(Boolean)
				: undefined,
		},
	};
}
