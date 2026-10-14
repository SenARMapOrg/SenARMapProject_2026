#!/usr/bin/env bash
# IKU NAVI ツール かんたんインストール・起動スクリプト（Mac 向け。Linux でもおおむね動く）
#
# ターミナルに次の1行を貼って Enter を押すだけで、必要なものを入れてツールを起動する:
#
#   curl -fsSL https://cdn.iku-navi.net/tools/install.sh | bash
#
# 2回目からも同じ1行で起動できる（入っているものは飛ばすので速い）。デスクトップにできる
# 「IKU NAVI ツール.command」をダブルクリックしても起動できる。
#
# やること:
#   1. リポジトリ（~/GitHub/SenARMapProject_2026）が無ければ clone する。main にいて変更が無ければ最新にする
#   2. Python 3.13 が無ければ Homebrew で入れる（Homebrew が無ければ、Mac に最初からある Python 3.9 を使う）
#   3. programs/IKU_NAVI_Tools/.venv を作り、requirements.txt を入れる（requirements.txt が変わったときだけ入れ直す）
#   4. デスクトップに起動用のファイルを作り、ツールを起動する
#
# オプション（curl … | bash -s -- --lite のように付ける）:
#   --lite         人物ぼかし（ultralytics・PyTorch、約1GB）を入れない。ほかのタブは使える
#   --no-launch    入れるだけで起動しない
#   --no-shortcut  デスクトップに起動用のファイルを作らない
#   --repo <場所>  リポジトリの場所（既定: ~/GitHub/SenARMapProject_2026。環境変数 IKU_REPO でも指定できる）
#
# 配布（管理者向け）: このファイルを変えたら、R2 の iku-navi-image バケットに上げ直す（README 参照）
#   npx wrangler r2 object put iku-navi-image/tools/install.sh --file programs/IKU_NAVI_Tools/install.sh \
#     --content-type "text/x-shellscript; charset=utf-8" --cache-control "no-cache" --remote
#
# 全体を main 関数に入れているのは、curl でのダウンロードが途中で切れたときに、途中までの行だけが
# 実行されないようにするため（最後の行まで読めたときだけ main が呼ばれる）。

