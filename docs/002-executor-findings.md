# 002 — Executor findings

Machine-verified answers to the `Phase 2 delta` §0 spike. Everything recorded here is
**`T1`** — observed by running the real binaries on this machine — except rows explicitly
marked `PENDING`, which are `T3` until someone runs them.

- Date of observation: **2026-09-04** (S1, S2, S5)
- Host: darwin 25.2.0 (arm64), Node 20+
- `claude` — **2.1.260 (Claude Code)**, `/Users/josephnomo/.local/bin/claude`
- `codex` — **codex-cli 0.149.1**, `/opt/homebrew/bin/codex`

Findings are version-pinned. A vendor upgrade invalidates every row; re-run the spike
rather than assuming it still holds.

---

## S1 — non-TTY subprocess: **does not hang**

`anthropics/claude-code#9026` **does not reproduce** on 2.1.260.

Spawned with no terminal attached, stdin closed (`< /dev/null`), `stdio: ['ignore','pipe','pipe']`:

| Observable | Value |
|---|---|
| Wall time | 14.2 s |
| `error` | `null` |
| `killed` | `null` |
| Exit code | 0 |
| stdout | one complete JSON object |
| stderr | empty |

Repeated with the exact shape `src/executors/claudeCode.ts` uses — `stdio:
['pipe','pipe','pipe']`, `detached: true`, prompt written to stdin then `end()` — also
completed cleanly (exit 0, empty stderr).

**Consequence: no `node-pty` spawn strategy is needed.** The delta's contingency is not
exercised. Do not add a pty dependency on speculation; if a future version regresses, this
row is the thing to re-run first.

---

## S2 — real JSON shape vs. the fixture

Captured a full `--output-format stream-json --verbose` run with the argv
`buildArgv()` actually produces. **The fixture is wrong in six ways, all of which the
Phase 2 work must correct — updating the fixture from reality, never the reverse.**

### Real event sequence (in order)

```
system / hook_started
system / hook_response
system / init
assistant
rate_limit_event
result / success
```

`test/fixtures/fake-claude.mjs` emits only `assistant` and `result`.

### Diff, field by field

| # | Real binary | `fake-claude.mjs` | Consequence |
|---|---|---|---|
| 1 | Emits three `system` lines (`hook_started`, `hook_response`, `init`) **before** the first `assistant` | emits none | Fixture never exercises the parser's leading-noise path |
| 2 | Emits **`rate_limit_event`** with a structured `rate_limit_info` payload | no such event | See S3 — this is the single most important finding in this document |
| 3 | `assistant` lines carry `{message, parent_tool_use_id, request_id, session_id, timestamp, type, uuid}` | bare `{type:'assistant'}` | Turn counting still works (it keys on `type` only), but by luck |
| 4 | `result` has **24** keys, incl. `api_error_status`, `terminal_reason`, `stop_reason`, `permission_denials`, `modelUsage`, `session_id`, `uuid` | 6 keys | `api_error_status` is a second machine-readable failure channel we do not read |
| 5 | `usage` has 11 keys, incl. `cache_creation_input_tokens`, `cache_read_input_tokens`, `service_tier`, `iterations` | 2 keys | **`mapTelemetry` under-reports input tokens by orders of magnitude** — see below |
| 6 | `system/init` advertises `capabilities`, `tools`, `model`, `permissionMode`, `claude_code_version` | absent | A free, machine-readable capability probe we are not using |

### Defect surfaced by row 5 — token under-reporting

Observed on a one-word prompt:

```
input_tokens:                 2
cache_creation_input_tokens:  13336
cache_read_input_tokens:      8144
output_tokens:                4
```

`mapTelemetry()` reads `usage.input_tokens` alone and reports **2**. True input was
**21 482**. Any `contextBudgetTokens` accounting built on this figure is meaningless.
Cache tokens are the overwhelming majority of real input and must be summed.

### Defect surfaced by row 2 — final-result selection is fragile

`ClaudeCodeExecutor` picks `finalResultRaw` by parsing the whole stdout (which fails for
NDJSON) and falling back to **`lastParsedLine`**. That happened to be the `result` line
here. It is not guaranteed to be: `rate_limit_event` now exists and carries no ordering
promise. **Select the line with `type === 'result'` explicitly.**

---

## S3 — rate-limit behaviour: **PENDING** (partially answered ahead of schedule)

Deliberately exhausting a window was not run — it costs the operator their working quota
and is theirs to schedule. **But S2 answered most of the question for free.**

### The CLI emits a machine-readable quota figure

Verbatim, from the live stream:

