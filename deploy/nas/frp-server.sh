#!/usr/bin/env bash
# 在云服务器上安装 frps，把飞牛 NAS 的端口映射到公网。
#
# 场景：NAS 只有 IPv6 公网，而你要从没有 IPv6 的网络（公司等）访问它。
#       frps 只监听 IPv4，隧道由 NAS 主动发起，两端都不需要 IPv6。
#
# 为什么不用 Docker：fatedier/frp 只在 Docker Hub，国内常拉不动且无 ghcr 镜像。
# 这里直接装官方二进制 + systemd，从 GitHub Release 经加速源下载，稳定得多。
#
# 用法：
#   sudo bash frp-server.sh                          # 默认 7000 通道 / 7100 对外端口 / NAS 后台 5666
#   sudo env NAS_PORT=5000 bash frp-server.sh        # 指定 NAS 后台端口
#   sudo env BIND_PORT=443 bash frp-server.sh        # 通道端口换成 443（公司只放行 443 时）
#
# 跑完会把「飞牛端要粘贴的配置」整段打印出来。
set -euo pipefail

BIND_PORT="${BIND_PORT:-7000}"
PROXY_PORT="${PROXY_PORT:-7100}"
NAS_PORT="${NAS_PORT:-5666}"
DATA_DIR="${DATA_DIR:-/etc/frp}"
DASH_PORT="7500"
FRP_VERSION="${FRP_VERSION:-}"

say()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m提示：\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m错误：\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" = "0" ] || die "请用 root 运行：sudo bash $0"

case "$(uname -m)" in
  x86_64|amd64)  ARCH="amd64" ;;
  aarch64|arm64) ARCH="arm64" ;;
  armv7l)        ARCH="arm" ;;
  *) die "不支持的架构：$(uname -m)" ;;
esac

