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
for f in manifest app/docker/docker-compose.yaml; do
  if [ "$(uname)" = "Darwin" ]; then
    sed -i '' -e "s/{{VERSION}}/$VERSION/g" -e "s/{{OWNER}}/$OWNER/g" "$STAGE/$f"
  else
    sed -i -e "s/{{VERSION}}/$VERSION/g" -e "s/{{OWNER}}/$OWNER/g" "$STAGE/$f"
  fi
done

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
  cp "$FPK" "$ROOT/dist/"
  echo "完成：dist/$(basename "$FPK")"
else
  echo "打包结束，但没找到 .fpk，请检查 fnpack 输出" >&2
  exit 1
fi