```json
{"type":"rate_limit_event",
 "rate_limit_info":{
   "status":"allowed_warning",
   "resetsAt":1788545400,
   "rateLimitType":"five_hour",
   "utilization":0.91,
   "isUsingOverage":false,
   "surpassedThreshold":0.9,
   "unifiedWindows":{
     "five_hour":{"utilization":0.91,"resetsAt":1788545400},
     "seven_day":{"utilization":0.1,"resetsAt":1789012800}}},
 "uuid":"…","session_id":"…"}
```

**This answers `BUILD_PROMPT.md` §14 open question 2 — "Is there a machine-readable quota
figure from the CLI, or is it operator-recorded?" — with: yes, there is.** As of 2.1.260
it carries utilization, per-window reset timestamps, an overage flag, and a `status` enum.

Consequences for the Phase 2 design:

- `quota_exhausted` detection for Claude Code should key on `rate_limit_event.rate_limit_info.status`,
  **not** on the `QUOTA_SIGNATURES` regexes in `claudeCode.ts`. Keep the regexes as a
  second-line fallback for versions that do not emit the event; do not let them be primary.
- `resetsAt` gives park/resume a real wake time instead of a poll. §17.2's per-account
  budget can record an actual reset instant rather than an unknown.
- `utilization` enables parking *before* a stage fails, which is strictly better than
  discovering exhaustion by crashing into it.

### Still `PENDING`, and still required

| Question | Status |
|---|---|
| The `status` value at genuine exhaustion (`allowed_warning` is the only value observed) | **PENDING** |
| Exit code on exhaustion — undocumented, `anthropics/claude-code#35540` | **PENDING** |
| Whether the error lands on stdout or stderr | **PENDING** |
| Whether `api_error_status` is populated on exhaustion | **PENDING** |

Until these land, the delta's stated fallback governs: **detect quota exhaustion by
scanning both streams, never by exit status alone.**

> Operator note, observed 2026-09-04: the `five_hour` window was at **0.91 utilization**
> at capture time, resetting `2026-09-04T18:10:00Z`. `seven_day` was at 0.10, resetting
> `2026-09-10T04:00:00Z`. Running S3 from near 0.91 is cheap; running it from 0.10 is not.

---

## S4 — token lifetime: **PENDING**

Requires running S1, waiting 25 hours, and running it again
(`anthropics/claude-code#42904`). Not runnable inside a single session.

If confirmed, unattended multi-day operation needs `claude setup-token` or an API-key
executor, **and that changes Phase 5.** Phase 2 must not assume a token outlives one run.

---

## Codex flags — confirmed, not assumed

§16.4 asked that the reasoning-effort flag be confirmed with `codex --help` rather than
guessed. It was. **The answer is that the flag does not exist.**

| Capability | `codex exec` (0.149.1) | `claude` (2.1.260) |
|---|---|---|
| Native structured output | **`--output-schema <FILE>`** ✅ | **absent** ❌ |
| Sandbox modes | `--sandbox read-only \| workspace-write \| danger-full-access` ✅ | own permission model (`--permission-mode`) |
| Resumable sessions | `codex exec resume <id>`, `fork` ✅ | `--session-id <uuid>` ✅ |
| Model selection | `-m, --model` ✅ | `--model` (alias: `fable`, `opus`, `sonnet`) ✅ |
| Reasoning effort | **no flag** — must use `-c model_reasoning_effort=<level>` | `--effort low\|medium\|high\|xhigh\|max` ✅ |
| Event stream | `--json` (JSONL) ✅ | `--output-format stream-json --verbose` ✅ |
| Spend cap | — | `--max-budget-usd` (only with `--print`) ✅ |
| Final message to file | `-o, --output-last-message <FILE>` ✅ | — |

Also present on `codex exec` and useful for hermetic tests: `--ephemeral`,
`--skip-git-repo-check`, `--ignore-user-config`, `--add-dir`, `-C/--cd`.

### Consequences for §9.1 / §9.1b

- `codexCli` → `nativeStructuredOutput: true`. `claudeCodeCli` → **`nativeStructuredOutput: false`**,
  verified by absence, not assumed. §9.1b's two-path schema enforcement is genuinely
  required; it is not a hypothetical.
- The codex adapter must pass effort as `-c model_reasoning_effort=<level>`, a TOML config
  override, **not** as a dedicated flag. Building `--reasoning-effort` would have failed at
  run time against a real binary.
- §17.5's `SandboxIntent` maps 1:1 onto `codex --sandbox` and requires translation for
  Claude Code's permission model — exactly the asymmetry §17.5 predicted.

---

## S5 — codex `--json` event vocabulary: **verified**

