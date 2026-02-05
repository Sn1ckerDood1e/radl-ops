#!/bin/bash
# Social Content Calendar Manager
# Usage:
#   ./social.sh ideas              Generate content ideas
#   ./social.sh plan <week>        Plan week's content
#   ./social.sh add <day> <type>   Add a post to calendar
#   ./social.sh view               View current calendar
#   ./social.sh post <id>          Mark post as published

set -e

SOCIAL_DIR="/home/hb/radl-ops/social"
CALENDAR_FILE="$SOCIAL_DIR/calendar.json"
IDEAS_FILE="$SOCIAL_DIR/ideas.json"

mkdir -p "$SOCIAL_DIR"

# Initialize files if they don't exist
if [ ! -f "$CALENDAR_FILE" ]; then
  echo '{"posts": []}' > "$CALENDAR_FILE"
fi

if [ ! -f "$IDEAS_FILE" ]; then
  cat > "$IDEAS_FILE" << 'IDEASEOF'
{
  "categories": {
    "product_demo": [
      "Show lineup drag-and-drop in action",
      "Equipment QR code scanning demo",
      "Weather integration feature",
      "Rigging database walkthrough",
      "Mobile app overview",
      "Coach dashboard tour"
    ],
    "rowing_humor": [
      "When the novice asks why we practice at 5am",
      "Cox box battery dies mid-piece",
      "Erg screen says 2:00 but body says 2:30",
      "Coaches when athletes ask about steady state",
      "That one rower who always forgets their uni"
    ],
    "tips": [
      "5 things to check before launching",
      "How to read weather for safe rowing",
      "Quick rigging adjustment tips",
      "Pre-practice checklist",
      "Equipment care basics"
    ],
    "behind_scenes": [
      "Building Radl: this week's features",
      "Bug squashing session timelapse",
      "Coffee + code morning routine",
      "User feedback we're implementing"
    ],
    "community": [
      "Repost user content",
      "Regatta season prep tips",
      "Feature request spotlight",
      "Beta tester shoutout"
    ]
  },
  "hashtags": {
    "instagram": "#rowing #crew #rowinglife #erging #rowingcoach #boathouse #radlapp #rowingteam #coxswain #sculling #sweep",
    "twitter": "#rowing #rowinglife #radlapp"
  }
}
IDEASEOF
fi

# Generate content ideas
cmd_ideas() {
  echo "=== Content Ideas ==="
  echo ""

  python3 << 'PYEOF'
import json
import random

with open('/home/hb/radl-ops/social/ideas.json', 'r') as f:
    ideas = json.load(f)

print("📱 Suggested posts for this week:\n")

categories = ideas['categories']
for i, (category, items) in enumerate(categories.items(), 1):
    idea = random.choice(items)
    emoji = {"product_demo": "🎬", "rowing_humor": "😂", "tips": "💡", "behind_scenes": "🔧", "community": "🤝"}
    print(f"{i}. {emoji.get(category, '📌')} [{category.replace('_', ' ').title()}]")
    print(f"   {idea}")
    print()

print("Hashtags:")
print(f"  Instagram: {ideas['hashtags']['instagram'][:60]}...")
print(f"  Twitter: {ideas['hashtags']['twitter']}")
PYEOF
}

# View calendar
cmd_view() {
  echo "=== Social Calendar ==="
  echo ""

  python3 << 'PYEOF'
import json
from datetime import datetime, timedelta

with open('/home/hb/radl-ops/social/calendar.json', 'r') as f:
    calendar = json.load(f)

posts = calendar.get('posts', [])

if not posts:
    print("No posts scheduled. Use 'social.sh add' to add posts.")
    exit(0)

# Group by week
today = datetime.now().date()
this_week = []
next_week = []
published = []

for post in posts:
    post_date = datetime.strptime(post['date'], '%Y-%m-%d').date()
    if post.get('published'):
        published.append(post)
    elif post_date < today:
        # Past unpublished
        pass
    elif post_date <= today + timedelta(days=7):
        this_week.append(post)
    else:
        next_week.append(post)

if this_week:
    print("📅 This Week:")
    for post in sorted(this_week, key=lambda x: x['date']):
        status = "✅" if post.get('published') else "⏳"
        print(f"  {status} {post['date']} [{post['platform']}] {post['type']}")
        print(f"      {post['content'][:50]}...")
    print()

if next_week:
    print("📆 Next Week:")
    for post in sorted(next_week, key=lambda x: x['date'])[:5]:
        print(f"  ⏳ {post['date']} [{post['platform']}] {post['type']}")
        print(f"      {post['content'][:50]}...")
    print()

print(f"📊 Stats: {len(published)} published, {len(this_week)} this week, {len(next_week)} upcoming")
PYEOF
}