public_ip() {
  local ip=""
  ip=$(curl -fsS -m 3 http://100.100.100.200/latest/meta-data/eipv4 2>/dev/null || true)
  [ -n "$ip" ] || ip=$(curl -fsS -m 4 https://api.ipify.org 2>/dev/null || true)
  [ -n "$ip" ] || ip=$(hostname -I 2>/dev/null | awk '{print $1}')
  printf '%s' "$ip"
}

# ---------- 1. 端口占用检查 ----------
for p in "$BIND_PORT" "$PROXY_PORT"; do
  if ss -lnt 2>/dev/null | awk '{print $4}' | grep -qE "[:.]$p$"; then
    die "端口 $p 已被占用，先腾出来，或用 BIND_PORT= / PROXY_PORT= 换一个"
  fi
done

# ---------- 2. 版本 ----------
if [ -z "$FRP_VERSION" ]; then
  FRP_VERSION=$(curl -fsS -m 8 https://api.github.com/repos/fatedier/frp/releases/latest 2>/dev/null \
    | sed -n 's/.*"tag_name": *"v\{0,1\}\([^"]*\)".*/\1/p' | head -1 || true)
fi
FRP_VERSION="${FRP_VERSION:-0.72.0}"
PKG="frp_${FRP_VERSION}_linux_${ARCH}.tar.gz"
say "frp 版本 $FRP_VERSION（$ARCH）"

# ---------- 3. 下载 ----------
TARBALL="/tmp/$PKG"
GOT=""
for BASE in "https://ghfast.top/https://github.com" "https://gh-proxy.com/https://github.com" "https://github.com"; do
  URL="$BASE/fatedier/frp/releases/download/v$FRP_VERSION/$PKG"
  say "下载 $PKG（经 ${BASE%%/*}）"
  if curl -fsSL -m 240 -o "$TARBALL" "$URL" && [ -s "$TARBALL" ]; then GOT=1; break; fi
  warn "这个源没成功，换下一个"
done
[ -n "$GOT" ] || die "二进制下载失败。可手动到 GitHub Releases 下载 $PKG 传到服务器，再重跑本脚本"

tar xzf "$TARBALL" -C /tmp || die "解压失败，文件可能不完整"
SRC="/tmp/frp_${FRP_VERSION}_linux_${ARCH}"
[ -x "$SRC/frps" ] || die "包内没找到 frps"
install -m 755 "$SRC/frps" /usr/local/bin/frps
install -m 755 "$SRC/frpc" /usr/local/bin/frpc
say "已安装 /usr/local/bin/frps 与 frpc"

# ---------- 4. 配置（已存在则复用 token） ----------
mkdir -p "$DATA_DIR"
if [ -f "$DATA_DIR/frps.toml" ]; then
  say "已有配置，复用 $DATA_DIR/frps.toml"
  TOKEN=$(sed -n 's/^auth\.token = "\(.*\)"$/\1/p' "$DATA_DIR/frps.toml" | head -1)
  DASH_PASS=$(sed -n 's/^webServer\.password = "\(.*\)"$/\1/p' "$DATA_DIR/frps.toml" | head -1)
else
  TOKEN=$(head -c 18 /dev/urandom | base64 | tr -d '/+=\n' | head -c 24)
  DASH_PASS=$(head -c 12 /dev/urandom | base64 | tr -d '/+=\n' | head -c 16)
  cat > "$DATA_DIR/frps.toml" <<EOF
bindPort = $BIND_PORT
auth.method = "token"
auth.token = "$TOKEN"
webServer.addr = "127.0.0.1"
webServer.port = $DASH_PORT
webServer.user = "admin"
webServer.password = "$DASH_PASS"
EOF
  chmod 600 "$DATA_DIR/frps.toml"
  say "已生成 $DATA_DIR/frps.toml"
fi

# ---------- 5. systemd ----------
cat > /etc/systemd/system/frps.service <<'EOF'
[Unit]
Description=frp server (NAS tunnel)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/local/bin/frps -c /etc/frp/frps.toml
Restart=always
RestartSec=3
LimitNOFILE=1048576

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable frps >/dev/null 2>&1 || true
systemctl restart frps
sleep 2

if ! systemctl is-active --quiet frps; then
  journalctl -u frps -n 20 --no-pager 2>/dev/null || true
  die "frps 没起来，报错见上面"
fi
if ! ss -lnt 2>/dev/null | awk '{print $4}' | grep -qE "[:.]$BIND_PORT$"; then
  journalctl -u frps -n 20 --no-pager 2>/dev/null || true
  die "frps 进程在跑，但 $BIND_PORT 没监听"
fi
say "frps 已运行，监听 $BIND_PORT"

IP=$(public_ip)

cat <<EOF

==> 服务端就绪

  通道端口：   $BIND_PORT（NAS 连这里）
  对外端口：   $PROXY_PORT（浏览器访问用）
  管理面板：   http://127.0.0.1:$DASH_PORT   用户 admin   密码 $DASH_PASS
               面板只绑本机，外网看：ssh -L $DASH_PORT:127.0.0.1:$DASH_PORT root@$IP

提示：必须手动做一步 —— 阿里云控制台 → 防火墙 → 放行 TCP $BIND_PORT 和 TCP $PROXY_PORT

────────────────────────────────────────────
一、在飞牛上装 frpc（SSH 里执行，整段粘）
────────────────────────────────────────────
cd /tmp && curl -fsSL https://ghfast.top/https://github.com/fatedier/frp/releases/download/v$FRP_VERSION/$PKG | tar xz && install -m755 ${SRC##*/}/frpc /usr/local/bin/frpc || install -m755 /tmp/${SRC##*/}/frpc /usr/local/bin/frpc
mkdir -p /etc/frp

────────────────────────────────────────────
二、写入 /etc/frp/frpc.toml（内容如下）
────────────────────────────────────────────
serverAddr = "$IP"
serverPort = $BIND_PORT
auth.method = "token"
auth.token = "$TOKEN"

[[proxies]]
name = "nas-web"
type = "tcp"
localIP = "127.0.0.1"
localPort = $NAS_PORT
remotePort = $PROXY_PORT

────────────────────────────────────────────
三、在飞牛上启动（systemd）
────────────────────────────────────────────
cat > /etc/systemd/system/frpc.service <<'UNIT'
[Unit]
Description=frp client
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/local/bin/frpc -c /etc/frp/frpc.toml
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload && systemctl enable --now frpc && sleep 2 && journalctl -u frpc -n 15 --no-pager

────────────────────────────────────────────
完成后浏览器打开： http://$IP:$PROXY_PORT/
（绑了域名就是 http://nas.你的域名:$PROXY_PORT/）

localPort 是 NAS 后台端口，这里按 $NAS_PORT 写的。若打不开，
看一眼 NAS 后台地址栏里冒号后的数字，改 frpc.toml 再 systemctl restart frpc。
────────────────────────────────────────────
EOF
