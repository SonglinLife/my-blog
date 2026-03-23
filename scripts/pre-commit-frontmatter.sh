#!/bin/bash
# Pre-commit hook for blog markdown files:
# 1. Auto-add frontmatter if missing (title from filename, tags: [draft])
# 2. When tags contain "release" and pubDatetime is still a placeholder,
#    update pubDatetime to current time (= publish time)

BLOG_DIR="src/data/blog"

staged_files=$(git diff --cached --name-only --diff-filter=ACM | grep "^${BLOG_DIR}/.*\.md$")

if [ -z "$staged_files" ]; then
  exit 0
fi

now=$(date "+%Y-%m-%dT%H:%M:%S+08:00")

for file in $staged_files; do
  first_line=$(head -n 1 "$file")

  if [ "$first_line" != "---" ]; then
    # No frontmatter — add one with draft tag and placeholder datetime
    filename=$(basename "$file" .md)
    original=$(cat "$file")
    {
      echo "---"
      echo "title: \"$filename\""
      echo "pubDatetime: 1970-01-01T00:00:00+08:00"
      echo "description: \"$filename\""
      echo "tags:"
      echo "  - draft"
      echo "---"
      echo ""
      echo "$original"
    } > "$file"
    git add "$file"
    echo "[pre-commit] Added frontmatter to $file"
    continue
  fi

  # Has frontmatter — check if it contains "release" tag
  # Extract frontmatter block (between first and second ---)
  frontmatter=$(sed -n '1,/^---$/{ /^---$/d; p; }' "$file" | tail -n +1)
  # More robust: get content between first --- and second ---
  frontmatter=$(awk 'BEGIN{c=0} /^---$/{c++;next} c==1{print}' "$file")

  has_release=$(echo "$frontmatter" | grep -E "^\s*-\s*release\s*$")
  if [ -z "$has_release" ]; then
    # Also check inline format: tags: [release, ...]
    has_release=$(echo "$frontmatter" | grep -E "tags:.*release")
  fi

  if [ -n "$has_release" ]; then
    # Check if pubDatetime is placeholder (1970)
    has_placeholder=$(echo "$frontmatter" | grep -E "pubDatetime:.*1970")
    if [ -n "$has_placeholder" ]; then
      # Replace placeholder with current time
      if [[ "$OSTYPE" == "darwin"* ]]; then
        sed -i '' "s|pubDatetime:.*1970.*|pubDatetime: $now|" "$file"
      else
        sed -i "s|pubDatetime:.*1970.*|pubDatetime: $now|" "$file"
      fi
      git add "$file"
      echo "[pre-commit] Updated pubDatetime to $now in $file (release detected)"
    fi
  fi
done
