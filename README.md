# Pi Lint Feedback

A [Pi](https://pi.dev) extension that gives the agent deterministic lint feedback as it
edits. After every successful `write`/`edit`, it runs the language's linter on the touched
file and appends any diagnostics to the tool result — so the model sees issues immediately
and self-corrects instead of needing a separate review pass.

Ships oxlint bundled for JS/TS. Other languages no-op unless their linter is installed
(currently `ruff` for Python). Adding a language is one entry in `LINTERS`.

## Install

```bash
pi install git:github.com/<you>/pi-lint-feedback@v1
```

## How it works

- Hooks `tool_result` for successful `write` and `edit` calls.
- Dispatches per file extension via `LINTERS`.
- Uses the project's own linter when available, else the bundled oxlint.
- Lint infrastructure failures (missing binary, timeout) never block the agent — they no-op.
- Output is bounded to Pi's standard truncation policy.
- Byte-identical findings on a file are injected only once (deduped) to avoid re-reading the same text.

## Security

This is an extension: it runs the linter binary against files you're editing, on your
machine. Review the source before installing.

## License

MIT.
