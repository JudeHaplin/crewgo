#!/usr/bin/env bash
# 速派 CrewGo · 云服务器一键部署（Linux / 需 root 或 sudo）
#
#   bash install.sh                    # 默认 8080 端口，数据放 /opt/crewgo/data
#   PORT=9080 bash install.sh          # 换端口
#   IMAGE=ghcr.io/judehaplin/crewgo:1.0.3 bash install.sh
#
# 说明：只用 docker，不装 nginx；镜像自带 healthcheck 和自动重启。
set -euo pipefail

PORT="${PORT:-8080}"
DATA_DIR="${DATA_DIR:-/opt/crewgo/data}"
IMAGE="${IMAGE:-ghcr.io/judehaplin/crewgo:1.0.3}"

say() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m提示：\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m错误：\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" = "0" ] || die "请用 root 运行：sudo bash install.sh"

# ---------- 1. Docker ----------
if ! command -v docker >/dev/null 2>&1; then
  say "没装 Docker，先装"
  if command -v apt-get >/dev/null 2>&1; then
    apt-get update -qq || true
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq docker.io || curl -fsSL https://get.docker.com | sh
  elif command -v dnf >/dev/null 2>&1; then
    dnf install -y docker || curl -fsSL https://get.docker.com | sh
  elif command -v yum >/dev/null 2>&1; then
    yum install -y docker || curl -fsSL https://get.docker.com | sh
  else
    curl -fsSL https://get.docker.com | sh
  fi
  systemctl enable --now docker
fi
systemctl is-active --quiet docker || systemctl start docker

# ---------- 2. 拉镜像 ----------
say "拉取镜像 $IMAGE（首次约 60MB，慢的话会重试）"
ok=""
for i in 1 2 3 4 5; do
  if docker pull "$IMAGE"; then ok=1; break; fi
  warn "第 $i 次拉取失败，10 秒后重试"
  sleep 10
done
if [ -z "$ok" ]; then
  die "镜像拉不下来。办法：①再跑一次本脚本；②在能上 ghcr.io 的电脑上 docker pull 后 docker save 成 tar，scp 到本机再 docker load；③自己 git clone 后 docker build -t crewgo:local ."
fi

# ---------- 3. 启动 ----------
mkdir -p "$DATA_DIR"
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
    IP=$(curl -fsS -m 3 https://api.ipify.org 2>/dev/null || hostname -I 2>/dev/null | awk '{print $1}')
    echo
    echo "  浏览器打开： http://${IP:-<服务器公网IP>}:$PORT/"
    echo "  数据目录：   $DATA_DIR（备份就是拷这个目录）"
    echo "  看日志：     docker logs -f crewgo"
    echo
    warn "如果打不开，先到云控制台的「防火墙 / 安全组」放行 TCP $PORT。"
    exit 0
  fi
  sleep 2
done

echo
docker logs --tail 30 crewgo || true
die "60 秒内没起来，上面是容器日志"
