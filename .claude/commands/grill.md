Run adversarial code review on the current diff using the `grill` MCP tool.

## Usage

```
/grill              # Review staged changes
/grill last-commit  # Review last commit
/grill main         # Review all changes vs main branch
```

## What It Does

Runs Sonnet as an adversarial reviewer on your git diff. Unlike `spot_check_diff` (which uses Haiku for quick pattern matching), `/grill` performs deeper analysis across 6 categories with actionable remediation for every finding.

## Verdicts

- **SHIP IT** — No blocking issues. Code is production-ready.
- **NEEDS WORK** — Advisory findings. Non-blocking but worth addressing.
- **BLOCK** — Critical/high issues that must be fixed before merging.

## Categories

1. **architecture** — Abstractions, coupling, patterns
2. **correctness** — Logic bugs, edge cases, race conditions
3. **security** — Injection, auth gaps, secrets, CSRF
4. **performance** — N+1 queries, memory leaks, unnecessary work
5. **maintainability** — Dead code, naming, complexity, duplication
6. **other** — Anything else

## When to Use

- Before creating a PR (use `main` scope)
- After completing a sprint's tasks
- When unsure if changes are ready to ship
- As a complement to code-reviewer agent (grill is faster, agent is more thorough)

## Cost

~$0.01-0.03 per review (Sonnet).

## Example

Run the grill tool with the scope from the argument (default: staged):

```
mcp__radl-ops__grill(scope: "$ARGUMENTS")
```

If BLOCK verdict: fix critical/high findings and re-run.
If NEEDS_WORK: review findings, fix what's reasonable, then proceed.
If SHIP_IT: you're good to go.