# Add a post
cmd_add() {
  local date="$1"
  local platform="$2"
  local post_type="$3"
  local content="$4"

  if [ -z "$date" ] || [ -z "$platform" ] || [ -z "$content" ]; then
    echo "Usage: social.sh add <YYYY-MM-DD> <instagram|twitter> <type> \"content\""
    echo ""
    echo "Types: product_demo, rowing_humor, tips, behind_scenes, community"
    echo ""
    echo "Example:"
    echo "  social.sh add 2026-02-10 instagram product_demo \"Check out lineup drag-and-drop!\""
    exit 1
  fi

  python3 << PYEOF
import json
import uuid

with open('$CALENDAR_FILE', 'r') as f:
    calendar = json.load(f)

post = {
    "id": str(uuid.uuid4())[:8],
    "date": "$date",
    "platform": "$platform",
    "type": "$post_type",
    "content": """$content""",
    "published": False,
    "created": "$(date -Iseconds)"
}

calendar['posts'].append(post)

with open('$CALENDAR_FILE', 'w') as f:
    json.dump(calendar, f, indent=2)

print(f"Added post {post['id']} for $date on $platform")
PYEOF
}

# Mark post as published
cmd_post() {
  local post_id="$1"

  if [ -z "$post_id" ]; then
    echo "Usage: social.sh post <id>"
    echo ""
    echo "Get post IDs from 'social.sh view'"
    exit 1
  fi

  python3 << PYEOF
import json

with open('$CALENDAR_FILE', 'r') as f:
    calendar = json.load(f)

found = False
for post in calendar['posts']:
    if post['id'] == '$post_id':
        post['published'] = True
        post['publishedAt'] = '$(date -Iseconds)'
        found = True
        print(f"Marked post {post['id']} as published")
        break

if not found:
    print(f"Post $post_id not found")
    exit(1)

with open('$CALENDAR_FILE', 'w') as f:
    json.dump(calendar, f, indent=2)
PYEOF
}

# Plan a week
cmd_plan() {
  local week_start="$1"

  if [ -z "$week_start" ]; then
    # Default to next Monday
    week_start=$(date -d 'next monday' '+%Y-%m-%d')
  fi

  echo "=== Planning Week of $week_start ==="
  echo ""
  echo "Suggested schedule (3-5 posts/week):"
  echo ""
  echo "  Monday:    Behind the scenes / Product update"
  echo "  Wednesday: Tips / Educational content"
  echo "  Friday:    Humor / Community engagement"
  echo ""
  echo "Use 'social.sh ideas' for content suggestions"
  echo "Use 'social.sh add <date> <platform> <type> \"content\"' to add posts"
}

# Main command router
case "$1" in
  ideas) cmd_ideas ;;
  view) cmd_view ;;
  add) cmd_add "$2" "$3" "$4" "$5" ;;
  post) cmd_post "$2" ;;
  plan) cmd_plan "$2" ;;
  *)
    echo "Social Content Calendar"
    echo ""
    echo "Usage: social.sh <command> [args]"
    echo ""
    echo "Commands:"
    echo "  ideas              Generate content ideas by category"
    echo "  plan [week]        Get planning template for a week"
    echo "  add <date> <platform> <type> \"content\""
    echo "                     Add a post to the calendar"
    echo "  view               View scheduled and published posts"
    echo "  post <id>          Mark a post as published"
    echo ""
    echo "Example:"
    echo "  social.sh add 2026-02-10 instagram product_demo \"New feature!\""
    ;;
esac
