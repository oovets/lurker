#!/usr/bin/env bash
# Copyright (c) 2026 Brad Root
# SPDX-License-Identifier: MPL-2.0
#
# One-shot "ship" button: stage everything, commit with the message you pass,
# and push the current branch (setting its upstream on the first push).
#
#   npm run ship -- "your commit message"
#   npm run ship -- fix the thing        # quotes optional; all args join
#
# Notes:
#  - Stages ALL changes (tracked + untracked + deletions), i.e. `git add -A`.
#  - If there's nothing staged it skips the commit but still pushes any commits
#    that haven't reached the remote yet.
#  - Refuses to run with an empty message.

set -euo pipefail

MSG="$*"
if [[ -z "${MSG// /}" ]]; then
  echo "ship: a commit message is required." >&2
  echo "usage: npm run ship -- \"your commit message\"" >&2
  exit 1
fi

# Run from the repo root regardless of where it was invoked.
cd "$(git rev-parse --show-toplevel)"

BRANCH="$(git rev-parse --abbrev-ref HEAD)"
if [[ "$BRANCH" == "HEAD" ]]; then
  echo "ship: detached HEAD — checkout a branch first." >&2
  exit 1
fi

# Auto-select everything you've done.
git add -A

if git diff --cached --quiet; then
  echo "ship: nothing staged to commit; checking for unpushed commits..."
else
  git commit -m "$MSG"
  echo "ship: committed on '$BRANCH'."
fi

# Push, wiring up the upstream the first time so later pushes are bare `git push`.
if git rev-parse --abbrev-ref --symbolic-full-name '@{u}' >/dev/null 2>&1; then
  git push
else
  echo "ship: no upstream set — pushing and tracking origin/$BRANCH."
  git push -u origin "$BRANCH"
fi

echo "ship: done."
