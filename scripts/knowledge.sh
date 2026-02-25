#!/bin/bash
# Knowledge Base Management for Session Handoffs
# Usage:
#   ./knowledge.sh decision "title" "context" "alternatives" "rationale"
#   ./knowledge.sh pattern "name" "description" "example"
#   ./knowledge.sh lesson "what happened" "what we learned"
#   ./knowledge.sh search "query"
#   ./knowledge.sh context              Generate session context summary
#   ./knowledge.sh export               Export knowledge for new session

set -e

RADL_OPS_DIR="${RADL_OPS_DIR:-$(cd "$(dirname "$0")/.." && pwd)}"
RADL_DIR="${RADL_DIR:-/home/hb/radl}"
KNOWLEDGE_DIR="$RADL_OPS_DIR/knowledge"
DECISIONS_FILE="$KNOWLEDGE_DIR/decisions.json"
PATTERNS_FILE="$KNOWLEDGE_DIR/patterns.json"
LESSONS_FILE="$KNOWLEDGE_DIR/lessons.json"

mkdir -p "$KNOWLEDGE_DIR"

# Initialize files if they don't exist
if [ ! -f "$DECISIONS_FILE" ]; then
  echo '{"decisions": []}' > "$DECISIONS_FILE"
fi

if [ ! -f "$PATTERNS_FILE" ]; then
  echo '{"patterns": []}' > "$PATTERNS_FILE"
fi

if [ ! -f "$LESSONS_FILE" ]; then
  echo '{"lessons": []}' > "$LESSONS_FILE"
fi

# Log a decision
cmd_decision() {
  local title="$1"
  local context="$2"
  local alternatives="$3"
  local rationale="$4"

  if [ -z "$title" ]; then
    echo "Usage: knowledge.sh decision <title> <context> <alternatives> <rationale>"
    echo ""
    echo "Example:"
    echo "  knowledge.sh decision \"Use Prisma over Drizzle\" \\"
    echo "    \"Needed ORM for database\" \\"
    echo "    \"Drizzle, Kysely, raw SQL\" \\"
    echo "    \"Prisma has better Supabase integration and type generation\""
    exit 1
  fi

  python3 << PYEOF
import json
from datetime import datetime

with open('$DECISIONS_FILE', 'r') as f:
    data = json.load(f)

decision = {
    "id": len(data['decisions']) + 1,
    "title": """$title""",
    "context": """$context""",
    "alternatives": """$alternatives""",
    "rationale": """$rationale""",
    "date": datetime.now().isoformat(),
    "phase": "$(cat $RADL_DIR/.planning/STATE.md 2>/dev/null | grep -A1 '| Phase |' | tail -1 | sed 's/.*| //' | sed 's/ |.*//' || echo 'Unknown')"
}

data['decisions'].append(decision)

with open('$DECISIONS_FILE', 'w') as f:
    json.dump(data, f, indent=2)

print(f"Decision #{decision['id']} logged: {decision['title']}")
PYEOF
}

# Log a reusable pattern
cmd_pattern() {
  local name="$1"
  local description="$2"
  local example="$3"

  if [ -z "$name" ]; then
    echo "Usage: knowledge.sh pattern <name> <description> <example>"
    echo ""
    echo "Example:"
    echo "  knowledge.sh pattern \"CSRF Protection\" \\"
    echo "    \"Always include CSRF token in API calls\" \\"
    echo "    \"headers: { 'X-CSRF-Token': csrfToken }\""
    exit 1
  fi

  python3 << PYEOF
import json
from datetime import datetime

with open('$PATTERNS_FILE', 'r') as f:
    data = json.load(f)

pattern = {
    "id": len(data['patterns']) + 1,
    "name": """$name""",
    "description": """$description""",
    "example": """$example""",
    "date": datetime.now().isoformat()
}

data['patterns'].append(pattern)

with open('$PATTERNS_FILE', 'w') as f:
    json.dump(data, f, indent=2)

print(f"Pattern #{pattern['id']} logged: {pattern['name']}")
PYEOF
}

