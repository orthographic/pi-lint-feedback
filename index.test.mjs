import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

async function writeOxlint(dir, output) {
	const packageDir = join(dir, "node_modules", "oxlint");
	await mkdir(join(packageDir, "bin"), { recursive: true });
	await writeFile(
		join(packageDir, "package.json"),
		'{"name":"oxlint","type":"module","exports":{"./package.json":"./package.json"}}',
	);
	await writeFile(
		join(packageDir, "bin", "oxlint"),
		`if (process.argv.at(-1).includes("@")) process.exit(2);\nprocess.stdout.write(${JSON.stringify(output)});\n`,
	);
}

async function loadExtension(dir) {
	const runtime = join(dir, "pi-runtime.mjs");
	await writeFile(
		runtime,
		`export const DEFAULT_MAX_BYTES = 50 * 1024;
export const DEFAULT_MAX_LINES = 2000;
export const formatSize = bytes => \`${"${bytes}"}B\`;
export function truncateHead(value, { maxBytes, maxLines }) {
	const lines = value.split("\\n");
	let content = "";
	let outputLines = 0;
	for (const line of lines) {
		const next = outputLines ? \`${"${content}"}\\n${"${line}"}\` : line;
		if (outputLines === maxLines || Buffer.byteLength(next) > maxBytes) break;
		content = next;
		outputLines++;
	}
	return {
		content,
		truncated: outputLines < lines.length,
		outputLines,
		totalLines: lines.length,
		outputBytes: Buffer.byteLength(content),
		totalBytes: Buffer.byteLength(value),
	};
}`,
	);
	const source = (await readFile(join(here, "index.ts"), "utf8")).replaceAll(
		'"@earendil-works/pi-coding-agent"',
		JSON.stringify(pathToFileURL(runtime).href),
	);
	const extension = join(dir, "index.ts");
	await writeFile(extension, source);
	return (await import(pathToFileURL(extension).href)).default;
}

async function createFixture(projectOutput) {
	const root = await mkdtemp(join(tmpdir(), "pi-lint-test-"));
	const extensionDir = join(root, "extension");
	const cwd = join(root, "project");
	await mkdir(join(cwd, "src"), { recursive: true });
	await writeFile(join(cwd, "package.json"), "{}");
	await writeFile(join(cwd, "src", "example.ts"), "export {};\n");
	await writeOxlint(extensionDir, Array(3000).fill("bundled lint").join("\n"));
	if (projectOutput) await writeOxlint(cwd, projectOutput);

	let handler;
	const extension = await loadExtension(extensionDir);
	extension({ on(name, callback) { if (name === "tool_result") handler = callback; } });
	assert.ok(handler);
	return { root, cwd, handler };
}

test("lint feedback uses bundled Oxlint, prefers the project version, and stays bounded", async (t) => {
	const bundled = await createFixture();
	t.after(() => rm(bundled.root, { recursive: true, force: true }));

	const fallbackResult = await bundled.handler(
		{ toolName: "write", isError: false, input: { path: "@src/example.ts" }, content: [] },
		{ cwd: bundled.cwd },
	);
	const fallbackFeedback = fallbackResult.content.at(-1).text;
	assert.match(fallbackFeedback, /^oxlint findings in src\/example\.ts/);
	assert.match(fallbackFeedback, /Lint output truncated/);
	assert.ok(Buffer.byteLength(fallbackFeedback) < 52 * 1024);
	assert.equal(
		await bundled.handler(
			{ toolName: "edit", isError: true, input: { path: "@src/example.ts" }, content: [] },
			{ cwd: bundled.cwd },
		),
		undefined,
	);

	const project = await createFixture("project lint");
	t.after(() => rm(project.root, { recursive: true, force: true }));
	const projectResult = await project.handler(
		{ toolName: "write", isError: false, input: { path: "src/example.ts" }, content: [] },
		{ cwd: project.cwd },
	);
	assert.match(projectResult.content.at(-1).text, /project lint/);
});
