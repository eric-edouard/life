#!/bin/zsh
# Copies every KEY=value of ~/Work/life/.env into the login Keychain as service "Life", account KEY: what Life.app's
# helper reads (Helper.swift merges every item of service Life into its environment), Prints the names only. It may prompt
# for the login password, and Life.app blocks until it is answered (14 Nov 2026 outage): run it only with the owner at the Mac.
set -eu
env_file="${1:-$HOME/Work/life/.env}"
while IFS= read -r line; do
  [[ "$line" =~ '^([A-Z0-9_]+)=(.*)$' ]] || continue
  name="${match[1]}"
  value="${match[2]}"
  value="${value#\"}"; value="${value%\"}"; value="${value#\'}"; value="${value%\'}"
  security add-generic-password -U -s Life -a "$name" -T /Applications/Life.app -w "$value"
  print "Life: $name"
done < "$env_file"
