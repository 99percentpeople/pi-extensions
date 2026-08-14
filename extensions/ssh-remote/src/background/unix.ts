import {
  controlDirectoryName,
  remoteSignalName,
  UNIX_TERMINATING_SIGNALS,
  type BackgroundSignal,
} from "./control.ts";
import { shellQuote } from "../workspace/target.ts";

const TERMINATING_SIGNALS = new Set<BackgroundSignal>(UNIX_TERMINATING_SIGNALS);

/**
 * Wrap a remote Unix command with a private, per-launch process-group record.
 * A second SSH channel can then signal the real remote process group rather
 * than killing ssh(1), which can otherwise leave the command orphaned.
 */
export function buildUnixBackgroundShellCommand(
  command: string,
  token: string,
): string {
  const directory = controlDirectoryName(token);
  const childRunner = [
    'child_state=$1',
    'printf \'%s\\n\' "$$" > "$child_state.tmp" || exit 70',
    'mv -f "$child_state.tmp" "$child_state" || exit 70',
    'exec sh -c "$2"',
  ].join("\n");
  const supervisor = [
    `control_dir="\${TMPDIR:-/tmp}/${directory}"`,
    'state="$control_dir/state"',
    'child_state="$control_dir/child"',
    'cleanup() { rm -f "$state" "$state.tmp" "$child_state" "$child_state.tmp"; rmdir "$control_dir" 2>/dev/null || :; }',
    "umask 077",
    'mkdir -m 700 "$control_dir" || exit 70',
    "trap 'cleanup' EXIT",
    'pgid=$(ps -o pgid= -p $$ 2>/dev/null | tr -d \'[:space:]\')',
    // A caught no-op disposition protects the supervisor when the whole group
    // is signaled. Unlike SIG_IGN (`trap ''`), caught dispositions are reset
    // to the default when the synchronous child shell is exec'd, so Bash user
    // scripts can install their own traps for every one of these signals.
    "trap ':' HUP INT QUIT TERM ABRT ALRM PIPE USR1 USR2",
    'case "$pgid" in',
    "  ''|*[!0-9]*) mode=tree; target=$$ ;;",
    "  *) mode=group; target=$pgid ;;",
    "esac",
    'printf \'%s %s %s\\n\' "$mode" "$target" "$$" > "$state.tmp" || exit 70',
    'mv -f "$state.tmp" "$state" || exit 70',
    // Keep the command in the foreground. POSIX shells force SIGINT/SIGQUIT
    // to SIG_IGN for asynchronous (`&`) children, which makes later Bash
    // `trap INT/QUIT` declarations silently ineffective.
    'sh -c "$2" sh "$child_state" "$1"',
    "status=$?",
    'exit "$status"',
  ].join("\n");
  return `sh -c ${shellQuote(supervisor)} sh ${shellQuote(command)} ${shellQuote(childRunner)}`;
}