Added because `Phase 2 delta` §17.3 asserts *"Codex surfaces `turn.failed` / `error` events
in its JSONL stream; map from there"* without a spike row backing it. That claim would
otherwise have been encoded into the adapter as if it were fact. **It is now `T1`.**

Two runs against `codex exec --json --ephemeral --skip-git-repo-check`: one trivial
success, one deliberate failure (`-m no-such-model-xyz`, which fails without spending a
model call).

### Success path — exact sequence

```json
{"type":"thread.started","thread_id":"01a06e8b-…"}
{"type":"turn.started"}
{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"ok"}}
{"type":"turn.completed","usage":{"input_tokens":18383,"cached_input_tokens":6144,
  "cache_write_input_tokens":0,"output_tokens":5,"reasoning_output_tokens":0}}
```

Exit 0, **stderr empty**.

| Need | Field |
|---|---|
| Session id for `codex exec resume <id>` | `thread.started.thread_id` |
| Turn counting (the turn cap) | count `turn.started` |
| Final artifact text (where `--output-schema` output lands) | `item.completed.item.text` where `item.type === "agent_message"` |
| Telemetry | `turn.completed.usage` |

**The codex turn cap is buildable and is not decorative.** `observedTurns` has a real
source; it does not need to degrade to `null`.

### Failure path — exact sequence

```json
{"type":"thread.started","thread_id":"01a06e8c-…"}
{"type":"item.completed","item":{"id":"item_0","type":"error","message":"Model metadata … not found. Defaulting to fallback metadata; …"}}
{"type":"turn.started"}
{"type":"error","message":"{\"type\":\"error\",\"status\":400,\"error\":{\"type\":\"invalid_request_error\",\"message\":\"…\"}}"}
{"type":"turn.failed","error":{"message":"{\"type\":\"error\",\"status\":400,…}"}}
```

Exit **1**.

Four findings that change the adapter:

1. **`turn.failed` and `error` both exist** — the delta's §17.3 instruction is correct.
2. **Everything goes to stdout; stderr is empty even on failure.** A codex adapter that
   scans stderr for failure signatures would find nothing. This is the opposite of the
   Claude Code assumption baked into `RawRunRecord.stderrTail`.
3. **`item.completed` with `item.type === "error"` is NOT fatal** — it appeared before a
   `turn.started` that then proceeded. Only `error` and `turn.failed` are terminal.
   Treating any error item as fatal would abort recoverable runs.
4. **The `message` field is a JSON-encoded string**, carrying `status` (HTTP, `400` here)
   and `error.type` (`invalid_request_error`). Quota mapping therefore has a structured
   path: parse `message`, read `.status` and `.error.type`. The delta's `rate_limit_error`
   fallback is what `.error.type` would carry at 429.

### Telemetry convention differs from Claude Code — do not share the fix

Codex `input_tokens: 18383` with `cached_input_tokens: 6144` — the cached figure is a
**subset** of the total. Claude Code's `input_tokens: 2` with
`cache_read_input_tokens: 8144` **excludes** cache. The S2 fix (summing cache into input)
is correct for Claude Code and would **double-count** on codex. Two adapters, two mappings.

### Still unverified

The `status` / `error.type` values at genuine **quota** exhaustion, as opposed to a 400.
Same gap as S3, on the other vendor. Same mitigation: match on `.error.type` containing
`rate_limit`, never on exit code alone.

---

## Summary — what changes in the code because of this

1. **No pty spawn strategy.** S1 clears it.
2. **Rewrite `fake-claude.mjs`** to emit the real six-line sequence, including
   `rate_limit_event` and the full `result` key set.
3. **Fix `mapTelemetry`** to include cache tokens in the input figure.
4. **Select the `result` line by `type`,** not by "last line that parsed".
5. **Primary quota detection becomes `rate_limit_event.rate_limit_info`;** the regexes
   demote to fallback.
6. **`ExecutorCapabilities.nativeStructuredOutput` is `false` for Claude Code and `true`
   for Codex** — verified, so the §9.1b split must be built.
7. **Codex effort ships as `-c model_reasoning_effort=`.**
8. Park/resume can carry a real `resetsAt`; consider recording it on `BudgetExhausted`.
9. **Codex turn counting is real** — count `turn.started`. Do not ship a degraded
   `observedTurns: null` path.
10. **Codex reports failures on stdout, not stderr.** `turn.failed` and `error` are
    terminal; an `item.completed` of `item.type === "error"` is not.
11. **Codex telemetry must NOT reuse the Claude Code cache-token fix** — codex's
    `input_tokens` already includes cached tokens; summing would double-count.
12. Codex session id for resume is `thread.started.thread_id`; the artifact text is
    `item.completed.item.text`.
