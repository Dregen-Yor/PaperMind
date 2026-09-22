#!/usr/bin/env bash
# PaperMind 一键安装脚本 — Linux / macOS
# 用法：curl -fsSL https://raw.githubusercontent.com/OWNER/PaperMind/main/scripts/install.sh | bash
set -euo pipefail

REPO="OWNER/PaperMind"   # ← 替换为你的 GitHub 用户名/仓库名
APP="papermind"
GH_API="https://api.github.com/repos/${REPO}/releases/latest"

# ── 颜色输出 ──────────────────────────────────────────────────────────────────
red()  { printf '\033[31m%s\033[0m\n' "$*"; }
green(){ printf '\033[32m%s\033[0m\n' "$*"; }
bold() { printf '\033[1m%s\033[0m\n' "$*"; }

# 从 AppImage 中提取品牌图标，安装图标/程序/桌面入口，并清理旧品牌入口。
# 参数：IMAGE_PATH INSTALL_DIR DATA_DIR（均为绝对路径）。提取或取图标失败时不做任何写入。
install_linux_appimage() (
  set -euo pipefail
  local image="$1" install_dir="$2" data_dir="$3"
  local scratch icon exec_path

  # 含换行的目录无法安全写进 desktop 文件的 Exec 行，直接拒绝而不是写出损坏的入口。
  if [[ "$install_dir" == *$'\n'* || "$data_dir" == *$'\n'* ]]; then
    printf 'PaperMind 安装失败：安装目录或数据目录不能包含换行符\n' >&2
    exit 1
  fi

  scratch=$(mktemp -d)
  trap 'rm -rf "$scratch"' EXIT
  (cd "$scratch" && "$image" --appimage-extract >/dev/null)
  icon="$scratch/squashfs-root/usr/share/icons/hicolor/512x512/apps/com.papermind.app.png"
  if [[ ! -s "$icon" ]]; then
    printf 'PaperMind 安装失败：AppImage 缺少 512px 品牌图标\n' >&2
    exit 1
  fi

  exec_path="$install_dir/papermind.AppImage"
  # Desktop Exec 内部双引号参数的反斜杠需要同时满足 desktop 与 Exec 两层转义。
  exec_path=${exec_path//\\/\\\\\\\\}
  exec_path=${exec_path//\$/\\\\\$}
  exec_path=${exec_path//\`/\\\\\`}
  exec_path=${exec_path//\"/\\\\\"}
  exec_path=${exec_path//%/%%}
  cat > "$scratch/com.papermind.app.desktop" <<DESKTOP
[Desktop Entry]
Name=PaperMind
Exec="$exec_path" %U
Icon=com.papermind.app
StartupWMClass=com.papermind.app
Terminal=false
Type=Application
Categories=Education;Science;
Comment=本地学术论文阅读助手
DESKTOP

  # 先写好全部产物再落盘：任何失败都发生在第一次 install 之前，旧安装保持原样。
  mkdir -p "$install_dir" "$data_dir/applications" "$data_dir/icons/hicolor/512x512/apps"
  install -m 644 "$icon" "$data_dir/icons/hicolor/512x512/apps/com.papermind.app.png"
  install -m 755 "$image" "$install_dir/papermind.AppImage"
  install -m 644 "$scratch/com.papermind.app.desktop" "$data_dir/applications/com.papermind.app.desktop"

  # 仅删除本安装器创建的旧品牌入口，不能删除同名但指向其他程序的入口。
  local old="$data_dir/applications/papermind.desktop"
  if [[ -f "$old" ]] && grep -Fxq 'Name=PaperMind' "$old" && grep -Fq "$install_dir/papermind.AppImage" "$old"; then
    rm "$old"
  fi

  if command -v update-desktop-database >/dev/null 2>&1; then
    update-desktop-database "$data_dir/applications" || true
  fi
)

main() {
  # ── 检测平台 & 架构 ──────────────────────────────────────────────────────────────
  OS=$(uname -s)
  ARCH=$(uname -m)

  case "$OS" in
    Linux)  PLATFORM="linux" ;;
    Darwin) PLATFORM="darwin" ;;
    *)      red "不支持的操作系统：$OS"; exit 1 ;;
  esac

  case "$ARCH" in
    x86_64)          ARCH_TAG="x64" ;;
    aarch64 | arm64) ARCH_TAG="arm64" ;;
    *)               red "不支持的架构：$ARCH"; exit 1 ;;
  esac

  TARGET="${PLATFORM}-${ARCH_TAG}"

  # 自定义数据目录必须是绝对路径，否则启动项会相对 cwd 落盘。
  if [ "$PLATFORM" = "linux" ] && [ -n "${XDG_DATA_HOME:-}" ] && [[ "${XDG_DATA_HOME}" != /* ]]; then
    red "XDG_DATA_HOME 必须是绝对路径：${XDG_DATA_HOME}"
    exit 1
  fi

  # ── 获取最新 Release 下载地址 ────────────────────────────────────────────────────
  bold "→ 查询最新 Release（${REPO}）..."
  RELEASE_JSON=$(curl -fsSL "$GH_API")
  VERSION=$(printf '%s' "$RELEASE_JSON" | grep '"tag_name"' | sed 's/.*"tag_name": *"\([^"]*\)".*/\1/')

  # 按扩展名匹配对应平台的文件
  case "$PLATFORM" in
    linux)  EXT="AppImage" ;;
    darwin) EXT="dmg"      ;;
  esac

  DOWNLOAD_URL=$(printf '%s' "$RELEASE_JSON" \
    | grep '"browser_download_url"' \
    | grep "${TARGET}\.${EXT}" \
    | sed 's/.*"browser_download_url": *"\([^"]*\)".*/\1/')

  if [ -z "$DOWNLOAD_URL" ]; then
    red "未找到适用于 ${TARGET} 的下载包（版本 ${VERSION}）"
    red "请前往 https://github.com/${REPO}/releases 手动下载"
    exit 1
  fi

  FILENAME="${APP}-${VERSION}-${TARGET}.${EXT}"
  bold "→ 下载 ${FILENAME}..."
  curl -fSL --progress-bar "$DOWNLOAD_URL" -o "/tmp/${FILENAME}"

  # ── 平台安装 ───────────────────────────────────────────────────────────────────
  if [ "$PLATFORM" = "linux" ]; then
    INSTALL_DIR="${HOME}/.local/bin"
    chmod +x "/tmp/${FILENAME}"
    install_linux_appimage "/tmp/${FILENAME}" "$INSTALL_DIR" "${XDG_DATA_HOME:-${HOME}/.local/share}"
    rm "/tmp/${FILENAME}"

    green "✓ 已安装至 ${INSTALL_DIR}/${APP}.AppImage"
    echo "  运行：${INSTALL_DIR}/${APP}.AppImage"
    echo "  或通过应用菜单搜索 PaperMind 启动"

  elif [ "$PLATFORM" = "darwin" ]; then
    MOUNT_POINT="/Volumes/PaperMind"
    bold "→ 挂载 dmg..."
    hdiutil attach "/tmp/${FILENAME}" -mountpoint "$MOUNT_POINT" -quiet -nobrowse

    bold "→ 安装到 /Applications..."
    # 删除旧版本（如存在）
    rm -rf "/Applications/PaperMind.app" 2>/dev/null || true
    cp -R "${MOUNT_POINT}/PaperMind.app" "/Applications/"

    hdiutil detach "$MOUNT_POINT" -quiet
    rm "/tmp/${FILENAME}"

    green "✓ PaperMind.app 已安装到 /Applications"
    echo ""
    echo "  ⚠️  首次运行提示（未签名应用）："
    echo "  方法一：右键单击图标 → 打开 → 确认"
    echo "  方法二：sudo xattr -cr /Applications/PaperMind.app"
  fi
}

# 直接执行（含 curl | bash 的管道执行）时运行安装流程；被 source 时只定义函数。
if [[ "${BASH_SOURCE[0]:-}" == "$0" || -z "${BASH_SOURCE[0]:-}" ]]; then
  main "$@"
fi
