import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import YAML from "yaml";

/**
 * Deterministic YAML serialization contract shared by canonical data writes
 * and generated read models: stable key sort, indent 2, no line folding,
 * LF newline, UTF-8, trailing newline.
 */
export function toStableYaml(value: unknown): string {
	const text = YAML.stringify(value, {
		indent: 2,
		lineWidth: 0,
		sortMapEntries: true,
		aliasDuplicateObjects: false,
	});
	return text.endsWith("\n") ? text : `${text}\n`;
}

export function parseYaml(text: string): unknown {
	return YAML.parse(text);
}

export function readYamlFile(filePath: string): unknown {
	return parseYaml(readFileSync(filePath, "utf8"));
}

/**
 * Atomic file write: write to a sibling temp file, then rename over the
 * target so concurrent readers never observe a half-written document.
 */
export function writeFileAtomic(filePath: string, content: string): void {
	mkdirSync(path.dirname(filePath), { recursive: true });
	const tempPath = `${filePath}.${process.pid}.tmp`;
	writeFileSync(tempPath, content, "utf8");
	renameSync(tempPath, filePath);
}

export function writeYamlFileAtomic(filePath: string, value: unknown): void {
	writeFileAtomic(filePath, toStableYaml(value));
}

/** Stable JSON serialization (sorted keys, indent 2, LF, trailing newline). */
export function toStableJson(value: unknown): string {
	const sorted = JSON.stringify(
		value,
		(_key, raw) => {
			if (raw && typeof raw === "object" && !Array.isArray(raw)) {
				const out: Record<string, unknown> = {};
				for (const key of Object.keys(raw as Record<string, unknown>).sort()) {
					out[key] = (raw as Record<string, unknown>)[key];
				}
				return out;
			}
			return raw;
		},
		2,
	);
	return `${sorted}\n`;
}
