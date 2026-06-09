#!/usr/bin/env bash
# zbb shell hook — sourced in the slot subshell.
# Provides:
#   - cd hook: scopes env to the current stack on directory change
#   - prompt update: PS1 shows [zb:slot:scope:name] when in an added stack
#   - zbb() wrapper: syncs env after stack/env mutations

# ── State ────────────────────────────────────────────────────────────

_ZBB_CURRENT_STACK=""
_ZBB_CURRENT_STACK_VARS=()
# Full npm package name of the active stack (e.g. "@zerobias-org/util")
_ZBB_CURRENT_STACK_FULL=""
# mtime of the stack's .env when last loaded. Lets us detect external
# rewrites (vault re-pull at slot load elsewhere, another terminal
# running `zbb env set`, etc.) so we reload instead of trusting the
# already-in-stack short-circuit. Without this, a stack .env that's
# updated AFTER the subshell entered the stack stays invisible until
# the user manually `source ~/.bashrc` or exits/re-enters the slot.
_ZBB_CURRENT_STACK_ENV_MTIME=""
# Every key zbb has ever exported into this shell (across all stacks). On
# each scope change we reconcile against this set: any tracked key no
# longer present in the new stack's .env is unset, so the live shell
# matches disk (a removed override disappears) instead of only ever adding
# vars. Plain indexed array for bash 3.2 (macOS) portability.
_ZBB_ALL_EXPORTED_VARS=()

# ── Helpers ──────────────────────────────────────────────────────────

# Membership test against a space-separated list (avoids bash-4 assoc
# arrays so the hook keeps working on macOS's stock bash 3.2).
_zbb_in_list() {
  local needle="$1" hay="$2" item
  for item in $hay; do
    [ "$item" = "$needle" ] && return 0
  done
  return 1
}

# ── Load a stack's .env into the current shell ───────────────────────

