# 🎬 115 网盘 + 国内 AList + 国外 Emby 全流程 STRM 302 直连与自动化刮削完整解决方案

本仓库包含针对 **115 网盘 302 原画直连** 深度优化修补的 **MediaWarp** 源码、**AutoFilm (STRM 生成工具)** 源码及全套生产环境部署教程。

> **核心特性：**
> - **真正的 115 CDN 满速直连**：本项目修补了上游 MediaWarp 的 User-Agent 丢失问题，在换取播放链接时**动态透传播放器真实 UA**，彻底解决 115 官方 CDN 校验签名失败报 `403 Forbidden (invalid signature)` 的历史顽疾。
> - **客户端无需内网组网**：开启 `raw_url: true` 后，手机 / 电视 / 电脑端播放器无需安装任何内网工具，直连 115 官方全国 CDN 高速拉流。
> - **海外与国内服务器 0 视频带宽**：播放流量不经过任何云服务器，仅在握手瞬间消耗几十字节的 302 重定向信令。
> - **网盘防风控刮削**：通过仓库内的 **AutoFilm** 扫描网盘并生成轻量 `.strm` 纯文本索引文件，Emby 仅对本地文本秒级建库；配合拟人化请求休眠与单线程扫描，杜绝 115 频控封号（429）。
> - **海外高速媒体元数据刮削**：利用国外机器网络环境，结合 **MetaTube Server + Emby 插件** 毫秒级抓取多源影视信息、演职员及高清海报。

---

## 📁 仓库结构

```text
.
├── MediaWarp/        # 包含动态 UA 透传优化补丁的 MediaWarp 源码与 Docker 构建文件
├── AutoFilm/         # 网盘媒体库 STRM 文件自动生成与同步工具源码
└── README.md         # 全流程生产环境部署与调优实战教程
```

---

## 📐 1. 架构与数据流走向

```text
[国内服务器]                                 [国外 VPS]
┌────────────────────────┐                   ┌──────────────────────────────────────────────┐
│  AList / OpenList      │                   │  AutoFilm  ──生成strm──>  [本地 /data/strm]   │
│  (挂载 115 网盘)       │                   │  (本仓库源码集成)               │ 本地秒级刮削 │
│  外部端口: <ALIST_PORT>│                   │     │                          ▼              │
│       ▲                │                   │     ▼                       Emby (<EMBY_PORT>)│
│       │                │                   │  AList API 换链                 ▲            │
│  Tailscale 私网 IP     │ <── Tailscale内网 ── │  (读目录/换直链)                 │ 前置反代   │
│  (例: 100.x.y.z)       │                   │                             MediaWarp (UA优化)│
└───────┼────────────────┘                   │                             (<WARP_PORT>)    │
        │ 带着客户端真实 UA 签出直链          └──────────────────────────────────┬───────────┘
        │                                                                       │ 1. 播放请求 (带UA)
        ▼                                                                       │
[115 官方高速 CDN] <──────────────── 3. 满速原画拉流播放 ───────────── [客户端 (Infuse/VidHub)]
                                (2. 返回 302 Location 专属直链)
```

---

## 🔌 2. 端口规划一览表（按需自定义偏移）

> **安全提示**：建议将所有对外端口修改为你自定义的高位非标准端口，防止全网端口扫描器探测。

| 节点 | 服务名称 | 容器内部端口 | **宿主机自定义映射端口** | 作用说明 |
| :--- | :--- | :--- | :--- | :--- |
| **国内机** | `openlist` / `alist` | `5244` | **`<ALIST_PORT>`** *(自定义端口)* | 挂载 115 网盘，为国外机器提供换链 API |
| **国外 VPS** | `emby` | `8096` | **`<EMBY_PORT>`** *(自定义端口)* | 媒体库核心后台、海报墙展示 |
| **国外 VPS** | `metatube-server` | `8080` | **`<METATUBE_PORT>`** *(仅内网绑定)* | 媒体元数据刮削后端加速缓存 |
| **国外 VPS** | `mediawarp` | `9000` | **`<WARP_PORT>`** *(自定义端口)* | **核心 302 直连网关（客户端实际连接此端口）** |
| **国外 VPS** | `autofilm` | - | - | 无外部端口，后台定时同步 115 生成 `.strm` |

