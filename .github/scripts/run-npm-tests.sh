#!/usr/bin/env bash
set +e
echo "::group::npm test (full TAP output)"
npm test 2>&1 | tee "$RUNNER_TEMP/frameforge-npm-test.tap"
test_status=${PIPESTATUS[0]}
echo "::endgroup::"
exit "$test_status"
