#!/usr/bin/env bash
# 速派 CrewGo · 云服务器一键部署（Linux / 需 root 或 sudo）
#
#   bash install.sh                       # 默认 8080 端口，数据放 /opt/crewgo/data
#   PORT=9080 bash install.sh             # 换端口
#   IMAGE=ghcr.io/judehaplin/crewgo:1.0.3 bash install.sh
#   VERSION=1.0.3 bash install.sh         # 指定版本（默认取 GitHub 最新发布，取不到用内置版本）
#   GHCR_MIRROR=1 bash install.sh         # 强制走南大镜像（ghcr.io 拉不动时）
#
# 只依赖 docker；镜像自带 healthcheck 与自动重启。
set -euo pipefail

PORT="${PORT:-8080}"
DATA_DIR="${DATA_DIR:-/opt/crewgo/data}"
NAME_PATH="judehaplin/crewgo"
MIRROR_ROOT="${MIRROR_ROOT:-ghcr.nju.edu.cn}"

say() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m提示：\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m错误：\033[0m %s\n' "$*" >&2; exit 1; }

# 内置兜底版本；正常情况下从 GitHub 取最新 release，免得每次发版都要改脚本。
# 注意：国内访问 api.github.com 常常超时（这里只等 6 秒），一旦取不到就会用下面这个版本，
# 所以它必须每次发版都更新——否则「升级」会静默降级回旧版。
FALLBACK_TAG="1.2.13"
if [ -z "${VERSION:-}" ] && [ -z "${IMAGE:-}" ]; then
  VERSION=$(curl -fsSL -m 6 https://api.github.com/repos/JudeHaplin/crewgo/releases/latest 2>/dev/null \
    | tr -d ' \n' | sed -n 's/.*"tag_name":"v\{0,1\}\([^"]*\)".*/\1/p' || true)
  if [ -n "${VERSION:-}" ]; then
    say "GitHub 最新版本：$VERSION"
  else
    VERSION="$FALLBACK_TAG"
    warn "取不到 GitHub 最新版本（多半是网络不通），将安装脚本内置版本 $VERSION。"
    warn "想装指定版本：VERSION=1.2.6 bash install.sh"
  fi
fi
IMAGE="${IMAGE:-ghcr.io/judehaplin/crewgo:${VERSION:-$FALLBACK_TAG}}"
TAG="${IMAGE##*:}"

# 优先取公网 IP（云厂商元数据最可靠，其次公共探测服务），最后才退回内网地址
public_ip() {
  local ip=""
  ip=$(curl -fsS -m 2 http://100.100.100.200/latest/meta-data/eipv4 2>/dev/null | tr -d ' \r\n' || true)
  [ -n "$ip" ] || ip=$(curl -fsS -m 3 https://api.ipify.org 2>/dev/null | tr -d ' \r\n' || true)
  [ -n "$ip" ] || ip=$(curl -fsS -m 3 https://ifconfig.me/ip 2>/dev/null | tr -d ' \r\n' || true)
  if [ -z "$ip" ]; then
    ip=$(hostname -I 2>/dev/null | awk '{print $1}')
    [ -n "$ip" ] && ip="$ip（内网地址，外网请用云控制台上的公网 IP）"
  fi
  printf '%s' "$ip"
}

[ "$(id -u)" = "0" ] || die "请用 root 运行：sudo bash install.sh"

# ---------- 1. Docker ----------
install_docker_apt() {
  apt-get update -qq || true
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq docker.io && return 0
  # 发行版没带 docker.io，就走阿里云 docker-ce 源
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq ca-certificates curl gnupg || true
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL "https://mirrors.aliyun.com/docker-ce/linux/ubuntu/gpg" | gpg --dearmor -o /etc/apt/keyrings/docker.gpg || return 1
  CODENAME="$(. /etc/os-release && echo "${VERSION_CODENAME:-jammy}")"
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://mirrors.aliyun.com/docker-ce/linux/ubuntu $CODENAME stable" > /etc/apt/sources.list.d/docker.list
  apt-get update -qq || true
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq docker-ce docker-ce-cli containerd.io
}

install_docker_rpm() {
  local pm="$1"
  $pm install -y docker >/dev/null 2>&1 || $pm install -y docker-ce >/dev/null 2>&1 || true
  if ! command -v docker >/dev/null 2>&1; then
    # 阿里云 docker-ce 源（CentOS/RHEL 系，Alibaba Cloud Linux 也能用）
    $pm install -y dnf-plugins-core >/dev/null 2>&1 || $pm install -y yum-utils >/dev/null 2>&1 || true
    (dnf config-manager --add-repo https://mirrors.aliyun.com/docker-ce/linux/centos/docker-ce.repo 2>/dev/null || \
     yum-config-manager --add-repo https://mirrors.aliyun.com/docker-ce/linux/centos/docker-ce.repo 2>/dev/null) || true
    $pm install -y docker-ce docker-ce-cli containerd.io >/dev/null 2>&1 || \
      $pm install -y --releasever=9 docker-ce docker-ce-cli containerd.io >/dev/null 2>&1 || \
      $pm install -y --releasever=8 docker-ce docker-ce-cli containerd.io >/dev/null 2>&1 || \
      $pm install -y --nobest docker-ce docker-ce-cli containerd.io >/dev/null 2>&1 || true
  fi
  command -v docker >/dev/null 2>&1
}

if ! command -v docker >/dev/null 2>&1; then
  say "没装 Docker，先装"
  ok=""
  if command -v apt-get >/dev/null 2>&1; then
    install_docker_apt && ok=1
  elif command -v dnf >/dev/null 2>&1; then
    install_docker_rpm dnf && ok=1
  elif command -v yum >/dev/null 2>&1; then
    install_docker_rpm yum && ok=1
  fi
  if [ -z "$ok" ]; then
    say "试官方脚本 get.docker.com"
    curl -fsSL https://get.docker.com | sh || die "Docker 装不上。最省事的办法：在阿里云控制台把这台机器「重置系统」为 Docker 应用镜像（约 2 分钟），再回来跑本脚本。"
  fi
fi
systemctl enable --now docker >/dev/null 2>&1 || systemctl start docker
systemctl is-active --quiet docker || die "Docker 没起来，试试 systemctl status docker 看原因"

# ---------- 2. 拉镜像 ----------
pull_once() { docker pull "$1" >/dev/null 2>&1; }

# 先探一下 ghcr.io 通不通（/v2/ 正常返回 401，说明网络能到）
ghcr_reachable() {
  local code
  code=$(curl -s -m 6 -o /dev/null -w '%{http_code}' https://ghcr.io/v2/ 2>/dev/null || echo 000)
  [ "$code" = "200" ] || [ "$code" = "401" ]
}

MIRRORED="$MIRROR_ROOT/$NAME_PATH:$TAG"
use_mirror() {
  warn "改走国内镜像：$MIRRORED"
  if pull_once "$MIRRORED"; then docker tag "$MIRRORED" "$IMAGE"; return 0; fi
  return 1
}

say "拉取镜像 $IMAGE（约 60MB）"
ok=""
if [ "${GHCR_MIRROR:-0}" = "1" ] || ! ghcr_reachable; then
  [ "${GHCR_MIRROR:-0}" = "1" ] || warn "ghcr.io 连不上（国内常见），直接用镜像源"
  use_mirror && ok=1
else
  for i in 1 2; do
    if pull_once "$IMAGE"; then ok=1; break; fi
    warn "第 $i 次没拉下来"
    sleep 5
  done
  if [ -z "$ok" ]; then use_mirror && ok=1; fi
fi

if [ -z "$ok" ]; then
  die "镜像拉不下来。可行办法：①过一会儿再跑一次本脚本；②在能访问 ghcr.io 的电脑上 docker pull 后 docker save 成 tar，scp 到本机再 docker load -i；③拉源码 docker build -t crewgo:local . 然后把 IMAGE=crewgo:local 传进来"
fi

# ---------- 3. 启动 ----------
mkdir -p "$DATA_DIR"
# 容器里应用以 node 用户（uid/gid 1000）运行，宿主机目录必须给它写权限，
# 否则 SQLite 打不开数据文件，页面能开但一保存就 500。
chown -R 1000:1000 "$DATA_DIR" 2>/dev/null || warn "改不动 $DATA_DIR 的属主，若起不来请看 docker logs crewgo"
if docker ps -a --format '{{.Names}}' | grep -qx crewgo; then
  say "已有同名容器，删除重建（数据在 $DATA_DIR，不会丢）"
  docker rm -f crewgo >/dev/null
fi

say "启动容器，对外端口 $PORT"
docker run -d \
  --name crewgo \
  --restart unless-stopped \
  -p "$PORT:8080" \
  -v "$DATA_DIR:/data" \
  -e TZ=Asia/Shanghai \
  -e PORT=8080 \
  -e DIGEST_HOUR=8 \
  "$IMAGE" >/dev/null

# ---------- 4. 自检 ----------
say "等应用起来（最多 60 秒）"
for i in $(seq 1 30); do
  if curl -fsS -m 2 "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then
    echo
    say "部署完成 ✔"
    IP=$(public_ip)
    echo
    echo "  版本：       $TAG"
    echo "  浏览器打开： http://${IP:-<服务器公网IP>}:$PORT/"
    echo "  数据目录：   $DATA_DIR（备份就是拷这个目录）"
    echo "  看日志：     docker logs -f crewgo"
    echo
    warn "如果浏览器打不开，先到云控制台的「防火墙 / 安全组」放行 TCP $PORT。"
    exit 0
  fi
  sleep 2
done

echo
docker logs --tail 30 crewgo || true
die "60 秒内没起来，上面是容器日志"
