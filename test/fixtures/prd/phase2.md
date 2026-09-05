# Phase 2 acceptance PRD

Build a small feature: a function that greets a user by name and rejects an empty name.

This PRD exists only to give the Phase 2 acceptance gate (`test/acceptance/phase2.test.ts`)
a real file to hash and reference. It is never sent to a real vendor binary — every executor
in that test is configured against `test/fixtures/fake-claude.mjs` or
`test/fixtures/fake-codex.mjs`.
