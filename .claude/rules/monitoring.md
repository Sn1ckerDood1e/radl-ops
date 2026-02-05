# Monitoring Checklist

## Daily Checks (for briefings)

### GitHub (`mcp__github__*`)
- [ ] Open issues — any new, any stale (>7 days)?
- [ ] Open PRs — any waiting for review?
- [ ] Recent commits — what shipped yesterday?
- [ ] Failed checks — any CI failures on main?

### Vercel (`mcp__vercel-radl__*`)
- [ ] Latest deployment status — success/failure?
- [ ] Build errors — any failures in last 24h?
- [ ] Build duration — unusual spikes?

### Supabase (`mcp__supabase__*`)
- [ ] Get logs (auth, postgres, edge-function) — any errors?
- [ ] Get advisors (security, performance) — any new warnings?
- [ ] Database health — connection issues?

### Sentry (future)
- [ ] New errors in last 24h
- [ ] Error trends — spikes?
- [ ] Unresolved high-priority issues

## What Constitutes "Worth Flagging"

**Immediate attention (flag in briefing):**
- Build/deploy failures on main
- Auth errors affecting users
- Database connection issues
- Security advisories (any severity)
- Error rate spike (>10 in 1 hour)

**Note but don't alarm:**
- Single transient errors
- Performance advisor suggestions
- Minor linting warnings
- Routine deprecation notices

## Briefing Structure

### Daily (Mon-Fri 7am)
```
🎯 TODAY'S FOCUS
- Top 1-3 priorities based on roadmap + any issues found

📊 SERVICE STATUS
- GitHub: X open issues, Y open PRs, [any problems]
- Vercel: Last deploy [status], [any problems]
- Supabase: [any errors/advisories]

⚠️ ISSUES FOUND (if any)
- [Description + suggested action]

📱 SOCIAL PROMPT
- One content idea for today
```

### Weekly (Saturday 7am)
```
📈 WEEK IN REVIEW
- Commits/PRs merged
- Issues closed
- Features shipped

🎯 NEXT WEEK GOALS
- Top 3-5 priorities

💡 FEATURE CONSIDERATION
- One idea worth exploring (researched)

📱 SOCIAL CALENDAR
- 5 post ideas for next week (Mon-Fri)

🏆 WIN OF THE WEEK
- Something that went well
```
