#!/usr/bin/env bash
# 速派 CrewGo · 域名 + HTTPS 一键切换（Caddy 反代 + Let's Encrypt 自动证书）
#
#   sudo bash https.sh crewgo.cn
#
# 前置条件（缺一不可）：
#   1. ICP 备案已通过（未备案域名访问大陆服务器 80/443 会被阻断，证书也申请不下来）
#   2. 域名 A 记录已指向本机公网 IP（crewgo.cn 与 www 各一条）
#   3. 云防火墙已放行 TCP 80、443
#
# 做的事：装 Caddy → 反代 127.0.0.1:8080 → 自动申请并续期证书 → 自检。
# 不动容器、不动数据；随时可退回 http://IP:8080 访问。
set -euo pipefail

DOMAIN="${1:-${DOMAIN:-}}"
UPSTREAM="${UPSTREAM:-127.0.0.1:8080}"
CADDYFILE="/etc/caddy/Caddyfile"

say() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m提示：\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m错误：\033[0m %s\n' "$*" >&2; exit 1; }
# 交互确认；非交互执行（如 curl | bash）直接视为继续
ask() {
  local ans=""
  if [ -r /dev/tty ]; then read -r -p "$1 (y/N) " ans </dev/tty || ans=""; else ans="y"; fi
  [ "$ans" = "y" ] || [ "$ans" = "Y" ]
}

[ "$(id -u)" = "0" ] || die "请用 root 运行：sudo bash https.sh 你的域名"
[ -n "$DOMAIN" ] || die "请把域名作为参数传入，例如：sudo bash https.sh crewgo.cn"
case "$DOMAIN" in *.*) ;; *) die "域名格式不对：$DOMAIN" ;; esac

# ---------- 1. 前置检查 ----------
say "检查域名解析"
PUBIP=$(curl -fsS -m 3 http://100.100.100.200/latest/meta-data/eipv4 2>/dev/null | tr -d ' \r\n' || true)
[ -n "$PUBIP" ] || PUBIP=$(curl -fsS -m 5 https://api.ipify.org 2>/dev/null | tr -d ' \r\n' || true)
RESOLVED=$(getent hosts "$DOMAIN" 2>/dev/null | awk '{print $1}' | head -1 || true)
echo "  本机公网 IP：${PUBIP:-取不到}"
echo "  域名解析到：${RESOLVED:-取不到}"
if [ -n "$PUBIP" ] && [ -n "$RESOLVED" ] && [ "$PUBIP" != "$RESOLVED" ]; then
  warn "域名没有指向这台服务器，证书会申请失败。请先到 DNS 控制台加 A 记录：$DOMAIN → $PUBIP"
  ask "仍然继续？" || exit 1
fi
if [ -z "$RESOLVED" ]; then
  warn "域名暂时解析不出结果（刚添加的记录可能要几分钟到几小时）。证书申请大概率会失败，建议稍后再跑。"
  ask "仍然继续？" || exit 1
fi

if ! curl -fsS -m 3 "http://$UPSTREAM/api/health" >/dev/null 2>&1; then
  warn "本机 $UPSTREAM 上没有服务在响应。请先确认容器在跑：docker ps | grep crewgo"
  ask "仍然继续？" || exit 1
fi

# ---------- 2. 端口占用 ----------
say "检查 80 / 443"
if ss -lnt 2>/dev/null | grep -qE ':(80|443)\s'; then
  if ! ss -lntp 2>/dev/null | grep -E ':(80|443)\s' | grep -q caddy; then
    die "80 或 443 已被其他程序占用。先停掉它（可能是另一个 nginx/apache），或把容器映射改回 8080 后再跑本脚本"
  fi
fi

# ---------- 3. 安装 Caddy ----------
if ! command -v caddy >/dev/null 2>&1; then
  say "安装 Caddy"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq || true
  if ! apt-get install -y -qq caddy >/dev/null 2>&1; then
    warn "apt 源里没有 caddy，改用官方源"
    apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https curl gnupg >/dev/null 2>&1 || true
    curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/gpg.key \
      | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg 2>/dev/null || true
    echo "deb [signed-by=/usr/share/keyrings/caddy-stable-archive-keyring.gpg] https://dl.cloudsmith.io/public/caddy/stable/deb/debian any-version main" \
      > /etc/apt/sources.list.d/caddy-stable.list
    apt-get update -qq || true
    apt-get install -y -qq caddy >/dev/null 2>&1 || die "Caddy 装不上。可换用容器方式：见 README「域名 + HTTPS」一节"
  fi
fi

# ---------- 4. 写配置 ----------
say "写入 $CADDYFILE（反代 $UPSTREAM）"
mkdir -p /var/log/caddy
cat > "$CADDYFILE" <<EOF
# 由 crewgo deploy/cloud/https.sh 生成
$DOMAIN, www.$DOMAIN {
    encode gzip
    reverse_proxy $UPSTREAM
    log {
        output file /var/log/caddy/crewgo.log {
            roll_size 10mb
            roll_keep 5
        }
    }
}
EOF

systemctl enable --now caddy >/dev/null 2>&1 || true
systemctl restart caddy || die "Caddy 起不来，看日志：journalctl -u caddy -n 50 --no-pager"

# ---------- 5. 自检 ----------
say "等证书签发（最多 90 秒）"
ok=""
for i in $(seq 1 18); do
  sleep 5
  if curl -fsS -m 8 "https://$DOMAIN/api/health" >/dev/null 2>&1; then ok=1; break; fi
done

echo
if [ -n "$ok" ]; then
  say "HTTPS 已生效 ✔"
  echo "  访问地址： https://$DOMAIN/"
  echo "  证书会自动续期（Caddy 到期前 30 天处理），不用每 3 个月手动换。"
  echo "  Caddy 日志：journalctl -u caddy -f    站点日志：/var/log/caddy/crewgo.log"
  echo
  warn "容器仍监听 8080，直连 http://$(hostname -I | awk '{print $1}'):8080 依然可用（内网/备用）。"
else
  warn "还没通。按这个顺序看："
  echo "  1) journalctl -u caddy -n 50 --no-pager    → 找 acme 报错"
  echo "  2) 80/443 是否放行：云控制台「防火墙」加 TCP 80、443"
  echo "  3) 备案是否通过：未备案时 Let's Encrypt 的 HTTP 验证会被拦"
  echo "  4) 域名是否指向本机：curl -s https://api.ipify.org; getent hosts $DOMAIN"
  exit 1
fi
