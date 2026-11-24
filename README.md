# 速派 CrewGo · 维修人员预约管理系统

> **AI 项目声明**
> 本项目的全部代码、页面、部署脚本与文档由 **AI 编程助手（WorkBuddy）生成**，人类负责提出需求、验收与试用反馈。因此：
> - 代码走的是「够用、简单、单人可维护」的路线，没做过度抽象，也没有高并发设计（团队隔离是 1.2.0 后加的，靠服务端强制注入 `team_id` 实现，够用但谈不上通用多租户方案）；
> - 业务逻辑（权限、团队隔离、时间冲突、通知去重、导入导出）有 **236 项自动化测试**覆盖，但**没有经过长期生产环境检验**；
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

- **姓名 + PIN 登录**：不用收验证码、不用记邮箱密码，维修工抬手机就能登；统筹可随时重设某人的 PIN。PIN 4–32 位，**字母、数字、符号都可以**（区分大小写，首尾空格自动忽略）。
- **微信登录**（1.2.0）：微信里打开自动拉起授权，电脑上打开是扫码；也可以先注册账号、之后在「我的资料」里绑微信。两个入口（公众号网页授权 / 开放平台扫码）用 `unionid` 打通，绑一个两边都能登。
- **团队隔离**（1.2.0）：数据按团队分开存，所有读写都带 `team_id` 且在服务端强制注入——前端改参数也看不到别的团队。注册后要凭**团队码**申请、管理员同意才能进。
- **排期看板**：整月日历，每条预约按人员颜色着色，谁哪天去哪一眼看清；休息日会在日历上打角标。
- **我的安排**：按 已过期 / 今天 / 明天 / 未来一周 分组，卡片上直接改状态。
- **角色权限**：团队内有 统筹管理员（最高权限）/ 管理员 / 成员 三级；管理员能管项目、人员、通知设置，成员只能看排期、改状态。
- **冲突检测 + 休息日**（1.2.0）：同一个人同一时段被约到两个项目会当场拦下来，可以确认后强制保存；维修工设了休息日后，那几天无法再被预约。
- **数据导入 / 导出**（1.2.0）：整库导出成 `.db` 或 JSON，也能直接从 Excel/CSV 导入人员和预约，导入前有预览，重复数据自动跳过。
- **通知四通道**：站内通知、电脑弹窗、邮件（QQ/163 邮箱直连，也可用 EmailJS）、微信（PushPlus），互不影响，配哪个用哪个。
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

首次打开会自动进入**初始化**：填姓名和 PIN，再给团队起个名，这个账号就是**团队统筹管理员**（最高权限），系统同时会生成团队码。

> **从旧版本升级不会丢数据**：启动时自动建一个默认团队（名字是「<你的姓名>的团队」，沿用你现在的全部项目、人员、预约和通知设置），原来那个管理员是团队统筹，**其它人员按原身份分成管理员/成员**（1.1.0 里的普通维修工升级后仍是成员，不会凭空拿到管理权限），所有人原 PIN 照旧能登。团队名可以在「设置 → 团队」里改，团队码也在那里。老的 `settings` 表结构会自动重建（`id=1` 的单行改成每团队一行），全程不需要手工动数据库——但**升级前建议先导出一次备份**。

> **拉镜像报 `unauthorized` 时**：GHCR 的容器包新建后默认私有，需要在
> `github.com/users/<owner>/packages/container/crewgo/settings` → 底部 Danger Zone →
> Change visibility → Public，改成公开后即可匿名拉取。
> 不想公开也行，先 `docker login ghcr.io`（用个人令牌，勾 `read:packages`）再拉。

## 部署到云服务器（阿里云轻量 / 任意 VPS）

NAS 上的飞牛网关偶尔会闹脾气，云服务器是最省事的路子：公网 IP、24 小时在线、手机流量也能访问。

### 怎么选

