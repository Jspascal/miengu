export const CONFIG_TEMPLATE = `target:
  repo: ../some-project
  mode: worktree            # worktree | clone   (clone declared, not implemented)
  baseRef: HEAD

oracles:                    # Phase 3 consumes; null = not declared
  build:     null
  test:      null
  lint:      null
  typecheck: null

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