---

## 🛠️ 3. 国内服务器部署：AList / OpenList 挂载 115

### 3.1 启动 AList 容器
```bash
mkdir -p /opt/openlist/data

docker run -d \
  --name openlist \
  --restart always \
  -p <ALIST_PORT>:5244 \
  -v /opt/openlist/data:/opt/openlist/data \
  openlist/openlist:latest
```
*(如使用官方原版 AList，镜像替换为 `xhofe/alist:latest` 即可)*

### 3.2 AList 后台关键配置
1. 访问 `http://国内公网IP:<ALIST_PORT>` 进入后台（初始密码执行 `docker logs openlist` 查看）；
2. **挂载 115**：进入【存储】->【添加】，驱动选择 **115网盘**（二维码来源建议选择 `tv` 或 `android`，防盗链机制更宽松），**挂载路径必须填写**：`/115`；
3. **获取 API 令牌**：进入【管理】->【设置】->【其他】（或【全局】），复制 **API Token**（保存备用）。

---

## 🚀 4. 国外服务器部署：Emby + 刮削 + 优化版 MediaWarp

### 4.1 安装 Tailscale 并打通内网
```bash
curl -fsSL https://tailscale.com/install.sh | sh
tailscale up
```
测试与国内机器的连通性（假设国内机器在 Tailscale 分配的私网 IP 为 `<国内Tailscale_IP>`）：
```bash
ping -c 2 <国内Tailscale_IP>
curl -I http://<国内Tailscale_IP>:<ALIST_PORT>
```

---

### 4.2 部署 Emby 与 MetaTube 元数据插件

```bash
# 1. 创建独立容器网络与存储目录
docker network create media_net || true
mkdir -p /opt/media/emby_config/plugins /opt/media/strm/115 /opt/media/mediawarp/config /opt/media/autofilm /tmp/metatube

# 2. 启动 MetaTube Server（仅绑定 127.0.0.1 杜绝公网暴露，带 Token 鉴权）
METATUBE_TOKEN="***"

docker run -d \
  --name metatube-server \
  --restart unless-stopped \
  --network media_net \
  -p 127.0.0.1:<METATUBE_PORT>:8080 \
  ghcr.io/metatube-community/metatube-server:latest \
  -token "${METATUBE_TOKEN}"

# 3. 下载并解压 Emby.MetaTube 官方插件
curl -fsSL "https://github.com/metatube-community/jellyfin-plugin-metatube/releases/latest/download/Emby.MetaTube%40v2025.1102.2200.0.zip" \
  -o /tmp/metatube/metatube.zip
unzip -o /tmp/metatube/metatube.zip -d /opt/media/emby_config/plugins/
rm -rf /tmp/metatube

# 4. 启动 Emby 媒体服务器
docker run -d \
  --name emby \
  --restart unless-stopped \
  --network media_net \
  -p <EMBY_PORT>:8096 \
  -v /opt/media/emby_config:/config \
  -v /opt/media/strm:/strm:rslave \
  -e PUID=0 \
  -e PGID=0 \
  -e GIDLIST=0 \
  amilys/embyserver:latest
```

#### Emby 后台关键设置：
1. 访问 `http://国外VPS_IP:<EMBY_PORT>` 初始化管理员账号；
2. **生成 API Key**：进入【设置】->【高级】->【API 密钥】-> 点击【+】生成一个 Key 并复制；
3. **关闭转码权限**：进入【设置】->【用户】-> 点击管理员账号，**取消勾选【允许视频转码】和【允许音频转码】**；
4. **配置 MetaTube 插件**：进入【设置】->【插件】-> 找到 MetaTube，设置 `Server` 为 `http://metatube-server:8080`，`Token` 填入你设定的鉴权 Token。

