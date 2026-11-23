#!/usr/bin/env bash
# 打飞牛 fnOS 的 .fpk 包
#   用法： OWNER=你的GitHub用户名 ./scripts/build-fpk.sh [版本号]
#   依赖： fnpack（官方打包工具，装到 PATH 里，或用 FNPACK=/path/to/fnpack 指定）
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT=$(pwd)

VERSION="${1:-$(node -p "require('./server/package.json').version")}"
OWNER="${OWNER:-$(git config --get remote.origin.url 2>/dev/null | sed -E 's#.*[:/]([^/]+)/[^/]+(\.git)?$#\1#' || true)}"
OWNER="${OWNER:-JudeHaplin}"
# Docker 镜像名只允许小写：GitHub 用户名是 JudeHaplin 时，镜像必须是 ghcr.io/judehaplin/...
# 大写会直接安装失败（invalid reference format: repository name must be lowercase），所以这里强制转小写。
IMAGE_OWNER=$(printf '%s' "$OWNER" | tr '[:upper:]' '[:lower:]')
IMAGE="ghcr.io/$IMAGE_OWNER/crewgo"

FNPACK="${FNPACK:-fnpack}"
if ! command -v "$FNPACK" >/dev/null 2>&1; then
  echo "找不到 fnpack。先下载官方工具：" >&2
  echo "  https://developer.fnnas.com/docs/cli/fnpack/" >&2
  echo "然后 FNPACK=/path/to/fnpack ./scripts/build-fpk.sh" >&2
  exit 1
fi

STAGE="$ROOT/dist/fpk-src"
rm -rf "$STAGE"
mkdir -p "$STAGE" "$ROOT/dist"

# 复制 fpk 源（排除构建产物）
cp -R "$ROOT/deploy/fnos/." "$STAGE/"
rm -rf "$STAGE/.build"

# 替换版本与镜像地址
#   manifest 里的 {{OWNER}} 用原大小写（GitHub 用户名是给人看的）
#   docker-compose 里的 {{IMAGE}} 是全小写镜像名前缀
for f in manifest app/docker/docker-compose.yaml; do
  if [ "$(uname)" = "Darwin" ]; then
    sed -i '' -e "s/{{VERSION}}/$VERSION/g" -e "s/{{OWNER}}/$OWNER/g" -e "s#{{IMAGE}}#$IMAGE#g" "$STAGE/$f"
  else
    sed -i -e "s/{{VERSION}}/$VERSION/g" -e "s/{{OWNER}}/$OWNER/g" -e "s#{{IMAGE}}#$IMAGE#g" "$STAGE/$f"
  fi
done

# 兜底自检：万一哪天模板改回大写，直接失败，别把坏包发出去
if grep -q '[A-Z]' <(grep '^ *image:' "$STAGE/app/docker/docker-compose.yaml" | grep -v '^ *#' | sed 's/.*image: *//'); then
  echo "错误：docker-compose.yaml 里的镜像名含大写：$(grep '^ *image:' "$STAGE/app/docker/docker-compose.yaml")" >&2
  exit 1
fi

# 生命周期脚本必须有执行权限
chmod +x "$STAGE"/cmd/* 2>/dev/null || true

echo "打包 crewgo $VERSION（镜像 ghcr.io/$OWNER/crewgo:$VERSION）"

# 默认不打签名（本地调试/社区分发够用）。有官方开发者证书时：
#   KEY=developer.key CERT=developer.crt ./scripts/build-fpk.sh
SIGN_ARGS="--nosign"
if [ -n "${KEY:-}" ] && [ -n "${CERT:-}" ]; then
  SIGN_ARGS="--key $KEY --cert $CERT"
  echo "使用证书签名：$CERT"
else
  echo "未提供开发者证书，按 --nosign 打包（安装时飞牛可能提示未签名）"
fi

(cd "$STAGE" && "$FNPACK" build $SIGN_ARGS)

FPK=$(ls -1t "$STAGE"/*.fpk 2>/dev/null | head -1 || true)
if [ -z "$FPK" ]; then
  FPK=$(ls -1t "$ROOT"/*.fpk 2>/dev/null | head -1 || true)
fi
if [ -n "$FPK" ]; then
  # 带上版本号，便于 Release 里区分；fnpack 默认只输出 crewgo.fpk
  OUT="$ROOT/dist/crewgo-$VERSION.fpk"
  cp "$FPK" "$OUT"
  echo "完成：dist/$(basename "$OUT") ($(wc -c < "$OUT" | tr -d ' ') 字节)"
else
  echo "打包结束，但没找到 .fpk，请检查 fnpack 输出" >&2
  exit 1
fi
