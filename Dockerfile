# 速派 · 自托管镜像
# 单容器：静态前端 + 本地 API（SQLite）+ 定时通知
FROM node:22-alpine

ENV NODE_ENV=production \
    TZ=Asia/Shanghai \
    DATA_DIR=/data \
    PORT=8080 \
    HOST=0.0.0.0

WORKDIR /app

# alpine 默认没有时区库：TZ=Asia/Shanghai 时 musl 找不到 zoneinfo 会退回 UTC，
# 而 Node 用自己的 ICU 数据按 +8 算 —— 两套时钟差 8 小时（验证码会「一发出就过期」）。
# 装上 tzdata 让 SQLite 的 localtime 也真的是北京时间。
RUN apk add --no-cache tzdata

# 先只拷服务端，利用层缓存
COPY server/package.json ./server/package.json
COPY server/src ./server/src

# 前端产物
COPY index.html ./index.html
COPY assets ./assets

RUN mkdir -p /data && chown -R node:node /data /app

USER node
EXPOSE 8080
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "--no-warnings", "server/src/index.js"]
