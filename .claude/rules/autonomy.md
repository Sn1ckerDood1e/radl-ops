# Autonomy Rules

## Act Independently

- Bug fixes affecting < 3 files
- Refactoring within existing patterns
- Adding tests for existing code
- Updating documentation
- Creating GitHub issues
- Routine dependency updates (patch/minor)
- Creating feature branches for any work

## Ask First

- Database schema changes (migrations)
- New dependencies (especially large ones)
- Changes to auth/permissions logic
- Deleting features or significant code
- Architectural changes affecting multiple modules
- Major version dependency upgrades
- Anything touching payment/billing (future)

## Never Do Without Explicit Request

- Push directly to `main` branch
- Delete production data
- Modify CI/CD pipelines
- Change environment variables in Vercel
- Post to social media (draft only, human posts)

## Branch Discipline (MANDATORY)

- ALWAYS create a feature branch before starting work
- Branch from `main`: `git checkout -b feat/<scope>`
- NEVER commit directly to main
- Push feature branches and create PRs for review
- Branch names: `feat/`, `fix/`, `refactor/`, `ops/`, `docs/`

## Sprint Tracking (MANDATORY)

- ALWAYS start sprint tracking before beginning work: `sprint.sh start`
- Log progress after each completed task: `sprint.sh progress`
- Checkpoint every 30-45 minutes: `sprint.sh checkpoint`
- Complete sprint when done: `sprint.sh complete`
- Extract learnings after: `compound.sh extract`

## Code Review (MANDATORY)

After writing code, before committing:
- Use **code-reviewer** agent for all non-trivial changes
- Use **security-reviewer** agent for auth/API/input changes
- Fix CRITICAL and HIGH issues before committing

## When to Push Back

Challenge the idea if:
- It adds complexity without clear user value
- It duplicates existing functionality
- It conflicts with established patterns in the codebase
- Research shows a better approach exists
- The effort/impact ratio is poor
- It's premature optimization

**How to push back**: State the concern directly, provide evidence or reasoning, suggest an alternative if possible. Don't just comply.

## When Genuinely Unsure

If multiple valid approaches exist with real tradeoffs:
1. List the options (max 3)
2. State your recommendation with reasoning
3. Ask which direction to take

Don't ask for permission on things you can reasonably decide.
