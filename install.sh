#!/usr/bin/env bash
# discopilot macOS/Linux installer (bootstrap). Ensures prerequisites (Node, git,
# GitHub Copilot CLI) then hands off to the shared bilingual config engine
# scripts/setup.mjs. Language: detected from the locale, overridable with --lang.
# Compatible with macOS's system bash 3.2 (no associative arrays / mapfile).
set -euo pipefail

# --- args ---
LANG_OPT=""
FWD=()
DRY=0
for a in "$@"; do
  case "$a" in
    --lang) : ;;                       # value handled below
    zh|en) LANG_OPT="$a" ;;            # value after --lang (loose)
    --lang=zh) LANG_OPT="zh" ;;
    --lang=en) LANG_OPT="en" ;;
    --yes|-y) FWD+=("--yes") ;;
    --dry-run) DRY=1; FWD+=("--dry-run") ;;
    --residency) FWD+=("--residency") ;;
    --no-residency) FWD+=("--no-residency") ;;
    --skip-auth) FWD+=("--skip-auth") ;;
  esac
done
# support "--lang zh" (separate token)
prev=""
for a in "$@"; do
  if [ "$prev" = "--lang" ]; then LANG_OPT="$a"; fi
  prev="$a"
done

# --- refuse root (avoids root-owned files + root's user services) ---
if [ "$(id -u)" = "0" ]; then
  echo "Do not run this installer as root/sudo. Run as your normal user; package installs will elevate individually." >&2
  echo "請勿用 root/sudo 執行安裝器。請用一般使用者身分執行；套件安裝會在需要時個別提權。" >&2
  exit 1
fi

# --- language (locale default, --lang overrides) ---
lang="en"
hint="${LC_ALL:-${LC_MESSAGES:-${LANGUAGE:-${LANG:-}}}}"
case "$hint" in zh*|Zh*|ZH*) lang="zh" ;; esac
case "$LANG_OPT" in zh) lang="zh" ;; en) lang="en" ;; esac
if [ "$lang" = "zh" ]; then export DISCOPILOT_LOCALE="zh-TW"; else export DISCOPILOT_LOCALE="en-US"; fi

msg() { # msg <key>
  if [ "$lang" = "zh" ]; then
    case "$1" in
      banner) echo "discopilot 安裝（前置準備）" ;;
      checking) echo "檢查前置需求（Node / git / Copilot CLI）…" ;;
      installing) echo "正在安裝" ;;
      manual) echo "無法自動安裝，請手動安裝後重新執行：" ;;
      reopen) echo "已安裝相依套件，但目前的 shell 可能還找不到它。請重新開啟終端機後再次執行本腳本。" ;;
      handoff) echo "前置準備完成，交給設定精靈…" ;;
      noPm) echo "找不到支援的套件管理器（brew/apt/dnf）。請手動安裝 Node>=20.19、git、GitHub Copilot CLI。" ;;
      dry) echo "（--dry-run：不會安裝或變更任何東西。）" ;;
    esac
  else
    case "$1" in
      banner) echo "discopilot install (bootstrap)" ;;
      checking) echo "Checking prerequisites (Node / git / Copilot CLI)…" ;;
      installing) echo "Installing" ;;
      manual) echo "Could not auto-install; please install manually and re-run: " ;;
      reopen) echo "Installed dependencies, but this shell may not see them yet. Reopen your terminal and run this script again." ;;
      handoff) echo "Bootstrap done, handing off to the setup wizard…" ;;
      noPm) echo "No supported package manager (brew/apt/dnf) found. Install Node>=20.19, git, and the GitHub Copilot CLI manually." ;;
      dry) echo "(--dry-run: nothing will be installed or changed.)" ;;
    esac
  fi
}

echo "== $(msg banner) =="
[ "$DRY" = "1" ] && echo "$(msg dry)"

have() { command -v "$1" >/dev/null 2>&1; }
node_ok() {
  have node || return 1
  node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit((a===20?b>=19:(a>=22&&(a>22||b>=12)))?0:1)' >/dev/null 2>&1
}

pm=""
if have brew; then pm="brew"; elif have apt-get; then pm="apt"; elif have dnf; then pm="dnf"; fi

install_pkg() { # install_pkg <brewName> <aptName> <dnfName>
  case "$pm" in
    brew) brew install "$1" ;;
    apt)  sudo apt-get update -y && sudo apt-get install -y "$2" ;;
    dnf)  sudo dnf install -y "$3" ;;
    *)    return 1 ;;
  esac
}

echo "$(msg checking)"
missing=""
node_ok || missing="$missing node"
have git || missing="$missing git"
have copilot || missing="$missing copilot"

if [ -n "$missing" ] && [ "$DRY" = "0" ]; then
  if [ -z "$pm" ]; then echo "$(msg noPm)" >&2; exit 1; fi
  for m in $missing; do
    echo "$(msg installing) $m …"
    case "$m" in
      node) install_pkg node nodejs nodejs || { echo "$(msg manual) node" >&2; exit 1; } ;;
      git)  install_pkg git git git || { echo "$(msg manual) git" >&2; exit 1; } ;;
      copilot) npm install -g @github/copilot || { echo "$(msg manual) @github/copilot" >&2; exit 1; } ;;
    esac
  done
  # re-verify
  still=""
  node_ok || still="$still node"
  have git || still="$still git"
  have copilot || still="$still copilot"
  if [ -n "$still" ]; then echo "$(msg reopen)"; exit 0; fi
elif [ -n "$missing" ] && [ "$DRY" = "1" ]; then
  echo "$(msg installing)$missing (dry-run)"
fi

# --- hand off to the shared bilingual config engine ---
# Forward --lang ONLY if the user explicitly chose one (or --yes, which is
# non-interactive); otherwise let setup.mjs show its interactive chooser,
# defaulting to DISCOPILOT_LOCALE.
echo "$(msg handoff)"
DIR="$(cd "$(dirname "$0")" && pwd)"
LANGFWD=()
if [ -n "$LANG_OPT" ]; then LANGFWD=(--lang "$lang"); fi
case " ${FWD[*]-} " in *" --yes "*) [ ${#LANGFWD[@]} -eq 0 ] && LANGFWD=(--lang "$lang") ;; esac
exec node "$DIR/scripts/setup.mjs" ${LANGFWD[@]+"${LANGFWD[@]}"} ${FWD[@]+"${FWD[@]}"}
