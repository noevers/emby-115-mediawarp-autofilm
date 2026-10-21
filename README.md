# 🎬 115 网盘 + 国内 AList + 国外 Emby 全流程 STRM 302 直连与自动化刮削实战教程

> **架构核心亮点：**
> - **国外 VPS 零流量中转**：通过现代 Go 中间件 **MediaWarp** 拦截播放请求，直接下发 `HTTP 302 Found` 响应，客户端直连 **115 官方高速 CDN** 满速拉流。
> - **杜绝网盘频控封禁**：通过 **AutoFilm** 扫描网盘并在本地生成轻量 `.strm` 索引文件，Emby 仅对本地文本秒级建库，无需通过 rclone 挂载大视频文件。
> - **海外直连媒体元数据自动化刮削**：利用国外机器网络环境，通过 **MetaTube Server + Emby 插件** 高速抓取多源影视信息、演职员及高清海报。
> - **私密安全隧道**：国内与国外服务器使用 **Tailscale** 建立私有内网互联，无需在公网暴露 AList 端口。

---

## 📐 1. 架构与数据流走向

```text
[国内服务器]                                 [国外 VPS]
┌────────────────────────┐                   ┌──────────────────────────────────────────────┐
│  AList / OpenList      │                   │  AutoFilm  ──生成strm──>  [本地 /data/strm]   │
│  (挂载 115 网盘)       │                   │     │                          │ 本地秒级刮削 │
│  外部端口: <ALIST_PORT>│                   │     ▼                          ▼              │
│       ▲                │                   │  AList API 换链             Emby (<EMBY_PORT>)│
│       │                │                   │  (读目录/换直链)                 ▲            │
│  Tailscale 私网 IP     │ <── Tailscale内网 ── │  Tailscale 内网互联              │ 前置反代   │
│  (例: 100.x.y.z)       │                   │                             MediaWarp        │
└───────┼────────────────┘                   │                             (<WARP_PORT>)    │
        │ 获取最新直链                       └──────────────────────────────────┬───────────┘
        │                                                                       │ 1. 播放请求
        │                                                                       │
        ▼                                                                       │
[115 官方高速 CDN] <──────────────── 3. 满速原画拉流播放 ───────────── [客户端 (Infuse/VidHub)]
                                (2. 返回 302 Location 重定向)
```

---

## 🔌 2. 端口规划一览表（按需自定义偏移）

> **安全提示**：建议将所有对外端口修改为你自定义的高位非标准端口，防止全网端口扫描器探测。

| 节点 | 服务名称 | 容器内部固定端口 | **宿主机自定义映射端口** | 作用说明 |
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
2. **挂载 115**：进入【存储】->【添加】，驱动选择 **115 Open** 或 **115网盘**，**挂载路径必须填写**：`/115`；
3. **获取 API 令牌**：进入【管理】->【设置】->【其他】（或【全局】），复制 **API Token**（保存备用）。

---

## 🚀 4. 国外服务器部署：Emby + 刮削 + 302 直连网关

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

### 4.3 部署 MediaWarp

编写配置文件 `/opt/media/mediawarp/config/config.yaml`：

```yaml
port: 9000

server:
  type: Emby
  addr: http://emby:8096
  auth: "你的Emby_API_KEY"

log:
  access:
    console: true
  service:
    console: true
    file: false

cache:
  enable: true
  alist_api_ttl: 10m

# 核心 115 302 直连规则
alist_strm:
  enable: true
  proxy: false                                # 严禁走国外服务器中转流量
  raw_url: true                               # 响应 115 官方 CDN 真实直链
  list:
    - addr: http://<国内Tailscale_IP>:<ALIST_PORT> # 国内 AList 的 Tailscale 私网地址与自定义端口
      token: "***"                # 必须带双引号
      prefix_list:
        - /strm                               # Emby 容器内的媒体根目录
```

运行 MediaWarp 容器：
```bash
docker run -d \
  --name mediawarp \
  --restart unless-stopped \
  --network media_net \
  -p <WARP_PORT>:9000 \
  -v /opt/media/mediawarp/config:/config \
  -v /opt/media/mediawarp/config/config.yaml:/app/config/config.yaml \
  akimio/mediawarp:latest
```

---

### 4.4 部署 AutoFilm（带拟人防封延迟与伴生下载）

编写配置文件 `/opt/media/autofilm/config.yaml`：

```yaml
alist:
  - id: domestic_alist
    base_url: http://<国内Tailscale_IP>:<ALIST_PORT>
    token: "***"
    wait_time: 1.2                            # 每次请求强制休眠 1.2 秒（防网盘频控）

media_servers:
  - id: foreign_emby
    kind: emby
    base_url: http://emby:8096
    api_key: "***"

alist2strm_tasks:
  - id: 115网盘
    cron: "0 23 20 * * *"                     # 每天北京时间 20:23 执行一次
    alist: domestic_alist
    source_dir: /115                          # AList 挂载 115 的根路径
    target_dir: /strm/115                     # 输出到容器内目录
    mode: AlistPath
    flatten_mode: false
    overwrite: false
    concurrency: 1                            # 单线程慢速扫描，模拟正常访问
    # 伴生文件自动下载（字幕、封面海报、NFO 元数据直接落盘）
    download:
      enable: true
      subtitle: true                          # 自动下载外挂字幕
      image: true                             # 自动下载本地封面海报
      nfo: true                               # 自动下载本地 nfo 简介
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

### 6.3 直连验证
播放任意 4K 原画影片，在国外 VPS 终端运行 `iftop -i any` 或 `nload`：
- **验证通过标准**：国外 VPS 出网带宽仅有几 KB/s（仅下发 302 重定向信令），视频流由播放器直接从 **115 官方高速 CDN 满速拉取**。
