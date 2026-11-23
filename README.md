# 速派 CrewGo · 维修人员预约管理系统

维修人员的**预约 + 排期 + 派单**系统，给维修队内部用：预约人提单（谁、哪天、去哪、修什么），维修工看自己接下来的安排，统筹一眼看完所有人的日历。

**自托管**：一个容器跑完整套（前端 + 本地数据库 + 定时通知），不依赖任何外部服务，适合放在 NAS 上长期跑。

```
预约人在手机上提单 ──► 系统记录 + 邮件/微信通知维修工
                           │
维修工登录 ──► 「我的安排」只看自己那几单，点一下改状态
统筹登录  ──► 月历看全员排期，按项目/人员筛，导出 CSV
每天 8 点  ──► 自动给统筹发一封「今日派单」汇总
```

## 特性

- **姓名 + PIN 登录**：不用收验证码、不用记邮箱密码，维修工抬手机就能登；统筹可随时重设某人的 PIN。
- **排期看板**：整月日历，每条预约按人员颜色着色，谁哪天去哪一眼看清。
- **我的安排**：按 已过期 / 今天 / 明天 / 未来一周 分组，卡片上直接改状态。
- **角色权限**：统筹能管项目、人员、通知设置；维修工只能看排期、改状态；删除限创建人或统筹。
- **通知四通道**：站内通知、电脑弹窗、邮件（EmailJS）、微信（PushPlus），互不影响，配哪个用哪个。
- **真·定时任务**：每天定时扫单发提醒、发汇总——不依赖「有人打开页面」。
- **一键派单文案**：生成排版好的文字，直接粘微信群，30 个人零学习。
- **数据在本地**：SQLite 单文件，随时备份/拷走，不锁在任何平台上。

## 快速开始（Docker）

```bash
git clone https://github.com/<你的用户名>/crewgo.git
cd crewgo

docker compose up -d --build
# 打开 http://<NAS或电脑IP>:8080
```

或者不用 compose：

```bash
docker run -d --name crewgo \
  -p 8080:8080 \
  -v $(pwd)/data:/data \
  --restart unless-stopped \
  ghcr.io/<你的用户名>/crewgo:latest
```

首次打开会自动进入**初始化**：填姓名和 PIN，这个账号就是统筹管理员。

## 安装到飞牛 fnOS（fpk）

1. 到 [Releases](../../releases) 下载 `crewgo-1.0.0.fpk`
2. 飞牛应用中心 → 手动安装 → 选择该文件
3. 装完从桌面图标打开，第一次进入创建管理员

> fpk 未做开发者签名（CI 用 `--nosign` 构建），安装时可能提示「未签名/未知来源」，允许继续即可。要上架飞牛应用中心需要申请官方开发者证书，然后 `KEY=developer.key CERT=developer.crt ./scripts/build-fpk.sh`。

数据目录在应用安装卷的 `var/data` 下，升级会自动备份，卸载前请先导出。

## 第一次用，按这个顺序

1. **建管理员**：首次打开填姓名 + PIN。
2. **设置 → 项目**：把小区/楼盘录进去，可设默认地址。
3. **设置 → 人员**：加维修工和预约人，填邮箱（选填），设一个 PIN（留空默认 `1234`）。
4. **建第一条预约**：项目、维修人员、日期、时段、地址、报修内容、联系人电话。
5. 让每个人用**自己的姓名 + PIN** 登录，维修工登录后直接落在「我的安排」。

忘记 PIN：统筹在「设置 → 人员 → 编辑」里重设；本人也可以在「设置 → 我的资料」里改。

## 通知怎么配（都选填）

| 通道 | 需要什么 | 说明 |
|---|---|---|
| 站内通知 | 无 | 右上角铃铛，登录就能看到 |
| 电脑弹窗 | 浏览器授权 | 页面开着时弹系统通知 |
| 邮件 | EmailJS 的 Service ID / Template ID / Public Key | 免费 200 封/月，约等于每天 3-4 单；一单 2 封（派单 + 出发提醒） |
| 微信 | 每人或全局的 PushPlus token | 免费 200 条/天，关注公众号即可，不用装 App |

**邮件（10 分钟）**：`emailjs.com` 注册 → 添加你的邮箱服务（QQ/163 填授权码）→ 新建模板，收件人写 `{{to_email}}`、主题写 `{{subject}}`、正文 HTML 模式粘 `{{{message}}}` → 把三个值填进「设置 → 通知 → 邮件通知」→ 点「发一封测试」。

**微信**：`pushplus.plus` 微信扫码 → 实名 → 复制 token。token 可以填在每个人档案里（只推给他），也可以填全局（群推）。

**定时任务**：容器每 5 分钟检查一次，`DIGEST_HOUR`（默认 8）点后发当日汇总，一天一封；今天/次日还没提醒过的单各补一次提醒。全部幂等，重启不会重复发。

## 数据与备份

- 数据库：`/data/repair.db`（挂载在宿主机的 `./data`）
- 签名密钥：`/data/secret.key`（丢了只是所有人要重新登录）
- 备份：直接拷 `data` 目录，或在「预约单」里导出 CSV
- 恢复：把 `repair.db` 放回 `/data` 再重启容器

## 技术栈

| 层 | 实现 |
|---|---|
| 前端 | 原生 HTML/CSS/JS，无构建、无框架，单页 |
| 后端 | Node 22 原生 `http` + 内置 `node:sqlite`，**零外部依赖** |
| 认证 | 姓名 + PIN（scrypt 加盐哈希），HMAC 签名令牌，登录失败限速 |
| 通知 | EmailJS（邮件）、PushPlus（微信），全部由服务端发出 |
| 打包 | Docker 多架构镜像（amd64/arm64）+ 飞牛 fpk |

接口很小，就五个：

```
POST /api/auth/setup    首次初始化管理员
POST /api/auth/login    姓名 + PIN 登录
GET  /api/auth/me       当前登录者
POST /api/db            统一的数据读写（表名白名单 + 服务端权限校验）
GET  /api/health        健康检查（容器 healthcheck 用）
```

## 本地开发

```bash
DATA_DIR=./.data PORT=8080 node --no-warnings server/src/index.js
```

跑测试（会启动服务并跑一遍接口 + 前端适配层，共 50 项断言）：

```bash
rm -rf .data
DATA_DIR=./.data PORT=8099 node --no-warnings server/src/index.js &
sleep 3
PORT=8099 node --no-warnings server/test/api-smoke.js     # 需要改 BASE 或用默认 8099
node --no-warnings server/test/client-shim.js
```

## 打包与发布

```bash
# 打 fpk（需要官方 fnpack：https://developer.fnnas.com/docs/cli/fnpack/）
OWNER=<你的GitHub用户名> ./scripts/build-fpk.sh 1.0.0

# 发布：打 tag 后 GitHub Actions 自动构建镜像 + 打包 fpk 并挂到 Release
git tag v1.0.0 && git push origin v1.0.0
```

> Windows 上用 fnpack 1.3.3 会在压缩阶段报 `sync ... Access is denied`（工具兼容性问题）。要么在 fnOS/Linux 上打包，要么直接推 tag 让 CI 在 Ubuntu 上打——推荐后者。

## 许可

MIT
