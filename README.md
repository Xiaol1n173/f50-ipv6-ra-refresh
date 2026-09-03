# IPv6 RA 路由修复（F50+CMCC）

## 原理

F50 用移动卡时仅在数据连接建立瞬间收到一次 RA，随后不再发送周期 RA，其默认路由：

```
default via fe80::X dev sipa_ethN ... expires 65536sec
```

到期后不会被刷新，导致 IPv6 断网。本方案定时检查该路由剩余有效期并续期：

- **路径一（标准）**：发 Router Solicitation 引出网关真 RA，内核按 ND 规程自动刷新 —— 需要 rdisc6（可选安装，没有则自动跳过）
- **路径二（同构）**：手工重建一条与 RA 原生路由完全同构的路由：`proto ra` + `hoplimit` + `metric` + 与 RA 一致的 Router Lifetime

## 刷新流程

1. 日志自裁剪（超 64KB 清空重记），IPv6 连通性自检（`ping6 2400:3200::1`）
2. 运营商白名单（`gsm.sim.operator.alpha`，兼容 `,中国移动` 脏值与大小写），非移动卡跳过
3. 动态探测活动数据口（`sipa_eth0~15` 中 state UP 的那个），不写死接口号/路由表名
4. 查找 `default via fe80::...` 路由并解析 `expires`：
   - 路由为静态（无 expires）→ 无需处理，退出
   - 路由已丢失 → 按兜底参数补建
5. **第 1 次 RS**（保留现有路由）：内核原生 RA 路由会原地续期，零断流；用户态 replace 出来的路由内核不认领，本次必然失败——由第 2 次收拾
6. **第 2 次 RS**（删除现有默认路由后重试）：让内核从空表重建原生 RA 路由（此刻默认路由短暂真空）
7. **回落 replace**：`ip -6 route replace` 带完整属性（`proto ra hoplimit metric expires`）重建同构路由，失败则降级为最小参数重试
8. 回读路由验证刷新结果，成功后把所用策略（`nd_renew` / `nd_rebuild` / `ra_replace` / `ra_replace_min`）与时间戳写入 `last_strategy`

返回值：`0`=正常或无需操作　`1`=出错　`2`=条件不满足而跳过

相关命令：

```sh
ip -6 route show table all | grep default        # 查看 IPv6 默认路由
ip -6 route replace default via fe80::2 dev sipa_eth8 table sipa_eth8 expires 600
```

## 插件部署

1. 将 `rdisc6` 托管到可直链下载的 URL，或在插件面板用「上传rdisc6」从本地导入（下载/上传后自动校验：大小、ELF 魔数、可执行性）
2. 在 UFI-TOOLS 中安装插件脚本，全部文件位于 `/data/kano_ipv6_ra/`：

```
/data/kano_ipv6_ra/
├── refresh_route.sh          # 核心修复脚本
├── refresh_route_watch.sh    # 调度器（循环执行上面的脚本）
├── refresh_route_watch.conf  # 调度间隔（秒）
├── refresh_route_watch.pid   # 调度器 pid
├── rdisc6                    # 可选
├── last_strategy             # 上次刷新成功策略
└── refresh_route.log         # 日志
```

3. 面板内选择调度间隔（5 分钟 ~ 6 小时），按需打开「开机自启」（写入 `/sdcard/ufi_tools_boot.sh`，开机自动拉起调度器）

## rdisc6 编译（aarch64 musl 静态）

```sh
# 1. 工具链
wget https://musl.cc/aarch64-linux-musl-cross.tgz
tar xf aarch64-linux-musl-cross.tgz
export PATH=$PWD/aarch64-linux-musl-cross/bin:$PATH

# 2. 源码（官方上游 remlab.net，版本 1.0.8）
wget https://www.remlab.net/files/ndisc6/ndisc6-1.0.8.tar.bz2
tar xf ndisc6-1.0.8.tar.bz2 && cd ndisc6-1.0.8

# 3. 静态编译（只需要 rdisc6 这一个目标）
./configure --host=aarch64-linux-musl CC=aarch64-linux-musl-gcc LDFLAGS="-static"
make

# 4. 确认
file rdisc6   # 应显示: ELF 64-bit ... ARM aarch64, statically linked
```