| 项 | 建议 | 说明 |
|---|---|---|
| 产品 | **轻量应用服务器**（不是 ECS） | 便宜、带固定公网 IP、控制台简单，2核2G 年付百元级足够 |
| 地域 | 选离使用的人近的（北京 / 杭州 / 深圳 / 广州） | 30 人看页面，延迟差别很小；但**地域决定备案归属** |
| 镜像 | **Ubuntu 24.04 LTS** | Docker 兼容最好；Alibaba Cloud Linux 也行 |
| 规格 | **2 核 2G** 起 | 应用本身只吃几十 MB 内存，但 Docker 拉镜像/构建时 1G 会紧张 |
| 磁盘 | 40G 系统盘 | 镜像约 60MB，数据几 MB，够用很久 |
| 带宽/流量 | 200Mbps 峰值 + 月流量包 | 你们一个月顶多用几个 G，随便选最便宜的档 |
| 续费 | **一定看续费价** | 新客 79/年，续费常是 300+/年，别只看首年 |

### 备案这件事（很重要）

- **只用 `http://公网IP:8080` 访问 → 不需要备案**，买完十几分钟就能用。
- **想用域名 + 80/443 访问 → 必须 ICP 备案**（域名要实名，服务器在大陆地域），阿里云免费代办，通常 1–2 周；没备案的域名解析到大陆机器会被拦。
- 不想备案又要域名：买**阿里云香港**地域，代价是延迟略高。

### 部署步骤（约 10 分钟）

1. **买完先重置密码**：控制台 → 服务器 → 「重置密码」，设一个 root 密码。
2. **放行端口**：轻量服务器 → 「防火墙」→ 添加规则，TCP `8080`（想更低调就换个端口，比如 `9080`，脚本支持 `PORT=9080`）。
3. **SSH 登录**：

   ```bash
   ssh root@<你的公网IP>
   ```

4. **跑一条命令**（用 jsDelivr CDN，`raw.githubusercontent.com` 在国内经常被重置）：

   ```bash
   curl -fsSL https://ghfast.top/https://raw.githubusercontent.com/JudeHaplin/crewgo/main/deploy/cloud/install.sh | sudo bash
   ```

   取不到就换这两个（都是实时抓 GitHub，不会拿到旧版）：

   ```bash
   curl -fsSL https://gh-proxy.com/https://raw.githubusercontent.com/JudeHaplin/crewgo/main/deploy/cloud/install.sh | sudo bash
   curl -fsSL https://raw.githubusercontent.com/JudeHaplin/crewgo/main/deploy/cloud/install.sh | sudo bash
   ```

   > 注意：`cdn.jsdelivr.net/gh/...@main/...` 这类 CDN 对分支引用有约 12 小时缓存，脚本刚更新时可能仍拿到旧版本，不建议用来部署/升级。

   脚本干四件事：没 Docker 就装、拉镜像（直连失败自动换南大镜像）、建数据目录并给容器用户写权限、起容器并自检。跑完直接打印访问地址。

5. **手动版**（脚本取不到时用这个，任何一步失败也好逐段定位）：

   ```bash
   # 装 Docker（Ubuntu/Debian）
   sudo apt-get update && sudo apt-get install -y docker.io
   sudo systemctl enable --now docker

   # 数据目录：容器里应用以 uid 1000 运行，目录必须归它，否则页面能开但保存报错
   sudo mkdir -p /opt/crewgo/data && sudo chown -R 1000:1000 /opt/crewgo/data

   # 拉镜像（直连 ghcr.io 慢，用南大镜像后打回原名）
   sudo docker pull ghcr.nju.edu.cn/judehaplin/crewgo:1.2.0
   sudo docker tag ghcr.nju.edu.cn/judehaplin/crewgo:1.2.0 ghcr.io/judehaplin/crewgo:1.2.0

   # 启动
   sudo docker run -d --name crewgo --restart unless-stopped \
     -p 8080:8080 -v /opt/crewgo/data:/data \
     -e TZ=Asia/Shanghai -e PORT=8080 -e DIGEST_HOUR=8 \
     ghcr.io/judehaplin/crewgo:1.2.0

   # 自检
   curl -I http://127.0.0.1:8080/api/health
   ```

6. 浏览器打开 `http://<公网IP>:8080/`，第一个进入的人创建统筹管理员账号。

### 想要域名 + HTTPS（备案通过后再做）

