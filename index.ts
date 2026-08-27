/**
 * Lint extension — deterministic lint feedback for agent-driven edits.
 *
 * After every successful write/edit tool call, runs the language's linter on the touched
 * file and appends any diagnostics to the tool result, so the agent sees them
 * immediately and self-corrects without a separate review pass.
 *
 * No single linter covers all languages, so this dispatches per extension.
 * Oxlint is bundled for JS/TS; other languages no-op unless their linter is
 * installed. Adding a language is one entry in LINTERS.
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	truncateHead,
} from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const execFileP = promisify(execFile);
const extensionRequire = createRequire(import.meta.url);
const bundledOxlint = join(
	dirname(extensionRequire.resolve("oxlint/package.json")),
	"bin",
	"oxlint",
);
const TIMEOUT_MS = 10_000;

type Linter = { bin: string; args: string[]; clean?: RegExp };
type Command = { bin: string; args: string[] };

const LINTERS: Array<[RegExp, Linter]> = [
	[
		/\.(?:js|jsx|mjs|cjs|ts|tsx|mts|cts|vue|svelte|astro)$/,
		{ bin: "oxlint", args: ["--format", "unix"] },
	],
	// ruff: reads pyproject.toml/ruff.toml config automatically; prints a success banner when clean
	[/\.py$/, { bin: "ruff", args: ["check"], clean: /All checks passed!/ }],
];

const commandCache = new Map<string, Command>();
function findCommand(linter: Linter, cwd: string): Command {
	const key = linter.bin + "@" + cwd;
	const cached = commandCache.get(key);
	if (cached) return cached;

	if (linter.bin === "oxlint") {
		let cli = bundledOxlint;
		try {
			const projectRequire = createRequire(resolve(cwd, "package.json"));
			cli = join(dirname(projectRequire.resolve("oxlint/package.json")), "bin", "oxlint");
		} catch {}
		const command = { bin: process.execPath, args: [cli] };
		commandCache.set(key, command);
		return command;
	}

	const local = join(cwd, "node_modules", ".bin", linter.bin);
	const command = { bin: existsSync(local) ? local : linter.bin, args: [] };
	commandCache.set(key, command);
	return command;
}

/**
 * Findings = non-empty linter output. Lint infra failures (missing binary, timeout,
 * spawn error) never block the agent — they no-op.
 */
async function lint(
	command: Command,
	linter: Linter,
	file: string,
	cwd: string,
	signal?: AbortSignal,
): Promise<string | null> {
	try {
		const { stdout } = await execFileP(command.bin, [...command.args, ...linter.args, file], {
			cwd,
			timeout: TIMEOUT_MS,
			maxBuffer: 1024 * 1024,
			signal,
		});
		const out = stdout.trim();
		if (!out) return null;
		if (linter.clean && linter.clean.test(out)) return null;
		return out;
	} catch (err: unknown) {
		const { stdout, stderr } = err as { stdout?: unknown; stderr?: unknown };
		const out =
			(typeof stdout === "string" && stdout.trim()) ||
			(typeof stderr === "string" ? stderr.trim() : "");
		return out || null;
	}
}

function formatFindings(findings: string): string {
	const result = truncateHead(findings, {
		maxBytes: DEFAULT_MAX_BYTES,
		maxLines: DEFAULT_MAX_LINES,
	});
	if (!result.truncated) return result.content;
	return `${result.content}\n\n[Lint output truncated: ${result.outputLines} of ${result.totalLines} lines (${formatSize(result.outputBytes)} of ${formatSize(result.totalBytes)})]`;
}

export default function (pi: ExtensionAPI) {
	pi.on("tool_result", async (event, ctx) => {
		if (event.isError || (event.toolName !== "write" && event.toolName !== "edit")) return;
		const path = (event.input as { path?: string }).path?.replace(/^@/, "");
		if (!path) return;

		const match = LINTERS.find(([ext]) => ext.test(path));
		if (!match) return;
		const linter = match[1];
		const command = findCommand(linter, ctx.cwd);

		const findings = await lint(command, linter, resolve(ctx.cwd, path), ctx.cwd, ctx.signal);
		if (!findings) return undefined;

		return {
			content: [
				...(event.content ?? []),
				{
					type: "text",
					text: `${linter.bin} findings in ${path} (fix before continuing):\n${formatFindings(findings)}`,
				},
			],
		};
	});
}
