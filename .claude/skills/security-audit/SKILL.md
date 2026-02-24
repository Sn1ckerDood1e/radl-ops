# Security Audit Skill

Comprehensive security audit methodology inspired by Trail of Bits' professional audit practices.
Covers differential review, insecure defaults detection, entry point analysis, and static analysis patterns.

## When to Use

- Before merging PRs with auth, API, or data access changes
- During sprint-end security review
- When reviewing third-party integrations
- For pre-production deployment checks

## Methodology

### Phase 1: Differential Risk Analysis

Analyze `git diff main...HEAD` with risk-first prioritization:

1. **Authentication & Authorization** (CRITICAL)
   - Changes to `withAuth`, `getUser`, RLS policies, CASL abilities
   - New API routes missing auth checks
   - Permission escalation paths

2. **Data Access & Injection** (HIGH)
   - Raw SQL queries without parameterization
   - Prisma queries missing team-scoped `where` clauses
   - User input flowing into queries without Zod validation

3. **Cryptographic & Secrets** (HIGH)
   - Hardcoded API keys, tokens, passwords (15+ patterns)
   - Default fallback values for secrets (fail-open vs fail-secure)
   - Weak crypto defaults (MD5, SHA1 for security purposes)

4. **External Interactions** (MEDIUM)
   - SSRF vectors in URL handling
   - Missing CSRF headers on mutations
   - Unvalidated redirect URLs

### Phase 2: Insecure Defaults Detection

Check for fail-open patterns:

```
CRITICAL: Application runs with insecure defaults when config missing
SAFE: Application crashes/refuses to start without proper config
```

Patterns to flag:
- `process.env.SECRET || 'default-value'` (hardcoded fallback)
- `const key = process.env.KEY ?? 'placeholder'` (runs without real key)
- Missing rate limiting on public endpoints
- CORS set to `*` in production
- Debug/verbose logging enabled by default
- Permissive CSP headers

### Phase 3: Entry Point Analysis

For each new/modified API route:

1. **Input validation** — Is every field validated with Zod?
2. **Auth check** — Does the route use `withAuth` or equivalent?
3. **Team scoping** — Does it filter by `teamId` from claims?
4. **Error handling** — Do errors leak internal details?
5. **Rate limiting** — Is the endpoint rate-limited?
6. **CSRF** — Does it check `x-csrf-token` header?

### Phase 4: Blast Radius Assessment

For each finding:
- Count dependent callers/importers
- Identify data flow paths (client → API → DB)
- Assess user impact (single user vs all users vs all teams)

### Phase 5: Static Analysis Patterns

Check for:
- `eval()`, `Function()`, `dangerouslySetInnerHTML` usage
- `innerHTML` assignment with user data
- Regex DoS (catastrophic backtracking)
- Prototype pollution (`__proto__`, `constructor.prototype`)
- Path traversal (`../` in file operations)
- Timing attacks (string comparison for secrets)

## Output Format

```
## Security Audit Report

### CRITICAL (fix before merge)
- [CRITICAL-1] Description | File:line | Impact | Fix

### HIGH (fix before deploy)
- [HIGH-1] Description | File:line | Impact | Fix

### MEDIUM (fix soon)
- [MEDIUM-1] Description | File:line | Impact | Fix

### LOW (track)
- [LOW-1] Description | File:line | Impact | Fix

### Insecure Defaults
- [DEFAULT-1] Pattern | File:line | Fail-open behavior

### Entry Point Summary
| Route | Auth | Validation | Team-Scoped | CSRF | Rate-Limit |
```

## Radl-Specific Checks

- `getUser()` not `getSession()` for server-side auth
- All Prisma queries scoped by `teamId`
- CSRF header in all mutation fetch calls
- Toast notifications for user-facing errors (not raw error messages)
- Equipment QR scan endpoint publicly accessible but rate-limited
- Magic link auth flow doesn't leak user existence
