#!/bin/bash

versions=($(npx lerna list --since HEAD~1 --json --no-progress | grep -v '^lerna' | jq -r '[ .[] | {name, version} | join (":")] | @sh' | tr -d \'\"))
dirs=($(npx lerna list --since HEAD~1 --json --no-progress | grep -v '^lerna' | jq -r '[ .[] | .location ] | @sh' | tr -d \'\"))

for ((i = 0 ; i < ${#versions[@]} ; i++)); do
  echo "${versions[$i]} https://github.com/${GITHUB_REPOSITORY}/blob/master/$(realpath --relative-to=. ${dirs[$i]})/CHANGELOG.md"
done
