#!/usr/bin/env bash
# =============================================================================
# kazahana-push-backend Recovery Script
# =============================================================================
#
# 2026-05-13 の障害概要 (unreachable 分岐):
#   Fly.io 個別ワーカーホスト（nrt zone 1ab3）が unreachable になり、
#   machine と同ホスト上の volume が応答不能に。Fly proxy ログでは
#     [PU03] unreachable worker host. this is a Fly issue.
#   と明示。machine restart / stop は API レベル 408 で失敗するため、
#   旧 machine を --force 破棄 → 同名の新 volume を別ホストに作成 →
#   fly deploy で復旧した。device_tokens テーブルは消失したが、
#   kazahana-ios/android は次回起動時に自動再登録するため、
#   実害は復旧までの通知不達のみだった。
#
# 2026-05-14 の障害概要 (down 分岐):
#   23:00 / 23:12 / 23:38 JST 頃に Sentinel で約 4 分間の連続無応答を 3 回検知。
#   machine は started・プロセスも生存だがイベントループのみブロック。
#   `fly logs` に node_modules/http2/lib/protocol/connection.js:355 の
#   MaxListenersExceededWarning（wakeup リスナー累積）が出ており、
#   node-apn 内部の旧 http2 パッケージで HTTP/2 フロー制御デッドロックが発生。
#   23:39 JST に APNs クライアントを node-apn から Bun fetch + WebCrypto の
#   自前実装に置換してデプロイ済み（per-call AbortSignal タイムアウト 10s）。
#   新実装では同種のデッドロックは原理的に発生しない想定だが、もし再発した
#   場合は `down` と判定され、本スクリプトの machine restart 分岐で復旧する
#   （volume 維持・device_tokens 保持）。
#
# このスクリプトの目的:
#   再発時に上記復旧手順をワンショットで実行する。
#   Sentinel が赤くなったら手動で叩く想定。
#
# 使い方:
#   scripts/recover.sh              # 対話モード（破壊操作前に確認）
#   scripts/recover.sh --yes        # 確認を全てスキップ（自動実行用）
#   scripts/recover.sh --dry-run    # 何を実行するかだけ表示
#   scripts/recover.sh --help       # このヘッダコメントを表示
#
# 必要なもの:
#   - flyctl にログイン済み（`flyctl auth whoami` が通る ／ `flyctl auth login`）
#   - curl, awk
#
# 動作フロー:
#   1. /health を叩いて生存確認。OK なら何もせず終了
#   2. `fly status` でマシン状態を確認
#   3. host 到達可能なら `flyctl machine restart` を試す
#   4. host unreachable なら：
#      a. 旧 machine を `--force` 破棄（control plane で完結）
#      b. 同名の新 volume を nrt に作成（別ホストに配置される）
#      c. `fly deploy` で新 machine を起動
#   5. /health が 200 を返すまで最大 180s ポーリング
#
# 注意事項:
#   - case 4 を実行すると device_tokens テーブルが消えます。
#     クライアントは次回起動時に自動再登録するためユーザ操作は不要ですが、
#     再登録されるまで該当ユーザに通知は届きません。
#   - 旧ボリュームが unreachable host に取り残されるため、
#     Fly 側でホスト復旧後に手動で `flyctl volumes destroy <id>` してください
#     （課金が継続するため）。スクリプト末尾で残存ボリューム ID を表示します。
# =============================================================================

set -euo pipefail

APP="kazahana-push-backend"
HEALTH_URL="https://${APP}.fly.dev/health"
REGION="nrt"
VOLUME_NAME="kazahana_push_data"
VOLUME_SIZE_GB=1
HEALTH_TIMEOUT=10
POST_DEPLOY_TIMEOUT=180
POLL_INTERVAL=5

ASSUME_YES=0
DRY_RUN=0

for arg in "$@"; do
  case "$arg" in
    -y|--yes) ASSUME_YES=1 ;;
    --dry-run) DRY_RUN=1 ;;
    -h|--help)
      awk 'NR>1 && /^#/ {print; next} NR>1 {exit}' "$0"
      exit 0
      ;;
    *) echo "Unknown arg: $arg" >&2; exit 2 ;;
  esac
done

log() { printf '[recover] %s\n' "$*"; }
err() { printf '[recover] ERROR: %s\n' "$*" >&2; }

confirm() {
  local prompt="$1"
  if [[ "$ASSUME_YES" == "1" ]]; then return 0; fi
  read -r -p "$prompt [y/N] " ans
  [[ "$ans" == "y" || "$ans" == "Y" ]]
}

run() {
  log "+ $*"
  if [[ "$DRY_RUN" == "1" ]]; then return 0; fi
  "$@"
}

