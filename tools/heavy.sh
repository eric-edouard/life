#!/bin/bash
# heavy.sh <cmd...>: run a heavy local job (check, tests, tsc, xcodebuild, simulator), Mac-wide, one at a time.
# First come, first served: a job takes a slot only when no older job is still waiting.
# It starts under 1-minute load 60. One slot plus the land, light and release lanes: his cap of 21 Nov (a saturated Mac
# times tests out and reruns them).
# HEAVY_LANE=land: the landing push of the branch holding the landing lock; its own lane, no load wait, one at a time.
# HEAVY_LANE=light: a job under a minute (one test file, one tsc): its own lane, no load wait, one at a time.
# The locks are shared by every session's builders.
D=${LIFE_TOOLS_STATE:-/private/tmp/life-tools}
Q="$D/queue"; mkdir -p "$Q"
# Swift and Xcode compile on every core, so they are never light, even with a test filter.
case "${HEAVY_LANE:-} $*" in "light swift "*|light*"swift test"*|light*"swift build"*|light*xcodebuild*) HEAVY_LANE="" ;; esac
L=""
if [ -n "${HEAVY_LANE:-}" ]; then
  until mkdir "$D/check.lock.${HEAVY_LANE}" 2>/dev/null; do sleep 5; done
  L="$D/check.lock.${HEAVY_LANE}"
else
  me="$Q/$(date +%s).$$"; : >"$me"
  trap 'rm -f "$me"' EXIT
  until [ -n "$L" ]; do
    first=""
    for f in $(ls "$Q" | sort -n); do
      kill -0 "${f##*.}" 2>/dev/null && { first="$Q/$f"; break; } || rm -f "$Q/$f"
    done
    if [ "$first" = "$me" ]; then
      load=$(sysctl -n vm.loadavg | awk '{print int($2)}')
      [ "$load" -lt 60 ] && mkdir "$D/check.lock" 2>/dev/null && L="$D/check.lock"
      # second slot while the Mac is idle enough (velocity tick, 21 Nov evening)
      [ -z "$L" ] && [ "$load" -lt 30 ] && mkdir "$D/check.lock.2" 2>/dev/null && L="$D/check.lock.2"
    fi
    [ -n "$L" ] || sleep 10
  done
  rm -f "$me"
fi
trap 'rmdir "$L"' EXIT
# Xcode's compile cache is keyed by content, so it is shared safely (his "do build cache now", 21 Nov). Never a shared
# .build folder: a reused test build reads another worktree's files through #filePath. HEAVY_NO_CACHE=1 skips it.
[ -n "${HEAVY_NO_CACHE:-}" ] || export XCODE_XCCONFIG_FILE="$(cd "$(dirname "$0")" && pwd)/compile-cache.xcconfig"
# Swift builds run once per branch, on its landing push (his yes of 21 Nov); every other push skips them.
[ "${HEAVY_LANE:-}" = land ] || export LIFE_CHECK_SWIFT=at-landing
"$@"