main() {
  set -euo pipefail

  local REPO_URL="https://github.com/SenARMapOrg/SenARMapProject_2026.git"
  local REPO="${IKU_REPO:-$HOME/GitHub/SenARMapProject_2026}"
  local LITE=0 LAUNCH=1 SHORTCUT=1

  while [ $# -gt 0 ]; do
    case "$1" in
      --lite) LITE=1 ;;
      --no-launch) LAUNCH=0 ;;
      --no-shortcut) SHORTCUT=0 ;;
      --repo) shift; REPO="${1:?--repo の後に場所を書いてください}" ;;
      -h|--help) sed -n '2,25p' "$0" 2>/dev/null || true; return 0 ;;
      *) die "知らないオプションです: $1（使えるのは --lite / --no-launch / --no-shortcut / --repo）" ;;
    esac
    shift
  done

  local OS
  OS="$(uname -s)"
  case "$OS" in
    Darwin|Linux) ;;
    *) die "このスクリプトは Mac（と Linux）用です。Windows では programs/IKU_NAVI_Tools/README.md の手順で入れてください。" ;;
  esac

  title "IKU NAVI ツールを準備します"

  # ---------------------------------------------------------------- 1. リポジトリ
  step "1/4 リポジトリを確認しています"
  command -v git >/dev/null 2>&1 || die "git がありません。Mac なら「xcode-select --install」を実行してから、もう一度この1行を実行してください。"
  if [ ! -d "$REPO/.git" ]; then
    info "$REPO が無いので、GitHub から取ってきます（数分かかります）"
    mkdir -p "$(dirname "$REPO")"
    git clone --quiet "$REPO_URL" "$REPO" </dev/null || die "clone できませんでした。ネットにつながっているか確かめてください。"
  fi
  local TOOLS="$REPO/programs/IKU_NAVI_Tools"
  [ -f "$TOOLS/main.py" ] || die "$TOOLS/main.py がありません。リポジトリの場所が違うときは --repo で指定してください。"

  # main にいて変更が無いときだけ最新にする（作業中のブランチや変更には触らない）
  local BRANCH
  BRANCH="$(git -C "$REPO" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")"
  if [ "$BRANCH" = "main" ] && [ -z "$(git -C "$REPO" status --porcelain --untracked-files=no 2>/dev/null)" ]; then
    if git -C "$REPO" pull --ff-only --quiet </dev/null 2>/dev/null; then
      ok "最新の main にしました"
    else
      warn "最新にできませんでした（ネットにつながっていない など）。今あるもので続けます"
    fi
  else
    warn "今のブランチは「${BRANCH:-不明}」か、変更があるため、最新にはしません（そのままのツールで起動します）"
  fi

  # ---------------------------------------------------------------- 2. Python
  step "2/4 Python を確認しています"
  load_brew
  local PY=""
  PY="$(find_python 3.13 3.12 3.11 3.10)"
  if [ -z "$PY" ] && [ "$OS" = "Darwin" ] && command -v brew >/dev/null 2>&1; then
    info "Python 3.13 を Homebrew で入れます（数分かかります）"
    brew install python@3.13 </dev/null || warn "Python 3.13 を入れられませんでした。Mac に最初からある Python で続けます"
    PY="$(find_python 3.13)"
  fi
  [ -z "$PY" ] && PY="$(find_python 3.9 any)"
  [ -n "$PY" ] || die "Python 3.9 以上が見つかりません。Mac なら「brew install python@3.13」を実行してから、もう一度この1行を実行してください。"
  ok "$("$PY" -c 'import sys; print("Python %d.%d.%d" % sys.version_info[:3])')（${PY}）を使います"

  # ---------------------------------------------------------------- 3. ライブラリ
  step "3/4 ツールに必要なライブラリを確認しています"
  local VENV="$TOOLS/.venv"
  local VPY="$VENV/bin/python"
  if [ -x "$VPY" ] && ! "$VPY" -c 'import sys; assert sys.version_info >= (3, 9)' >/dev/null 2>&1; then
    warn "前に作った環境（.venv）が壊れているので作り直します"
    rm -rf "$VENV"
  fi
  if [ ! -x "$VPY" ]; then
    info "ツール専用の環境（.venv）を作ります"
    "$PY" -m venv "$VENV" || die "環境（.venv）を作れませんでした。"
  fi

  # requirements.txt と --lite の組み合わせが前回と同じなら、入れ直さない
  local REQ="$TOOLS/requirements.txt" STAMP="$VENV/.iku-installed"
  local WANT
  WANT="$(cat "$REQ"; echo "lite=$LITE")"
  if [ -f "$STAMP" ] && [ "$(cat "$STAMP")" = "$WANT" ] && "$VPY" -c 'import PyQt6.QtWidgets' >/dev/null 2>&1; then
    ok "必要なライブラリは入っています"
  else
    if [ "$LITE" = 1 ]; then
      info "ライブラリを入れます（人物ぼかしは入れません。数百MB・数分かかります）"
    else
      info "ライブラリを入れます（合計約1.3GB。初回は数分〜十数分かかります。大半は人物ぼかし用です）"
      info "人物ぼかしを使わないなら、Ctrl+C で止めて「curl -fsSL https://cdn.iku-navi.net/tools/install.sh | bash -s -- --lite」"
    fi
    local REQ_USE="$REQ"
    if [ "$LITE" = 1 ]; then
      REQ_USE="$(mktemp)"
      grep -v '^ultralytics' "$REQ" >"$REQ_USE"
    fi
    "$VPY" -m pip install --disable-pip-version-check --quiet --upgrade pip </dev/null || true
    "$VPY" -m pip install --disable-pip-version-check --progress-bar on -r "$REQ_USE" </dev/null \
      || die "ライブラリを入れられませんでした。上のエラーを開発メンバーに見せてください。"
    [ "$REQ_USE" != "$REQ" ] && rm -f "$REQ_USE"
    printf '%s' "$WANT" >"$STAMP"
    ok "ライブラリを入れました"
  fi

  # 画面を作る前の確認（足りないものがあれば、直し方を出して止める）
  if ! (cd "$TOOLS" && "$VPY" -c 'import sys; from iku_tools import startup; startup.prepare()' >/dev/null 2>&1); then
    warn "このままでは起動できないようです。環境診断の結果を出します:"
    (cd "$TOOLS" && "$VPY" main.py --doctor) || true
    die "上の内容をそのまま開発メンバー（Discord）に送ってください。"
  fi

  # ---------------------------------------------------------------- 4. 起動
  step "4/4 起動の準備をしています"
  if [ "$SHORTCUT" = 1 ] && [ "$OS" = "Darwin" ] && [ -d "$HOME/Desktop" ]; then
    local CMD="$HOME/Desktop/IKU NAVI ツール.command"
    cat >"$CMD" <<EOF