用 Caddy 反代，Let's Encrypt 证书自动申请、自动续期（免费，不用买）：

```bash
# 前提：ICP 备案已通过、A 记录已指向本机、防火墙放行 80/443
curl -fsSL https://ghfast.top/https://raw.githubusercontent.com/JudeHaplin/crewgo/main/deploy/cloud/https.sh -o /tmp/https.sh
sudo bash /tmp/https.sh crewgo.cn
```

脚本会检查解析与端口、装 Caddy、写反代配置、等证书签发并自检。手工版等价操作：

```bash
apt-get install -y caddy
cat >/etc/caddy/Caddyfile <<'EOF'
crewgo.example.com, www.crewgo.example.com {
    encode gzip
    reverse_proxy 127.0.0.1:8080
}
EOF
systemctl restart caddy
```

> 也可以不装 Caddy，用阿里云「个人测试证书（免费版）」：每实名主体每年 20 张、**90 天有效期且不自动续期**，到期要重新申请并替换。相比之下 Let's Encrypt 自动续期，省事得多。轻量服务器控制台的「HTTPS 设置」面板只认阿里云账号内的证书，走 Caddy 就不受这个限制。
>
> 未备案时 Let's Encrypt 的 HTTP 验证会被大陆服务器拦掉，所以**必须先备案再上证书**。

### 日常维护

```bash
docker logs -f crewgo                    # 看日志（1.0.3 起每个请求一行）
docker restart crewgo                    # 重启
docker rm -f crewgo && bash install.sh   # 升级到新版本（数据在 /opt/crewgo/data 不动）
tar czf crewgo-data-$(date +%F).tgz -C /opt crewgo/data   # 备份
```

**升级前顺手备份**（尤其跨大版本，比如 1.0.x / 1.1.0 → 1.2.x，会自动改表结构）：

```bash
tar czf ~/crewgo-data-$(date +%F).tgz -C /opt crewgo/data
```

**升级后起不来怎么回退**：数据永远在 `/opt/crewgo/data`，容器删了也不会动，退回上一个镜像就行。

```bash
docker images | grep crewgo              # 看本机还留着哪些版本
docker rm -f crewgo
docker run -d --name crewgo --restart unless-stopped -p 8080:8080 \
  -v /opt/crewgo/data:/data -e TZ=Asia/Shanghai -e PORT=8080 \
  ghcr.io/judehaplin/crewgo:1.1.0
```

回退前先 `docker logs --tail 30 crewgo` 看一眼报错，把最后几行发出来更快定位。

**公网暴露后的安全建议**：管理员 PIN 别用 `1234`，至少 6 位；**团队码当成口令对待**——只在内部群发，别贴在公开页面，怀疑外泄就「设置 → 团队 → 重置团队码」；**别打开「允许直接加入」**，让每个新人都走审批；端口随意但防火墙规则要精确到 TCP；SSH 建议改成密钥登录并禁用密码。

## 顺手把飞牛 NAS 也挂到公网（可选）

如果 NAS 只有 IPv6 公网、而你要从没有 IPv6 的网络（公司、部分手机热点）访问它，可以用这台服务器做中转。

原理上这不是「反向代理」而是**反向隧道**：阿里云轻量服务器不支持 IPv6，没法主动连 NAS；但 NAS 能主动向服务器的 IPv4 建立出站连接，隧道建好之后，服务器顺着这条连接把流量送回 NAS。所以两端都不需要 IPv6。

```bash
curl -fsSL https://ghfast.top/https://raw.githubusercontent.com/JudeHaplin/crewgo/main/deploy/nas/frp-server.sh -o /tmp/frp.sh
sudo bash /tmp/frp.sh                      # 默认通道 7000，对外 7100，NAS 后台 5666
sudo env NAS_PORT=5000 bash /tmp/frp.sh    # NAS 后台端口不是 5666 时指定
```

脚本会装好 `frps` 并注册为 systemd 服务，最后打印**飞牛端要粘贴的 frpc 配置和启动命令**。

跑之前/之后必须做：阿里云控制台 → 防火墙 → 放行 `TCP 7000`（隧道）和 `TCP 7100`（对外）。

