# 速派 CrewGo · 维修人员预约管理系统

> **AI 项目声明**
> 本项目的全部代码、页面、部署脚本与文档由 **AI 编程助手（WorkBuddy）生成**，人类负责提出需求、验收与试用反馈。因此：
> - 代码走的是「够用、简单、单人可维护」的路线，没做过度抽象，也没有多租户/高并发设计；
> - 业务逻辑（权限、时间、通知去重）有 52 项自动化测试覆盖，但**没有经过长期生产环境检验**；
> - 建议先在队内小范围试用一到两周，确认排期口径、通知对象都符合你们的习惯，再全面推开。
> 发现问题欢迎提 Issue，我（和 AI）会继续改。

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
git clone https://github.com/JudeHaplin/crewgo.git
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
  ghcr.io/judehaplin/crewgo:latest
```

首次打开会自动进入**初始化**：填姓名和 PIN，这个账号就是统筹管理员。

> **拉镜像报 `unauthorized` 时**：GHCR 的容器包新建后默认私有，需要在
> `github.com/users/<owner>/packages/container/crewgo/settings` → 底部 Danger Zone →
> Change visibility → Public，改成公开后即可匿名拉取。
> 不想公开也行，先 `docker login ghcr.io`（用个人令牌，勾 `read:packages`）再拉。

## 安装到飞牛 fnOS（fpk）

1. 到 [Releases](../../releases) 下载 `crewgo-<版本号>.fpk`（**请用 1.0.2 或更新版本**）
2. 飞牛应用中心 → 手动安装 → 选择该文件
3. 装完从桌面图标打开，第一次进入创建管理员

> fpk 未做开发者签名（CI 用 `--nosign` 构建），安装时可能提示「未签名/未知来源」，允许继续即可。要上架飞牛应用中心需要申请官方开发者证书，然后 `KEY=developer.key CERT=developer.crt ./scripts/build-fpk.sh`。

数据目录在应用安装卷的 `var/data` 下，升级会自动备份，卸载前请先导出。

### 装不上时对照这张表

| 弹窗报错 | 原因 | 处理 |
|---|---|---|
| `unable to get image 'ghcr.io/JudeHaplin/crewgo:1.0.x'`<br>`repository name (JudeHaplin/crewgo) must be lowercase` | 镜像地址里带了大写字母，Docker 不认这种名字。1.0.0 / 1.0.1 的打包脚本把 GitHub 用户名原样拼进去了 | 换 **1.0.2+** 的 fpk（脚本已强制转小写，并在打包时自检） |
| `unauthorized` / `denied` / `manifest unknown` | GHCR 上的容器包是私有，或 tag 还没构建完 | 见上面「拉镜像报 unauthorized」；或等 Actions 跑完 |
| `context deadline exceeded` / `i/o timeout` | NAS 访问 `ghcr.io` 太慢（国内常见） | 给 NAS 的 Docker 配代理；或在能拉取的机器 `docker pull` 后 `docker save` 成 tar，传到 NAS `docker load`，此时把 compose 里的 `image` 改成你 load 进去的本地名字 |
| 端口 8080 已被占用 | 别的应用占了这个端口 | 先停掉占用者，或改 fpk 里的 `ports` 映射（如 `18080:8080`） |

手动排查最快的方式：把弹窗里的镜像地址复制出来，在 NAS 的终端执行 `docker pull <那个地址>`，报错就很明确了。

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

跑测试（自动为每个测试文件起一个干净实例，共 52 项断言）：

```bash
node server/test/run.js              # 全部
node server/test/run.js api-smoke    # 只跑一个
```

## 打包与发布

```bash
# 打 fpk（需要官方 fnpack：https://developer.fnnas.com/docs/cli/fnpack/）
# OWNER 写 GitHub 用户名即可（大小写随意），脚本会自动把镜像名部分转成小写
OWNER=<你的GitHub用户名> ./scripts/build-fpk.sh 1.0.2

# 发布：打 tag 后 GitHub Actions 自动构建镜像 + 打包 fpk 并挂到 Release
git tag v1.0.2 && git push origin v1.0.2
```

> Windows 上用 fnpack 1.3.3 会在压缩阶段报 `sync ... Access is denied`（工具兼容性问题）。要么在 fnOS/Linux 上打包，要么直接推 tag 让 CI 在 Ubuntu 上打——推荐后者。

> **镜像名必须全小写**：Docker 的镜像地址不允许大写字母，`github.repository_owner` 是 `JudeHaplin`，
> 直接拼会得到 `ghcr.io/JudeHaplin/crewgo`，飞牛安装时就会报
> `invalid reference format: repository name must be lowercase`。CI 和 `build-fpk.sh` 都已强制转小写，
> 并在打包后自检 `image:` 行——如果以后自己改模板，记得别写死大写。

## 参考与致谢

代码是从零写的，没有复制现成项目的源码；但 fpk 目录结构、字段规范、接口用法都大量参照了下面这些官方资料，特此注明：

| 用途 | 参考对象 | 链接 |
|---|---|---|
| fpk 包结构、`manifest` / `config` / `privilege` 字段、install/upgrade/uninstall 生命周期脚本 | 飞牛 fnOS 官方开发者文档（应用包规范与示例） | https://developer.fnnas.com/ |
| `.fpk` 打包与签名 | 官方命令行工具 `fnpack` 1.3.3 | https://developer.fnnas.com/docs/cli/fnpack/ |
| 本地数据库（零依赖） | Node.js 内置 `node:sqlite` 官方文档（Node ≥ 22.5） | https://nodejs.org/api/sqlite.html |
| 邮件通道 | EmailJS 文档与模板变量约定（`{{to_email}}` / `{{subject}}` / `{{{message}}}`） | https://www.emailjs.com/docs/ |
| 微信通道 | PushPlus 推送接口 | https://www.pushplus.plus/doc/ |
| 多架构镜像、CI/CD | Docker 官方文档、GitHub Actions、`docker/build-push-action`、`docker/metadata-action` | https://docs.docker.com/ |
| 图标生成 | Pillow（PIL） | https://python-pillow.org/ |

- 图标里的「速」字用系统字体（Windows 微软雅黑 / Linux DejaVu Sans）渲染成 PNG，**字体文件不随包分发**。
- 前端没有引入框架、也没有 CDN 资源，断网也能用。
- 若后续引入第三方开源代码，会在这里补上项目名、链接与许可证。

## 许可

MIT，见 [LICENSE](LICENSE)。
