#!/usr/bin/env bash
# Re-vendor the Celopedia grounding into the repo (celopedia-refs/) from the upstream
# celopedia-skill in the workspace. Run this when the skill updates, then review the
# diff and commit — the backend reads the in-repo copy, not the workspace skill.
#
#   bun run sync-celopedia   # or:  bash scripts/sync-celopedia.sh
#
set -euo pipefail

cd "$(dirname "$0")/.."   # kane-be repo root
SRC="../.agents/skills/celopedia-skill/references"

if [ ! -d "$SRC" ]; then
  echo "!! upstream skill not found at $SRC — run from inside the KaneAI workspace."
  exit 1
fi

# Mirror only the top-level .md files (what celopedia.ts actually reads).
rsync -a --delete --include="*.md" --exclude="*" "$SRC/" celopedia-refs/

echo "Synced $(ls celopedia-refs/*.md 2>/dev/null | wc -l | tr -d ' ') .md files into celopedia-refs/."
echo "Review 'git diff celopedia-refs/' and commit."
