#!/system/bin/sh
#
# refresh_route.sh —— 修复中兴 F50（移动卡）IPv6 默认路由不随 RA 刷新、65536s 后掉线的问题
#
# 原理：F50 用移动卡时仅在数据连接建立瞬间收到一次 RA，但随后不发送周期RA，其默认路由
#       `default via fe80::X dev sipa_ethN ... expires 65536sec`
#       到期后不会被刷新，导致 IPv6 断网。本脚本定时检查该路由剩余
#       有效期，低于阈值就用 ip route replace 续期。
#
#   路径一（标准）：发 Router Solicitation 引出网关真 RA，内核按 ND 规程自动刷新
#                   ——需要 rdisc6（ndisc6 包，可选安装，没有则自动跳过）
#   路径二（同构）：手工重建一条与 RA 原生路由完全同构的路由：
#                   proto ra + hoplimit + metric + 与 RA 一致的 Router Lifetime
# 部署（crontab，每小时检查一次，日志由脚本自理）：
#   0 * * * * sh /data/kano_cron/scripts/refresh_route.sh
#
# 返回值：0=正常或无需操作  1=出错  2=条件不满足而跳过
#
# 特性：
#   - 动态探测活动数据口（sipa_eth0~15），不写死接口号/路由表名
#   - 运营商白名单，兼容 ",中国移动" 这类脏值及大小写差异
#   - 日志自动追加并按大小裁剪（/sdcard/refresh_route.log）
#   - 刷新后回读路由验证，失败以非零退出
#

# ip -6 route show table all | grep default      # IPv6
# ip route show table all | grep default         # IPv4
# ip -6 route replace default via fe80::2 dev sipa_eth8 table sipa_eth8 expires 600


# rdisc6编译
# # 1. 工具链
# wget https://musl.cc/aarch64-linux-musl-cross.tgz
# tar xf aarch64-linux-musl-cross.tgz
# export PATH=$PWD/aarch64-linux-musl-cross/bin:$PATH
#
# # 2. 源码（官方上游 remlab.net，版本 1.0.8）
# wget https://www.remlab.net/files/ndisc6/ndisc6-1.0.8.tar.bz2
# tar xf ndisc6-1.0.8.tar.bz2 && cd ndisc6-1.0.8
#
# # 3. 静态编译（只需要 rdisc6 这一个目标）
# ./configure --host=aarch64-linux-musl CC=aarch64-linux-musl-gcc LDFLAGS="-static"
# make
#
# # 4. 确认
# file rdisc6   # 应显示: ELF 64-bit ... ARM aarch64, statically linked

# ================= 配置 =================
RA_LIFETIME=65535           # 与网关 RA 下发的 Router Lifetime 一致（≈18.2h，标准寿命）
                            # 改 864000 = 10 天，换取强容错（放弃寿命忠实性）
THRESHOLD=63000             # 剩余有效期低于此值(17.5h)才刷新
GW_FALLBACK="fe80::2"       # 路由完全丢失时的兜底网关
IF_PREFIX="sipa_eth"        # 厂商数据口前缀（自动探测 0~15 中 state UP 的那个）
IF_FALLBACK="sipa_eth8"     # 探测不到 UP 口时的兜底接口（按你设备实际填）
LOG="/sdcard/refresh_route.log"
LOG_MAX=65536               # 日志超过 64KB 清空重记
RDISC6="/data/kano_cron/bin/rdisc6" # rdisc6 的 aarch64 musl 静态构建

PATH=/system/bin:/system/xbin:/vendor/bin:/odm/bin:/sbin
export PATH

log() { echo "[$(date '+%m-%d %H:%M:%S')] $*" | tee -a "$LOG" 2>/dev/null; }


[ -f "$LOG" ] && [ "$(wc -c < "$LOG")" -gt "$LOG_MAX" ] && : > "$LOG"

# 可选：连通性自检（移动 IPv6 DNS）
ping6 -c 1 -W 3 2400:3200::1 >/dev/null 2>&1 && log "IPv6 连通性 OK" || log "⚠️ ping 不通"

log "===== 开始检查 ====="

# ================= 运营商白名单 =================
OPERATOR=$(getprop gsm.sim.operator.alpha 2>/dev/null | tr -d '\r\n\t ,' | tr '[:upper:]' '[:lower:]')
case "$OPERATOR" in
    *移动*|*cmcc*|*chinamobile*)
        log "运营商: $OPERATOR"
        ;;
    "")
        log "错误：读取运营商属性失败，跳过"
        exit 1
        ;;
    *)
        log "非中国移动($OPERATOR)，跳过"
        exit 2
        ;;
esac

# ================= 探测活动数据口 =================
DEV=""
for i in 0 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
    IFACE="${IF_PREFIX}${i}"
    if ip link show dev "$IFACE" 2>/dev/null | grep -q 'state UP'; then
        DEV="$IFACE"
        break
    fi
done
[ -n "$DEV" ] || DEV="$IF_FALLBACK"
log "数据口: $DEV"

# ================= 工具函数 =================
find_route() {
    ip -6 route show table all 2>/dev/null | grep '^default via fe80' | grep -m1 " dev $DEV "
}
get_expires() { echo "$1" | sed -n 's/.*expires \(-\{0,1\}[0-9]\{1,\}\)sec.*/\1/p'; }

