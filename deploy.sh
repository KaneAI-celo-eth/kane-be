#!/usr/bin/env bash
# One-command deploy: kane-be -> Celiq VPS.
#
# The VPS is NOT a git checkout (git isn't installed there), so deployment is an
# rsync of the source + Celopedia grounding, followed by a pm2 restart. Idempotent
# and safe to re-run.
#
#   ./deploy.sh            # or:  bun run deploy
#   KANE_VPS=other-host ./deploy.sh
#
set -euo pipefail

VPS="${KANE_VPS:-celiq-vps}"
REMOTE="/home/celiqdev/apps/kane-be"
HEALTH="https://kane-api.157.10.160.167.nip.io/health"  # the backend we just restarted

cd "$(dirname "$0")"                                  # kane-be repo root
REFS="celopedia-refs"  # Celopedia grounding, bundled in-repo (re-vendor via `bun run sync-celopedia`)

if [ -n "$(git status --porcelain 2>/dev/null || true)" ]; then
  echo "!  uncommitted changes present — deploying the working tree as-is."
fi

echo "-> src/"
rsync -az --delete -e ssh src/ "$VPS:$REMOTE/src/"

echo "-> package.json  (run 'bun install' on the VPS if dependencies changed)"
rsync -az -e ssh package.json "$VPS:$REMOTE/package.json"

if [ -d "$REFS" ]; then
  echo "-> Celopedia grounding"
  rsync -az -e ssh "$REFS/" "$VPS:$REMOTE/celopedia-refs/"
else
  echo "!  $REFS not found — skipping grounding sync (standalone checkout)."
fi

echo "-> pm2 restart"
ssh "$VPS" 'pm2 restart kane-be --update-env >/dev/null 2>&1 && echo "   online"'

echo "-> health (retries while the service boots)"
# --retry-all-errors rides out the brief 502/recv window during the restart.
if curl -fs --retry 15 --retry-delay 2 --retry-all-errors --max-time 10 "$HEALTH" >/dev/null 2>&1; then
  echo "   OK — backend /health returns 200"
else
  echo "   !! health check failed after retries — verify manually"
  exit 1
fi
echo "Deployed."