日常维护：

```bash
systemctl status frps
journalctl -u frps -n 50 --no-pager
```

**先说清代价**：走隧道时速度受服务器带宽限制（3 Mbps 套餐约 350 KB/s），看文件列表、下载文档没问题，在线看视频不行。手机 4G/5G 通常自带 IPv6，可以继续直连 NAS 拿满速，两条路并存最好。

> 不用 Docker 的原因：`fatedier/frp` 只在 Docker Hub，国内常拉不动，且 ghcr 上没有这个镜像（实测 404）。所以脚本直接装官方二进制。

## 安装到飞牛 fnOS（fpk）

1. 到 [Releases](../../releases) 下载 `crewgo-<版本号>.fpk`（**请用 1.2.0 或更新版本**）
2. 飞牛应用中心 → 手动安装 → 选择该文件
3. 装完从桌面图标打开，第一次进入创建管理员

> fpk 未做开发者签名（CI 用 `--nosign` 构建），安装时可能提示「未签名/未知来源」，允许继续即可。要上架飞牛应用中心需要申请官方开发者证书，然后 `KEY=developer.key CERT=developer.crt ./scripts/build-fpk.sh`。

数据目录在应用安装卷的 `var/data` 下，升级会自动备份，卸载前请先导出。

### 装不上时对照这张表

| 弹窗报错 | 原因 | 处理 |
|---|---|---|
| `unable to get image 'ghcr.io/JudeHaplin/crewgo:1.0.x'`<br>`repository name (JudeHaplin/crewgo) must be lowercase` | 镜像地址里带了大写字母，Docker 不认这种名字。1.0.0 / 1.0.1 的打包脚本把 GitHub 用户名原样拼进去了 | 换 **1.0.2+** 的 fpk（脚本已强制转小写，并在打包时自检） |
| 装好了，但点桌面图标 / 打开 `xxx.fnos.net` 报 **HTTP 502**「该网页无法正常运作」 | 飞牛网关连不到应用端口：bridge + `ports` 映射在部分 fnOS 版本上，网关拿不到容器端口 | 换 **1.0.3+** 的 fpk（容器改 host 网络，网关直接连 `127.0.0.1:8080`）；仍不通就先用日志里打印的 `http://<NAS局域网IP>:8080/` 直连 |
| `unauthorized` / `denied` / `manifest unknown` | GHCR 上的容器包是私有，或 tag 还没构建完 | 见上面「拉镜像报 unauthorized」；或等 Actions 跑完 |
| `context deadline exceeded` / `i/o timeout` | NAS 访问 `ghcr.io` 太慢（国内常见） | 给 NAS 的 Docker 配代理；或在能拉取的机器 `docker pull` 后 `docker save` 成 tar，传到 NAS `docker load`，此时把 compose 里的 `image` 改成你 load 进去的本地名字 |
| 端口 8080 已被占用 | 别的应用占了这个端口（host 网络下更要注意） | 先停掉占用者，或同时改 compose 里的 `PORT` 与 manifest 的 `service_port` |

手动排查最快的方式：把弹窗里的镜像地址复制出来，在 NAS 的终端执行 `docker pull <那个地址>`，报错就很明确了。

### 界面打不开时看日志

1.0.3 起，应用「运行日志」里会直接打出可访问地址和一个请求日志：

```
速派已启动 v1.0.3 → 监听 0.0.0.0:8080
数据目录：/data
浏览器打开：http://192.168.1.10:8080/
```

- 用这个 `http://192.168.1.10:8080/` 能打开 → 应用没问题，是飞牛域名/反代这一段的事，可以直接用 IP 访问，或在飞牛「远程访问」里把该应用加进可访问列表。
- 用 IP 也打不开 → 端口没通：`docker ps` 看容器状态、`ss -lnt | grep 8080` 看宿主有没有在听。
- 打开域名时日志里**没有任何 `GET /` 记录** → 请求没到应用，问题在网关层；有记录但浏览器仍是 5xx → 把日志里那行 `host=...` 发我。

## 第一次用，按这个顺序