probe_health() {
  curl -fsS --max-time "$HEALTH_TIMEOUT" "$HEALTH_URL" >/dev/null 2>&1
}

wait_for_health() {
  local elapsed=0
  while (( elapsed < POST_DEPLOY_TIMEOUT )); do
    if probe_health; then return 0; fi
    sleep "$POLL_INTERVAL"
    elapsed=$((elapsed + POLL_INTERVAL))
    log "  waiting for /health ... ${elapsed}s / ${POST_DEPLOY_TIMEOUT}s"
  done
  return 1
}

machine_ids() {
  flyctl machine list -a "$APP" 2>/dev/null \
    | awk '/^[0-9a-f]{14}/ {gsub(/\*/, "", $1); print $1}'
}

detect_state() {
  if probe_health; then
    echo "healthy"
    return
  fi
  local out
  if ! out=$(flyctl status -a "$APP" 2>&1); then
    err "flyctl status failed:"
    err "$out"
    echo "unknown"
    return
  fi
  if grep -qE '💀|could not be reached|host is unreachable' <<<"$out"; then
    echo "unreachable"
  else
    echo "down"
  fi
}

orphan_volumes() {
  flyctl volumes list -a "$APP" 2>/dev/null \
    | awk '/\*$/ {print $1}'
}

main() {
  command -v flyctl >/dev/null || { err "flyctl not in PATH"; exit 1; }
  command -v curl   >/dev/null || { err "curl not in PATH"; exit 1; }
  command -v awk    >/dev/null || { err "awk not in PATH"; exit 1; }
  flyctl auth whoami >/dev/null 2>&1 || { err "flyctl not logged in (run 'flyctl auth login')"; exit 1; }

  log "probing $HEALTH_URL ..."
  local state
  state=$(detect_state)
  log "detected state: $state"

  case "$state" in
    healthy)
      log "service is healthy — nothing to do"
      exit 0
      ;;
    down)
      local mid
      mid=$(machine_ids | head -n1)
      if [[ -z "$mid" ]]; then
        err "no machines found and host is reachable — falling through to deploy"
        confirm "Run 'fly deploy' to create a new machine?" || { log "aborted"; exit 1; }
        local project_dir
        project_dir=$(cd "$(dirname "$0")/.." && pwd)
        run flyctl deploy -c "$project_dir/fly.toml" --remote-only
      else
        log "host reachable but health failing — attempting restart of $mid"
        confirm "Restart machine $mid?" || { log "aborted"; exit 1; }
        run flyctl machine restart "$mid" -a "$APP"
      fi
      ;;
    unreachable)
      log "host unreachable — full rebuild required"
      log "  WARNING: device_tokens will be wiped; clients re-register on next launch"
      confirm "Proceed with rebuild?" || { log "aborted"; exit 1; }

      log "step 1/3: destroying unreachable machine(s) with --force"
      local ids
      ids=$(machine_ids)
      if [[ -n "$ids" ]]; then
        for mid in $ids; do
          run flyctl machine destroy "$mid" -a "$APP" --force || true
        done
      else
        log "  (no machines to destroy)"
      fi

      log "step 2/3: creating new volume '$VOLUME_NAME' (${VOLUME_SIZE_GB}GB) in $REGION"
      run flyctl volumes create "$VOLUME_NAME" -a "$APP" --region "$REGION" --size "$VOLUME_SIZE_GB" --yes

      log "step 3/3: fly deploy"
      local project_dir
      project_dir=$(cd "$(dirname "$0")/.." && pwd)
      run flyctl deploy -c "$project_dir/fly.toml" --remote-only
      ;;
    *)
      err "unknown state — aborting"
      err "manual investigation: flyctl status -a $APP && flyctl logs -a $APP"
      exit 1
      ;;
  esac

  log "verifying $HEALTH_URL ..."
  if [[ "$DRY_RUN" == "1" ]]; then
    log "(dry-run: skipping health verification)"
  elif wait_for_health; then
    log "SUCCESS — /health is responding"
  else
    err "service did not become healthy within ${POST_DEPLOY_TIMEOUT}s"
    err "investigate: flyctl status -a $APP && flyctl logs -a $APP"
    exit 1
  fi

  local orphans
  orphans=$(orphan_volumes || true)
  if [[ -n "$orphans" ]]; then
    log ""
    log "FOLLOW-UP: orphaned volumes on unreachable hosts (delete after host recovers):"
    while IFS= read -r vid; do
      log "  flyctl volumes destroy $vid -a $APP --yes"
    done <<<"$orphans"
  fi
}

main "$@"
