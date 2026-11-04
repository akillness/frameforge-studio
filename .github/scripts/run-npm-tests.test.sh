#!/usr/bin/env bash
set -euo pipefail

runner_temp="$(mktemp -d)"
trap 'rm -rf "$runner_temp"' EXIT
export RUNNER_TEMP="$runner_temp"

npm() {
  printf '%s\n' '# tests 1' '# pass 0' '# fail 1'
  return 23
}
export -f npm

set +e
output="$(bash .github/scripts/run-npm-tests.sh 2>&1)"
status=$?
set -e

if [[ "$status" -ne 23 ]]; then
  printf 'Expected npm test exit 23 to be preserved, got %s\n' "$status" >&2
  printf '%s\n' "$output" >&2
  exit 1
fi
[[ "$output" == *'::group::npm test (full TAP output)'* ]]
[[ "$output" == *'::endgroup::'* ]]
[[ "$output" == *'# fail 1'* ]]
grep -F '# fail 1' "$RUNNER_TEMP/frameforge-npm-test.tap" >/dev/null
printf '%s\n' 'PASS: grouped TAP capture preserves npm test exit code 23'