1. **建管理员 + 建团队**：首次打开填姓名 + PIN（4–32 位，字母/数字/符号都行，区分大小写），再给团队起个名。系统会**自动生成团队码**，形如 `ABC123456`（前 3 位大写字母 + 6 位数字，字母去掉了容易看错的 `I`/`O`）。这个人就是**团队统筹管理员**（最高权限）。
2. **设置 → 项目**：把小区/楼盘录进去，可设默认地址。
3. **设置 → 人员**：加维修工和预约人，填邮箱（选填），设一个 PIN（留空默认 `1234`）。
4. **建第一条预约**：项目、维修人员、日期、时段、地址、报修内容、联系人电话。
5. 把**团队码**发给同事，他们自己注册后填码申请，你在「设置 → 团队」里点同意（管理员也能批）。
6. 让每个人用**自己的姓名 + PIN** 登录，维修工登录后直接落在「我的安排」。

忘记 PIN：统筹在「设置 → 人员 → 编辑」里重设；本人也可以在「设置 → 我的资料」里改。

## 团队、团队码与审批（1.2.0）

系统默认是「关起门来自己用」的：任何人拿到链接注册，也**只能看到一个空库**，看不到你们的项目、人员、预约。

**三种角色**

| 角色 | 能干什么 |
|---|---|
| 统筹管理员（`owner`） | 全部权限；可改团队名、重置团队码、任免管理员、移交团队、解散团队 |
| 管理员（`admin`） | 审批入团申请、管项目/人员/通知设置、移除成员 |
| 成员（`member`） | 看团队排期、建和改预约、设自己的休息日 |

**加入流程**

```
同事打开链接 → 注册（姓名 + PIN + 手机号）→ 填团队码申请
      → 管理员/统筹在「设置 → 团队 → 待审批」看到申请 → 同意
      → 才成为成员，此时才能看到团队数据
```

- 没被批准前，页面只会显示「等待审批」，看板和人员都是空的。
- 申请人可以自己撤回申请；管理员也可以拒绝。
- **有人申请时，统筹和管理员会收到站内通知**（铃铛 + 电脑弹窗，页面开着的话一分钟内就到），不用天天去翻设置页。
- **同名的人**：如果团队里已经有一个同名档案（老版本手工建的、或导入台账时自动建的），同意申请时会**合并**到那一行——历史预约、休息日都跟着新账号走，不会报 `UNIQUE constraint`。如果同名的那位是管理员/统筹，则不合并（防止顶着名字把权限接过去），会提示你先去「设置 → 人员」改名。
- **团队码泄露了**：统筹在「设置 → 团队」里点「重置团队码」，旧码立刻失效（已加入的人不受影响）。
- **允许直接加入**：如果你们是内部小圈子、觉得审批麻烦，统筹可以打开这个开关，之后填对团队码就直接进，不用等审批。**公网部署时建议保持关闭。**
- 同名的两个人可以分属不同团队：登录时用「姓名 + PIN」在所有团队里找匹配的那个，PIN 不对就进不去。

> 技术上，所有业务表都带 `team_id`，`/api/db` 在服务端强制拼上 `WHERE team_id = <当前登录者>`；`team_id` / `team_role` 这两列被服务端锁死，不能通过接口改（否则谁都能给自己提权）。这就是「前端改参数也看不到别的团队」的原因。

## 微信登录怎么配（1.2.0，都选填）

不配也能用，配了之后可以直接微信登录、或者在「我的资料」里绑微信（绑定后登录页会提示「未绑定微信」，点了就走授权）。

| 场景 | 需要的微信能力 | 配置项 |
|---|---|---|
| 微信里打开（群里点链接、公众号菜单） | **公众号网页授权**（服务号，`snsapi_userinfo`） | 公众号 AppID + AppSecret |
| 电脑浏览器打开 | **开放平台网站应用**（扫码登录，`snsapi_login`） | 开放平台 AppID + AppSecret |

「设置 → 登录方式」里把上面两组填进去保存即可，填完页面会自动显示正确的**授权回调域名**（形如 `https://你的域名/api/auth/wechat/callback`），把它原样填到微信后台：

