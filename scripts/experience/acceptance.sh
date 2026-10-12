#!/bin/sh
set -eu
cd "$(dirname "$0")/../.."
node --experimental-strip-types --test tests/experience-learning-automation.test.ts
node --experimental-strip-types --test tests/codex-hook-bridge.test.ts
pnpm --config.manage-package-manager-versions=false run typecheck
