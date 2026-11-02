#!/usr/bin/env bash
set +e

log_path="$RUNNER_TEMP/frameforge-npm-test.tap"
status_path="$RUNNER_TEMP/frameforge-npm-test.exit"
printf '::group::npm test (full TAP output)\n'
npm test 2>&1 | tee "$log_path"
test_status=${PIPESTATUS[0]}
printf '::endgroup::\n'
printf '%s\n' "$test_status" > "$status_path"
exit "$test_status"