- 公众号：`mp.weixin.qq.com` → 设置与开发 → 公众号设置 → 功能设置 → **网页授权域名**（微信要的那个 `MP_verify_xxx.txt` 校验文件，直接丢进数据目录 `/data` 就能被访问到，不用重新打镜像）
- 开放平台：`open.weixin.qq.com` → 管理中心 → 网站应用 → **授权回调域**（**只填域名，不带 `https://` 和路径**）

两个 AppID 最好在微信后台绑定到同一个开放平台账号，系统会用 `unionid` 把它们认成同一个人——绑一次微信，公众号和扫码两边都能登。

> 常见报错已经翻译成中文了：`40029` 授权码失效（重复用/过期，重来一次即可）、`40125` AppSecret 填错、`50001` 网页授权域名和后台不一致、`redirect_uri 参数错误` 多半是回调域名没填对或带了端口。

**用微信直接注册的账号**，登录后会被强制要求补**姓名 + 手机号**才能进主界面（手机号必须是 11 位大陆号码，`1[3-9]` 开头，空格/横线/`+86` 会自动清理）。这样团队里不会出现一堆「微信用户」。

## 排期冲突与休息日（1.2.0）

**冲突检测**：保存预约时，服务端会查「同一个人 + 同一天 + 时段重叠」的其它单子（全天与任何时段都算冲突），命中就返回 409 和冲突明细，页面上是一条黄色提示条，写着撞了哪一单、在哪个项目。确认没问题可以点「仍然保存」强制写入（比如上午在东区下午在西区，本来就该这么排）。

**休息日**：

- 维修工在「设置 → 我的资料 → 我的休息日」里选日期加进去，支持一次选一段（最多 180 天）。
- 管理员在「设置 → 人员」里也能替某个人加休（请假、调休）。
- 加了之后，这个人在那些天**无法被预约**——新建/修改预约时直接拦下并说明「XX 当天休息」。日历上当天会显示 `休` 角标，旁边列出谁在休息。

> 冲突检测和休息日都是**写库前**在服务端判的，绕过前端直接调接口也会被拦。休息日只拦「新建/改期」；只改状态（比如标成已完成）不受影响，避免历史单子改不动。

## 通知怎么配（都选填）

| 通道 | 需要什么 | 说明 |
|---|---|---|
| 站内通知 | 无 | 右上角铃铛，登录就能看到 |
| 电脑弹窗 | 浏览器授权 | 页面开着时弹系统通知 |
| 邮件 | 邮箱地址 + 授权码（SMTP 直连） | QQ 邮箱约 500 封/天，免费、不经过第三方；也可切到 EmailJS（200 封/月） |
| 微信 | 每人或全局的 PushPlus token | 免费 200 条/天，关注公众号即可，不用装 App |

**邮件（3 分钟，QQ 邮箱为例）**：

1. `mail.qq.com` → 设置 → 账号 → 开启「SMTP 服务」→ 手机发一条验证短信 → 拿到 **16 位授权码**（只显示一次）
2. 「设置 → 通知 → 邮件通知」选 **邮箱直连**：服务器 `smtp.qq.com`、端口 `465`、账号填完整邮箱、授权码粘进去
3. 保存 → 点「发一封测试」

> 服务端用自己写的极简 SMTP 客户端（`server/src/smtp.js`，零依赖）直连发信，授权码只存在服务器上、不会下发到浏览器。465 走 SSL，587 走 STARTTLS，163/腾讯企业邮同理。也可切回「EmailJS 中转」，填 Service ID / Template ID / Public Key 即可。

**微信**：`pushplus.plus` 微信扫码 → 实名 → 复制 token。token 可以填在每个人档案里（只推给他），也可以填全局（群推）。

**定时任务**：容器每 5 分钟检查一次，`DIGEST_HOUR`（默认 8）点后发当日汇总，一天一封；今天/次日还没提醒过的单各补一次提醒。全部幂等，重启不会重复发。

## 数据与备份

