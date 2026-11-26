#!/usr/bin/env bash
# 速派 CrewGo · 换服务器（到期换机 / 迁移）
#
#   bash migrate.sh export                    # 旧机：停机几秒打包数据目录
#   bash migrate.sh import <文件.tgz>          # 新机：放回数据并自动跑 install.sh
#
# 数据目录默认 /opt/crewgo/data；若当初用 DATA_DIR=... 改过路径，脚本会
# 先从运行中的容器读实际挂载点，读不到才用默认值。也可以用 DATA_DIR 覆盖。
set -euo pipefail

DATA_DIR="${DATA_DIR:-/opt/crewgo/data}"
CONTAINER="${CONTAINER:-crewgo}"
HERE="$(cd "$(dirname "$0")" && pwd)"

say() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m提示：\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m错误：\033[0m %s\n' "$*" >&2; exit 1; }

stamp() { date +%Y%m%d-%H%M; }

need_root() {
  [ "$(id -u)" = "0" ] || die "请用 root 运行：sudo bash $0 $*"
}
need_docker() {
  command -v docker >/dev/null 2>&1 || die "这台机器没有 docker，先装：curl -fsSL https://ghfast.top/https://raw.githubusercontent.com/JudeHaplin/crewgo/main/deploy/cloud/install.sh | sudo bash"
}
container_exists() {
  docker ps -a --format '{{.Names}}' 2>/dev/null | grep -qx "$CONTAINER"
}
container_running() {
  docker ps --format '{{.Names}}' 2>/dev/null | grep -qx "$CONTAINER"
}

# 以容器实际挂载点为准，避免当初自定义过路径时找不到数据
detect_data_dir() {
  command -v docker >/dev/null 2>&1 || return 0
  container_exists || return 0
  local m
  m=$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Source}}{{end}}{{end}}' "$CONTAINER" 2>/dev/null || true)
  [ -n "$m" ] && DATA_DIR="$m"
  return 0
}

cmd_export() {
  need_root export
  need_docker
  detect_data_dir

  [ -d "$DATA_DIR" ] || die "找不到数据目录：$DATA_DIR（当初改过路径的话：DATA_DIR=/你的路径 bash $0 export）"
  [ -f "$DATA_DIR/repair.db" ] || warn "$DATA_DIR 里没有 repair.db，路径可能不对，先确认再继续"

  local out="crewgo-data-$(stamp).tgz"
  local was_running=""

  if container_running; then
    was_running=1
    say "先停容器（几秒），保证 SQLite 已落盘"
    docker stop "$CONTAINER" >/dev/null
  fi

  say "打包 $DATA_DIR"
  tar czf "$out" -C "$(dirname "$DATA_DIR")" "$(basename "$DATA_DIR")"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$out" > "$out.sha256"
  fi

  if [ -n "$was_running" ]; then
    say "把旧机容器拉回来"
    docker start "$CONTAINER" >/dev/null || warn "旧机容器没起来，要用就先 docker start $CONTAINER"
  fi

  local size
  size=$(du -h "$out" | awk '{print $1}')
  say "完成 ✔  $(pwd)/$out（$size）"
  echo
  echo "  下一步：传到新机器，然后在新机器上导入"
  echo "    scp $(pwd)/$out root@<新服务器IP>:/root/"
  echo "    sudo bash migrate.sh import /root/$out"
  echo
  warn "旧机先别退：确认新机能登录、附件打得开、当天的通知发得出去，再关旧机。"
}

cmd_import() {
  local src="${1:-}"
  need_root import
  need_docker
  [ -n "$src" ] || die "用法：bash $0 import <crewgo-data-xxx.tgz>"
  [ -f "$src" ] || die "找不到文件：$src"

  tar tzf "$src" >/dev/null 2>&1 || die "不是有效的 .tar.gz：$src"

  if [ -f "$src.sha256" ]; then
    say "校验完整性"
    ( cd "$(dirname "$src")" && sha256sum -c "$(basename "$src").sha256" ) >/dev/null 2>&1 \
      || die "校验不通过，文件多半没传完整，重新传一次"
  fi

  tar tzf "$src" | grep -q 'repair\.db' || warn "包里没看到 repair.db，确认一下这是不是 CrewGo 的数据包"

  # 新机上已有数据就挪开，绝不覆盖
  if [ -d "$DATA_DIR" ] && [ -n "$(ls -A "$DATA_DIR" 2>/dev/null || true)" ]; then
    local bak="$DATA_DIR.bak-$(stamp)"
    say "新机上已有数据，先挪到 $bak"
    mv "$DATA_DIR" "$bak"
  fi

  mkdir -p "$(dirname "$DATA_DIR")"
  say "解压到 $(dirname "$DATA_DIR")"
  tar xzf "$src" -C "$(dirname "$DATA_DIR")"

  # 包里的顶层目录名不一定是 data（当初换过路径就会是别的名字）
  if [ ! -d "$DATA_DIR" ]; then
    local top
    top=$(tar tzf "$src" | head -1 | cut -d/ -f1)
    if [ -n "$top" ] && [ -d "$(dirname "$DATA_DIR")/$top" ]; then
      mv "$(dirname "$DATA_DIR")/$top" "$DATA_DIR"
    fi
  fi
  [ -f "$DATA_DIR/repair.db" ] || die "解压后没找到 repair.db，看看包里有什么：tar tzf $src"

  say "修正目录属主（容器里以 node / uid 1000 运行）"
  chown -R 1000:1000 "$DATA_DIR" 2>/dev/null || warn "改不动属主，若容器起不来请看 docker logs $CONTAINER"

  if container_exists; then
    say "删掉新机上的旧容器，按现有数据重建"
    docker rm -f "$CONTAINER" >/dev/null
  fi

  if [ -f "$HERE/install.sh" ]; then
    say "跑 install.sh 起容器（拉镜像 + 健康检查）"
    bash "$HERE/install.sh"
  else
    warn "没找到同目录下的 install.sh，手动起容器："
    echo "  docker run -d --name crewgo --restart unless-stopped -p 8080:8080 \\"
    echo "    -v $DATA_DIR:/data -e TZ=Asia/Shanghai -e PORT=8080 \\"
    echo "    ghcr.io/judehaplin/crewgo:latest"
  fi
}

case "${1:-}" in
  export|backup|out)
    cmd_export
    ;;
  import|restore|in)
    shift
    cmd_import "${1:-}"
    ;;
  *)
    sed -n '2,7p' "$0" | sed 's/^# \{0,1\}//'
    exit 1
    ;;
esac
