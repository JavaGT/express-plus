#!/bin/sh
# One-time setup: point git at the repo hooks directory so the pre-push
# guard (issue #129) actually runs. Idempotent; safe to re-run.

set -e
git config core.hooksPath .githooks
echo "core.hooksPath -> $(git config core.hooksPath) (pre-push guard active)"
