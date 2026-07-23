#!/bin/sh
# Git hooks live in .git/hooks/, which is never tracked by git itself --
# run this once after cloning to install them. Idempotent, safe to re-run.
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

cat > "$ROOT/.git/hooks/post-commit" << 'EOF'
#!/bin/sh
# Completed-work-marker auto-draft. Draft-only, never blocks the commit --
# always exits 0 regardless of what post-commit-draft.ts does.
# NOT tracked by git (hooks never are) -- installed by scripts/install-hooks.sh,
# which IS tracked. Re-run that after a fresh clone.
npm run post-commit-draft --silent
exit 0
EOF
chmod +x "$ROOT/.git/hooks/post-commit"
echo "installed .git/hooks/post-commit"
