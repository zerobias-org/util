#!/usr/bin/env bash
# zbb shell hook — sourced in the slot subshell.
# Provides:
#   - cd hook: scopes env to the current stack on directory change
#   - zbb() wrapper: syncs env after stack/env mutations

# ── State ────────────────────────────────────────────────────────────

_ZBB_CURRENT_STACK=""
_ZBB_CURRENT_STACK_VARS=()

# ── Load a stack's .env into the current shell ───────────────────────

_zbb_load_stack_env() {
  local stack_name="$1"
  local slot_dir="${ZB_SLOT_DIR:-}"
  local stacks_dir="${ZB_STACKS_DIR:-$slot_dir/stacks}"
  local env_file="$stacks_dir/$stack_name/.env"

  # Unset previous stack's vars (but preserve slot-level vars)
  if [ ${#_ZBB_CURRENT_STACK_VARS[@]} -gt 0 ]; then
    for var in "${_ZBB_CURRENT_STACK_VARS[@]}"; do
      # Never unset slot-level vars — they must persist across stack changes
      case "$var" in
        ZB_SLOT|ZB_SLOT_DIR|ZB_SLOT_CONFIG|ZB_SLOT_LOGS|ZB_SLOT_STATE|ZB_SLOT_TMP|ZB_STACKS_DIR|STACK_NAME) ;;
        *) unset "$var" 2>/dev/null ;;
      esac
    done
    _ZBB_CURRENT_STACK_VARS=()
  fi

  _ZBB_CURRENT_STACK="$stack_name"

  # If no stack, we're done (just cleared vars)
  [ -z "$stack_name" ] && return

  # Source the stack's .env if it exists
  if [ -f "$env_file" ]; then
    local key value
    while IFS='=' read -r key value; do
      [ -z "$key" ] && continue
      [[ "$key" =~ ^[[:space:]]*# ]] && continue
      key=$(echo "$key" | xargs)
      export "$key=$value"
      _ZBB_CURRENT_STACK_VARS+=("$key")
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

  while [ "$dir" != "/" ]; do
    if [ -f "$dir/zbb.yaml" ]; then
      local name
      name=$(grep -m1 '^name:' "$dir/zbb.yaml" 2>/dev/null | sed 's/^name:[[:space:]]*//' | sed 's/^["'"'"']//' | sed 's/["'"'"']$//')
      if [ -n "$name" ]; then
        local candidate="${name##*/}"
        # Only activate if this stack has been added to the slot
        if [ -d "$stacks_dir/$candidate" ]; then
          stack_name="$candidate"
        fi
        break
      fi
    fi
    dir=$(dirname "$dir")
  done

  # If same stack and not a forced reload, skip
  [ "$stack_name" = "$_ZBB_CURRENT_STACK" ] && [ "${_ZBB_FORCE_RELOAD:-}" != "1" ] && return

  local prev="$_ZBB_CURRENT_STACK"
  _ZBB_FORCE_RELOAD=""

  _zbb_load_stack_env "$stack_name"

  # Log the transition
  if [ -n "$stack_name" ] && [ "$stack_name" != "$prev" ]; then
    echo "[stack: $stack_name]"
  elif [ -z "$stack_name" ] && [ -n "$prev" ]; then
    echo "[stack: none]"
  elif [ -n "$stack_name" ] && [ "$stack_name" = "$prev" ]; then
    echo "[stack: $stack_name] (reloaded)"
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
        set|unset|reset)
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
