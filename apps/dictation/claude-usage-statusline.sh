#!/bin/sh
# Preserve stdin for both Life's usage bridge and an optional existing status-line renderer.
input=$(cat)
printf '%s' "$input" | "$HOME/.local/bin/lifelog-quiet" --claude-usage
if [ "$#" -gt 0 ]; then
    printf '%s' "$input" | "$@"
fi
