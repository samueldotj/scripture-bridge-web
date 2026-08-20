#!/usr/bin/env bash
#
# Run a command, echo its output, and re-emit a digest as a GitHub annotation:
# an error annotation on failure, a notice on success.
#
# Adapted from scripture-bridge-db/scripts/ci-run.sh, and here for the same
# reason: GitHub requires sign-in to read Actions logs, even on public
# repositories, and the logs API returns 403 without repository admin rights.
# Annotations are readable through the public API. Without this, a CI result is
# visible from outside only as "Process completed with exit code 1" — or, when
# it passes, as nothing at all.
#
# The success digest earns its place as much as the failure one: a check step
# that quietly stopped asserting anything would otherwise stay green forever,
# and "green" would mean "nothing ran" rather than "nothing broke".
#
# The digest here is the console's own summary lines rather than the database
# repository's TAP plan, because these scripts report counts, not TAP.
#
# Usage:  bash scripts/ci-run.sh "<label>" <command> [args...]

set -uo pipefail

label="$1"
shift

out=$("$@" 2>&1)
code=$?

printf '%s\n' "$out"

# Workflow-command payloads are newline-delimited, so the text must be escaped:
# % first (or it mangles the escapes introduced after it), then CR, then LF.
escape() {
  printf '%s' "$1" \
    | sed -e 's/%/%25/g' -e 's/\r/%0D/g' \
    | sed -e ':a' -e 'N' -e '$!ba' -e 's/\n/%0A/g'
}

if [ "$code" -ne 0 ]; then
  printf '::error::%s failed (exit %s): %s\n' \
    "$label" "$code" "$(escape "$(printf '%s' "$out" | tail -c 3000)")"
  exit "$code"
fi

# Strip ANSI before counting: the scripts colour their own output, and an
# escape sequence between "ok" and the message defeats a naive grep.
plain=$(printf '%s\n' "$out" | sed -e 's/\x1b\[[0-9;]*m//g')

oks=$(printf '%s\n' "$plain" | grep -cE '^[[:space:]]*ok[[:space:]]')
checked=$(printf '%s\n' "$plain" | grep -oE 'Checked [0-9]+ reference\(s\) across [0-9]+ statement\(s\) in [0-9]+ file\(s\)' | tail -1)
scanned=$(printf '%s\n' "$plain" | grep -oE 'Scanning [0-9]+ client asset\(s\)' | tail -1)

digest=""
if [ "$oks" -gt 0 ];    then digest="$digest ok=$oks"; fi
if [ -n "$checked" ];   then digest="$digest $checked"; fi
if [ -n "$scanned" ];   then digest="$digest $scanned"; fi
if [ -z "$digest" ];    then digest=" completed"; fi

printf '::notice::%s passed —%s\n' "$label" "$(escape "$digest")"
exit 0
