#!/bin/bash

# Get published packages
packages=$(npx lerna list --since HEAD~1 --json --no-progress 2>/dev/null | grep -v '^lerna' | jq -c '.[]')

if [ -z "$packages" ]; then
  echo "No packages published"
  exit 0
fi

# Generate output
output=""

# Add actor info if available
if [ -n "$GITHUB_ACTOR" ]; then
  output+="Published by *@${GITHUB_ACTOR}*"
  output+=$'\n\n'
fi

output+="*:package: Packages*"
output+=$'\n'

while IFS= read -r pkg; do
  name=$(echo "$pkg" | jq -r '.name')
  version=$(echo "$pkg" | jq -r '.version')
  location=$(echo "$pkg" | jq -r '.location')
  changelog="https://github.com/${GITHUB_REPOSITORY}/blob/main/$(realpath --relative-to=. "$location")/CHANGELOG.md"

  output+="• \`${name}@${version}\` <${changelog}|changelog>"
  output+=$'\n'
done <<< "$packages"

printf '%s' "$output"