_zbb_load_stack_env() {
  local stack_name="$1"
  local slot_dir="${ZB_SLOT_DIR:-}"
  local stacks_dir="${ZB_STACKS_DIR:-$slot_dir/stacks}"
  local env_file="$stacks_dir/$stack_name/.env"

  # Collect the keys the new stack .env defines (space-separated).
  local new_keys=""
  if [ -n "$stack_name" ] && [ -f "$env_file" ]; then
    local k v
    while IFS='=' read -r k v; do
      [ -z "$k" ] && continue
      [[ "$k" =~ ^[[:space:]]*# ]] && continue
      k=$(echo "$k" | xargs)
      new_keys="$new_keys $k"
    done < "$env_file"
  fi

  # Reconcile: unset every previously-exported zbb var that is NOT in the
  # new set (slot-level vars always persist). Superset of the old "unset
  # the previous stack's vars" pass — robust across stack hops and
  # external .env edits (e.g. another terminal running `zbb env unset`).
  if [ ${#_ZBB_ALL_EXPORTED_VARS[@]} -gt 0 ]; then
    local kept=()
    local var
    for var in "${_ZBB_ALL_EXPORTED_VARS[@]}"; do
      case "$var" in
        ZB_SLOT|ZB_SLOT_DIR|ZB_SLOT_CONFIG|ZB_SLOT_LOGS|ZB_SLOT_STATE|ZB_SLOT_TMP|ZB_STACKS_DIR) continue ;;
      esac
      if _zbb_in_list "$var" "$new_keys"; then
        kept+=("$var")
      else
        unset "$var" 2>/dev/null
      fi
    done
    _ZBB_ALL_EXPORTED_VARS=("${kept[@]}")
  fi

  _ZBB_CURRENT_STACK="$stack_name"
  _ZBB_CURRENT_STACK_VARS=()

  # If no stack, we're done (just reconciled vars)
  [ -z "$stack_name" ] && return

  # Source the stack's .env if it exists
  if [ -f "$env_file" ]; then
    local key value
    while IFS='=' read -r key value; do
      [ -z "$key" ] && continue
      [[ "$key" =~ ^[[:space:]]*# ]] && continue
      key=$(echo "$key" | xargs)
      # Unescape \n and \r written by serializeEnv (new single-line format)
      value="${value//\\n/$'\n'}"
      value="${value//\\r/$'\r'}"
      value="${value//\\\\/\\}"
      export "$key=$value"
      _ZBB_CURRENT_STACK_VARS+=("$key")
      if ! _zbb_in_list "$key" "${_ZBB_ALL_EXPORTED_VARS[*]}"; then
        _ZBB_ALL_EXPORTED_VARS+=("$key")
      fi
    done < "$env_file"
  fi
}

# ── cd hook: detect stack from cwd ───────────────────────────────────

_zbb_scope_env() {
  local slot_dir="${ZB_SLOT_DIR:-}"
  local stacks_dir="${ZB_STACKS_DIR:-$slot_dir/stacks}"

  [ -z "$slot_dir" ] && return
  [ ! -d "$stacks_dir" ] && return

  # Walk up from cwd looking for a zbb.yaml with a 'name:' field
  local dir="$PWD"
  local stack_name=""
  local stack_full=""

  # Walk up looking for the nearest zbb.yaml whose stack is actually added
  # to the slot. Nested packages (e.g. appliance/zbb.yaml inside
  # com/hub/zbb.yaml) may declare their own identity without being
  # standalone stacks in the slot — in that case the hub stack from the
  # parent dir is the right scope. Don't stop at the first zbb.yaml;
  # stop at the first one that matches an added stack.
  while [ "$dir" != "/" ]; do
    if [ -f "$dir/zbb.yaml" ]; then
      local name
      name=$(grep -m1 '^name:' "$dir/zbb.yaml" 2>/dev/null | sed 's/^name:[[:space:]]*//' | sed 's/^["'"'"']//' | sed 's/["'"'"']$//')
      if [ -n "$name" ]; then
        # Match by IDENTITY: find the added stack whose stack.yaml `name`
        # equals this repo's full scoped name. Collision-proof and works with
        # scope-qualified dirs (e.g. 'org-util') — the dir name may differ
        # from the short name, but the identity is exact. Mirrors the TS
        # resolveStackForCwd.
        local sd sid
        for sd in "$stacks_dir"/*/; do
          [ -f "${sd}stack.yaml" ] || continue
          sid=$(grep -m1 '^name:' "${sd}stack.yaml" 2>/dev/null | sed 's/^name:[[:space:]]*//' | sed 's/^["'"'"']//' | sed 's/["'"'"']$//')
          if [ "$sid" = "$name" ]; then
            stack_name=$(basename "$sd")
            stack_full="$name"
            break 2
          fi
        done
      fi
    fi
    dir=$(dirname "$dir")
  done

  # Refresh PS1 every prompt redraw (cheap, idempotent). The format is:
  #   [zb:<slot>]                — no active stack
  #   [zb:<slot>:<scope>:<name>] — in an added stack, where <scope> is the
  #                                trailing piece of the npm scope after
  #                                "zerobias-" (e.g. "org" or "com") and
  #                                <name> is the package short name.
  if [ -n "$stack_full" ]; then
    local scope="${stack_full%%/*}"           # "@zerobias-org"
    scope="${scope#@}"                          # "zerobias-org"
    scope="${scope#zerobias-}"                  # "org" (or unchanged if no zerobias- prefix)
    PS1="\[\033[01;36m\][zb:${ZB_SLOT}:${scope}:${stack_name}]\[\033[00m\]:\[\033[01;34m\]\w\[\033[00m\]\$ "
  else
    PS1="\[\033[01;36m\][zb:${ZB_SLOT}]\[\033[00m\]:\[\033[01;34m\]\w\[\033[00m\]\$ "
  fi

  # If same stack and not a forced reload, also check whether the stack
  # .env was rewritten on disk since we last loaded it. The original
  # short-circuit assumed `_ZBB_CURRENT_STACK == stack_name` was enough,
  # but stack .envs can be rewritten by another terminal (`zbb env set`),
  # by vault re-pull on a fresh slot load elsewhere, or by zbb itself
  # during a command — and the subshell would silently keep stale values
  # until the user exited and re-entered. mtime check is one stat() per
  # prompt redraw, near-free.
  local env_file=""
  local env_mtime=""
  if [ -n "$stack_name" ]; then
    env_file="$stacks_dir/$stack_name/.env"
    if [ -f "$env_file" ]; then
      # GNU stat first, BSD stat fallback (macOS).
      env_mtime=$(stat -c '%Y' "$env_file" 2>/dev/null || stat -f '%m' "$env_file" 2>/dev/null || echo "")
    fi
  fi

  if [ "$stack_name" = "$_ZBB_CURRENT_STACK" ] \
     && [ "${_ZBB_FORCE_RELOAD:-}" != "1" ] \
     && [ "$env_mtime" = "$_ZBB_CURRENT_STACK_ENV_MTIME" ]; then
    return
  fi

  local prev="$_ZBB_CURRENT_STACK"
  local prev_mtime="$_ZBB_CURRENT_STACK_ENV_MTIME"
  _ZBB_FORCE_RELOAD=""

  _ZBB_CURRENT_STACK_FULL="$stack_full"
  _zbb_load_stack_env "$stack_name"
  _ZBB_CURRENT_STACK_ENV_MTIME="$env_mtime"

  # Log the transition
  if [ -n "$stack_name" ] && [ "$stack_name" != "$prev" ]; then
    echo "[stack: $stack_name]"
  elif [ -z "$stack_name" ] && [ -n "$prev" ]; then
    echo "[stack: none]"
  elif [ -n "$stack_name" ] && [ "$stack_name" = "$prev" ]; then
    if [ "$env_mtime" != "$prev_mtime" ]; then
      echo "[stack: $stack_name] (.env updated — reloaded)"
    else
      echo "[stack: $stack_name] (reloaded)"
    fi
  fi
}

# ── Heartbeat alert display ──────────────────────────────────────────

_zbb_check_heartbeat_alerts() {
  local alerts_file="${ZB_SLOT_DIR:-}/state/heartbeat-alerts.log"
  if [ -f "$alerts_file" ] && [ -s "$alerts_file" ]; then
    # Display alerts with bell
    echo -ne "\a"
    cat "$alerts_file"
    # Clear after display
    > "$alerts_file"
  fi
}

# Hook into cd via PROMPT_COMMAND (append, don't replace)
if [[ ! "$PROMPT_COMMAND" =~ _zbb_scope_env ]]; then
  PROMPT_COMMAND="${PROMPT_COMMAND:+$PROMPT_COMMAND;}_zbb_scope_env;_zbb_check_heartbeat_alerts"
fi

# ── zbb wrapper ──────────────────────────────────────────────────────

# Wrap the zbb binary so that mutations to stack/env re-source the shell.
zbb() {
  command zbb "$@"
  local rc=$?
  case "$1" in
    env)
      case "$2" in
        set|unset|reset|resolve|refresh)
          _ZBB_FORCE_RELOAD=1
          _zbb_scope_env
          ;;
      esac
      ;;
    stack)
      case "$2" in
        add|remove|start|stop|restart)
          _ZBB_FORCE_RELOAD=1
          _zbb_scope_env
          ;;
      esac
      ;;
  esac
  return $rc
}

# Run initial scope on source
_zbb_scope_env