- 数据库：`/data/repair.db`（挂载在宿主机的 `./data`）
- 签名密钥：`/data/secret.key`（丢了只是所有人要重新登录）
- 自动快照：每次从界面上「导入数据库」前，会把当前库拷一份到 `/data/backups/`，出问题能退回去
- 备份：直接拷 `data` 目录，或用下面的界面导出
- 恢复：把 `repair.db` 放回 `/data` 再重启容器，或者在界面上「导入数据库」

### 界面里导出（1.2.0）

「设置 → 数据备份」三个按钮：

| 操作 | 得到什么 | 什么时候用 |
|---|---|---|
| 导出数据库（`.db`） | 当前团队的完整 SQLite 文件 | 换机器、整库搬走、存档 |
| 导出 JSON | 本团队的项目、人员、预约、通知、设置 | 想用脚本处理、或跨版本迁移 |

> **JSON 里不含密钥**：邮箱授权码、微信 AppSecret、PushPlus token 导出时会被清空（`redacted` 字段会列出被清掉哪几列），导入后重新填一次即可。PIN 只保留 scrypt 哈希，所以导入后大家还能用原 PIN 登录；从 JSON 里**新加**的人员没有 PIN，需要管理员在「设置 → 人员」里设一个。
| 导入 | 支持 `.db` / `.json` / `.csv` / `.xlsx` | 从旧系统搬数据、批量录人 |

**导入数据库（`.db`）** 是**整库替换**：会先校验文件头是不是真的 SQLite、有没有必需的 `profiles` / `appointments` 表，通过后自动快照当前库再替换，替换完立刻生效（不用重启容器）。注意这是**整个部署**的库，团队隔离下只有统筹能操作。

**导入表格（`.csv` / `.xlsx`）** 是**按行合并**，不会覆盖已有数据：

- 表头认中文列名，也认常见别名（`姓名/人员/维修工`、`日期/上门日期/预约日期/预定维修日期`、`时段/时间/时间段`、`报修内容/维修项目/内容`、`项目/项目名称/小区` 等），列的顺序无所谓，多余列忽略；「创建时间」「最后修改时间」这类系统列不会被误当成时段；
- 日期支持 `2026-11-25`、`2026/11/25`、`2026年11月25日`、Excel 的日期序列号；
- 时段写 `上午 / 下午 / 全天 / 晚上` 都认，`AM/PM` 也认；**表里根本没有时段列时，按「全天」导入**（台账通常只记到天）；
- 状态认 `待确认 / 已确认 / 进行中 / 已完成 / 已取消`，写别的按「待确认」处理；如果表里有「实际维修日期 / 完工日期」且填了值，那行自动记成**已完成**；
- 预约里出现的项目和人员如果库里没有，会**自动建档**，不用先手工录；
- 判断重复看「日期 + 时段 + 人员 + 项目 + 地址」，已经存在的那行直接跳过，所以同一份表格导两次不会重复；
- 导入前会先给一份**预览**（几行、几列、认到了哪些字段、有几条重复、将要新建哪些项目和人员），确认后才真写库，写完给一份报告（新增多少、跳过多少、哪几行有问题）。预览里的数字和真跑完全一致。

> CSV 编码自动识别 UTF-8 / UTF-8 BOM / GBK——从 Excel「另存为 CSV」出来的中文不会变乱码。

## 技术栈

| 层 | 实现 |
|---|---|
| 前端 | 原生 HTML/CSS/JS，无构建、无框架，单页 |
| 后端 | Node 22 原生 `http` + 内置 `node:sqlite`，**零外部依赖** |
| 认证 | 姓名 + PIN（scrypt 加盐哈希），HMAC 签名令牌，登录失败限速；微信 OAuth2 手写实现（无需 SDK） |
| 隔离 | 所有业务表带 `team_id`，服务端强制注入过滤；`team_id`/`team_role` 不可通过接口修改 |
| 通知 | 自写 SMTP 客户端（邮件，零依赖）、PushPlus（微信），全部由服务端发出 |
| 导入导出 | 手写 CSV 状态机（引号/换行/BOM/GBK）+ 手写 XLSX 解析（zip + `zlib.inflateRawSync` + sharedStrings），零依赖 |
| 打包 | Docker 多架构镜像（amd64/arm64）+ 飞牛 fpk |

