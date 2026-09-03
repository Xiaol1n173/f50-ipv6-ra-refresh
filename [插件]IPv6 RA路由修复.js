//<script>
(async () => {
    // 防止重复加载
    if (document.querySelector('#IFRAME_KANO_RRA')) return

    // ================= 常量配置（统一使用插件标准目录 /data/kano_ipv6_ra） =================
    const RRA = {
        name: 'IPv6 RA路由修复',
        dir: '/data/kano_ipv6_ra',                                     // 插件专属目录
        scriptPath: '/data/kano_ipv6_ra/refresh_route.sh',             // 核心修复脚本
        watchPath: '/data/kano_ipv6_ra/refresh_route_watch.sh',        // 定时调度器
        confPath: '/data/kano_ipv6_ra/refresh_route_watch.conf',       // 调度间隔(秒)
        pidPath: '/data/kano_ipv6_ra/refresh_route_watch.pid',         // 调度器 pid
        rdPath: '/data/kano_ipv6_ra/rdisc6',                           // rdisc6 aarch64 静态构建
        strategyPath: '/data/kano_ipv6_ra/last_strategy',              // 上次刷新成功策略
        logPath: '/data/kano_ipv6_ra/refresh_route.log',
        bootPath: '/sdcard/ufi_tools_boot.sh',                         // UFI-TOOLS 平台标准开机脚本
        //defaultUrl: 'https://pan.kanokano.cn/d/UFI-TOOLS-UPDATE/plugins/rdisc6',
        defaultUrl: 'https://raw.githubusercontent.com/Xiaol1n173/f50-ipv6-ra-refresh/refs/heads/main/rdisc6',
        raLifetime: 65535,   // 与网关 RA 下发的 Router Lifetime 一致
    }

    // 上次刷新成功策略 => 中文标签
    const STRATEGY_LABELS = {
        nd_renew: '标准 ND 续期（rdisc6 RS，内核原地续期，零断流）',
        nd_rebuild: 'ND 重建原生路由（rdisc6 RS，内核从空表重建）',
        ra_replace: 'RA 同构路由重建（完整属性 replace）',
        ra_replace_min: 'RA 同构路由重建（降级最小参数 replace）',
    }

    // 核心脚本：移植自 refresh_route.sh（修复中兴 F50 移动卡 IPv6 默认路由不随 RA 刷新、65536s 后掉线）
    // 无阈值判断：完全由定时调度驱动，每次触发直接续期
    // 并发锁：同一时刻仅允许一个实例执行（watcher 调度与手动刷新互斥）
    // 返回值：0=正常或无需操作  1=出错  2=条件不满足而跳过（含并发锁让位）
    const REFRESH_SH = String.raw`#!/system/bin/sh
#
# refresh_route.sh —— 修复中兴 F50（移动卡）IPv6 默认路由不随 RA 刷新、65536s 后掉线的问题
# 由 UFI-TOOLS「IPv6 RA路由修复」插件安装/维护，由 refresh_route_watch.sh 定时调度执行
#
# 原理：F50 用移动卡时仅在数据连接建立瞬间收到一次 RA，随后不再发送周期 RA，默认路由
#       default via fe80::X dev sipa_ethN ... expires 65536sec
#       到期后不会被刷新，导致 IPv6 断网。本脚本每次被调度时直接为默认路由续期：
#   路径一（标准）：发 Router Solicitation 引出网关真 RA，内核按 ND 规程自动刷新（需 rdisc6）
#   路径二（同构）：手工重建 proto ra + hoplimit + metric + Router Lifetime 完全一致的同构路由
# 刷新成功后，所用策略会记录到 last_strategy 文件（第1行策略key，第2行时间戳）

# ================= 配置 =================
RA_LIFETIME=65535           # 与网关 RA 下发的 Router Lifetime 一致（约 18.2h）
GW_FALLBACK="fe80::2"       # 路由完全丢失时的兜底网关
IF_PREFIX="sipa_eth"        # 厂商数据口前缀（自动探测 0~15 中 state UP 的那个）
IF_FALLBACK="sipa_eth8"     # 探测不到 UP 口时的兜底接口
STATE_DIR="/data/kano_ipv6_ra"
LOG="/data/kano_ipv6_ra/refresh_route.log"
LOG_MAX=65536               # 日志超过 64KB 清空重记
STRATEGY_FILE="/data/kano_ipv6_ra/last_strategy"
RDISC6="/data/kano_ipv6_ra/rdisc6"

PATH=/system/bin:/system/xbin:/vendor/bin:/odm/bin:/sbin
export PATH

log() { echo "[$(date '+%m-%d %H:%M:%S')] $*" | tee -a "$LOG" 2>/dev/null; }
set_strategy() { printf '%s\n%s\n' "$1" "$(date +%s)" > "$STRATEGY_FILE" 2>/dev/null; }

[ -f "$LOG" ] && [ "$(wc -c < "$LOG")" -gt "$LOG_MAX" ] && : > "$LOG"

# ================= 并发锁（watcher 调度与手动刷新互斥，自动清理陈旧锁） =================
LOCK="$STATE_DIR/.refresh_route.lock"
take_lock() {
    mkdir "$LOCK" 2>/dev/null || return 1
    echo $$ > "$LOCK/pid"
    trap 'rm -rf "$LOCK" 2>/dev/null' EXIT INT TERM
    return 0
}
acquire_lock() {
    if take_lock; then return 0; fi
    # 锁被占用：持锁进程存活（cmdline 确认，防 PID 复用）则让位，否则视为陈旧锁清理重试
    LP=$(cat "$LOCK/pid" 2>/dev/null)
    if [ -n "$LP" ] && [ -d "/proc/$LP" ] && grep -q refresh_route "/proc/$LP/cmdline" 2>/dev/null; then
        return 1
    fi
    log "清理陈旧锁 $LOCK（原持锁进程: $LP）"
    rm -rf "$LOCK"
    take_lock
}
if ! acquire_lock; then
    log "已有实例在运行，跳过本次"
    exit 2
fi

# 可选：连通性自检（移动 IPv6 DNS）
ping6 -c 1 -W 3 2400:3200::1 >/dev/null 2>&1 && log "IPv6 连通性 OK" || log "!! ping 不通"

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
    IFACE="$IF_PREFIX$i"
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
else
    log "剩余有效期 $OLD_EXP sec，按调度直接刷新"
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
    # 内核原生 RA 路由会原地续期，零断流；用户态 replace 出来的路由内核不认领，
    # 本次必然失败——正好由第2次负责收拾
    log "发送 Router Solicitation，尝试标准路径刷新（第1次，保留现有路由）..."
    "$RDISC6" -1 -q -r 2 -w 3000 "$DEV" >/dev/null 2>&1
    log "rdisc6 退出码 $? (0=收到RA, 2=无应答)"
    sleep 2
    RS_LINE=$(find_route)
    RS_EXP=$(get_expires "$RS_LINE")
    if [ -n "$RS_EXP" ] && [ "$RS_EXP" -gt $((OLD_EXP)) ] 2>/dev/null; then
        log "OK 内核已按标准 ND 流程原地续期: $RS_LINE"
        set_strategy nd_renew
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
        log "OK 内核已重建原生 RA 路由: $RS_LINE"
        set_strategy nd_rebuild
        exit 0
    fi
    log "第2次仍未生效（RS_EXP:$RS_EXP），回落到手工重建"
else
    log "未安装 rdisc6，直接手工重建（RA 同构路由）"
fi

# ================= 路径二：手工重建与 RA 同构的路由 =================
REPLACED=""
if ip -6 route replace default via "$GW" dev "$DEV" table "$TABLE" \
       proto ra hoplimit "$HOPLIMIT" metric "$METRIC" expires "$RA_LIFETIME" 2>>"$LOG"; then
    REPLACED="ra_replace"
else
    log "带完整属性 replace 失败，降级为最小参数重试"
    if ! ip -6 route replace default via "$GW" dev "$DEV" table "$TABLE" expires "$RA_LIFETIME" 2>>"$LOG"; then
        log "!! route replace 执行失败"
        exit 1
    fi
    REPLACED="ra_replace_min"
fi
set_strategy "$REPLACED"

sleep 1
NEW_LINE=$(ip -6 route show table "$TABLE" 2>/dev/null | grep -m1 '^default')
NEW_EXP=$(get_expires "$NEW_LINE")
if [ -n "$NEW_EXP" ] && [ "$NEW_EXP" -ge $OLD_EXP ] 2>/dev/null; then
    log "OK 刷新成功（RA 同构路由）: $NEW_LINE"
    exit 0
fi
log "!! 已执行 replace 但回读结果异常: $NEW_LINE"
exit 1
`

    // 定时调度器：每隔 INTERVAL 秒执行一次 refresh_route.sh，直到被 kill
    const WATCH_SH = String.raw`#!/system/bin/sh
# refresh_route_watch.sh —— IPv6 RA 路由保活调度器（由 UFI-TOOLS 插件生成）
CONF=/data/kano_ipv6_ra/refresh_route_watch.conf
PIDF=/data/kano_ipv6_ra/refresh_route_watch.pid
INTERVAL=3600
if [ -f "$CONF" ]; then
    V=$(timeout 2s awk '{print}' "$CONF" | tr -d '\r\n \t')
    case "$V" in
        ''|*[!0-9]*) ;;
        *) INTERVAL="$V" ;;
    esac
fi
[ "$INTERVAL" -ge 60 ] 2>/dev/null || INTERVAL=3600
echo $$ > "$PIDF"
while true; do
    sh /data/kano_ipv6_ra/refresh_route.sh >/dev/null 2>&1
    sleep "$INTERVAL"
done
`

    // ================= 小工具 =================
    const getInterval = () => {
        const v = Number(localStorage.getItem('rra_interval_sec'))
        return Number.isFinite(v) && v >= 60 ? v : 3600
    }

    const humanInterval = (sec) => {
        if (sec % 3600 === 0) return (sec / 3600) + ' 小时'
        if (sec >= 3600) return (sec / 3600).toFixed(1) + ' 小时'
        return (sec / 60) + ' 分钟'
    }

    const formatTs = (ts) => {
        if (!Number.isFinite(ts) || ts <= 0) return ''
        const d = new Date(ts * 1000)
        const p = (n) => String(n).padStart(2, '0')
        return `${d.getMonth() + 1}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
    }

    const isInstalled = async () => {
        const res = await runShellWithRoot(`ls ${RRA.scriptPath} >/dev/null 2>&1 && ls ${RRA.watchPath} >/dev/null 2>&1 && echo INSTALLED`)
        return (res?.content || '').includes('INSTALLED')
    }

    const isWatcherRunning = async () => {
        // 除 PID 存活外，再校验 cmdline 确为调度器，防止重启后 PID 复用导致误判
        const res = await runShellWithRoot(`P=$(timeout 2s awk '{print}' ${RRA.pidPath} 2>/dev/null); if [ -n "$P" ] && grep -q refresh_route_watch "/proc/$P/cmdline" 2>/dev/null; then echo running; else echo stopped; fi`)
        return (res?.content || '').includes('running')
    }

    // 校验 rdisc6 文件是否有效：大小 -> ELF 魔数 -> 可执行性
    const verifyRdisc6 = async () => {
        // 1) 文件存在且大小合理（排除 404 页面残留与空文件）
        const sz = await runShellWithRoot(`wc -c < ${RRA.rdPath} 2>/dev/null`)
        const size = Number((sz?.content || '').trim())
        if (!Number.isFinite(size) || size < 10240) return false
        // 2) ELF 魔数（排除 HTML 错误页/文本文件）
        const elf = await runShellWithRoot(`dd if=${RRA.rdPath} bs=1 count=4 2>/dev/null`)
        const isElf = (elf?.content || '').includes('ELF')
        if (!isElf) return false
        // 3) 可执行性（126/127 = 无法加载执行，如架构不符）
        const run = await runShellWithRoot(`timeout 3s ${RRA.rdPath} --help >/dev/null 2>&1; echo EXIT:$?`)
        const m = (run?.content || '').match(/EXIT:(\d+)/)
        if (m && (m[1] === '126' || m[1] === '127')) return false
        return true
    }

    // 写文本文件到设备（目录需已存在）
    const writeTextFile = async (text, filename, outputFile) => {
        const file = new File([text], filename, { type: 'text/plain' })
        return await saveConfig(file, outputFile)
    }

    // ================= 状态显示 =================
    let bootBusy = false

    const refreshStatus = async () => {
        try {
            const opEl = document.querySelector('#rra_op')
            const ifaceEl = document.querySelector('#rra_iface')
            const pingEl = document.querySelector('#rra_ping')
            const routeEl = document.querySelector('#rra_route')
            const expEl = document.querySelector('#rra_exp')
            const barEl = document.querySelector('#rra_bar')
            if (!opEl || !routeEl || !expEl || !barEl) return

            const res = await runShellWithRoot(String.raw`
OP=$(getprop gsm.sim.operator.alpha 2>/dev/null | tr -d '\r\n\t ,')
echo "OP:$OP"
DEV=""
for i in 0 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
    if ip link show dev sipa_eth$i 2>/dev/null | grep -q 'state UP'; then DEV=sipa_eth$i; break; fi
done
[ -n "$DEV" ] || DEV="sipa_eth8"
echo "IFACE:$DEV"
RL=$(ip -6 route show table all 2>/dev/null | grep '^default via fe80' | grep -m1 " dev $DEV ")
echo "ROUTE:$RL"
ping6 -c 1 -W 2 2400:3200::1 >/dev/null 2>&1 && echo "PING6:ok" || echo "PING6:fail"
`)
            const text = res?.content || ''
            const kv = (k) => {
                const m = text.match(new RegExp('^' + k + ':(.*)$', 'm'))
                return m ? m[1].trim() : ''
            }

            opEl.textContent = kv('OP') || '未知'
            ifaceEl.textContent = kv('IFACE') || '--'

            const pingOk = kv('PING6') === 'ok'
            pingEl.textContent = pingOk ? '正常' : '不通'
            pingEl.style.color = pingOk ? '#4caf50' : '#f44336'

            const route = kv('ROUTE')
            routeEl.textContent = route || '未找到 RA 默认路由（可能已到期被删）'
            const expMatch = route.match(/expires (-?\d+)sec/)

            if (!route) {
                expEl.textContent = '无'
                expEl.style.color = '#f44336'
                barEl.style.width = '0%'
                barEl.style.background = '#f44336'
            } else if (!expMatch) {
                expEl.textContent = '静态路由（无 expires），无需处理'
                expEl.style.color = ''
                barEl.style.width = '100%'
                barEl.style.background = '#9e9e9e'
            } else {
                const exp = Number(expMatch[1])
                if (exp <= 0) {
                    expEl.textContent = '已过期，等待下次调度刷新'
                    expEl.style.color = '#f44336'
                    barEl.style.width = '0%'
                    barEl.style.background = '#f44336'
                } else {
                    expEl.textContent = kano_formatTime(exp) + `（${exp}s）`
                    expEl.style.color = '#4caf50'
                    barEl.style.width = Math.min(100, Math.max(0, (exp / RRA.raLifetime) * 100)) + '%'
                    barEl.style.background = '#4caf50'
                }
            }
        } catch (e) {
            console.error('refreshStatus error:', e)
        }
    }

    const refreshStates = async () => {
        try {
            const [res, stRes] = await Promise.all([
                runShellWithRoot(`
ls ${RRA.rdPath} >/dev/null 2>&1 && echo "RD:1" || echo "RD:0"
P=$(timeout 2s awk '{print}' ${RRA.pidPath} 2>/dev/null)
if [ -n "$P" ] && grep -q refresh_route_watch "/proc/$P/cmdline" 2>/dev/null; then echo "WATCH:1"; else echo "WATCH:0"; fi
grep -qF 'refresh_route_watch' ${RRA.bootPath} 2>/dev/null && echo "BOOT:1" || echo "BOOT:0"
ls ${RRA.scriptPath} >/dev/null 2>&1 && echo "INST:1" || echo "INST:0"
`),
                // 上次刷新策略：第1行策略key，第2行时间戳
                runShellWithRoot(`timeout 2s awk '{print}' ${RRA.strategyPath} 2>/dev/null`)
            ])
            const text = res?.content || ''
            const kv = (k) => {
                const m = text.match(new RegExp('^' + k + ':(.*)$', 'm'))
                return m ? m[1].trim() : ''
            }

            const installed = kv('INST') === '1'
            const rdEl = document.querySelector('#rra_rd')
            const watchEl = document.querySelector('#rra_watch')
            const watchIvEl = document.querySelector('#rra_watch_iv')
            if (rdEl) {
                const rdOk = kv('RD') === '1'
                rdEl.textContent = rdOk ? '已安装' : '未安装（可选，推荐）'
                rdEl.style.color = rdOk ? '#4caf50' : '#ff9800'
            }
            if (watchEl) {
                const running = kv('WATCH') === '1'
                watchEl.textContent = running ? '运行中' : '已停止'
                watchEl.style.color = running ? '#4caf50' : '#9e9e9e'
            }
            if (watchIvEl) watchIvEl.textContent = humanInterval(getInterval())

            // 上次刷新成功所使用的策略
            const stEl = document.querySelector('#rra_strategy')
            if (stEl) {
                const stLines = (stRes?.content || '').split('\n').map(s => s.trim()).filter(Boolean)
                const stKey = STRATEGY_LABELS[stLines[0]] ? stLines[0] : ''
                const stTs = Number(stLines[1])
                if (stKey) {
                    const when = formatTs(stTs)
                    stEl.textContent = STRATEGY_LABELS[stKey] + (when ? `（${when}）` : '')
                    stEl.style.color = '#4caf50'
                } else {
                    stEl.textContent = '暂无（尚未刷新过）'
                    stEl.style.color = ''
                }
            }

            const installBtn = document.querySelector('#rra_install')
            if (installBtn) installBtn.textContent = installed ? '更新脚本' : '安装脚本'
            if (!bootBusy) bootSwitch?.update(kv('BOOT') === '1')
        } catch (e) {
            console.error('refreshStates error:', e)
        }
    }

    const refreshAll = async () => {
        await Promise.all([refreshStatus(), refreshStates()])
    }

    // ================= 日志回显 =================
    let prevLogText = ''
    const genLog = async () => {
        const ta = document.querySelector('#rra_log')
        if (!ta) return
        const res = await runShellWithRoot(`timeout 2s awk '{print}' ${RRA.logPath} 2>/dev/null | tail -n 40`)
        const text = res?.content || ''
        if (text === prevLogText) return
        prevLogText = text
        ta.value = text
        ta.scrollTo({
            top: ta.scrollHeight,
            behavior: "smooth",
        })
    }

    // ================= 动作 =================
    const installScript = async () => {
        if (!(await checkAdvancedFunc())) return createToast('请先启用高级功能', 'pink')
        createToast('正在写入脚本...')
        const mk = await runShellWithRoot(`mkdir -p ${RRA.dir}`)
        if (!mk.success) return createToast('创建目录失败', 'red')

        if (!await writeTextFile(REFRESH_SH, 'refresh_route.sh', RRA.scriptPath)) {
            return createToast('写入 refresh_route.sh 失败', 'red')
        }
        if (!await writeTextFile(WATCH_SH, 'refresh_route_watch.sh', RRA.watchPath)) {
            return createToast('写入 refresh_route_watch.sh 失败', 'red')
        }
        const chmod = await runShellWithRoot(`chmod 777 ${RRA.scriptPath} ${RRA.watchPath}`)
        if (!chmod.success) return createToast('设置执行权限失败', 'red')
        createToast('脚本安装/更新成功', 'green')
        await refreshAll()
    }

    const runNow = async () => {
        if (!(await checkAdvancedFunc())) return createToast('请先启用高级功能', 'pink')
        if (!(await isInstalled())) return createToast('请先安装脚本', 'red')
        createToast('正在执行刷新（无 rdisc6 时约数秒，请稍候）...')
        // 末尾回显退出码：0=成功 1=出错 2=条件不满足而跳过（非移动卡 / 并发锁让位）
        const res = await runShellWithRoot(`sh ${RRA.scriptPath}; echo "RRA_EXIT:$?"`, 60 * 1000)
        await Promise.all([refreshAll(), genLog()])
        const m = (res?.content || '').match(/RRA_EXIT:(\d+)/)
        if (!m) createToast('执行超时或无输出，详情见日志', 'red')
        else if (m[1] === '0') createToast('刷新完成，详情见日志', 'green')
        else if (m[1] === '2') createToast('已跳过本次刷新（非移动卡或已有实例在运行），详情见日志', 'orange')
        else createToast('执行出错，详情见日志', 'red')
    }

    // 校验并落地 rdisc6（下载/上传共用）
    const finalizeRdisc6 = async () => {
        const chmod = await runShellWithRoot(`chmod 777 ${RRA.rdPath}`)
        if (!chmod.success) {
            await refreshStates()
            return '设置执行权限失败'
        }
        if (!(await verifyRdisc6())) {
            // 校验失败：清理无效文件，避免残留假 rdisc6
            await runShellWithRoot(`rm -f ${RRA.rdPath}`)
            await refreshStates()
            return '文件校验失败：不是可用的 rdisc6（aarch64 ELF）'
        }
        await refreshStates()
        return null
    }

    // 下载 rdisc6：-f 让 HTTP 404/5xx 直接失败，下载后做 ELF/可执行性校验
    const downloadRdisc6 = async () => {
        if (!(await checkAdvancedFunc())) return createToast('请先启用高级功能', 'pink')
        const urlInput = document.querySelector('#rra_url')
        const url = (urlInput?.value || '').trim() || RRA.defaultUrl
        localStorage.setItem('rra_rd_url', url)
        createToast('开始下载 rdisc6（约 200KB）...')
        await runShellWithRoot(`mkdir -p ${RRA.dir}`)
        const res = await runShellWithRoot(`/data/data/com.minikano.f50_sms/files/curl -fL --connect-timeout 15 '${url}' -o ${RRA.rdPath}`, 120 * 1000)
        if (!res.success) {
            // 清理 curl 留下的错误页/空文件残留
            await runShellWithRoot(`rm -f ${RRA.rdPath}`)
            createToast('下载失败：地址不存在(404)或网络错误', 'red')
            await refreshStates()
            return
        }
        const err = await finalizeRdisc6()
        if (err) return createToast(`下载失败：${err}`, 'red')
        createToast('rdisc6 下载安装成功', 'green')
    }

    // 手动上传 rdisc6：从浏览器选择本地文件上传到设备
    const uploadRdisc6 = async () => {
        if (!(await checkAdvancedFunc())) return createToast('请先启用高级功能', 'pink')
        const picker = document.createElement('input')
        picker.type = 'file'
        picker.accept = '*/*'
        picker.onchange = async () => {
            const file = picker.files && picker.files[0]
            if (!file) return
            createToast(`正在上传 ${file.name}（${formatBytes(file.size)}）...`)
            await runShellWithRoot(`mkdir -p ${RRA.dir}`)
            const ok = await saveConfig(file, RRA.rdPath)
            if (!ok) return createToast('上传 rdisc6 失败', 'red')
            const err = await finalizeRdisc6()
            if (err) return createToast(`上传失败：${err}`, 'red')
            createToast('rdisc6 上传安装成功', 'green')
        }
        picker.click()
    }

    const stopWatcher = async (silent = false) => {
        // 仅当 PID 的 cmdline 确为调度器时才 kill，防止 PID 复用误杀无关进程；pkill 兜底清理多实例
        // 用 [.] 正则避免 pkill 匹配到自身命令行
        await runShellWithRoot(`P=$(timeout 2s awk '{print}' ${RRA.pidPath} 2>/dev/null); if [ -n "$P" ] && grep -q refresh_route_watch "/proc/$P/cmdline" 2>/dev/null; then kill "$P" 2>/dev/null; fi; rm -f ${RRA.pidPath}; pkill -f 'refresh_route_watch[.]sh' 2>/dev/null; true`)
        if (!silent) createToast('调度器已停止', 'green')
        await refreshStates()
    }

    const startWatcher = async (silent = false) => {
        if (!(await checkAdvancedFunc())) {
            createToast('请先启用高级功能', 'pink')
            return false
        }
        if (!(await isInstalled())) {
            createToast('请先安装脚本', 'red')
            return false
        }
        // 防止重复启动：调度器已在运行则直接返回（多实例会并发重复调度）
        if (await isWatcherRunning()) {
            if (!silent) createToast('调度器已在运行中，无需重复启动')
            await refreshStates()
            return true
        }
        // 写入当前调度间隔
        await runShellWithRoot(`mkdir -p ${RRA.dir}`)
        if (!await writeTextFile(String(getInterval()), 'refresh_route_watch.conf', RRA.confPath)) {
            createToast('写入调度间隔失败', 'red')
            return false
        }
        await runShellWithRoot(`sh -c '${RRA.watchPath} >/dev/null 2>&1 &'`)
        await new Promise(r => setTimeout(r, 1200))
        const running = await isWatcherRunning()
        if (running) {
            if (!silent) createToast(`调度器已启动（间隔 ${humanInterval(getInterval())}）`, 'green')
        } else {
            createToast('调度器启动失败', 'red')
        }
        await refreshStates()
        return running
    }

    // ================= UI 挂载 =================
    const mmContainer = document.querySelector('.functions-container')
    if (!mmContainer) return
    mmContainer.insertAdjacentHTML("afterend", `
            <div id="IFRAME_KANO_RRA" style="width: 100%; margin-top: 10px;">
                <div class="title" style="margin: 6px 0 ;">
                    <strong>IPv6 RA路由修复</strong>
                    <div style="display: inline-block;" id="collapse_rra_btn"></div>
                </div>
                <div class="collapse" id="collapse_rra" data-name="close" style="height: 0px; overflow: hidden;">
                    <div class="collapse_box">
                        <div style="padding:10px;border-radius:10px;background:rgba(255,255,255,.04);font-size:.72rem;line-height:1.9;">
                            <div>运营商：<span id="rra_op">--</span>　数据口：<span id="rra_iface">--</span>　IPv6连通：<span id="rra_ping">--</span></div>
                            <div>调度器：<span id="rra_watch">--</span>（间隔 <span id="rra_watch_iv">--</span>）　rdisc6：<span id="rra_rd">--</span></div>
                            <div>上次刷新策略：<span id="rra_strategy">--</span></div>
                            <div style="word-break:break-all;opacity:.9;">当前路由：<span id="rra_route">--</span></div>
                            <div>剩余有效期：<span id="rra_exp">--</span></div>
                            <div style="height:6px;margin-top:4px;border-radius:4px;background:rgba(128,128,128,.25);overflow:hidden;">
                                <div id="rra_bar" style="height:100%;width:0%;background:#4caf50;transition:all .5s;"></div>
                            </div>
                            <div style="margin-top:6px;font-size:.66rem;opacity:.75;">
                                原理：F50 用移动卡时仅在数据连接建立瞬间收到一次 RA，默认路由 expires 65536s 到期后不会被刷新，导致 IPv6 断网；本插件不做阈值判断，完全由定时调度周期性续期（优先 rdisc6 标准 ND 流程，其次 RA 同构路由重建），并记录上次刷新成功的策略。
                            </div>
                        </div>
                        <div id="rra_action_box" style="margin:10px 0;display:flex;gap:10px;flex-wrap:wrap;align-items:center;"></div>
                        <div style="font-size:.7rem;opacity:.85;margin:6px 0 4px 0;">rdisc6 下载地址（aarch64 musl 静态构建；无法下载时可用「上传rdisc6」从本地文件导入）：</div>
                        <input id="rra_url" style="width:100%;box-sizing:border-box;padding:6px 8px;border-radius:8px;border:1px solid rgba(128,128,128,.4);background:transparent;color:inherit;font-size:.7rem;" placeholder="${RRA.defaultUrl}" />
                        <ul class="deviceList">
                            <li style="padding:10px;">
                                <div class="title">
                                    <span>日志（${RRA.logPath}）</span>
                                    <button style="margin: 0 !important;padding: 2px 6px;" id="rra_log_refresh">刷新</button>
                                    <button style="margin: 0 !important;padding: 2px 6px;" id="rra_log_clear">清空</button>
                                </div>
                                <textarea id="rra_log" disabled style="margin-top: 4px;font-size:12px !important;border:none;padding:4px;margin:0;width:100%;height:260px;border-radius: 10px;overflow-x: hidden;background:transparent;"></textarea>
                            </li>
                        </ul>
                    </div>
                </div>
            </div>
            `)

    // ---------- 动作按钮 ----------
    const mmBox = document.querySelector('#rra_action_box')

    const installBtn = document.createElement('button')
    installBtn.id = 'rra_install'
    installBtn.textContent = '安装脚本'
    installBtn.onclick = installScript

    const runNowBtn = document.createElement('button')
    runNowBtn.textContent = '立即刷新'
    runNowBtn.onclick = runNow

    const downloadBtn = document.createElement('button')
    downloadBtn.textContent = '下载rdisc6'
    downloadBtn.onclick = downloadRdisc6

    const uploadBtn = document.createElement('button')
    uploadBtn.textContent = '上传rdisc6'
    uploadBtn.onclick = uploadRdisc6

    const startBtn = document.createElement('button')
    startBtn.textContent = '启动调度'
    startBtn.onclick = () => startWatcher()

    const stopBtn = document.createElement('button')
    stopBtn.textContent = '停止调度'
    stopBtn.onclick = () => stopWatcher()

    // 卸载（点击3次确认，参考示例防误触写法）
    let uniCount = 0
    let uniTimer = null
    const uninstallBtn = document.createElement('button')
    uninstallBtn.textContent = '卸载'
    uninstallBtn.onclick = async () => {
        if (!(await checkAdvancedFunc())) return createToast('请先启用高级功能', 'pink')
        if (uniTimer) clearTimeout(uniTimer)
        uniTimer = setTimeout(() => { uniCount = 0 }, 2000)
        if (uniCount++ < 2) return createToast(`危险操作！再点击 ${3 - uniCount} 次确认卸载`, 'pink')
        uniCount = 0
        await stopWatcher(true)
        await runShellWithRoot(`sed -i '/refresh_route_watch/d' ${RRA.bootPath}`)
        const res = await runShellWithRoot(`rm -rf ${RRA.dir}`)
        if (!res.success) return createToast('卸载失败', 'red')
        createToast('卸载成功（插件目录已删除，含日志）', 'green')
        await refreshAll()
    }

    // 调度间隔选择
    const intervalWrap = document.createElement('span')
    intervalWrap.style.cssText = 'display:inline-flex;align-items:center;gap:6px;font-size:.7rem;'
    intervalWrap.innerHTML = `调度间隔：<select id="rra_interval" style="padding:4px 6px;border-radius:8px;border:1px solid rgba(128,128,128,.4);background:transparent;color:inherit;font-size:.7rem;">
                <option value="300">5 分钟</option>
                <option value="900">15 分钟</option>
                <option value="1800">30 分钟</option>
                <option value="3600">1 小时</option>
                <option value="7200">2 小时</option>
                <option value="21600">6 小时</option>
            </select>`

    // 开机自启开关
    const bootSwitch = createSwitch({
        text: '开机自启',
        value: false,
        fontSize: 13,
        onChange: async (newVal) => {
            if (bootBusy) {
                bootSwitch.update(!newVal)
                return
            }
            bootBusy = true
            try {
                if (!(await checkAdvancedFunc())) {
                    bootSwitch.update(false)
                    return createToast('请先启用高级功能', 'pink')
                }
                if (!(await isInstalled())) {
                    bootSwitch.update(false)
                    return createToast('请先安装脚本', 'red')
                }
                if (newVal) {
                    const r = await runShellWithRoot(`grep -qF 'refresh_route_watch' ${RRA.bootPath} || echo '${RRA.watchPath} >/dev/null 2>&1 &' >> ${RRA.bootPath}`)
                    if (!r.success) {
                        bootSwitch.update(false)
                        return createToast('写入开机自启失败', 'red')
                    }
                    createToast('已设置开机自启（开机自动拉起调度器）', 'green')
                } else {
                    const r = await runShellWithRoot(`sed -i '/refresh_route_watch/d' ${RRA.bootPath}`)
                    if (!r.success) {
                        bootSwitch.update(true)
                        return createToast('移除开机自启失败', 'red')
                    }
                    createToast('已取消开机自启', 'green')
                }
            } finally {
                bootBusy = false
                await refreshStates()
            }
        }
    })

    mmBox.appendChild(installBtn)
    mmBox.appendChild(runNowBtn)
    mmBox.appendChild(downloadBtn)
    mmBox.appendChild(uploadBtn)
    mmBox.appendChild(startBtn)
    mmBox.appendChild(stopBtn)
    mmBox.appendChild(uninstallBtn)
    mmBox.appendChild(intervalWrap)
    mmBox.appendChild(bootSwitch)

    // ---------- 日志按钮 ----------
    document.querySelector('#rra_log_refresh').onclick = () => {
        genLog()
        createToast('日志已刷新')
    }
    document.querySelector('#rra_log_clear').onclick = async () => {
        await runShellWithRoot(`: > ${RRA.logPath}`)
        prevLogText = ''
        await genLog()
        createToast('日志已清空', 'green')
    }

    // ---------- 下载地址输入框 ----------
    const urlInput = document.querySelector('#rra_url')
    urlInput.value = localStorage.getItem('rra_rd_url') || RRA.defaultUrl
    urlInput.onchange = () => localStorage.setItem('rra_rd_url', urlInput.value.trim())

    // ---------- 调度间隔选择 ----------
    const intervalSel = document.querySelector('#rra_interval')
    intervalSel.value = String(getInterval())
    intervalSel.onchange = async () => {
        const v = Number(intervalSel.value)
        localStorage.setItem('rra_interval_sec', String(v))
        createToast(`调度间隔已设为 ${humanInterval(v)}`)
        await refreshStates()
        // 若调度器正在运行，重启以应用新间隔
        if (await isWatcherRunning()) {
            createToast('正在重启调度器以应用新间隔...')
            await stopWatcher(true)
            const ok = await startWatcher(true)
            if (ok) createToast('调度器已应用新间隔', 'green')
            // 失败时 startWatcher 内部已提示「调度器启动失败」，此处不再重复
        }
    }

    // ---------- 定时器（面板展开时轮询状态与日志） ----------
    let statusTimer = null
    let logTimer = null
    const startTimers = () => {
        stopTimers()
        statusTimer = requestInterval(refreshAll, 5000)
        logTimer = requestInterval(genLog, 2000)
        refreshAll()
        genLog()
    }
    const stopTimers = () => {
        statusTimer && statusTimer()
        logTimer && logTimer()
        statusTimer = null
        logTimer = null
    }

    collapseGen("#collapse_rra_btn", "#collapse_rra", "#collapse_rra", (newVal) => {
        newVal == 'open' ? startTimers() : stopTimers()
    })
    if (localStorage.getItem("#collapse_rra") == 'open') {
        startTimers()
    }

    // ---------- 主入口按钮 ----------
    const mainBtn = document.createElement('button')
    mainBtn.textContent = 'IPv6 RA路由修复'
    mainBtn.onclick = async () => {
        if (!(await checkAdvancedFunc())) return createToast('请先启用高级功能', 'pink')
        const collapseEl = document.querySelector('#collapse_rra')
        if (collapseEl && collapseEl.dataset.name !== 'open') {
            // createSwitch 的事件绑定在 checkbox input 上
            document.querySelector('#collapse_rra_btn input')?.click()
        }
        scroolToTop()
    }
    document.querySelector('.actions-buttons')?.appendChild(mainBtn)
})()
//</script>
