import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    globals: false,
    // The heaviest files (test/supervisor/loop.test.ts, test/cli/status.test.ts,
    // test/acceptance/*) spawn real subprocesses and drive git in temp worktrees; individually
    // they take 8-15s. The suite spends ~400s of test time against a ~180s wall, so under
    // normal contention those legitimately cross a 30s budget, which made the full suite
    // intermittently red while every file passed in isolation. 60s absorbs the contention
    // without masking a genuine hang: the supervisor bounds its own runaway independently via
    // MAX_LOOP_ITERATIONS and the per-invocation wall budget, so a truly stuck loop still fails
    // fast on its own terms rather than by tripping this timeout.
    testTimeout: 60000,
    hookTimeout: 60000,
    pool: 'forks',
    poolOptions: {
      forks: {
        // Phase 5 grew the suite from 66 to 70 files, several of them CPU-heavy
        // (test/supervisor/loop.test.ts, test/acceptance/*, test/cli/status.test.ts). Left
        // unbounded, `forks` spins up one fork per logical CPU and runs that many files
        // concurrently, which lets those files compete for the same cores and intermittently
        // pushes an individual test past `testTimeout` even though its own workload has not
        // grown. Bounding concurrency (rather than raising the timeout, which would also mask
        // a genuine hang) keeps each running file's share of CPU stable regardless of how many
        // more files Groups E-G add. `minForks` must be set alongside `maxForks`: Vitest
        // otherwise defaults `minForks` to the logical CPU count, which conflicts with a lower
        // `maxForks` and fails to start.
        minForks: 4,
        maxForks: 4,
      },
    },
  },
});
