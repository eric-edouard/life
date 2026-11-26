#!/bin/bash
# heavy.sh <cmd...>: run a heavy local job (check, tests, tsc, xcodebuild, simulator), Mac-wide, one at a time.
# First come, first served: a job takes a slot only when no older job is still waiting.
# It starts under 1-minute load 60. One slot plus the land, light and release lanes: his cap of 21 Nov (a saturated Mac
# times tests out and reruns them).
# HEAVY_LANE=land: the landing push of the branch holding the landing lock; its own lane, no load wait, one at a time.
# HEAVY_LANE=release: an owner-facing build (Life.app, the phone install); it starts at once and queued jobs wait for it (its lock holds its pid; a dead holder blocks no one).
# HEAVY_LANE=light: a job under a minute (one test file, one tsc): its own lane, no load wait, one at a time.
# The locks are shared by every session's builders.
D=${LIFE_TOOLS_STATE:-/private/tmp/life-tools}
Q="$D/queue"; mkdir -p "$Q"
# Swift and Xcode compile on every core, so they are never light, even with a test filter.
case "${HEAVY_LANE:-} $*" in "light swift "*|light*"swift test"*|light*"swift build"*|light*xcodebuild*) HEAVY_LANE="" ;; esac
L=""
# Take a lock folder; one whose holder died (killed, crashed) is taken over. Every lock holds its holder's pid.
take() { local p; p=$(cat "$1/pid" 2>/dev/null); [ -n "$p" ] && ! kill -0 "$p" 2>/dev/null && rm -rf "$1"
  mkdir "$1" 2>/dev/null && echo $$ >"$1/pid"; }
if [ -n "${HEAVY_LANE:-}" ]; then
  until take "$D/check.lock.${HEAVY_LANE}"; do sleep 5; done
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
      # Crash guard (his ask, 21 Nov): no new heavy job while memory is short or swap is large; treat it as full load.
      memf=$(memory_pressure | awk -F': ' '/free percentage/{print int($2)}'); swapm=$(sysctl -n vm.swapusage | awk '{print int($6)}')
      { [ "${memf:-100}" -lt 10 ] || [ "${swapm:-0}" -gt 20000 ]; } && load=999
      # An owner-facing build (release lane) running goes first: no queued job starts a slot until it ends.
      kill -0 "$(cat "$D/check.lock.release/pid" 2>/dev/null)" 2>/dev/null && load=999
      [ "$load" -lt 60 ] && take "$D/check.lock" && L="$D/check.lock"
      # second slot while the Mac is idle enough (velocity tick, 21 Nov evening)
      [ -z "$L" ] && [ "$load" -lt 30 ] && take "$D/check.lock.2" && L="$D/check.lock.2"
    fi
    [ -n "$L" ] || sleep 10
  done
  rm -f "$me"
fi
trap 'rm -rf "$L"' EXIT
# Xcode's compile cache is keyed by content, so it is shared safely (his "do build cache now", 21 Nov). Never a shared
# .build folder: a reused test build reads another worktree's files through #filePath. HEAVY_NO_CACHE=1 skips it.
[ -n "${HEAVY_NO_CACHE:-}" ] || export XCODE_XCCONFIG_FILE="$(cd "$(dirname "$0")" && pwd)/compile-cache.xcconfig"
# Swift builds run once per branch, on its landing push (his yes of 21 Nov); every other push skips them.
[ "${HEAVY_LANE:-}" = land ] || export LIFE_CHECK_SWIFT=at-landing
# A push inside this slot (`tools/heavy.sh git push`, a landing) runs its pre-push check here, never queued again.
export HEAVY_HELD=1
nice -n 10 "$@"   # builds never starve his live Life (dictation took 10 s under load, 21 Nov)
