#!/usr/bin/env bash
# Build the site from ~/learn (or $LEARN_CONTENT) and publish it to
# $LEARN_PUBLISH_DIR (default /var/lib/learn), which learn.service serves read-only. A LaTeX error stops
# the publish, so the live site never gets a half-built version.
set -euo pipefail
cd "$(dirname "$0")/.."

{ [ -d node_modules/pdfjs-dist ] && [ -d node_modules/@highlightjs/cdn-assets ] && [ -d node_modules/katex ]; } || npm ci --no-audit --no-fund
node build.mjs
# LEARN_OUT / LEARN_PUBLISH_DIR let a local test build somewhere harmless.
rsync -a --delete --chmod=D0755,F0644 "${LEARN_OUT:-dist}/" "${LEARN_PUBLISH_DIR:-/var/lib/learn}/"
echo "published to ${LEARN_PUBLISH_DIR:-/var/lib/learn}"