# Log a lesson learned
cmd_lesson() {
  local situation="$1"
  local learning="$2"

  if [ -z "$situation" ]; then
    echo "Usage: knowledge.sh lesson <what happened> <what we learned>"
    echo ""
    echo "Example:"
    echo "  knowledge.sh lesson \"Build failed on type errors\" \\"
    echo "    \"Always run tsc before committing TypeScript changes\""
    exit 1
  fi

  python3 << PYEOF
import json
from datetime import datetime

with open('$LESSONS_FILE', 'r') as f:
    data = json.load(f)

lesson = {
    "id": len(data['lessons']) + 1,
    "situation": """$situation""",
    "learning": """$learning""",
    "date": datetime.now().isoformat()
}

data['lessons'].append(lesson)

with open('$LESSONS_FILE', 'w') as f:
    json.dump(data, f, indent=2)

print(f"Lesson #{lesson['id']} logged")
PYEOF
}

# Search knowledge base
cmd_search() {
  local query="$1"

  if [ -z "$query" ]; then
    echo "Usage: knowledge.sh search <query>"
    exit 1
  fi

  echo "=== Knowledge Base Search: $query ==="
  echo ""

  python3 << PYEOF
import json
import re

query = """$query""".lower()

# Search decisions
with open('$DECISIONS_FILE', 'r') as f:
    decisions = json.load(f)['decisions']

matches = []
for d in decisions:
    searchable = f"{d['title']} {d['context']} {d['rationale']}".lower()
    if query in searchable:
        matches.append(('Decision', d['id'], d['title'], d['rationale'][:100]))

# Search patterns
with open('$PATTERNS_FILE', 'r') as f:
    patterns = json.load(f)['patterns']

for p in patterns:
    searchable = f"{p['name']} {p['description']}".lower()
    if query in searchable:
        matches.append(('Pattern', p['id'], p['name'], p['description'][:100]))

# Search lessons
with open('$LESSONS_FILE', 'r') as f:
    lessons = json.load(f)['lessons']

for l in lessons:
    searchable = f"{l['situation']} {l['learning']}".lower()
    if query in searchable:
        matches.append(('Lesson', l['id'], l['situation'][:50], l['learning'][:100]))

if matches:
    for type_, id_, title, detail in matches:
        print(f"[{type_} #{id_}] {title}")
        print(f"  {detail}...")
        print()
else:
    print(f"No results for '{query}'")
PYEOF
}

# Generate context summary for session handoff
cmd_context() {
  echo "=== Session Context Summary ==="
  echo "Generated: $(date '+%Y-%m-%d %H:%M')"
  echo ""

  python3 << PYEOF
import json
from pathlib import Path
from datetime import datetime, timedelta

# Current sprint status
sprint_file = Path('$RADL_DIR/.planning/sprints/current.json')
if sprint_file.exists():
    with open(sprint_file, 'r') as f:
        sprint = json.load(f)
    print("## Current Sprint")
    print(f"- Phase: {sprint.get('phase', 'Unknown')}")
    print(f"- Title: {sprint.get('title', 'Unknown')}")
    print(f"- Estimate: {sprint.get('estimate', 'Unknown')}")
    print(f"- Tasks completed: {len(sprint.get('completedTasks', []))}")
    blockers = [b for b in sprint.get('blockers', []) if not b.get('resolved', False)]
    if blockers:
        print(f"- Active blockers: {len(blockers)}")
        for b in blockers:
            print(f"  - {b['description']}")
    print()
else:
    print("## No Active Sprint")
    print()

# Recent decisions (last 5)
decisions_file = Path('$KNOWLEDGE_DIR/decisions.json')
if decisions_file.exists():
    with open(decisions_file, 'r') as f:
        decisions = json.load(f)['decisions']
    if decisions:
        print("## Recent Decisions")
        for d in decisions[-5:]:
            print(f"- [{d.get('phase', '?')}] {d['title']}")
            print(f"  Rationale: {d['rationale'][:80]}...")
        print()

# Recent lessons (last 3)
lessons_file = Path('$KNOWLEDGE_DIR/lessons.json')
if lessons_file.exists():
    with open(lessons_file, 'r') as f:
        lessons = json.load(f)['lessons']
    if lessons:
        print("## Lessons to Remember")
        for l in lessons[-3:]:
            print(f"- {l['learning']}")
        print()

# Key patterns
patterns_file = Path('$KNOWLEDGE_DIR/patterns.json')
if patterns_file.exists():
    with open(patterns_file, 'r') as f:
        patterns = json.load(f)['patterns']
    if patterns:
        print("## Established Patterns")
        for p in patterns[-5:]:
            print(f"- **{p['name']}**: {p['description'][:60]}...")
        print()

# Sprint velocity
sprint_dir = Path('$RADL_DIR/.planning/sprints')
completed = sorted(sprint_dir.glob('completed-*.json'), reverse=True)[:5]
if completed:
    print("## Recent Sprint Velocity")
    for f in completed:
        try:
            with open(f, 'r') as file:
                data = json.load(file)
            phase = data.get('phase', '?')
            est = data.get('estimate', '?')
            act = data.get('actualTime', '?')
            print(f"- {phase}: {est} → {act}")
        except:
            pass
    print()

# Current state from STATE.md
state_file = Path('$RADL_DIR/.planning/STATE.md')
if state_file.exists():
    print("## Project State")
    with open(state_file, 'r') as f:
        content = f.read()
    # Extract key info
    import re
    phase = re.search(r'\| Phase \| (.+?) \|', content)
    sprint = re.search(r'\| Sprint \| (.+?) \|', content)
    status = re.search(r'\| Sprint Status \| (.+?) \|', content)
    if phase:
        print(f"- Current Phase: {phase.group(1)}")
    if sprint:
        print(f"- Current Sprint: {sprint.group(1)}")
    if status:
        print(f"- Status: {status.group(1)}")
PYEOF
}