/** Build the remote Unix half of a background signal control request. */
export function buildUnixBackgroundSignalCommand(
  token: string,
  signal: BackgroundSignal,
): string {
  const directory = controlDirectoryName(token);
  const signalName = remoteSignalName(signal);
  const terminating = TERMINATING_SIGNALS.has(signal) ? "1" : "0";
  const controller = [
    `control_dir="\${TMPDIR:-/tmp}/${directory}"`,
    'state="$control_dir/state"',
    'child_state="$control_dir/child"',
    'cleanup() { rm -f "$state" "$state.tmp" "$child_state" "$child_state.tmp"; rmdir "$control_dir" 2>/dev/null || :; }',
    "attempt=0",
    'while [ ! -r "$state" ] && [ "$attempt" -lt 30 ]; do',
    "  attempt=$((attempt + 1))",
    "  sleep 0.1",
    "done",
    '[ -r "$state" ] || exit 75',
    'IFS=\' \' read -r mode target root < "$state" || exit 75',
    'case "$target:$root" in *[!0-9:]*|:*|*:) exit 76 ;; esac',
    "descendants_of() {",
    "  ps -e -o pid= -o ppid= 2>/dev/null | awk -v root=\"$1\" '",
    "    { parent[$1] = $2 }",
    "    END {",
    "      for (pid in parent) {",
    "        current = pid",
    "        hops = 0",
    "        while ((current in parent) && current != root && current != 1 && hops < 1000) {",
    "          current = parent[current]",
    "          hops++",
    "        }",
    "        if (current == root && pid != root) print pid",
    "      }",
    "    }'",
    "}",
    // The synchronous child publishes its own PID before exec. This avoids a
    // full ps/awk scan on the normal process-group path and closes the race for
    // an immediately chained bg_kill.
    "attempt=0",
    'while [ ! -r "$child_state" ] && kill -0 "$root" 2>/dev/null && [ "$attempt" -lt 30 ]; do',
    "  attempt=$((attempt + 1))",
    "  sleep 0.1",
    "done",
    '[ -r "$child_state" ] || { if ! kill -0 "$root" 2>/dev/null; then cleanup; fi; exit 77; }',
    'IFS= read -r child < "$child_state" || exit 76',
    'case "$child" in \'\'|*[!0-9]*) exit 76 ;; esac',
    'kill -0 "$child" 2>/dev/null || { if ! kill -0 "$root" 2>/dev/null; then cleanup; fi; exit 77; }',
    'if [ "$mode" = group ]; then',
    '  current_root_pgid=$(ps -o pgid= -p "$root" 2>/dev/null | tr -d \'[:space:]\')',
    '  current_child_pgid=$(ps -o pgid= -p "$child" 2>/dev/null | tr -d \'[:space:]\')',
    '  case "$current_root_pgid:$current_child_pgid" in',
    '    "$target:$target"|:) : ;;',
    '    *) cleanup; exit 77 ;;',
    '  esac',
    'fi',
    `signal_name=${signalName}`,
    "status=1",
    'if [ "$mode" = group ]; then',
    '  kill -s "$signal_name" -- "-$target" 2>/dev/null && status=0 || :',
    'elif [ "$mode" != tree ]; then',
    "  exit 76",
    "fi",
    // BusyBox ash does not accept `kill ... -- -PGID`, and a target can
    // disappear between state-file lookup and delivery. Fall back to a
    // positive-PID process-tree walk whenever group delivery did not work.
    'if [ "$status" -ne 0 ]; then',
    '  descendants=$(descendants_of "$root")',
    '  if [ -n "$descendants" ]; then',
    '    kill -s "$signal_name" $descendants 2>/dev/null && status=0 || :',
    "  fi",
    '  kill -s "$signal_name" "$root" 2>/dev/null && status=0 || :',
    "fi",
    // Some BusyBox kill builtins deliver a negative-PGID signal but return a
    // failure for the unsupported `--` token. Treat a dead/zombie supervisor
    // as successful delivery after the positive-PID fallback has been tried.
    'if [ "$status" -ne 0 ]; then',
    '  process_state=$(ps -o stat= -p "$root" 2>/dev/null | tr -d \'[:space:]\')',
    '  if ! kill -0 "$root" 2>/dev/null; then status=0; cleanup; fi',
    '  case "$process_state" in Z*|z*) status=0; cleanup ;; esac',
    "fi",
    '[ "$status" -eq 0 ] || exit 77',
    `if [ ${terminating} -eq 1 ]; then`,
    "  attempt=0",
    '  while kill -0 "$root" 2>/dev/null && [ "$attempt" -lt 20 ]; do',
    '    process_state=$(ps -o stat= -p "$root" 2>/dev/null | tr -d \'[:space:]\')',
    '    case "$process_state" in Z*|z*) break ;; esac',
    "    attempt=$((attempt + 1))",
    "    sleep 0.05",
    "  done",
    '  process_state=$(ps -o stat= -p "$root" 2>/dev/null | tr -d \'[:space:]\')',
    '  if [ "$signal_name" = KILL ] || ! kill -0 "$root" 2>/dev/null; then',
    "    cleanup",
    "  else",
    '    case "$process_state" in Z*|z*) cleanup ;; esac',
    "  fi",
    "fi",
    "exit 0",
  ].join("\n");
  return `sh -c ${shellQuote(controller)}`;
}

/** Probe whether a Unix background supervisor still owns the control record. */
export function buildUnixBackgroundProbeCommand(token: string): string {
  const directory = controlDirectoryName(token);
  const controller = [
    `control_dir="\${TMPDIR:-/tmp}/${directory}"`,
    'state="$control_dir/state"',
    'child_state="$control_dir/child"',
    'cleanup() { rm -f "$state" "$state.tmp" "$child_state" "$child_state.tmp"; rmdir "$control_dir" 2>/dev/null || :; }',
    'if [ ! -r "$state" ]; then printf \'PI_SSH_BG_STATUS=finished\\n\'; exit 0; fi',
    'IFS=\' \' read -r mode target root < "$state" || exit 76',
    'case "$target:$root" in *[!0-9:]*|:*|*:) exit 76 ;; esac',
    'if ! kill -0 "$root" 2>/dev/null; then cleanup; printf \'PI_SSH_BG_STATUS=finished\\n\'; exit 0; fi',
    'if [ "$mode" = group ]; then',
    '  current_pgid=$(ps -o pgid= -p "$root" 2>/dev/null | tr -d \'[:space:]\')',
    '  if [ -n "$current_pgid" ] && [ "$current_pgid" != "$target" ]; then cleanup; printf \'PI_SSH_BG_STATUS=finished\\n\'; exit 0; fi',
    'fi',
    'process_state=$(ps -o stat= -p "$root" 2>/dev/null | tr -d \'[:space:]\')',
    'case "$process_state" in Z*|z*) cleanup; printf \'PI_SSH_BG_STATUS=finished\\n\' ;; *) printf \'PI_SSH_BG_STATUS=running\\n\' ;; esac',
    "exit 0",
  ].join("\n");
  return `sh -c ${shellQuote(controller)}`;
}
