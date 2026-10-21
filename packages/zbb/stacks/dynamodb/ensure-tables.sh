#!/usr/bin/env bash
# Create DynamoDB tables in the slot's DynamoDB Local from descriptor files, idempotently. A descriptor
# is a JSON array of CreateTable inputs (as passed to CreateTableCommand); a table may also carry
# "ttl": "<attribute>" to enable Time To Live on that attribute. Existing tables are left as they are.
# Usage: ensure-tables.sh <tables.json>...           create missing tables, enable TTL
#        ensure-tables.sh --check <tables.json>...   exit 1 if any declared table is missing
#        ensure-tables.sh --ping                     exit 0 once DynamoDB Local answers
# Endpoint: DYNAMODB_URL (exported by the dynamodb stack). DynamoDB Local accepts any credentials.
set -euo pipefail

URL=${DYNAMODB_URL:?DYNAMODB_URL is not set (import it from the dynamodb stack)}

die() { echo "dynamodb: $*" >&2; exit 1; }

# POST one DynamoDB API call; prints the response body and fails on a non-2xx status.
ddb() {
  local out code
  out=$(curl -sS --max-time 10 -w '\n%{http_code}' -X POST "$URL/" \
    -H "X-Amz-Target: DynamoDB_20120810.$1" -H 'Content-Type: application/x-amz-json-1.0' \
    -H 'Authorization: AWS4-HMAC-SHA256 Credential=local/20200101/us-east-1/dynamodb/aws4_request, SignedHeaders=host, Signature=local' \
    -d "$2") || return 1
  code=${out##*$'\n'}
  printf '%s' "${out%$'\n'*}"
  [[ $code == 2* ]]
}

# Names of every table DynamoDB Local has, one per line (follows ListTables pagination).
existing_tables() {
  local req='{}' page last
  while :; do
    page=$(ddb ListTables "$req")
    jq -r '.TableNames[]' <<<"$page"
    last=$(jq -r '.LastEvaluatedTableName // empty' <<<"$page")
    [ -n "$last" ] || return 0
    req=$(jq -nc --arg t "$last" '{ExclusiveStartTableName: $t}')
  done
}

# Wait up to 60 s for DynamoDB Local to answer.
wait_ready() {
  local _
  for _ in $(seq 60); do ddb ListTables '{}' >/dev/null 2>&1 && return 0; sleep 1; done
  die "$URL is not answering"
}

# Fail unless a descriptor file is a JSON array of objects that each name a table.
validate() {
  [ -r "$1" ] || die "descriptor $1 not readable"
  jq -e 'type == "array" and all(.[]; type == "object" and (.TableName | type) == "string")' "$1" >/dev/null \
    || die "descriptor $1 must be a JSON array of CreateTable inputs with TableName"
}

# Create each missing table of a descriptor file and enable TTL where it names an attribute.
ensure_file() {
  local file=$1 have table name ttl status
  have=$(existing_tables)
  while read -r table; do
    name=$(jq -r .TableName <<<"$table")
    if ! grep -qxF "$name" <<<"$have"; then
      ddb CreateTable "$(jq -c 'del(.ttl)' <<<"$table")" >/dev/null || die "creating table $name failed"
      echo "dynamodb: created $name"
    fi
    ttl=$(jq -r '.ttl // empty' <<<"$table")
    [ -n "$ttl" ] || continue
    status=$(ddb DescribeTimeToLive "$(jq -nc --arg n "$name" '{TableName: $n}')" \
      | jq -r '.TimeToLiveDescription.TimeToLiveStatus // "DISABLED"')
    [ "$status" = ENABLED ] && continue
    ddb UpdateTimeToLive "$(jq -nc --arg n "$name" --arg a "$ttl" \
      '{TableName: $n, TimeToLiveSpecification: {Enabled: true, AttributeName: $a}}')" >/dev/null \
      || die "enabling TTL on $name failed"
  done < <(jq -c '.[]' "$file")
}

# Exit 1 naming the first table of the given descriptors that DynamoDB Local doesn't have.
check_files() {
  local have file name
  have=$(existing_tables)
  for file in "$@"; do
    for name in $(jq -r '.[].TableName' "$file"); do
      grep -qxF "$name" <<<"$have" || die "missing table $name"
    done
  done
}

case ${1:-} in
  --ping) ddb ListTables '{}' >/dev/null 2>&1 ;;
  --check)
    shift
    [ $# -gt 0 ] || die "usage: ensure-tables.sh --check <tables.json>..."
    for f in "$@"; do validate "$f"; done
    check_files "$@"
    ;;
  ''|-h|--help) sed -n '2,8p' "$0" | sed 's/^# \{0,1\}//'; exit 2 ;;
  *)
    for f in "$@"; do validate "$f"; done
    wait_ready
    for f in "$@"; do ensure_file "$f"; done
    ;;
esac