# ================= 现状检查 =================
ROUTE_LINE=$(find_route)
OLD_EXP=$(get_expires "$ROUTE_LINE")
[ -n "$OLD_EXP" ] || OLD_EXP=-1

if [ -z "$ROUTE_LINE" ]; then
    log "未找到 RA 默认路由（可能已到期被删），需要补建"
elif ! echo "$ROUTE_LINE" | grep -q 'expires'; then
    log "默认路由为静态（无 expires），无需处理"
    exit 0
elif [ "$OLD_EXP" -lt "$THRESHOLD" ] 2>/dev/null; then
    log "剩余有效期 ${OLD_EXP}s，低于阈值 ${THRESHOLD}s，需要刷新"
else
    log "剩余有效期 ${OLD_EXP}s，充足，无需刷新"
    exit 0
fi

# 从现有路由行提取属性（路由已丢时全部走默认值）
GW=$(echo "$ROUTE_LINE" | sed -n 's/.* via \([^ ]*\) .*/\1/p')
TABLE=$(echo "$ROUTE_LINE" | sed -n 's/.* table \([^ ]*\).*/\1/p')
METRIC=$(echo "$ROUTE_LINE" | sed -n 's/.* metric \([0-9]\{1,\}\) .*/\1/p')
HOPLIMIT=$(echo "$ROUTE_LINE" | sed -n 's/.* hoplimit \([0-9]\{1,\}\) .*/\1/p')
[ -n "$GW" ] || GW="$GW_FALLBACK"
[ -n "$TABLE" ] || TABLE="$DEV"
[ -n "$METRIC" ] || METRIC=1024
[ -n "$HOPLIMIT" ] || HOPLIMIT=255

# ================= 路径一：标准 ND 流程（RS -> 真 RA），可选 =================
if [ -x "$RDISC6" ]; then
    # --- 第1次：保留现有路由直接 RS ---
    # 若是内核原生的 RA 路由（带 RTF_ADDRCONF），内核会原地续期，零断流；
    # 若是用户态 replace 出来的路由，内核不认领，RA 反而会把它的
    # expires 毒化成"现在"（内核 <=6.1 缺陷），本次必然失败——这正好
    # 由第2次负责收拾。
    log "发送 Router Solicitation，尝试标准路径刷新（第1次，保留现有路由）..."
    "$RDISC6" -1 -q -r 2 -w 3000 "$DEV" >/dev/null 2>&1
    log "rdisc6 退出码 $? (0=收到RA, 2=无应答)"
    sleep 2
    RS_LINE=$(find_route)
    RS_EXP=$(get_expires "$RS_LINE")
    if [ -n "$RS_EXP" ] && [ "$RS_EXP" -gt $((OLD_EXP)) ] 2>/dev/null; then
        log "✅ 内核已按标准 ND 流程原地续期: $RS_LINE"
        exit 0
    fi
    log "第1次未生效（RS_EXP:$RS_EXP OLD_EXP:$OLD_EXP）——现有路由可能为用户态创建，内核无法认领"

    # --- 第2次：删路由后重试，让内核从空表重建原生 RA 路由 ---
    # 注意：此刻起 IPv6 默认路由短暂真空，直到 RA 到达或走回落 replace
    log "删除现有默认路由后重试 RS（第2次，让内核重建原生路由）..."
    ip -6 route del default dev "$DEV" table "$TABLE" 2>>"$LOG"
    "$RDISC6" -1 -q -r 2 -w 3000 "$DEV" >/dev/null 2>&1
    log "rdisc6 退出码 $? (0=收到RA, 2=无应答)"
    sleep 2
    RS_LINE=$(find_route)
    RS_EXP=$(get_expires "$RS_LINE")
    if [ -n "$RS_EXP" ] && [ "$RS_EXP" -gt $((OLD_EXP)) ] && [ "$RS_EXP" -gt 0 ] 2>/dev/null; then
        log "✅ 内核已重建原生 RA 路由: $RS_LINE"
        exit 0
    fi
    log "第2次仍未生效（RS_EXP:$RS_EXP），回落到手工重建"
else
    log "未安装 rdisc6，直接手工重建（RA 同构路由）"
fi

# ================= 路径二：手工重建与 RA 同构的路由 =================
if ip -6 route replace default via "$GW" dev "$DEV" table "$TABLE" \
       proto ra hoplimit "$HOPLIMIT" metric "$METRIC" expires "$RA_LIFETIME" 2>>"$LOG"; then
    :
else
    log "带完整属性 replace 失败，降级为最小参数重试"
    if ! ip -6 route replace default via "$GW" dev "$DEV" table "$TABLE" expires "$RA_LIFETIME" 2>>"$LOG"; then
        log "❌ route replace 执行失败"
        exit 1
    fi
fi

sleep 1
NEW_LINE=$(ip -6 route show table "$TABLE" 2>/dev/null | grep -m1 '^default')
NEW_EXP=$(get_expires "$NEW_LINE")
if [ -n "$NEW_EXP" ] && [ "$NEW_EXP" -ge $OLD_EXP ] 2>/dev/null; then
    log "✅ 刷新成功（RA 同构路由）: $NEW_LINE"
    exit 0
fi
log "⚠️ 已执行 replace 但回读结果异常: ${NEW_LINE:-<空>}"
exit 1
