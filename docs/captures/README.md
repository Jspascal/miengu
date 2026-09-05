# Raw spike captures

Verbatim stdout from the real binaries, kept so fixtures can be rewritten **from reality
rather than from a prose summary** (`Phase 2 delta` §0/S2: "Update the fixture from
reality, not the other way round"). Analysis lives in `../002-executor-findings.md`.

| File | Command | Exit |
|---|---|---|
| `s2-claude-stream-json.ndjson` | `claude -p --output-format stream-json --verbose --permission-mode acceptEdits --session-id <uuid> --model sonnet`, prompt on stdin | 0 |
| `s5-codex-success.jsonl` | `codex exec --json --sandbox read-only --ephemeral --skip-git-repo-check -`, prompt on stdin | 0 |
| `s5-codex-failure.jsonl` | same, plus `-m no-such-model-xyz` | 1 |

`claude` 2.1.260 · `codex-cli` 0.149.1 · captured 2026-09-04 · darwin arm64.

Both codex runs wrote **nothing to stderr**, including the failure. The claude run also
wrote nothing to stderr. Session ids and thread ids in these files are spent and inert.
