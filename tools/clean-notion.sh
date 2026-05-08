#!/bin/bash
# Clean all Notion records - paginated query + archive
TOKEN="${NOTION_TOKEN}"
DB_ID="${NOTION_DATABASE_ID}"
CURSOR=""
TOTAL=0
ARCHIVED=0

while true; do
  # Build query JSON
  if [ -z "$CURSOR" ]; then
    CURSOR_JSON=""
  else
    CURSOR_JSON=", \"start_cursor\": \"$CURSOR\""
  fi

  RESULT=$(curl -s -X POST "https://api.notion.com/v1/databases/${DB_ID}/query" \
    -H "Authorization: Bearer ${TOKEN}" \
    -H "Content-Type: application/json" \
    -H "Notion-Version: 2022-06-28" \
    -d "{\"page_size\": 100${CURSOR_JSON}}")

  # Check for errors
  ERROR=$(echo "$RESULT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('message',''))" 2>/dev/null)
  if [ -n "$ERROR" ]; then
    echo "API Error: $ERROR"
    echo "$RESULT" | head -5
    break
  fi

  # Extract results
  RESULTS=$(echo "$RESULT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(len(d.get('results',[])))" 2>/dev/null)
  TOTAL=$((TOTAL + RESULTS))

  # Archive each page
  for PAGE_ID in $(echo "$RESULT" | python3 -c "
import sys,json
d=json.load(sys.stdin)
for r in d.get('results',[]):
    print(r['id'])
" 2>/dev/null); do
    curl -s -X PATCH "https://api.notion.com/v1/pages/${PAGE_ID}" \
      -H "Authorization: Bearer ${TOKEN}" \
      -H "Content-Type: application/json" \
      -H "Notion-Version: 2022-06-28" \
      -d '{"archived": true}' > /dev/null
    ARCHIVED=$((ARCHIVED + 1))
    echo "Archived $ARCHIVED/$TOTAL"
    sleep 0.35
  done

  CURSOR=$(echo "$RESULT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('next_cursor','') or '')" 2>/dev/null)
  echo "Batch done: total=$TOTAL archived=$ARCHIVED next_cursor=$CURSOR"

  if [ -z "$CURSOR" ]; then
    break
  fi
done

echo ""
echo "Done: $ARCHIVED pages archived"
