export const CONFIG_TEMPLATE = `target:
  repo: ../some-project
  mode: worktree            # worktree | clone   (clone declared, not implemented)
  baseRef: HEAD

oracles:                    # Phase 3 consumes; null = not declared
  build:     null
  test:      null
  lint:      null
  typecheck: null

brownfield:
  enabled: true
  maxTreeEntries: 5000
  maxFilesPerScope: 200
  maxDependencyDepth: 2
  maxFileBytes: 262144
  maxTestExcerptBytes: 8192
  maxGitCommits: 200
  maxFilesPerCommit: 50
  falsification:
    maxPredicatesPerScope: 8
    maxWallSeconds: 30
    maxOutputBytes: 65536
    commands: {}
    sandbox: null

# 1. Quota pools. Every executor instance must name one of these keys.
accounts:
  claude-personal:
    maxTurnsPerItem:        null      # accumulated ledger ceiling for this pool; null = unlimited
    maxWallSecondsPerItem:  null
    maxUsdPerItem:          null
  codex-personal:
    maxTurnsPerItem:        null
    maxWallSecondsPerItem:  null
    maxUsdPerItem:          null

# 2. Named executor instances. Model + effort live here: they are provider terms.
executors:
  cc-sonnet:  { type: claude-code, model: sonnet,        effort: medium, account: claude-personal }
  cc-opus:    { type: claude-code, model: opus,          effort: high,   account: claude-personal }
  cx-high:    { type: codex,       model: gpt-5.2-codex, effort: high,   account: codex-personal }
  cx-low:     { type: codex,       model: gpt-5.2-codex, effort: low,    account: codex-personal }

# 3. Declared cross-vendor ranking. Explicit, because no honest inferred rank exists.
tiers:
  cc-sonnet: 2
  cc-opus:   3
  cx-low:    1
  cx-high:   3

# 4. Roles reference an instance by name. Turns + context live here: role terms.
roles:
  analyst:    { executor: cx-high,   maxTurns: 8,  contextBudgetTokens: 40000 }
  architect:  { executor: cx-high,   maxTurns: 12, contextBudgetTokens: 90000 }
  planner:    { executor: cx-low,    maxTurns: 6,  contextBudgetTokens: 50000 }
  testAuthor: { executor: cx-high,   maxTurns: 15, contextBudgetTokens: 40000 }
  coder:      { executor: cc-sonnet, maxTurns: 60, contextBudgetTokens: 60000 }
  reviewer:   { executor: cc-opus,   maxTurns: 10, contextBudgetTokens: 50000 }

budget:
  maxWallSecondsPerInvocation: 1800   # miengu-enforced kill timer; roles carry no wall knob
  maxUsdPerRun:                null

limits:
  kOracle: 3
  kTest: 3
  kReview: 2
  maxAttemptsPerStage: 3

planner:
  maxPathsPerTask: 8        # §15.3 mechanical check; no literal in code

# 5. Gates (§8). Blocking is decided by blast radius, never by agent confidence.
checkpoints:
  defaultOwner: operator
  reversible:   { slaSeconds: 86400, default: accept }   # never blocks; auto-approves after the SLA
  irreversible: { slaSeconds: null,  default: null }     # always blocks: no timeout, no default
  blastRadius:
    # miengu never invents a pattern: an undeclared surface is an ungated surface.
    # Glob subset: \`**\` matches any run of segments, \`*\` matches within one segment.
    migrationOrSchemaPaths:  ["**/migrations/**", "**/*.sql", "**/schema.prisma"]
    sensitivePaths:          ["**/auth/**", "**/permissions/**", "**/payment*/**", "**/billing/**"]
    externalContractPaths:   ["**/openapi*.y*ml", "**/*.proto", "**/public-api/**"]
    protectedPaths:          ["**/index.ts", "**/*.d.ts"]
    dependencyManifestPaths: ["package.json", "**/package.json", "requirements.txt", "Cargo.toml", "go.mod"]
    maxDiffLines:    400
    maxFilesTouched: 20
    severity:
      migration-or-schema:  blocking
      sensitive-surface:    blocking
      external-contract:    blocking
      protected-surface:    blocking
      dependency-manifest:  blocking
      diff-size:            advisory

assumptions:
  maxStackDepth: 2          # an assumption resting on two unresolved assumptions escalates

wiki:
  language: en
locale: fr
store:
  dir: .miengu
  snapshotEvery: 200
log:
  level: info
`;

export interface RenderConfigTemplateOptions {
  readonly targetRepo: string;
}

export function renderConfigTemplate(options: RenderConfigTemplateOptions): string {
  return CONFIG_TEMPLATE.replace('../some-project', options.targetRepo);
}
