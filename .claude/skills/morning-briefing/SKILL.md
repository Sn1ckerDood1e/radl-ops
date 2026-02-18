# /morning-briefing — Daily Gmail Briefing

Generate and deliver the morning briefing via Gmail. Chains production health check, calendar lookup, and AI-generated briefing into one command.

## Usage

```
/morning-briefing
/morning-briefing "Focus on equipment bugs today"
```

## Arguments

Optional: a custom focus area to include in the briefing (e.g., "onboarding week priorities").

## Workflow

### Step 1: Enable Content Tools

```
mcp__radl-ops__enable_tools({ group: "content", action: "enable" })
```

### Step 2: Check Production Health

```
mcp__radl-ops__production_status({})
```

Save the output as `monitoring_context` for step 4. If any service shows `issues_detected`, note it for the briefing.

### Step 3: Get Today's Calendar

```
mcp__google_workspace__get_events({
  user_google_email: "kinseymi@radl.solutions",
  timeMin: "<today 00:00 ISO>",
  timeMax: "<today 23:59 ISO>"
})
```

Save the output as `calendar_context` for step 4. If Google Workspace MCP is unavailable, skip this step and use `calendar_context: "Calendar unavailable"`.

### Step 4: Generate and Send Briefing

```
mcp__radl-ops__daily_briefing({
  deliver_via_gmail: true,
  monitoring_context: "<from step 2>",
  calendar_context: "<from step 3>",
  custom_focus: "<user's argument, if provided>"
})
```

This generates the briefing via eval-opt (Haiku generates, Sonnet evaluates), converts to HTML, and sends via Gmail.

### Step 5: Report Result

Tell the user:
- Whether the email was sent successfully
- A 2-3 line summary of the briefing content (production status, top priorities)
- If any critical alerts were found in step 2

### Error Handling

- If Gmail delivery fails, show the briefing content in the terminal instead
- If production_status fails, generate the briefing without monitoring context
- If calendar lookup fails, generate without calendar context
- Never block the briefing on a single failed step

## Notes

- The briefing is sent to the configured recipient (`GOOGLE_BRIEFING_RECIPIENT` env var, defaults to `kinseymi@radl.solutions`)
- Content tools are automatically disabled after the session ends (they start disabled by default)
- The eval-opt loop runs Haiku as generator and Sonnet as evaluator with a quality threshold of 7/10