接口很小：

```
POST /api/auth/setup     首次初始化管理员 + 建团队
POST /api/auth/login     姓名 + PIN 登录
POST /api/auth/register  注册（之后要凭团队码申请加入）
POST /api/auth/profile   补姓名/手机号（微信直接注册的账号必须先补）
GET  /api/auth/me        当前登录者（带团队、待审批、微信绑定状态）
POST /api/auth/pin       修改自己的 PIN
GET  /api/auth/wechat/url      取微信授权地址（公众号 / 扫码自动选）
GET  /api/auth/wechat/callback 微信回调（换 unionid → 一次性 ticket）
POST /api/auth/wechat/ticket   用 ticket 换正式会话
POST /api/auth/wechat/unbind   解除微信绑定
POST /api/team/create|join|cancel          建团队 / 凭团队码申请 / 撤回申请
GET  /api/team/requests                    待审批列表（管理员）
POST /api/team/requests/decide              同意 / 拒绝
GET  /api/team/members                     成员列表
POST /api/team/members/role|members/remove  任免管理员 / 移除成员
POST /api/team/code/reset|allow-direct|rename|owner|leave|dissolve  团队管理
GET  /api/settings/wechat    读微信配置（不返回 Secret）
POST /api/settings/wechat    保存微信配置
POST /api/db                 统一的数据读写（表名白名单 + 团队过滤 + 权限校验 + 冲突检测）
POST /api/schedule/check     查某人某天某时段是否冲突
GET  /api/schedule/time-off  休息日列表
POST /api/schedule/time-off  加休息日（支持区间）
POST /api/schedule/time-off/remove  取消休息日
GET  /api/backup/export      导出（format=db|json）
POST /api/backup/import      导入（.db 整库 / .json 合并 / .csv .xlsx 表格，dry=1 只预览）
POST /api/mail/send          发一封邮件（SMTP 直连或 EmailJS 中转）
POST /api/mail/digest        立即发今日汇总
GET  /api/health             健康检查（容器 healthcheck 用）
```

## 本地开发

```bash
DATA_DIR=./.data PORT=8080 node --no-warnings server/src/index.js
```

跑测试（自动为每个测试文件起一个干净实例，共 236 项断言）：

```bash
node server/test/run.js              # 全部
node server/test/run.js api-smoke    # 只跑一个
```

## 打包与发布

```bash
# 打 fpk（需要官方 fnpack：https://developer.fnnas.com/docs/cli/fnpack/）
# OWNER 写 GitHub 用户名即可（大小写随意），脚本会自动把镜像名部分转成小写
OWNER=<你的GitHub用户名> ./scripts/build-fpk.sh 1.2.0

# 发布：打 tag 后 GitHub Actions 自动构建镜像 + 打包 fpk 并挂到 Release
git tag v1.2.0 && git push origin v1.2.0
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
| 邮件通道（直连） | QQ 邮箱 / 163 邮箱官方 SMTP 参数与授权码机制（`smtp.qq.com:465`、`smtp.163.com:465`），MIME 与 RFC 2047 中文编码按 RFC 5322/2045/2047 实现 | https://service.mail.qq.com/ |
| 邮件通道（中转，可选） | EmailJS 文档与模板变量约定（`{{to_email}}` / `{{subject}}` / `{{{message}}}`） | https://www.emailjs.com/docs/ |
| 微信通道 | PushPlus 推送接口 | https://www.pushplus.plus/doc/ |
| 多架构镜像、CI/CD | Docker 官方文档、GitHub Actions、`docker/build-push-action`、`docker/metadata-action` | https://docs.docker.com/ |
| 图标生成 | Pillow（PIL） | https://python-pillow.org/ |

- 图标里的「速」字用系统字体（Windows 微软雅黑 / Linux DejaVu Sans）渲染成 PNG，**字体文件不随包分发**。
- 前端没有引入框架、也没有 CDN 资源，断网也能用。
- 若后续引入第三方开源代码，会在这里补上项目名、链接与许可证。

## 许可

MIT，见 [LICENSE](LICENSE)。