#!/bin/bash
# ダブルクリックで IKU NAVI ツールを起動する（install.sh が作ったファイル。消しても問題ない）
cd "$TOOLS" && exec "$VPY" main.py
EOF
    chmod +x "$CMD"
    ok "デスクトップに「IKU NAVI ツール.command」を作りました（次からはダブルクリックで起動できます）"
  fi

  echo
  ok "準備ができました"
  info "次からは、もう一度この1行を実行するか、デスクトップの「IKU NAVI ツール.command」をダブルクリックしてください"
  info "うまく動かないときは: cd \"$TOOLS\" && .venv/bin/python main.py --doctor"
  if [ "$LAUNCH" = 1 ]; then
    echo
    info "IKU NAVI ツールを起動します（このターミナルは、ツールを閉じるまでそのままにしてください）"
    cd "$TOOLS"
    exec "$VPY" main.py </dev/null
  fi
}

# ---------------------------------------------------------------- 表示
if [ -t 1 ]; then
  C_B=$'\033[1m'; C_G=$'\033[32m'; C_Y=$'\033[33m'; C_R=$'\033[31m'; C_C=$'\033[36m'; C_0=$'\033[0m'
else
  C_B=""; C_G=""; C_Y=""; C_R=""; C_C=""; C_0=""
fi
title() { printf '\n%s== %s ==%s\n' "$C_B" "$1" "$C_0"; }
step() { printf '\n%s▶ %s%s\n' "$C_C" "$1" "$C_0"; }
info() { printf '  %s\n' "$1"; }
ok() { printf '  %s✓%s %s\n' "$C_G" "$C_0" "$1"; }
warn() { printf '  %s!%s %s\n' "$C_Y" "$C_0" "$1"; }
die() { printf '\n%s✗ %s%s\n\n' "$C_R" "$1" "$C_0" >&2; exit 1; }

# ターミナルの設定を読み込んでいないときでも Homebrew を使えるようにする（Apple シリコンは /opt/homebrew）
load_brew() {
  command -v brew >/dev/null 2>&1 && return 0
  local b
  for b in /opt/homebrew/bin/brew /usr/local/bin/brew; do
    if [ -x "$b" ]; then
      eval "$("$b" shellenv)"
      return 0
    fi
  done
  return 0
}

# 指定した版の python3.X を探して、見つかった最初のものを出す。"any" なら python3 でも、3.9 以上ならよい
find_python() {
  local v p
  for v in "$@"; do
    if [ "$v" = any ]; then
      p="$(command -v python3 2>/dev/null || true)"
    else
      p="$(command -v "python$v" 2>/dev/null || true)"
    fi
    if [ -n "$p" ] && "$p" -c 'import sys, venv; assert sys.version_info >= (3, 9)' >/dev/null 2>&1; then
      echo "$p"
      return 0
    fi
  done
  echo ""
}

main "$@"