---

### 4.3 构建并部署优化版 MediaWarp（支持客户端 UA 透传直连）

本仓库内提供的 `MediaWarp/` 已经预置了 UA 动态透传补丁，解决了原生版本向 AList 换链时默认发送 `Go-http-client/1.1` 导致 115 签名不匹配的问题。

```bash
# 1. 克隆本仓库到国外 VPS
git clone https://github.com/noevers/emby-115-mediawarp-autofilm.git /opt/emby-suite
cd /opt/emby-suite/MediaWarp

# 2. 构建优化版 Docker 镜像
docker build -t mediawarp:ua-fix -f docker/Dockerfile .

# 3. 编写 MediaWarp 生产配置文件
mkdir -p /opt/media/mediawarp/config

cat << EOF > /opt/media/mediawarp/config/config.yaml
port: 9000

server:
  type: Emby
  addr: http://emby:8096
  auth: "你的Emby_API_KEY"

log:
  access:
    console: false                          # 生产环境关闭访问日志刷屏
    file: false
  service:
    console: true
    file: false

cache:
  enable: true
  alist_api_ttl: 30m                        # 延长 API 缓存时间
  image_ttl: 24h                            # 海报内存缓存 24 小时，滑动海报墙秒开
  subtitle_ttl: 12h

# 核心 115 302 直连规则 (配合 UA 透传补丁，可安全开启 raw_url: true)
alist_strm:
  enable: true
  proxy: false                              # 严禁走国外服务器中转视频流量
  raw_url: true                             # 响应 115 官方 CDN 真实直链，0 服务器带宽占用
  list:
    - addr: http://<国内Tailscale_IP>:<ALIST_PORT> # 国内 AList 的 Tailscale 私网地址与端口
      token: "***"              # 必须带双引号
      prefix_list:
        - /strm                             # Emby 容器内的媒体根目录

# 字幕高清渲染调优
subtitle:
  enable: true
  srt2ass: true                             # 开启外挂 SRT 动态转高质量 ASS 描边字幕
  ass_style:
    - "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding"
    - "Style: Default,苹方-简,22,&H03FFFFFF,&H00FFFFFF,&H00000000,&H02000000,-1,0,0,0,100,100,0,0,1,2,1,2,10,10,12,1"
EOF

# 4. 运行优化版 MediaWarp 容器
docker run -d \
  --name mediawarp \
  --restart unless-stopped \
  --network media_net \
  -p <WARP_PORT>:9000 \
  -v /opt/media/mediawarp/config:/config \
  -v /opt/media/mediawarp/config/config.yaml:/app/config/config.yaml \
  mediawarp:ua-fix
```

---

### 4.4 部署 AutoFilm（STRM 自动生成与伴生下载）

编写配置文件 `/opt/media/autofilm/config.yaml`：

```yaml
alist:
  - id: domestic_alist
    base_url: http://<国内Tailscale_IP>:<ALIST_PORT>
    token: "***"
    wait_time: 1.2                          # 每次请求强制休眠 1.2 秒（防网盘频控）

media_servers:
  - id: foreign_emby
    kind: emby
    base_url: http://emby:8096
    api_key: "***"

alist2strm_tasks:
  - id: 115网盘
    cron: "0 23 20 * * *"                   # 每天北京时间 20:23 执行一次
    alist: domestic_alist
    source_dir: /115                        # AList 挂载 115 的根路径
    target_dir: /strm/115                   # 输出到容器内目录
    mode: AlistPath
    flatten_mode: false
    overwrite: false
    concurrency: 1                          # 单线程慢速扫描，模拟正常人类浏览
    # 伴生文件自动下载（字幕、封面海报、NFO 元数据直接落盘）
    download:
      enable: true
      subtitle: true                        # 自动下载外挂字幕 (.srt/.ass)
      image: true                           # 自动下载本地封面海报
      nfo: true                             # 自动下载本地 nfo 简介
      concurrency: 2
    sync:
      enabled: true
```