# Export full knowledge base for new session
cmd_export() {
  echo "# Radl Knowledge Base Export"
  echo "# Generated: $(date '+%Y-%m-%d %H:%M')"
  echo "# Use this to restore context in a new session"
  echo ""

  cmd_context

  echo ""
  echo "---"
  echo ""

  # Full decisions list
  echo "## All Architectural Decisions"
  python3 << PYEOF
import json
from pathlib import Path

decisions_file = Path('$KNOWLEDGE_DIR/decisions.json')
if decisions_file.exists():
    with open(decisions_file, 'r') as f:
        decisions = json.load(f)['decisions']
    for d in decisions:
        print(f"\n### {d['id']}. {d['title']}")
        print(f"**Phase:** {d.get('phase', 'Unknown')}")
        print(f"**Date:** {d.get('date', 'Unknown')[:10]}")
        print(f"**Context:** {d.get('context', 'N/A')}")
        print(f"**Alternatives:** {d.get('alternatives', 'N/A')}")
        print(f"**Rationale:** {d.get('rationale', 'N/A')}")
PYEOF
}

# List all knowledge
cmd_list() {
  echo "=== Knowledge Base Summary ==="
  echo ""

  python3 << PYEOF
import json
from pathlib import Path

decisions_file = Path('$KNOWLEDGE_DIR/decisions.json')
patterns_file = Path('$KNOWLEDGE_DIR/patterns.json')
lessons_file = Path('$KNOWLEDGE_DIR/lessons.json')

d_count = 0
p_count = 0
l_count = 0

if decisions_file.exists():
    with open(decisions_file, 'r') as f:
        d_count = len(json.load(f)['decisions'])

if patterns_file.exists():
    with open(patterns_file, 'r') as f:
        p_count = len(json.load(f)['patterns'])

if lessons_file.exists():
    with open(lessons_file, 'r') as f:
        l_count = len(json.load(f)['lessons'])

print(f"📋 Decisions logged: {d_count}")
print(f"🔧 Patterns recorded: {p_count}")
print(f"💡 Lessons learned: {l_count}")
print()
print("Commands:")
print("  knowledge.sh decision <title> <context> <alternatives> <rationale>")
print("  knowledge.sh pattern <name> <description> <example>")
print("  knowledge.sh lesson <situation> <learning>")
print("  knowledge.sh search <query>")
print("  knowledge.sh context  - Quick context summary")
print("  knowledge.sh export   - Full export for new sessions")
PYEOF
}

# Main command router
case "$1" in
  decision) cmd_decision "$2" "$3" "$4" "$5" ;;
  pattern) cmd_pattern "$2" "$3" "$4" ;;
  lesson) cmd_lesson "$2" "$3" ;;
  search) cmd_search "$2" ;;
  context) cmd_context ;;
  export) cmd_export ;;
  list) cmd_list ;;
  *)
    cmd_list
    ;;
esac