启动 AutoFilm 容器（锁定北京时区）：
```bash
docker run -d \
  --name autofilm \
  --restart unless-stopped \
  --network media_net \
  -e TZ=Asia/Shanghai \
  -v /etc/localtime:/etc/localtime:ro \
  -v /opt/media/autofilm:/config \
  -v /opt/media/strm:/strm \
  akimio/autofilm:latest
```

---

## ⚡ 5. 随时手动即时同步工具：`sync-115`

为避免等待每日定时，提供一键即时同步工具。在终端输入 `sync-115` 即可立即触发一次完整扫描并在完成后自动退出清理。

创建脚本 `/usr/local/bin/sync-115`：
```bash
cat << \EOF > /usr/local/bin/sync-115
#!/bin/bash
set -e

echo ">>> 准备执行单次 115 立即同步..."

# 动态获取北京时间 2 秒后的 Cron (秒 分 时 日 月 周)
RUN_CRON=$(TZ=\x27Asia/Shanghai\x27 date -d "+2 seconds" +"%-S %-M %-H %-d %-m *")

mkdir -p /tmp/autofilm_manual
sed "s/cron: .*/cron: \"${RUN_CRON}\"/" /opt/media/autofilm/config.yaml > /tmp/autofilm_manual/config.yaml

CONTAINER_NAME="autofilm_run_once"
docker rm -f "$CONTAINER_NAME" 2>/dev/null || true

echo ">>> 计划在北京时间 [${RUN_CRON}] 准时触发..."

docker run -d \
  --name "$CONTAINER_NAME" \
  --network media_net \
  -e TZ=Asia/Shanghai \
  -v /etc/localtime:/etc/localtime:ro \
  -v /tmp/autofilm_manual:/config \
  -v /opt/media/strm:/strm \
  akimio/autofilm:latest --debug --timezone Asia/Shanghai --config /config/config.yaml > /dev/null

echo ">>> 正在连接网盘递归扫描，实时进度如下："
docker logs -f "$CONTAINER_NAME" 2>&1 | while IFS= read -r line; do
  echo "$line"
  if echo "$line" | grep -qE "scanned_dir_count|Alist2Strm 任务失败"; then
    echo "========================================================="
    echo "✔ 全部目录扫描生成完毕！自动清理退出。"
    echo "========================================================="
    docker rm -f "$CONTAINER_NAME" > /dev/null 2>&1 || true
    rm -rf /tmp/autofilm_manual
    break
  fi
done
EOF

chmod +x /usr/local/bin/sync-115
```

---

## 📺 6. 客户端播放器配置与 4K 直连验证

### 6.1 播放器推荐选型
* **苹果生态（Apple TV / iPhone / Mac）**：
  * **`VidHub`**（强烈推荐，4K/HDR/HEVC 免费播放，海报墙美观）；
  * **`Infuse`**（付费体验佳）；
  * **`SenPlayer`**（轻量稳定）。
* **安卓 / 电视端**：`VidHub Android版`、`Emby Android TV 官方客户端`、`Kodi`。
* **Windows**：`Emby Theater 电脑客户端`（显卡直接硬解）。

### 6.2 客户端连接
* **服务器地址**：`http://国外VPS_IP:<WARP_PORT>`（**切记：必须填写 MediaWarp 映射的自定义端口，不可直连 Emby 的管理端口**）；
* 填写 Emby 用户名和密码登录。
* **无需开启 Tailscale**：得益于 UA 透传补丁，客户端可处于任意公网环境直接拉流。

### 6.3 直连验证
播放任意 4K 原画影片，在国外 VPS 终端运行 `iftop -i any` 或 `nload`：
- **验证通过标准**：国外 VPS 出网带宽仅有几 KB/s（仅下发 302 重定向信令），视频流由播放器直接从 **115 官方高速 CDN 满速拉取**。
