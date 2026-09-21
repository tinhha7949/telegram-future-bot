// ============================================================
// BACKTEST 60 DAYS - CORE LOGIC
// ĐẶT Ở ĐẦU index.js
// Không chạy nếu BACKTEST_ENABLED = false
// ============================================================

const BACKTEST_ENABLED = true

async function BACKTEST_60D(options = {}) {

    const cfg = {
        days: 60,
        startingBalance: 20,

        riskPercent: 0.01,

        feeRate: 0.0005,

        symbols: [
    'BTCUSDT',
    'ETHUSDT',
    'BNBUSDT',
    'SOLUSDT',
    'XRPUSDT',
    'DOGEUSDT',
    'ADAUSDT',
    'AVAXUSDT',
    'LINKUSDT',
    'SUIUSDT'
],

        stepMinutes: 1,

        maxOpenTrades: 20,

        ...options
    }

    const sleep = ms =>
        new Promise(resolve => setTimeout(resolve, ms))

    const r = (x,d=6) =>
        Number(Number(x).toFixed(d))

    const now = Date.now()

    const endTime =
        Number(cfg.endTime) ||
        now

    const startTime =
        Number(cfg.startTime) ||
        endTime -
        cfg.days * 24 * 60 * 60 * 1000

    let balance =
        Number(cfg.startingBalance)

    const initialBalance =
        balance

    const trades = []

    const openTrades = []

    const stats = {
        calls:0,
        signals:0,
        rejected:0,

        wins:0,
        losses:0,

        grossPnL:0,
        fees:0,
        netPnL:0,

        totalR:0,

        maxBalance:balance,
        maxDrawdown:0,

        currentLosingStreak:0,
        longestLosingStreak:0
    }

    const bySide = {}
    const bySetup = {}
    const byTrigger = {}

    // ------------------------------------------------------------
    // TELEGRAM
    // ------------------------------------------------------------

    const sendTelegram = async text => {

        try {

            if (
                typeof BOT_TOKEN !== 'string' ||
                !BOT_TOKEN ||
                typeof CHAT_ID === 'undefined' ||
                !CHAT_ID
            ) {
                console.log(
                    '[BACKTEST] TELEGRAM SKIP: BOT_TOKEN / CHAT_ID không có'
                )

                return
            }

            const url =
                `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`

            const res =
                await fetch(url,{
                    method:'POST',

                    headers:{
                        'content-type':
                            'application/json'
                    },

                    body:JSON.stringify({
                        chat_id:CHAT_ID,
                        text
                    })
                })

            if (!res.ok) {

                const body =
                    await res.text()

                console.log(
                    '[BACKTEST] TELEGRAM ERROR',
                    res.status,
                    body
                )
            }

        } catch(err) {

            console.log(
                '[BACKTEST] TELEGRAM ERROR',
                err.message
            )
        }
    }

    // ------------------------------------------------------------
    // BINANCE KLINES
    // ------------------------------------------------------------

    const BINANCE =
        'https://fapi.binance.com/fapi/v1/klines'

    const intervalMs = {
        '1m':60*1000,
        '5m':5*60*1000,
        '15m':15*60*1000,
        '1h':60*60*1000
    }

    async function fetchKlines(
        symbol,
        interval,
        from,
        to
    ) {

        const result = []

        let cursor = from

        const step =
            intervalMs[interval]

        if (!step) {
            throw new Error(
                `BACKTEST interval không hợp lệ: ${interval}`
            )
        }

        while (cursor < to) {

            const url =
                `${BINANCE}?symbol=${symbol}` +
                `&interval=${interval}` +
                `&startTime=${cursor}` +
                `&endTime=${to}` +
                `&limit=1500`

            let response

            for (let attempt=1;attempt<=5;attempt++) {

                try {

                    response =
                        await fetch(url)

                    if (response.ok) {
                        break
                    }

                    const txt =
                        await response.text()

                    throw new Error(
                        `HTTP ${response.status}: ${txt.slice(0,200)}`
                    )

                } catch(err) {

                    if (attempt >= 5) {
                        throw err
                    }

                    console.log(
                        `[BACKTEST] retry ${symbol} ${interval} ${attempt}/5`,
                        err.message
                    )

                    await sleep(
                        1000 * attempt
                    )
                }
            }

            const rows =
                await response.json()

            if (!Array.isArray(rows)) {
                throw new Error(
                    `Binance trả dữ liệu lỗi ${symbol} ${interval}`
                )
            }

            if (!rows.length) {
                break
            }

            for (const k of rows) {

                const openTime =
                    Number(k[0])

                if (
                    openTime >= from &&
                    openTime < to
                ) {
                    result.push(k)
                }
            }

            const lastOpen =
                Number(rows[rows.length-1][0])

            const next =
                lastOpen + step

            if (next <= cursor) {
                break
            }

            cursor = next

            await sleep(80)

            if (rows.length < 1500) {
                break
            }
        }

        return result
    }

    // ------------------------------------------------------------
    // LOAD DATA
    // ------------------------------------------------------------

    const market = {}

    console.log('')
    console.log('================================================')
    console.log('BACKTEST START')
    console.log('================================================')
    console.log(
        'START:',
        new Date(startTime).toISOString()
    )
    console.log(
        'END  :',
        new Date(endTime).toISOString()
    )
    console.log(
        'BALANCE:',
        initialBalance
    )
    console.log(
        'RISK:',
        cfg.riskPercent * 100 + '%'
    )
    console.log(
        'SYMBOLS:',
        cfg.symbols.join(', ')
    )
    console.log('================================================')
    console.log('')

    try {

        for (
            let si=0;
            si<cfg.symbols.length;
            si++
        ) {

            const symbol =
                String(cfg.symbols[si])
                    .toUpperCase()

            console.log(
                `[BACKTEST] DATA ${si+1}/${cfg.symbols.length} ${symbol}`
            )

            const [
                data1m,
                data5,
                data15,
                data1h
            ] =
                await Promise.all([

                    fetchKlines(
                        symbol,
                        '1m',
                        startTime -
                            100 * 60 * 1000,
                        endTime +
                            60 * 1000
                    ),

                    fetchKlines(
                        symbol,
                        '5m',
                        startTime -
                            100 * 5 * 60 * 1000,
                        endTime +
                            5 * 60 * 1000
                    ),

                    fetchKlines(
                        symbol,
                        '15m',
                        startTime -
                            140 * 15 * 60 * 1000,
                        endTime +
                            15 * 60 * 1000
                    ),

                    fetchKlines(
                        symbol,
                        '1h',
                        startTime -
                            120 * 60 * 60 * 1000,
                        endTime +
                            60 * 60 * 1000
                    )
                ])

            market[symbol] = {
                data1m,
                data5,
                data15,
                data1h
            }

            console.log(
                `[BACKTEST] ${symbol}`,
                `1m=${data1m.length}`,
                `5m=${data5.length}`,
                `15m=${data15.length}`,
                `1h=${data1h.length}`
            )
        }

    } catch(err) {

        console.error(
            '[BACKTEST] DATA ERROR:',
            err
        )

        await sendTelegram(
            `❌ BACKTEST DATA ERROR\n\n${err.message}`
        )

        return null
    }

    // ------------------------------------------------------------
    // TIME INDEX
    // ------------------------------------------------------------

    const timeline = new Set()

    for (const symbol of cfg.symbols) {

        const d =
            market[symbol]

        for (const k of d.data1m) {

            const t =
                Number(k[0])

            if (
                t >= startTime &&
                t < endTime
            ) {
                timeline.add(t)
            }
        }
    }

    const times =
        Array.from(timeline)
            .sort((a,b) => a-b)

    console.log(
        `[BACKTEST] TIMELINE: ${times.length} candles`
    )

    // ------------------------------------------------------------
    // HELPERS
    // ------------------------------------------------------------

    const getClosedData = (
        rows,
        time
    ) => {

        let lo=0
        let hi=rows.length-1
        let idx=-1

        while (lo <= hi) {

            const mid =
                (lo + hi) >> 1

            const t =
                Number(rows[mid][0])

            if (t <= time) {

                idx=mid
                lo=mid+1

            } else {

                hi=mid-1
            }
        }

        if (idx < 0) {
            return null
        }

        /*
         * IMPORTANT:
         *
         * coreLogic() tự slice(0,-1)
         * nên phải đưa thêm 1 candle phía sau.
         *
         * Candle cuối cùng sẽ bị core loại.
         */

        const end =
            Math.min(
                rows.length,
                idx + 2
            )

        return rows.slice(0,end)
    }

    const candleHigh = k =>
        Number(k[2])

    const candleLow = k =>
        Number(k[3])

    const candleClose = k =>
        Number(k[4])

    const candleOpen = k =>
        Number(k[1])

    // ------------------------------------------------------------
    // POSITION MANAGEMENT
    // ------------------------------------------------------------

    const removeOpenTrade = trade => {

        const i =
            openTrades.indexOf(trade)

        if (i >= 0) {
            openTrades.splice(i,1)
        }
    }

    const registerResult = (
        trade,
        pnl,
        rMultiple,
        result
    ) => {

        balance += pnl

        stats.netPnL += pnl
        stats.totalR += rMultiple

        if (result === 'WIN') {

            stats.wins++

            stats.currentLosingStreak=0

        } else {

            stats.losses++

            stats.currentLosingStreak++

            stats.longestLosingStreak =
                Math.max(
                    stats.longestLosingStreak,
                    stats.currentLosingStreak
                )
        }

        stats.maxBalance =
            Math.max(
                stats.maxBalance,
                balance
            )

        const dd =
            stats.maxBalance > 0
                ? (
                    stats.maxBalance -
                    balance
                ) /
                stats.maxBalance
                : 0

        stats.maxDrawdown =
            Math.max(
                stats.maxDrawdown,
                dd
            )

        const side =
            trade.signal.side

        const setup =
            trade.signal.setup

        const trigger =
            trade.signal.triggerType

        if (!bySide[side]) {
            bySide[side] = {
                trades:0,
                wins:0,
                losses:0,
                pnl:0,
                r:0
            }
        }

        if (!bySetup[setup]) {
            bySetup[setup] = {
                trades:0,
                wins:0,
                losses:0,
                pnl:0,
                r:0
            }
        }

        if (!byTrigger[trigger]) {
            byTrigger[trigger] = {
                trades:0,
                wins:0,
                losses:0,
                pnl:0,
                r:0
            }
        }

        for (
            const x of [
                bySide[side],
                bySetup[setup],
                byTrigger[trigger]
            ]
        ) {

            x.trades++

            if (result === 'WIN') {
                x.wins++
            } else {
                x.losses++
            }

            x.pnl += pnl
            x.r += rMultiple
        }
    }

    // ------------------------------------------------------------
    // CHECK OPEN POSITIONS
    // ------------------------------------------------------------

    const checkOpenTrade = (
        trade,
        symbol,
        currentTime
    ) => {

        const d =
            market[symbol]

        const rows =
            d.data1m

        const k =
            rows.find(
                x =>
                    Number(x[0]) === currentTime
            )

        if (!k) {
            return false
        }

        /*
         * Không kiểm tra cây signal.
         * Chỉ kiểm tra từ candle kế tiếp.
         */

        if (
            currentTime <=
            trade.entryTime
        ) {
            return false
        }

        const high =
            candleHigh(k)

        const low =
            candleLow(k)

        let result=null
        let exitPrice=null

        if (trade.side === 'LONG') {

            const hitSL =
                low <= trade.sl

            const hitTP =
                high >= trade.tp

            /*
             * Nếu cùng chạm trong cùng candle:
             * SL trước => conservative.
             */

            if (hitSL) {

                result='LOSS'
                exitPrice=trade.sl

            } else if (hitTP) {

                result='WIN'
                exitPrice=trade.tp
            }

        } else {

            const hitSL =
                high >= trade.sl

            const hitTP =
                low <= trade.tp

            if (hitSL) {

                result='LOSS'
                exitPrice=trade.sl

            } else if (hitTP) {

                result='WIN'
                exitPrice=trade.tp
            }
        }

        if (!result) {
            return false
        }

        const priceMove =
            trade.side === 'LONG'
                ? exitPrice - trade.entry
                : trade.entry - exitPrice

        const grossPnl =
            trade.qty *
            priceMove

        const exitFee =
            Math.abs(
                trade.qty *
                exitPrice
            ) *
            cfg.feeRate

        const pnl =
            grossPnl -
            trade.entryFee -
            exitFee

        const rMultiple =
            trade.riskPerUnit > 0
                ? priceMove /
                  trade.riskPerUnit
                : 0

        stats.fees +=
            trade.entryFee +
            exitFee

        stats.grossPnL +=
            grossPnl

        trade.exitTime =
            currentTime

        trade.exitPrice =
            exitPrice

        trade.result =
            result

        trade.pnl =
            pnl

        trade.r =
            rMultiple

        trade.balance =
            balance + pnl

        registerResult(
            trade,
            pnl,
            rMultiple,
            result
        )

        trades.push(trade)

        removeOpenTrade(trade)

        return true
    }

    // ------------------------------------------------------------
    // MAIN BACKTEST LOOP
    // ------------------------------------------------------------

    let lastProgress=0

    for (
        let ti=0;
        ti<times.length;
        ti++
    ) {

        const currentTime =
            times[ti]

        // --------------------------------------------------------
        // 1. CHECK EXISTING POSITIONS
        // --------------------------------------------------------

        for (
            const trade of [...openTrades]
        ) {

            checkOpenTrade(
                trade,
                trade.symbol,
                currentTime
            )
        }

        // --------------------------------------------------------
        // 2. SIGNAL SCAN
        // --------------------------------------------------------

        for (const symbol of cfg.symbols) {

            if (
                openTrades.length >=
                cfg.maxOpenTrades
            ) {
                break
            }

            const d =
                market[symbol]

            const data1m =
                getClosedData(
                    d.data1m,
                    currentTime
                )

            const data5 =
                getClosedData(
                    d.data5,
                    currentTime
                )

            const data15 =
                getClosedData(
                    d.data15,
                    currentTime
                )

            const data1h =
                getClosedData(
                    d.data1h,
                    currentTime
                )

            if (
                !data1m ||
                !data5 ||
                !data15 ||
                !data1h
            ) {
                continue
            }

            if (
                data1m.length < 82 ||
                data5.length < 82 ||
                data15.length < 122 ||
                data1h.length < 102
            ) {
                continue
            }

            /*
             * Không mở lại cùng symbol khi đang có lệnh.
             */

            if (
                openTrades.some(
                    x =>
                        x.symbol === symbol
                )
            ) {
                continue
            }

            stats.calls++

            let signal=null

            try {

                signal =
                    await coreLogic(
                        data15,
                        data1h,
                        data5,
                        data1m
                    )

            } catch(err) {

                console.log(
                    `[BACKTEST] CORE ERROR ${symbol}`,
                    err.message
                )

                continue
            }

            if (!signal) {

                stats.rejected++

                continue
            }

            stats.signals++

            if (
                signal.side !== 'LONG' &&
                signal.side !== 'SHORT'
            ) {
                continue
            }

            const entry =
                Number(signal.price)

            const sl =
                Number(signal.sl)

            const tp =
                Number(signal.tp)

            const riskPerUnit =
                Math.abs(
                    entry-sl
                )

            if (
                !(entry > 0) ||
                !(sl > 0) ||
                !(tp > 0) ||
                !(riskPerUnit > 0)
            ) {
                continue
            }

            const riskMoney =
                balance *
                cfg.riskPercent

            /*
             * qty = số tiền muốn mất / khoảng SL
             */

            const qty =
                riskMoney /
                riskPerUnit

            if (
                !(qty > 0) ||
                !Number.isFinite(qty)
            ) {
                continue
            }

            const notional =
                qty * entry

            const entryFee =
                notional *
                cfg.feeRate

            if (
                balance <= entryFee
            ) {
                continue
            }

            const trade = {

                symbol,

                side:
                    signal.side,

                entryTime:
                    currentTime,

                entry,

                sl,

                tp,

                qty,

                notional,

                riskMoney,

                riskPerUnit,

                entryFee,

                signal
            }

            balance -=
                entryFee

            stats.fees +=
                entryFee

            openTrades.push(
                trade
            )

            if (
                ti - lastProgress >= 1440
            ) {

                lastProgress=ti

                const progress =
                    (
                        ti /
                        times.length
                    ) * 100

                console.log(
                    `[BACKTEST] ${progress.toFixed(1)}%`,
                    `balance=${balance.toFixed(4)}`,
                    `trades=${trades.length}`,
                    `open=${openTrades.length}`
                )
            }
        }
    }

    // ------------------------------------------------------------
    // CLOSE OPEN POSITIONS AT END
    // ------------------------------------------------------------

    for (
        const trade of [...openTrades]
    ) {

        const d =
            market[trade.symbol]

        const rows =
            d.data1m

        const last =
            rows[rows.length-1]

        if (!last) {
            continue
        }

        const exitPrice =
            candleClose(last)

        const priceMove =
            trade.side === 'LONG'
                ? exitPrice-trade.entry
                : trade.entry-exitPrice

        const grossPnl =
            trade.qty *
            priceMove

        const exitFee =
            Math.abs(
                trade.qty *
                exitPrice
            ) *
            cfg.feeRate

        const pnl =
            grossPnl -
            trade.entryFee -
            exitFee

        const rMultiple =
            trade.riskPerUnit > 0
                ? priceMove /
                  trade.riskPerUnit
                : 0

        stats.fees +=
            exitFee

        stats.grossPnL +=
            grossPnl

        trade.exitTime =
            endTime

        trade.exitPrice =
            exitPrice

        trade.result =
            'EOD'

        trade.pnl =
            pnl

        trade.r =
            rMultiple

        trade.balance =
            balance + pnl

        balance += pnl

        stats.netPnL +=
            pnl

        stats.totalR +=
            rMultiple

        stats.maxBalance =
            Math.max(
                stats.maxBalance,
                balance
            )

        const dd =
            (
                stats.maxBalance -
                balance
            ) /
            stats.maxBalance

        stats.maxDrawdown =
            Math.max(
                stats.maxDrawdown,
                dd
            )

        trades.push(trade)
    }

    // ------------------------------------------------------------
    // FINAL STATS
    // ------------------------------------------------------------

    const totalTrades =
        trades.length

    const winRate =
        totalTrades > 0
            ? stats.wins /
              totalTrades
            : 0

    const netPnL =
        balance -
        initialBalance

    const roi =
        initialBalance > 0
            ? netPnL /
              initialBalance
            : 0

    const formatTable = obj => {

        const keys =
            Object.keys(obj)

        if (!keys.length) {
            return 'Không có dữ liệu'
        }

        return keys
            .map(k => {

                const x =
                    obj[k]

                const wr =
                    x.trades > 0
                        ? (
                            x.wins /
                            x.trades *
                            100
                        ).toFixed(1)
                        : '0.0'

                return (
                    `${k}: ` +
                    `${x.trades}T ` +
                    `W${x.wins}/L${x.losses} ` +
                    `WR ${wr}% ` +
                    `PnL ${x.pnl.toFixed(4)} ` +
                    `R ${x.r.toFixed(2)}`
                )
            })
            .join('\n')
    }

    const dateText =
        d =>
            new Date(d)
                .toISOString()
                .slice(0,16)
                .replace('T',' ')

    const report =
`📊 BACKTEST CORE — ${cfg.days} NGÀY

💰 VỐN
Start: ${initialBalance.toFixed(4)} USDT
End: ${balance.toFixed(4)} USDT
PnL: ${netPnL >= 0 ? '+' : ''}${netPnL.toFixed(4)} USDT
ROI: ${(roi*100).toFixed(2)}%

📈 KẾT QUẢ
Trades: ${totalTrades}
Wins: ${stats.wins}
Losses: ${stats.losses}
Win rate: ${(winRate*100).toFixed(2)}%
Total R: ${stats.totalR.toFixed(2)}R

📉 RỦI RO
Max drawdown: ${(stats.maxDrawdown*100).toFixed(2)}%
Longest losing streak: ${stats.longestLosingStreak}

💸 PHÍ
Fees: ${stats.fees.toFixed(6)} USDT

⚙️ CORE
Core calls: ${stats.calls}
Core rejects: ${stats.rejected}
Signals: ${stats.signals}

🕐 PERIOD
${dateText(startTime)}
→
${dateText(endTime)}

🪙 SYMBOLS
${cfg.symbols.join(', ')}

📌 SIDE
${formatTable(bySide)}

📌 SETUP
${formatTable(bySetup)}

📌 TRIGGER
${formatTable(byTrigger)}
`

    console.log('')
    console.log('================================================')
    console.log('BACKTEST FINISHED')
    console.log('================================================')
    console.log(report)
    console.log('================================================')

    // ------------------------------------------------------------
    // CSV-LIKE TRADE LOG
    // ------------------------------------------------------------

    console.log('')
    console.log('[BACKTEST] TRADE LOG')

    for (
        const t of trades
    ) {

        console.log(
            [
                t.symbol,
                t.side,
                dateText(t.entryTime),
                t.entry,
                t.sl,
                t.tp,
                t.result,
                t.exitPrice,
                r(t.pnl,6),
                r(t.r,3),
                t.signal.setup,
                t.signal.triggerType
            ].join(' | ')
        )
    }

    // ------------------------------------------------------------
    // TELEGRAM
    // ------------------------------------------------------------

    await sendTelegram(
        report
    )

    return {
        config:cfg,

        startTime,
        endTime,

        initialBalance,

        finalBalance:
            balance,

        pnl:
            netPnL,

        roi,

        stats,

        trades,

        bySide,

        bySetup,

        byTrigger
    }
}
let DB_READY = false
const OPEN_POSITION_LOCK = {}
const TPSL_LOCK = {}
const TPSL_PHASE = {}
let DB_RECONNECTING = false
let DB_LAST_ERROR = 0
let TIME_SYNCED = false
const TPSL_PENDING = {}
const TPSL_CLOSING = {}
const DYNAMIC_LAST_UPDATE = {}
const DYNAMIC_PHASE = {}
let SYNCING_TIME = false
let LAST_OFFSET_LOG = 0
let serverTimeOffset = 0
const OPENING_POSITIONS = {}
const fs = require("fs")

const PID_FILE = "./bot.pid"

// nếu đã có bot chạy
if(fs.existsSync(PID_FILE)){
    const oldPid = parseInt(fs.readFileSync(PID_FILE,"utf8"))

    try{
        process.kill(oldPid, 0)
        console.log("⛔ BOT ĐANG CHẠY SẴN → EXIT")
        process.exit(1)
    }catch(e){
        // process chết → ok
    }
}
//
process.on("unhandledRejection", err => {
    console.log("UNHANDLED:", err)
})

process.on("uncaughtException", err => {
    console.log("UNCAUGHT:", err)
})
const https = require("https")

const agent = new https.Agent({
    keepAlive: true,
    maxSockets: 15,
    maxFreeSockets: 5,
    timeout: 15000
})
let POS_CACHE = null
let POS_CACHE_TIME = 0
async function ensureDB(){

    if(DB_READY){
        try{
            await db.command({ ping: 1 })
            return true
        }catch(e){
            DB_READY = false
            console.log("⚠️ MongoDB ping failed")
        }
    }

    if(DB_RECONNECTING){
        return false
    }

    DB_RECONNECTING = true

    try{

        console.log("🔄 MongoDB reconnect...")

        await client.connect()

        db = client.db("trading")
        trades = db.collection("trades")

        await db.command({
            ping: 1
        })

        DB_READY = true

        console.log("🟢 MongoDB READY")

        return true

    }catch(e){

        DB_READY = false

        console.log(
            "🔴 MongoDB reconnect FAIL:",
            e?.message || e
        )

        return false

    }finally{

        DB_RECONNECTING = false

    }
}
async function getPositionsCached(){

    let now = Date.now()

    if(
        POS_CACHE &&
        now - POS_CACHE_TIME < 5000
    ){
        return POS_CACHE
    }

    POS_CACHE =
        await binance.futuresPositionRisk({
            recvWindow:20000
        })

    POS_CACHE_TIME = now

    return POS_CACHE
}
async function safeFetch(url, options = {}, retry = 3){

    for(let i = 0; i < retry; i++){

        try{

            const res = await fetch(url, {
                ...options,
                ...(url.includes("telegram.org")
                    ? {}
                    : { agent })
            })

            if(res && res.ok){
                return res
            }

            if(
                res &&
                (res.status === 429 || res.status === 418)
            ){
                await new Promise(r =>
                    setTimeout(r, 3000)
                )
                continue
            }

            let text = ""

            try{
                text = await res.text()
            }catch(e){}

            console.log(
                `❌ FETCH STATUS ${res?.status}:`,
                text.slice(0,300)
            )

        }catch(e){

            if(
                e?.message &&
                (
                    e.message.includes("recvWindow") ||
                    e.message.includes("Timestamp")
                )
            ){
                await syncTime()
            }

            if(!url.includes("telegram.org")){
                console.log(
                    `❌ FETCH FAIL: ${url}`,
                    e?.message || e
                )
            }
        }

        if(i < retry - 1){
            await new Promise(r =>
                setTimeout(r, 1000)
            )
        }
    }

    return null
}
async function getClosedTradeResult(t){

    try{

        const trades = await binance.futuresUserTrades({
            symbol: t.symbol,
            limit: 50,
            recvWindow: 20000
        })

        if(!trades || trades.length === 0){
            return null
        }

        // Chỉ lấy các fill có realized PnL (lệnh đóng vị thế)
        const openTime = t.enteredAt || t.createdAt || 0

const exits = trades.filter(x =>
    Number(x.realizedPnl || 0) !== 0 &&
    Number(x.time || 0) >= openTime
)

        if(exits.length === 0){
            return null
        }

        // orderId của lệnh đóng mới nhất
        const latestOrderId = exits.at(-1).orderId

        // Gom toàn bộ fill của cùng order đó
        const fills = exits.filter(x => x.orderId === latestOrderId)

        const pnl = fills.reduce(
            (sum, x) => sum + Number(x.realizedPnl || 0),
            0
        )

        const lastFill = fills.at(-1)

        return {
            pnl,
            exitOrderId: String(latestOrderId),
            closedAt: Number(lastFill.time || Date.now())
        }

    }catch(e){

        console.log(`❌ CHECK EXIT ${t.symbol}:`, e.message)
        return null
    }
}
async function syncTime(){

    if(SYNCING_TIME) return

    SYNCING_TIME = true

    try{

        const start = Date.now()

        let res = await fetch(
            "https://fapi.binance.com/fapi/v1/time"
        )

        if(!res){
            TIME_SYNCED = false
            return
        }

        let data = await res.json()

        const end = Date.now()

        const latency = (end - start) / 2

        serverTimeOffset =
            data.serverTime - end + latency

        TIME_SYNCED = true

        if(
    Date.now() - LAST_OFFSET_LOG >
    60000
){

    console.log(
        `🕒 TIME OFFSET: ${Math.round(serverTimeOffset)}ms`
    )

    LAST_OFFSET_LOG = Date.now()
}

    }catch(e){

        TIME_SYNCED = false

    }finally{

        SYNCING_TIME = false
    }
}
async function checkTimeError(err){

    let msg = String(err?.message || err)

    if(
        msg.includes("-1021") ||
        msg.includes("Timestamp") ||
        msg.includes("recvWindow")
    ){
        console.log("🕒 AUTO RESYNC")

        await syncTime()

        return true
    }

    return false
}
///////////
function getTimestamp(){
    let ts = TIME_SYNCED
        ? Date.now() + serverTimeOffset
        : Date.now()
    return Math.floor(ts)
}
//////////////
require("dotenv").config()
const { MongoClient } = require("mongodb")
const client = new MongoClient(process.env.MONGO_URI, {
    connectTimeoutMS: 10000,
    serverSelectionTimeoutMS: 10000,
    socketTimeoutMS: 30000,
    maxPoolSize: 20,
    minPoolSize: 1,
    retryWrites: true,
    retryReads: true
})
const Binance = require('binance-api-node').default

const binance = Binance({
    apiKey: process.env.BINANCE_KEY,
    apiSecret: process.env.BINANCE_SECRET,
    recvWindow: 60000
})
const crypto = require("crypto")

async function getBalance(){
    try{
        const baseUrl = "https://fapi.binance.com"
        const path = "/fapi/v2/balance"

        const timestamp = getTimestamp()

        const query = `timestamp=${timestamp}`

        const signature = crypto
            .createHmac("sha256", process.env.BINANCE_SECRET)
            .update(query)
            .digest("hex")

        const url = `${baseUrl}${path}?${query}&signature=${signature}`

        let res = await safeFetch(url, {
            headers: {
                "X-MBX-APIKEY": process.env.BINANCE_KEY
            }
        })
        if(!res) return 0

        let data = await res.json()
        
        let usdt = data.find(x => x.asset === "USDT")

        return Number(usdt?.balance || 0)

    }catch(e){
        console.log("❌ BAL ERROR:", e.message)
        return 0
    }
}
let db, trades
// ================= CONFIG =================
const BOT_TOKEN = process.env.BOT_TOKEN
const CHAT_ID = process.env.CHAT_ID

const BOT_TOKEN_2 = process.env.BOT_TOKEN_2
const AI_CHAT_ID = process.env.AI_CHAT_ID

const LIMIT_15M = 300 //300
const LIMIT_1H  = 200 //100

const RR_THRESHOLD = 1.20 // 1.3 hoặc 1.4 nếu muốn 

const TRADE_CONFIG = {
    riskPerTrade: 0.01,      
    maxRiskPerTrade: 0.01,    
    maxPositionPercent: 1.5,  
    maxActivePositions: 20      
}
let ACCOUNT_BALANCE = 0
const MIN_VOL_15M = 60000 // 100000 hoặc  nếu rác
// const MIN_VOL_24H = 15000000

const DEBUG_AI = false
const ENABLE_REVERSAL = true

let lastUpdateId = 0
let cachedSymbols = null
let lastSymbolsUpdate = 0
//let lastSignalTime = {}
let isScanning = false
let scanning = false
// ===== ACTIVE TRADES =====
let exchangeInfoTime = 0
let checkingTrades = false
let activeTrades = []
let exchangeInfoCache = null
let validFuturesSymbols = new Set()
let pollingLock = true
let telegramPolling = false
let TELEGRAM_LOCK = 0
let DATA_FAILS = {}
let WATCHDOG_RUNNING = false
let BTC_REGIME_CACHE = null
let BTC_REGIME_CACHE_TIME = 0

async function updateBalance(){

    try{
        let bal = await getBalance()
        if(bal && bal > 0){
            ACCOUNT_BALANCE = bal
            console.log(
                "💰 BALANCE:",
                ACCOUNT_BALANCE
            )
            return bal
        }
        return ACCOUNT_BALANCE
    }catch(e){
        console.log(
            "❌ updateBalance error:",
            e.message
        )
        return ACCOUNT_BALANCE
    }
}
function normalizePrice(price, tickSize){

    if(!tickSize) return price

    const precision =
        (tickSize.toString().split(".")[1] || "")
        .replace(/0+$/,"")
        .length

    const normalized =
        Math.round(price / tickSize) * tickSize

    return Number(
        normalized.toFixed(precision)
    )
}
function normalizeQty(qty, stepSize){
    return Number(
        (Math.floor(qty / stepSize) * stepSize)
        .toFixed(
            (stepSize.toString().split(".")[1] || "").length
        )
    )
}
async function getSymbolInfo(symbol){

    try{

        if(
    !exchangeInfoCache ||
    !exchangeInfoCache.symbols ||
    Date.now() - exchangeInfoTime > 3600000
){

            let res = await safeFetch(
                "https://fapi.binance.com/fapi/v1/exchangeInfo"
            )

            if(!res) return null

            let data = await res.json()

            if(!data.symbols){
                return null
            }

            exchangeInfoCache = data
exchangeInfoTime = Date.now()
        }

        return exchangeInfoCache.symbols.find(
            s => s.symbol === symbol
        )

    }catch(e){
        return null
    }
}
// ================= TELEGRAM =================
async function sendTelegram(msg) {

    try {

        const url =
            `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`

        console.log("📤 TELEGRAM: sending message...")
        console.log("📏 TELEGRAM message length:", msg?.length || 0)

        const res = await safeFetch(url, {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                chat_id: CHAT_ID,
                text: String(msg || "")
            })
        })

        // safeFetch không trả response
        if (!res) {

            console.error(
                "❌ TELEGRAM: safeFetch returned NULL"
            )

            return false
        }

        console.log(
            "📡 TELEGRAM HTTP:",
            res.status,
            res.statusText
        )

        let data

        try {

            data = await res.json()

        } catch (jsonErr) {

            console.error(
                "❌ TELEGRAM JSON PARSE ERROR:",
                jsonErr.message
            )

            return false
        }

        console.log(
            "📨 TELEGRAM RESPONSE:",
            JSON.stringify(data)
        )

        if (data?.ok === true) {

            console.log(
                "✅ TELEGRAM SENT SUCCESSFULLY"
            )

            return true
        }

        console.error(
            "❌ TELEGRAM API REJECTED:",
            data?.error_code || "UNKNOWN"
        )

        console.error(
            "❌ TELEGRAM DESCRIPTION:",
            data?.description || "NO DESCRIPTION"
        )

        return false

    } catch (e) {

        console.error(
            "❌ TELEGRAM EXCEPTION:",
            e?.message || e
        )

        console.error(
            "❌ TELEGRAM STACK:",
            e?.stack || "NO STACK"
        )

        return false
    }
}
// Telegram phụ
async function sendTelegram2(msg){
    try{
        let url = `https://api.telegram.org/bot${BOT_TOKEN_2}/sendMessage`
        let res = await safeFetch(url,{
            method:"POST",
            headers:{"Content-Type":"application/json"},
            body: JSON.stringify({ chat_id: AI_CHAT_ID, text: msg })
        })
        if(!res) return false

let data = await res.json()
        return data.ok

    }catch(e){
        console.log("❌ TELE 2:", e.message)
        return false
    }
}
function normalizeQtyFinal(qty, stepSize){

    if(!stepSize) return qty

    const precision =
        (stepSize.toString().split(".")[1] || "")
        .replace(/0+$/,"")
        .length

    const normalized =
        Math.floor(qty / stepSize) * stepSize

    return parseFloat(
        normalized.toFixed(precision)
    )
}
//function normalizeQtyFinal(qty, stepSize){
    //if(!stepSize) return qty

    //const precision = (stepSize.toString().split(".")[1] || "").length

   // let fixed = Math.floor(qty / stepSize) * stepSize

   // return Number(fixed.toFixed(precision))
//}
async function cancelAlgoTPSL(symbol){

    if(!symbol){
        console.log("❌ CANCEL ALGO NO SYMBOL")
        return false
    }

    try{

        const baseUrl =
            "https://fapi.binance.com"

        const path =
            "/fapi/v1/algoOpenOrders"

        const timestamp =
            getTimestamp()

        const query =
            `symbol=${symbol}` +
            `&recvWindow=60000` +
            `&timestamp=${timestamp}`

        const signature =
            crypto
                .createHmac(
                    "sha256",
                    process.env.BINANCE_SECRET
                )
                .update(query)
                .digest("hex")

        const url =
            `${baseUrl}${path}?${query}&signature=${signature}`

        const res =
            await safeFetch(
                url,
                {
                    method: "DELETE",
                    headers: {
                        "X-MBX-APIKEY":
                            process.env.BINANCE_KEY
                    }
                }
            )

        if(!res || !res.ok){

            console.log(
                `❌ ALGO CANCEL HTTP FAIL ${symbol}:`,
                res?.status
            )

            return false
        }

        const data =
            await res.json()

        if(
            data?.code === -1021 ||
            String(data?.msg || "")
                .toLowerCase()
                .includes("timestamp")
        ){

            console.log(
                `🕒 ALGO CANCEL RESYNC ${symbol}`
            )

            await syncTime()

            return false
        }

        /*
         * Binance có thể trả:
         *
         * {
         *   code: 200,
         *   msg: "The operation of cancel all open orders..."
         * }
         *
         * hoặc response thành công tương đương.
         *
         * Chỉ coi là fail khi code là lỗi âm.
         */

        if(
            data?.code !== undefined &&
            Number(data.code) < 0
        ){

            console.log(
                `❌ ALGO CANCEL REJECT ${symbol}:`,
                data
            )

            return false
        }

        console.log(
            `🗑 ALGO TPSL CANCELLED ${symbol}`
        )

        return true

    }catch(e){

        await checkTimeError(e)

        console.log(
            `❌ CANCEL ALGO TPSL ${symbol}:`,
            e?.message || e
        )

        return false
    }
}
async function getOpenTrade(symbol){

    try{

        const trade =
            await trades.findOne({

                symbol: symbol,
                result: "PENDING"

            })

        return trade || null

    }catch(e){

        console.log(
            `❌ GET OPEN TRADE ${symbol}:`,
            e.message
        )

        return null
    }
}
async function hasPosition(symbol){

    try{

        let positions =
            await getPositionsCached()

        return positions.find(
            p =>
                p.symbol === symbol &&
                Math.abs(Number(p.positionAmt)) > 0
        )

    }catch(e){

        return null
    }
}
async function openPosition(symbol, side, qty){

    if(!symbol){
        console.log("❌ OPEN NO SYMBOL")
        return null
    }

    if(OPEN_POSITION_LOCK[symbol]){
        console.log(
            `⛔ OPEN LOCK ${symbol}`
        )
        return null
    }

    OPEN_POSITION_LOCK[symbol] = true

    try{

        // =========================================
        // LUÔN INVALIDATE CACHE TRƯỚC KHI CHECK
        // =========================================

        POS_CACHE = null
        POS_CACHE_TIME = 0

        const existingPos =
            await hasPosition(symbol)

        if(existingPos){

            console.log(
                `⛔ SKIP OPEN ${symbol}: POSITION EXISTS`
            )

            return {
                skipped: true,
                reason: "POSITION_EXISTS",
                position: existingPos
            }
        }
        // =========================================
// CLEAR STALE ORDERS / ALGO TPSL
// =========================================

const cleared =
    await cancelAllOrders(symbol)

if(!cleared){

    console.log(
        `⛔ SKIP OPEN ${symbol}: OLD ORDERS NOT CLEARED`
    )

    return {
        skipped: true,
        reason: "OLD_ORDERS_NOT_CLEARED"
    }
}

        // =========================================
        // CHECK OPEN ORDERS
        // =========================================

        let openOrders

        try{

            openOrders =
                await binance.futuresOpenOrders({
                    symbol,
                    recvWindow: 20000
                })

        }catch(e){

            await checkTimeError(e)

            console.log(
                `❌ CHECK OPEN ORDERS ${symbol}:`,
                e.message
            )

            return null
        }

        const pendingMarket =
            openOrders.find(o =>
                o.type === "MARKET" &&
                (
                    o.status === "NEW" ||
                    o.status === "PARTIALLY_FILLED"
                )
            )

        if(pendingMarket){

            console.log(
                `⛔ MARKET ORDER EXISTS ${symbol}`
            )

            return {
                skipped: true,
                reason: "MARKET_ORDER_EXISTS"
            }
        }

        // =========================================
        // SYMBOL INFO
        // =========================================

        const info =
            await getSymbolInfo(symbol)

        if(!info || !info.filters){

            console.log(
                `❌ SYMBOL INFO FAIL ${symbol}`
            )

            return null
        }

        const lotFilter =
            info.filters.find(
                f => f.filterType === "LOT_SIZE"
            )

        const stepSize =
            parseFloat(
                lotFilter?.stepSize || "0.001"
            )

        qty =
            normalizeQtyFinal(
                qty,
                stepSize
            )

        if(
            !qty ||
            qty <= 0 ||
            !Number.isFinite(qty)
        ){

            console.log(
                `❌ INVALID FINAL QTY ${symbol}`
            )

            return null
        }

        // =========================================
        // SEND MARKET
        // =========================================

        const baseUrl =
            "https://fapi.binance.com"

        const path =
            "/fapi/v1/order"

        const timestamp =
            getTimestamp()

        const query =
            `symbol=${symbol}` +
            `&side=${side === "LONG" ? "BUY" : "SELL"}` +
            `&type=MARKET` +
            `&quantity=${qty}` +
            `&timestamp=${timestamp}` +
            `&recvWindow=10000`

        const signature =
            crypto
                .createHmac(
                    "sha256",
                    process.env.BINANCE_SECRET
                )
                .update(query)
                .digest("hex")

        const url =
            `${baseUrl}${path}?${query}&signature=${signature}`

        const res =
            await safeFetch(
                url,
                {
                    method: "POST",
                    headers: {
                        "X-MBX-APIKEY":
                            process.env.BINANCE_KEY
                    }
                }
            )

        if(!res || !res.ok){

            console.log(
                `❌ ORDER HTTP FAIL ${symbol}`,
                res?.status
            )

            return null
        }

        let data =
            await res.json()

        if(
            data.code === -1021 ||
            String(data.msg || "")
                .includes("Timestamp")
        ){

            console.log(
                `🕒 BINANCE RESYNC ${symbol}`
            )

            await syncTime()

            return null
        }

        if(data.code){

            console.log(
                `❌ BINANCE REJECT ${symbol}:`,
                data
            )

            return null
        }

        // =========================================
        // MARKET FILLED / VERIFY POSITION
        // =========================================

        POS_CACHE = null
        POS_CACHE_TIME = 0

        const verifyPos =
            await waitPosition(symbol)

        if(verifyPos){

            console.log(
                `✅ POSITION EXISTS ${symbol}`
            )

            data.status =
                "FILLED"

            console.log(
                `✅ FILLED ${symbol}`
            )

            return data
        }

        // =========================================
        // FINAL ORDER STATUS
        // =========================================

        for(let i = 0; i < 10; i++){

            await new Promise(r =>
                setTimeout(r, 800)
            )

            try{

                const check =
                    await binance.futuresGetOrder({
                        symbol,
                        orderId: data.orderId,
                        recvWindow: 60000
                    })

                if(check.status === "FILLED"){

                    data = check

                    POS_CACHE = null
                    POS_CACHE_TIME = 0

                    const finalPos =
                        await waitPosition(symbol)

                    if(finalPos){

                        console.log(
                            `✅ FILLED ${symbol}`
                        )

                        return data
                    }

                    continue
                }

                if(
                    check.status === "CANCELED" ||
                    check.status === "REJECTED" ||
                    check.status === "EXPIRED"
                ){

                    console.log(
                        `❌ ORDER DEAD ${symbol}`
                    )

                    return null
                }

            }catch(e){

                await checkTimeError(e)

                console.log(
                    `❌ CHECK ORDER ${symbol}:`,
                    e.message
                )
            }
        }

        console.log(
            `❌ NOT FILLED FINAL ${symbol}`
        )

        return null

    }catch(e){

        await checkTimeError(e)

        console.log(
            `❌ OPEN ORDER FAIL ${symbol}:`,
            e.message
        )

        return null

    }finally{

        delete OPEN_POSITION_LOCK[symbol]
    }
}
async function placeTPSLWithRetry(
    symbol,
    side,
    type,
    stopPrice
){

    const closeSide =
        side === "LONG"
            ? "SELL"
            : "BUY"

    for(
        let attempt = 1;
        attempt <= 4;
        attempt++
    ){

        try{

            const result =
                await binance.futuresOrder({

                    symbol,
                    side: closeSide,
                    type,
                    stopPrice,
                    closePosition: true,
                    workingType: "MARK_PRICE",
                    recvWindow: 60000

                })

            if(
                result &&
                (
                    result.algoId ||
                    result.orderId
                )
            ){

                return result
            }

        }catch(e){

            await checkTimeError(e)

            const msg =
                String(
                    e?.message ||
                    e?.body ||
                    e
                )

            const conflict =
                msg.includes(
                    "open stop or take profit order"
                ) ||
                msg.includes(
                    "GTE and closePosition"
                )

            console.log(
                `⚠️ TPSL ${type} RETRY ` +
                `${symbol} ` +
                `ATTEMPT=${attempt}/4: ` +
                msg
            )

            if(!conflict){

                throw e
            }

            if(attempt < 4){

                await new Promise(r =>
                    setTimeout(
                        r,
                        1000 * attempt
                    )
                )
            }
        }
    }

    return null
}
async function setDynamicTPSL(trade){

    const symbol =
        String(trade?.symbol || "").trim()

    if(!symbol){
        console.log("❌ DYNAMIC TPSL NO SYMBOL")
        return false
    }
    const side = String(trade?.side || "").toUpperCase()

if(side !== "LONG" && side !== "SHORT"){
    console.log(
        `❌ DYNAMIC INVALID SIDE ${symbol}: ${trade?.side}`
    )
    return false
}

    if(TPSL_LOCK[symbol]){
        console.log(
            `⛔ DYNAMIC TPSL LOCK BUSY ${symbol}`
        )
        return false
    }

    TPSL_LOCK[symbol] = true

    try{

        // =================================================
        // 1. VERIFY REAL POSITION
        // =================================================

        const pos =
            await waitPosition(symbol)

        if(!pos){
            console.log(
                `❌ DYNAMIC NO POSITION ${symbol}`
            )
            return false
        }

        const positionAmt =
            Number(pos.positionAmt)

        if(
            !Number.isFinite(positionAmt) ||
            positionAmt === 0
        ){
            console.log(
                `❌ DYNAMIC ZERO POSITION ${symbol}`
            )
            return false
        }

       const positionSide =
    positionAmt > 0
        ? "LONG"
        : "SHORT"

        const entry =
            Number(pos.entryPrice)

        if(
            !Number.isFinite(entry) ||
            entry <= 0
        ){
            console.log(
                `❌ INVALID ENTRY ${symbol}`
            )
            return false
        }

        // =================================================
        // 2. SYMBOL FILTERS
        // =================================================

        const info =
            await getSymbolInfo(symbol)

        if(!info || !info.filters){
            console.log(
                `❌ DYNAMIC SYMBOL INFO FAIL ${symbol}`
            )
            return false
        }

        const priceFilter =
            info.filters.find(
                f => f.filterType === "PRICE_FILTER"
            )

        if(!priceFilter){
            console.log(
                `❌ NO PRICE FILTER ${symbol}`
            )
            return false
        }

        const tickSize =
            Number(priceFilter.tickSize)

        if(
            !Number.isFinite(tickSize) ||
            tickSize <= 0
        ){
            console.log(
                `❌ INVALID TICK SIZE ${symbol}`
            )
            return false
        }

        // =================================================
        // 3. CURRENT MARKET PRICE
        // =================================================

        const currentPrice =
            Number(
                pos.markPrice ||
                pos.entryPrice
            )

        if(
            !Number.isFinite(currentPrice) ||
            currentPrice <= 0
        ){
            console.log(
                `❌ INVALID CURRENT PRICE ${symbol}`
            )
            return false
        }

        // =================================================
        // 4. RAW SL / TP
        // =================================================

        let rawSL =
            Number(trade.sl)

        let rawTP =
            Number(trade.tp)

        if(
            !Number.isFinite(rawSL) ||
            !Number.isFinite(rawTP) ||
            rawSL <= 0 ||
            rawTP <= 0
        ){

            console.log(
                `❌ INVALID DYNAMIC TPSL ${symbol} ` +
                `SL=${rawSL} TP=${rawTP}`
            )

            return false
        }

        // =================================================
// 5. DIRECTIONAL PRICE NORMALIZATION
// =================================================

let sl
let tp

if(positionSide==="LONG"){
    sl=Math.ceil(rawSL/tickSize)*tickSize
    tp=Math.ceil(rawTP/tickSize)*tickSize
}else{
    sl=Math.floor(rawSL/tickSize)*tickSize
    tp=Math.floor(rawTP/tickSize)*tickSize
}

        sl =
            Number(
                sl.toFixed(
                    Math.max(
                        0,
                        String(tickSize).split(".")[1]?.length || 0
                    )
                )
            )

        tp =
            Number(
                tp.toFixed(
                    Math.max(
                        0,
                        String(tickSize).split(".")[1]?.length || 0
                    )
                )
            )

            const previousSL=Number(trade.previousSL)

if(Number.isFinite(previousSL)&&previousSL>0){
    if(positionSide==="LONG"&&sl<previousSL)sl=previousSL
    if(positionSide==="SHORT"&&sl>previousSL)sl=previousSL
    sl=Number(sl.toFixed(Math.max(0,String(tickSize).split(".")[1]?.length||0)))
}

        // =================================================
        // 6. HARD VALIDATION
        // =================================================

        if(
            !Number.isFinite(sl) ||
            !Number.isFinite(tp) ||
            sl <= 0 ||
            tp <= 0
        ){
            console.log(
                `❌ NORMALIZED TPSL INVALID ${symbol}`
            )
            return false
        }

        if(positionSide === "LONG"){

            /*
             * LONG:
             *
             * SL < current
             * TP > current
             * SL < entry
             * TP > entry
             */

            if(
    sl >= currentPrice ||
    tp <= currentPrice
){

                console.log(
                    `❌ INVALID LONG DYNAMIC TPSL ${symbol} ` +
                    `ENTRY=${entry} ` +
                    `CURRENT=${currentPrice} ` +
                    `SL=${sl} TP=${tp}`
                )

                return false
            }

        }else{

            /*
             * SHORT:
             *
             * SL > current
             * TP < current
             * SL > entry
             * TP < entry
             */

            if(
    sl <= currentPrice ||
    tp >= currentPrice
){

                console.log(
                    `❌ INVALID SHORT DYNAMIC TPSL ${symbol} ` +
                    `ENTRY=${entry} ` +
                    `CURRENT=${currentPrice} ` +
                    `SL=${sl} TP=${tp}`
                )

                return false
            }
        }

        // =================================================
        // 7. VERIFY POSITION STILL EXISTS BEFORE CHANGE
        // =================================================

        POS_CACHE = null
        POS_CACHE_TIME = 0

        const verifyBefore =
            await hasPosition(symbol)

        if(!verifyBefore){

            console.log(
                `⚠️ POSITION DISAPPEARED BEFORE DYNAMIC ${symbol}`
            )

            return false
        }

        // =================================================
        // 8. CANCEL OLD TPSL
        // =================================================

        const cancelled =
            await cancelAllOrders(symbol)

        if(!cancelled){

            console.log(
                `❌ DYNAMIC OLD TPSL NOT CLEARED ${symbol}`
            )

            return false
        }
        await new Promise(r =>
    setTimeout(r, 1000)
)

        // =================================================
        // 9. SET SL
        // =================================================

        const closeSide =
            positionSide === "LONG"
                ? "SELL"
                : "BUY"

        let slRes

try{

    slRes =
        await placeTPSLWithRetry(
            symbol,
            positionSide,
            "STOP_MARKET",
            sl
        )

}catch(e){

    await checkTimeError(e)

    console.log(
        `❌ DYNAMIC SL SET FAIL ${symbol}:`,
        e?.message || e
    )

    return false
}

if(
    !slRes ||
    !(
        slRes.algoId ||
        slRes.orderId
    )
){

    console.log(
        `❌ SL INVALID RESPONSE ${symbol}:`,
        JSON.stringify(slRes)
    )

    return false
}

const slOrderId =
    slRes.algoId ||
    slRes.orderId

console.log(
    `🛡 DYNAMIC SL SET ${symbol}: ${sl}`
)
        // =================================================
        // 10. SET TP
        // =================================================

        let tpRes

try{

    tpRes =
        await placeTPSLWithRetry(
            symbol,
            positionSide,
            "TAKE_PROFIT_MARKET",
            tp
        )

}catch(e){

    await checkTimeError(e)

    console.log(
        `❌ DYNAMIC TP SET FAIL ${symbol}:`,
        e?.message || e
    )

    return false
}

if(
    !tpRes ||
    !(
        tpRes.algoId ||
        tpRes.orderId
    )
){

    console.log(
        `❌ TP INVALID RESPONSE ${symbol}:`,
        JSON.stringify(tpRes)
    )

    return false
}

const tpOrderId =
    tpRes.algoId ||
    tpRes.orderId

console.log(
    `🎯 DYNAMIC TP SET ${symbol}: ${tp}`
)

        return {
    ok: true,
    sl,
    tp,
    slOrderId,
    tpOrderId
}

    }catch(e){

        await checkTimeError(e)

        console.log(
            `❌ DYNAMIC TPSL FAIL ${symbol}:`,
            e.message
        )

        return false

    }finally{

        delete TPSL_LOCK[symbol]
    }
}
async function waitPosition(symbol){

    for(let i=0;i<15;i++){

        POS_CACHE = null
        POS_CACHE_TIME = 0

        let positions = await getPositionsCached()

        let pos = positions.find(
            p =>
                p.symbol === symbol &&
                Math.abs(parseFloat(p.positionAmt || "0")) > 0
        )

        if(pos) return pos

        await new Promise(r=>setTimeout(r,1000))
    }

    return null
}
async function setInitialTPSL(trade){

    const symbol =
        String(trade?.symbol || "").trim()

    if(!symbol){
        console.log("❌ INITIAL TPSL NO SYMBOL")
        return false
    }

    try{

        const pos =
            await waitPosition(symbol)

        if(!pos){

            console.log(
                `❌ NO POSITION FOR TPSL ${symbol}`
            )

            return false
        }

        const positionAmt =
            Number(pos.positionAmt)

        if(
            !Number.isFinite(positionAmt) ||
            positionAmt === 0
        ){

            console.log(
                `❌ ZERO POSITION FOR TPSL ${symbol}`
            )

            return false
        }

        const positionSide =
            positionAmt > 0
                ? "LONG"
                : "SHORT"

        const closeSide =
            positionSide === "LONG"
                ? "SELL"
                : "BUY"

        const info =
            await getSymbolInfo(symbol)

        if(!info || !info.filters){

            console.log(
                `❌ SYMBOL INFO FAIL ${symbol}`
            )

            return false
        }

        const priceFilter =
            info.filters.find(
                f => f.filterType === "PRICE_FILTER"
            )

        const tickSize =
            parseFloat(
                priceFilter?.tickSize || "0.01"
            )

        if(
            !Number.isFinite(tickSize) ||
            tickSize <= 0
        ){

            console.log(
                `❌ INVALID TICK SIZE ${symbol}`
            )

            return false
        }

        const rawSL =
            Number(trade.sl)

        const rawTP =
            Number(trade.tp)

        if(
            !Number.isFinite(rawSL) ||
            !Number.isFinite(rawTP) ||
            rawSL <= 0 ||
            rawTP <= 0
        ){

            console.log(
                `❌ INVALID INITIAL TPSL ${symbol} ` +
                `SL=${rawSL} TP=${rawTP}`
            )

            return false
        }

        let sl
        let tp

        if(positionSide === "LONG"){

            sl =
                Math.floor(
                    rawSL / tickSize
                ) * tickSize

            tp =
                Math.ceil(
                    rawTP / tickSize
                ) * tickSize

        }else{

            sl =
                Math.ceil(
                    rawSL / tickSize
                ) * tickSize

            tp =
                Math.floor(
                    rawTP / tickSize
                ) * tickSize
        }

        const decimals =
            Math.max(
                0,
                String(tickSize)
                    .split(".")[1]
                    ?.length || 0
            )

        sl =
            Number(
                sl.toFixed(decimals)
            )

        tp =
            Number(
                tp.toFixed(decimals)
            )

        const entry =
            Number(pos.entryPrice)

        if(
            !Number.isFinite(entry) ||
            entry <= 0
        ){

            console.log(
                `❌ INVALID ENTRY ${symbol}`
            )

            return false
        }

        if(positionSide === "LONG"){

            if(
                sl >= entry ||
                tp <= entry
            ){

                console.log(
                    `❌ INVALID LONG TPSL ${symbol} ` +
                    `ENTRY=${entry} SL=${sl} TP=${tp}`
                )

                return false
            }

        }else{

            if(
                sl <= entry ||
                tp >= entry
            ){

                console.log(
                    `❌ INVALID SHORT TPSL ${symbol} ` +
                    `ENTRY=${entry} SL=${sl} TP=${tp}`
                )

                return false
            }
        }

        // =========================================
        // GIỐNG CORE CŨ
        // =========================================

        const cancelled =
            await cancelAllOrders(symbol)

        if(!cancelled){

            console.log(
                `❌ OLD TPSL CLEAR FAIL ${symbol}`
            )

            return false
        }

        // =========================================
        // SET SL
        // =========================================

        console.log(
            `🛡 SET SL ${symbol}: ${sl}`
        )

        const slRes =
    await placeTPSLWithRetry(
        symbol,
        positionSide,
        "STOP_MARKET",
        sl
    )

        console.log(
            `✅ SL RESPONSE ${symbol}:`,
            JSON.stringify(slRes)
        )

        if(
            !slRes ||
            !(
                slRes.algoId ||
                slRes.orderId
            )
        ){

            console.log(
                `❌ SL INVALID RESPONSE ${symbol}`
            )

            return false
        }
        const slOrderId =
    slRes.algoId ||
    slRes.orderId

        // =========================================
        // SET TP
        // =========================================

        console.log(
            `🎯 SET TP ${symbol}: ${tp}`
        )

        const tpRes =
    await placeTPSLWithRetry(
        symbol,
        positionSide,
        "TAKE_PROFIT_MARKET",
        tp
    )

        console.log(
            `✅ TP RESPONSE ${symbol}:`,
            JSON.stringify(tpRes)
        )

        if(
    !tpRes ||
    !(
        tpRes.algoId ||
        tpRes.orderId
    )
){

    console.log(
        `❌ TP INVALID RESPONSE ${symbol}:`,
        JSON.stringify(tpRes)
    )

    await cancelAllOrders(symbol)

    return false
}


const tpOrderId =
    tpRes.algoId ||
    tpRes.orderId

        await new Promise(r =>
            setTimeout(r, 3000)
        )

        return {
    ok: true,
    sl,
    tp,
    slOrderId,
    tpOrderId
}

    }catch(e){

        await checkTimeError(e)

        console.log(
            `❌ INITIAL TPSL FAIL ${symbol}:`,
            e.message
        )

        return false
    }
}
async function openPositionWithTPSL(trade, qty){

    const symbol =
        String(trade?.symbol || "").trim()

    if(!symbol){
        console.log("❌ ENTRY NO SYMBOL")
        return false
    }

    const order =
        await openPosition(
            symbol,
            trade.side,
            qty
        )

    if(!order){

        console.log(
            `❌ ENTRY FAIL ${symbol}`
        )

        return false
    }

    if(order.skipped){

        console.log(
            `⛔ ENTRY SKIPPED ${symbol}: ` +
            `${order.reason}`
        )

        return {
            ok: false,
            skipped: true,
            reason: order.reason
        }
    }

    let pos =
        await waitPosition(symbol)

    if(!pos){

        pos =
            await hasPosition(symbol)

        if(!pos){

            console.log(
                `❌ NO POSITION AFTER ENTRY ${symbol}`
            )

            return false
        }
    }

    const realEntry =
        Number(pos.entryPrice)

    if(
        !Number.isFinite(realEntry) ||
        realEntry <= 0
    ){

        console.log(
            `❌ INVALID REAL ENTRY ${symbol}`
        )

        return false
    }

    trade.entry =
        realEntry

    trade.initialRisk =
        Math.abs(
            realEntry -
            Number(trade.sl)
        )

    if(
        !Number.isFinite(trade.initialRisk) ||
        trade.initialRisk <= 0
    ){

        console.log(
            `❌ INVALID INITIAL RISK ${symbol}`
        )

        return false
    }

    trade.openedAt =
        Date.now()

    trade.enteredAt =
        trade.openedAt

    console.log(
        `📌 ${symbol} ` +
        `ENTRY=${trade.entry} ` +
        `INITIAL_RISK=${trade.initialRisk}`
    )

    TPSL_PENDING[symbol] = true
    TPSL_PHASE[symbol] = "INITIAL"

    try{

        await new Promise(r =>
            setTimeout(r, 3000)
        )

        console.log(
            `🛡 SETTING INITIAL TPSL ${symbol}`
        )

        const tpslResult =
            await setInitialTPSL(
                trade
            )

        if(!tpslResult?.ok){

            console.log(
                `🚨 INITIAL TPSL FAIL ${trade.symbol}`
            )

            POS_CACHE = null
            POS_CACHE_TIME = 0

            let realPos = null

            try{

                const positions =
                    await getPositionsCached()

                realPos =
                    positions.find(p =>
                        p.symbol === trade.symbol &&
                        Math.abs(
                            Number(p.positionAmt || 0)
                        ) > 0
                    )

            }catch(e){

                await checkTimeError(e)

                console.log(
                    `⚠️ INITIAL POSITION VERIFY FAIL ${trade.symbol}:`,
                    e.message
                )

                return false
            }

            // Position đã biến mất → không close nữa
            if(!realPos){

                console.log(
                    `ℹ️ POSITION ALREADY CLOSED ${trade.symbol}`
                )

                return false
            }

            // Position còn nhưng initial TPSL thất bại
            const realQty =
                Math.abs(
                    Number(realPos.positionAmt)
                )

            if(
                !Number.isFinite(realQty) ||
                realQty <= 0
            ){

                console.log(
                    `❌ INVALID REAL QTY ${trade.symbol}`
                )

                return false
            }

            console.log(
                `🚨 INITIAL TPSL FAIL -> CLOSE ${trade.symbol}`
            )

            const closed =
                await closePosition(
                    trade.symbol,
                    trade.side,
                    realQty
                )

            if(!closed){

                console.log(
                    `🚨 CRITICAL INITIAL CLOSE FAIL ${trade.symbol}`
                )

                await sendTelegram2(
                    `🚨 CRITICAL INITIAL TPSL FAILURE\n` +
                    `${trade.symbol}\n` +
                    `POSITION STILL OPEN\n` +
                    `TPSL NOT ACTIVE\n` +
                    `CLOSE FAILED`
                )
            }

            return false
        }

        // =========================================
        // SAVE REAL TPSL
        // =========================================

        trade.sl =
            Number(tpslResult.sl)

        trade.tp =
            Number(tpslResult.tp)

        trade.initialRisk =
            Math.abs(
                Number(trade.entry) -
                Number(trade.sl)
            )

        if(
            !Number.isFinite(trade.initialRisk) ||
            trade.initialRisk <= 0
        ){

            console.log(
                `🚨 INVALID FINAL RISK ${symbol}`
            )

            await cancelAllOrders(symbol)

            const currentPos =
                await hasPosition(symbol)

            if(currentPos){

                const qty =
                    Math.abs(
                        Number(currentPos.positionAmt)
                    )

                await closePosition(
                    symbol,
                    trade.side,
                    qty
                )
            }

            return false
        }

        // =========================================
        // SAVE DB
        // =========================================

        TPSL_PHASE[symbol] =
            "ACTIVE"

        console.log(
            `✅ TPSL ACTIVE ${symbol} ` +
            `SL=${trade.sl} ` +
            `TP=${trade.tp} ` +
            `INITIAL_RISK=${trade.initialRisk}`
        )

        return {
            ok: true,
            entry: trade.entry,
            sl: trade.sl,
            tp: trade.tp,
            initialRisk: trade.initialRisk
        }

    }catch(e){

        await checkTimeError(e)

        console.log(
            `❌ ENTRY TPSL ERROR ${symbol}:`,
            e.message
        )

        return false

    }finally{

        delete TPSL_PENDING[symbol]
    }
}
// Dynamic manager compatible with Core V3.
// Core V3 owns the initial structure SL and TP. This function NEVER widens SL
// and NEVER pushes TP farther. It only protects profit after the market pays.
// Dynamic manager compatible with Core V3.
// Core V3 owns the initial structure SL and TP. This function NEVER widens SL.
// TP stays unchanged unless a qualified continuation has a farther structure.
async function manageDynamicTPSL(trade) {
    try {
        if (!trade?.symbol || !trade?.side) return
        const symbol = trade.symbol
        const side = String(trade.side).toUpperCase()
        const avg = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0
        const nearestAbove = (values, value) => values.filter(x => Number.isFinite(x) && x > value).sort((a, b) => a - b)[0]
        const nearestBelow = (values, value) => values.filter(x => Number.isFinite(x) && x < value).sort((a, b) => b - a)[0]
        if (side !== 'LONG' && side !== 'SHORT') return
        if (TPSL_CLOSING[symbol] || TPSL_PENDING[symbol]) return

        const enteredAt = Number(trade.enteredAt || trade.openedAt || trade.createdAt)
        if (!Number.isFinite(enteredAt) || enteredAt <= 0 || Date.now() - enteredAt < 90000) return
        TPSL_PENDING[symbol] = true

        const pos = await hasPosition(symbol)
        if (!pos) {
            delete DYNAMIC_LAST_UPDATE[symbol]
            delete DYNAMIC_PHASE[symbol]
            return
        }

        const [data5, data15] = await Promise.all([getData(symbol, '5m', 100), getData(symbol, '15m', 100)])
        if (!Array.isArray(data5) || !Array.isArray(data15) || data5.length < 70 || data15.length < 70) return
        const closed5 = data5.slice(0, -1), closed15 = data15.slice(0, -1)
        if (closed5.length < 60 || closed15.length < 60) return

        const h5 = closed5.map(x => Number(x[2])), l5 = closed5.map(x => Number(x[3])), c5 = closed5.map(x => Number(x[4]))
        if ([h5,l5,c5].flat().some(x => !Number.isFinite(x))) return
        const current = Number(pos.markPrice || pos.entryPrice || trade.entry)
        const entry = Number(pos.entryPrice || trade.entry)
        const oldSL = Number(trade.sl), oldTP = Number(trade.tp)
        if (!(current > 0 && entry > 0 && oldSL > 0 && oldTP > 0)) return

        let initialRisk = Number(trade.initialRisk)
        if (!(initialRisk > 0)) {
            initialRisk = Math.abs(entry - oldSL)
            if (!(initialRisk > 0)) return
            await trades.updateOne({ symbol, result: 'PENDING' }, { $set: { initialRisk, updatedAt: Date.now() } })
        }
        const originalSL = side === 'LONG' ? entry - initialRisk : entry + initialRisk
        const profit = side === 'LONG' ? current - entry : entry - current
        const R = profit / initialRisk
        if (!Number.isFinite(R) || R < .80) return // Let the structure stop do its job before +0.8R.

        const atr15Raw = Number(atr(closed15.slice(-60))), atr5Raw = Number(atr(closed5.slice(-60)))
        const atr15 = atr15Raw > 0 ? atr15Raw : current * .003
        const atr5 = atr5Raw > 0 ? atr5Raw : atr15
        const buffer = Math.max(atr5 * .20, atr15 * .12, current * .00025)
        if (!(atr15 > 0 && atr5 > 0 && buffer > 0)) return

        // A swing needs two completed candles on its right; a wick is not enough.
        const confirmedSwingLow = () => {
            for (let i = l5.length - 3; i >= Math.max(2, l5.length - 30); i--) {
                if (l5[i] < l5[i-1] && l5[i] <= l5[i-2] && l5[i] < l5[i+1] && l5[i] <= l5[i+2]) return l5[i]
            }
            return null
        }
        const confirmedSwingHigh = () => {
            for (let i = h5.length - 3; i >= Math.max(2, h5.length - 30); i--) {
                if (h5[i] > h5[i-1] && h5[i] >= h5[i-2] && h5[i] > h5[i+1] && h5[i] >= h5[i+2]) return h5[i]
            }
            return null
        }

        let newSL = oldSL
        let newTP = oldTP
        let phase = 1
        // +0.8R: remove the possibility of a full loss, but leave room for a 5M retest.
        const floorR = R >= 1.80 ? .90 : R >= 1.20 ? .30 : .05
        if (R >= 1.20) phase = 2
        if (R >= 1.80) phase = 3
        const floor = side === 'LONG' ? entry + initialRisk * floorR : entry - initialRisk * floorR
        if (side === 'LONG' && floor > newSL && floor < current) newSL = floor
        if (side === 'SHORT' && floor < newSL && floor > current) newSL = floor

        // Only after +1.2R can a confirmed 5M swing tighten the stop.
        let swing = null
        if (R >= 1.20) {
            swing = side === 'LONG' ? confirmedSwingLow() : confirmedSwingHigh()
            const structureSL = side === 'LONG' ? Number(swing) - buffer : Number(swing) + buffer
            if (Number.isFinite(structureSL)) {
                if (side === 'LONG' && structureSL > newSL && structureSL < current) newSL = structureSL
                if (side === 'SHORT' && structureSL < newSL && structureSL > current) newSL = structureSL
            }
        }

        // TP extension is exceptional, not automatic.  It may happen only before
        // the original TP is hit: price must be close to it, 5M momentum must
        // continue, and there must be a materially farther visible structure.
        const e9 = ema(c5.slice(-40), 9), e20 = ema(c5.slice(-60), 20)
        const recentVolumes = closed5.map(x => Number(x[5])).slice(-21, -1)
        const vol5 = avg(recentVolumes)
        const vol5Ratio = vol5 > 0 ? Number(closed5.at(-1)[5]) / vol5 : 1
        const nearOriginalTP = side === 'LONG'
            ? current < oldTP && oldTP - current <= Math.max(atr5 * .45, initialRisk * .25)
            : current > oldTP && current - oldTP <= Math.max(atr5 * .45, initialRisk * .25)
        const momentumLong = e9 > e20 && c5.at(-1) > c5.at(-2) && c5.at(-2) >= c5.at(-3) && vol5Ratio >= .80
        const momentumShort = e9 < e20 && c5.at(-1) < c5.at(-2) && c5.at(-2) <= c5.at(-3) && vol5Ratio >= .80
        const allHighs = h5.slice(-48, -1).concat(closed15.slice(-48, -1).map(x => Number(x[2])))
        const allLows = l5.slice(-48, -1).concat(closed15.slice(-48, -1).map(x => Number(x[3])))
        const nextObstacle = side === 'LONG' ? nearestAbove(allHighs, oldTP) : nearestBelow(allLows, oldTP)
        const extendedTP = side === 'LONG' ? Number(nextObstacle) - buffer * .20 : Number(nextObstacle) + buffer * .20
        const enoughExtension = side === 'LONG'
            ? extendedTP >= oldTP + Math.max(atr5 * .60, initialRisk * .35)
            : extendedTP <= oldTP - Math.max(atr5 * .60, initialRisk * .35)
        if (R >= .90 && nearOriginalTP && enoughExtension && ((side === 'LONG' && momentumLong) || (side === 'SHORT' && momentumShort))) {
            newTP = extendedTP
        }

        // Absolute invariants: no widened stop, no stop on the wrong side of price;
        // TP may only move farther when the continuation gate above passed.
        if (side === 'LONG') {
            if (newSL < originalSL || newSL < oldSL || newSL >= current) newSL = oldSL
        } else {
            if (newSL > originalSL || newSL > oldSL || newSL <= current) newSL = oldSL
        }
        const info = await getSymbolInfo(symbol)
        const priceFilter = info?.filters?.find(f => f.filterType === 'PRICE_FILTER')
        const tickSize = Number(priceFilter?.tickSize)
        if (!(tickSize > 0)) return
        const precision = Math.max(0, String(tickSize).split('.')[1]?.length || 0)
        // Round SL toward the safe side; round TP before its next obstacle.
        newSL = side === 'LONG' ? Math.floor(newSL / tickSize) * tickSize : Math.ceil(newSL / tickSize) * tickSize
        newTP = side === 'LONG' ? Math.floor(newTP / tickSize) * tickSize : Math.ceil(newTP / tickSize) * tickSize
        newSL = Number(newSL.toFixed(precision))
        newTP = Number(newTP.toFixed(precision))
        if (side === 'LONG' && newSL < oldSL) newSL = oldSL
        if (side === 'SHORT' && newSL > oldSL) newSL = oldSL
        if ((side === 'LONG' && newSL >= current) || (side === 'SHORT' && newSL <= current)) newSL = oldSL
        if (side === 'LONG' && newTP < oldTP) newTP = oldTP
        if (side === 'SHORT' && newTP > oldTP) newTP = oldTP
        const minimumChange = Math.max(entry * .00005, atr15 * .03)
        if (Math.abs(newSL - oldSL) < minimumChange && Math.abs(newTP - oldTP) < minimumChange) return

        const updateTrade = { ...trade, symbol, side, entry, sl: newSL, tp: newTP, initialRisk, previousSL: oldSL }
        const result = await setDynamicTPSL(updateTrade)
        if (!result?.ok) {
            console.log(`⚠️ DYNAMIC TPSL FAILED ${symbol}`)
            return
        }
        const finalSL = Number(result.sl), finalTP = Number(result.tp)
        if (!(finalSL > 0 && finalTP > 0)) return
        // Reject an exchange result that widens the stop or moves TP backward.
        const invalidLong = side === 'LONG' && (finalSL < oldSL || finalSL >= current || finalTP < oldTP)
        const invalidShort = side === 'SHORT' && (finalSL > oldSL || finalSL <= current || finalTP > oldTP)
        if (invalidLong || invalidShort) {
            console.log(`🚨 REJECT INVALID DYNAMIC RESULT ${symbol}`)
            return
        }
        trade.sl = finalSL; trade.tp = finalTP
        DYNAMIC_LAST_UPDATE[symbol] = Date.now(); DYNAMIC_PHASE[symbol] = phase
        await trades.updateOne({ symbol, result: 'PENDING' }, { $set: { sl: finalSL, tp: finalTP, initialRisk, dynamicPhase: phase, dynamicUpdatedAt: Date.now(), updatedAt: Date.now() } })
        console.log(`🎯 DYNAMIC ${symbol} ${side} R=${R.toFixed(2)} PHASE=${phase} SL ${oldSL}->${finalSL} TP=${finalTP} swing=${swing ?? 'none'}`)
    } catch (e) {
        await checkTimeError(e)
        console.log(`❌ MANAGE DYNAMIC TPSL ERROR ${trade?.symbol || 'UNKNOWN'}: ${e.message}`)
    } finally {
        if (trade?.symbol) delete TPSL_PENDING[trade.symbol]
    }
}

async function cancelAllOrders(symbol){

    if(!symbol){
        console.log("❌ CANCEL ALL NO SYMBOL")
        return false
    }

    try{

        console.log(
            `🗑 CANCEL OLD TPSL ${symbol}`
        )

        // =========================================
        // 1. CANCEL REGULAR OPEN ORDERS
        // =========================================

        try{

            await binance.futuresCancelAllOpenOrders({
                symbol,
                recvWindow: 60000
            })

        }catch(e){

            await checkTimeError(e)

            console.log(
                `❌ REGULAR CANCEL FAIL ${symbol}:`,
                e?.message || e
            )

            return false
        }

        // =========================================
        // 2. CANCEL ALGO TPSL
        // =========================================

        const algoCancelled =
            await cancelAlgoTPSL(symbol)

        if(!algoCancelled){

            console.log(
                `❌ ALGO TPSL CANCEL FAIL ${symbol}`
            )

            return false
        }

        // =========================================
        // 3. WAIT BINANCE
        // =========================================

        await new Promise(r =>
            setTimeout(r, 1500)
        )

        console.log(
            `🗑 OLD TPSL CLEARED ${symbol}`
        )

        return true

    }catch(e){

        await checkTimeError(e)

        console.log(
            `❌ CANCEL TPSL ${symbol}:`,
            e?.message || e
        )

        return false
    }
}
// ================= COMMAND =================
let checkingCmd = false

async function checkCommand(){

    if (TELEGRAM_LOCK) return
TELEGRAM_LOCK = Date.now()

    try{

        let url = `https://api.telegram.org/bot${BOT_TOKEN}/getUpdates?offset=${lastUpdateId+1}&timeout=25`

        let res = await safeFetch(url)

        if(!res){
            return
        }

        // ⚠️ FIX 409
        if(res.status === 409){
            console.log("⚠️ 409 DETECTED → RESET")

            await new Promise(r => setTimeout(r, 5000))

            return
        }

        let data = await res.json()
        if(!data.result) return

        for(let u of data.result){
            lastUpdateId = u.update_id

            if(u.message?.text === "/status"){
                await sendTelegram("🤖 BOT OK")
            }
        }

    }catch(e){
        console.log("CMD ERROR:", e.message)

    }finally{
        TELEGRAM_LOCK = 0
    }
}
// ================= INDICATORS =================
function ema(arr, p){
    let k = 2 / (p + 1)
    let e = arr[0]

    for(let i = 1; i < arr.length; i++){
        e = arr[i] * k + e * (1 - k)
    }

    return e
}

function rsi(arr, p = 14){
    if(arr.length < p + 1) return 50

    let g = 0, l = 0

    for(let i = arr.length - p; i < arr.length; i++){
        let d = arr[i] - arr[i - 1]
        if(d >= 0) g += d
        else l -= d
    }

    let rs = g / (l || 1)
    return 100 - (100 / (1 + rs))
}


function atr(data,p=14){
    let trs=[]
    for(let i=1;i<data.length;i++){
        let h=+data[i][2], l=+data[i][3], pc=+data[i-1][4]
        trs.push(Math.max(h-l, Math.abs(h-pc), Math.abs(l-pc)))
    }
    let slice = trs.slice(-p)
return slice.reduce((a,b)=>a+b,0) / slice.length
}
async function getData(symbol, interval, limit){

    const url =
        `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`

    try{

        const controller = new AbortController()

        const timeout = setTimeout(
            () => controller.abort(),
            10000
        )

        const res = await safeFetch(
            url,
            {
                headers: {
                    "User-Agent": "Mozilla/5.0"
                },
                signal: controller.signal
            },
            1
        )

        clearTimeout(timeout)

        if(!res || !res.ok){
            return null
        }

        const data = await res.json()

        if(
            Array.isArray(data) &&
            data.length > 0
        ){
            return data
        }

        return null

    }catch(e){

        console.log(
            `❌ DATA FAIL ${symbol} ${interval}:`,
            e?.message || e
        )

        return null
    }
}
// ================= SYMBOL (PRO) =================
async function getTopSymbols(){

    const urls = [
        "https://api.binance.com/api/v3/ticker/24hr",
        "https://data-api.binance.vision/api/v3/ticker/24hr"
    ]

    for(const url of urls){

        for(let attempt = 0; attempt < 2; attempt++){

            try{

                const res = await safeFetch(
                    url,
                    {
                        headers:{
                            "User-Agent":"Mozilla/5.0"
                        }
                    }
                )

                if(!res || !res.ok){
                    continue
                }

                const data = await res.json()

                if(
                    !Array.isArray(data) ||
                    data.length === 0
                ){
                    continue
                }

                // =====================================================
                // 1. BASE FILTER
                //
                // Chỉ loại những coin thực sự không phù hợp.
                //
                // Không dùng 24H movement để quyết định coin có
                // được scan hay không.
                // CoreLogic mới sẽ tự quyết định trend/pullback.
                // =====================================================

                const base = data
                    .filter(c => {

                        const symbol =
                            String(c.symbol || "")

                        return (
                            symbol.endsWith("USDT") &&
                            !symbol.includes("UP") &&
                            !symbol.includes("DOWN") &&
                            !symbol.includes("BUSD") &&
                            !symbol.includes("USD1") &&
                            !symbol.includes("FDUSD") &&
                            !symbol.includes("USDC") &&
                            !symbol.includes("EUR") &&
                            !symbol.includes("TRY") &&
                            !symbol.includes("RLUSD")
                        )
                    })

                    // =================================================
                    // Chỉ lấy Futures symbol hợp lệ
                    // =================================================

                    .filter(c =>
                        validFuturesSymbols &&
                        validFuturesSymbols.size > 0 &&
                        validFuturesSymbols.has(c.symbol)
                    )

                    // =================================================
                    // Thanh khoản tối thiểu
                    //
                    // 1.5M vẫn đủ an toàn nhưng rộng hơn bản cũ 2M.
                    // =================================================

                    .filter(c => {

                        const volume =
                            Number(c.quoteVolume)

                        return (
                            Number.isFinite(volume) &&
                            volume >= 1_500_000
                        )
                    })

                    // =================================================
                    // Range tối thiểu
                    //
                    // Không lấy coin quá chết.
                    //
                    // 1.2% thay vì 1.5% bản cũ.
                    // =================================================

                    .filter(c => {

                        const high =
                            Number(c.highPrice)

                        const low =
                            Number(c.lowPrice)

                        const last =
                            Number(c.lastPrice)

                        if(
                            !Number.isFinite(high) ||
                            !Number.isFinite(low) ||
                            !Number.isFinite(last)
                        ){
                            return false
                        }

                        if(
                            high <= 0 || low <= 0 ||
                            last <= 0
                        ){
                            return false
                        }

                        const range24 =
                            (high - low) / last

                        return range24 >= 0.012
                    })

                // =====================================================
                // 2. SCORE
                //
                // Đây KHÔNG phải score entry.
                //
                // Chỉ dùng để xếp coin nào đáng cho Core soi trước.
                //
                // Không ưu tiên coin tăng mạnh vô hạn.
                //
                // 0.5% -> vẫn có thể được chọn
                // 3-8% -> rất tốt
                // >8% -> điểm movement bị giới hạn
                //
                // Điều này hợp với:
                //
                // TREND
                // +
                // PULLBACK
                //
                // hơn việc ưu tiên coin đang pump mạnh.
                // =====================================================

                const scoreCoin = c => {

                    const move =
                        Math.abs(
                            Number(
                                c.priceChangePercent
                            )
                        )

                    const volume =
                        Number(c.quoteVolume)

                    if(
                        !Number.isFinite(move) ||
                        !Number.isFinite(volume)
                    ){
                        return -Infinity
                    }

                    const movementScore =
                        Math.min(move, 8) * 1.5

                    const volumeScore =
                        Math.log10(
                            Math.max(volume, 1)
                        ) * 2.5

                    return (
                        movementScore +
                        volumeScore
                    )
                }

                // =====================================================
                // 3. SORT
                //
                // Không còn:
                //
                // quiet 30
                // moving 40
                // strong 35
                // extreme 15
                //
                // Tất cả coin hợp lệ được xếp chung.
                // =====================================================

                const ranked =
                    base
                        .map(c => ({
                            symbol: c.symbol,
                            score: scoreCoin(c)
                        }))
                        .filter(x =>
                            Number.isFinite(x.score)
                        )
                        .sort(
                            (a,b) =>
                                b.score - a.score
                        )

                // =====================================================
                // 4. SELECT
                //
                // Lấy tối đa 120 coin.
                //
                // Nếu base chỉ có 80 coin thì lấy 80.
                // Không ép thêm coin rác chỉ để đủ 120.
                // =====================================================

                const selected =
                    ranked
                        .slice(0, 200)
                        .map(x => x.symbol)

                // =====================================================
                // 5. LOG
                // =====================================================

                console.log(
                    `📊 SYMBOLS ${selected.length} ` +
                    `BASE=${base.length} ` +
                    `RANKED=${ranked.length}`
                )

                if(
                    selected.length > 0
                ){

                    console.log(
                        `🎯 TOP SYMBOLS: ` +
                        `${selected.slice(0,10).join(", ")}`
                    )
                }
// =====================================================
                // 6. RETURN
                // =====================================================

                return selected

            }catch(e){

                if(attempt === 1){

                    console.log(
                        "❌ SYMBOL FAIL:",
                        url,
                        e?.message || e
                    )
                }
            }
        }
    }

    return null
}
async function loadValidFuturesSymbols(){

    try{

        let res = await safeFetch(
            "https://fapi.binance.com/fapi/v1/exchangeInfo"
        )

        if(!res) return

        let data = await res.json()

        if(!data.symbols) return

        validFuturesSymbols = new Set(

            data.symbols
                .filter(s =>
                    s.status === "TRADING" &&
                    s.contractType === "PERPETUAL"
                )
                .map(s => s.symbol)
        )

        console.log(`✅ Futures symbols: ${validFuturesSymbols.size}`)

    }catch(e){

        console.log("❌ LOAD FUTURES SYMBOL:", e.message)
    }
}

// =========================================================
// CORE 24H ANALYTICS
// =========================================================

const CORE_REJECT_STATS = {

    VALIDATION: 0,
    DATA_LENGTH: 0,
    INVALID_DATA: 0,

    ATR5: 0,

    "1H_DIRECTION": 0,
    BIAS: 0,

    VOL5: 0,
    PULLBACK: 0,
    CONFIRMATION: 0,
    VOL1: 0,
    CHASE: 0,

    RSI_INVALID: 0,
    RSI_LONG_EXTREME: 0,
    RSI_SHORT_EXTREME: 0,

    FINAL_SETUP: 0,

    RISK_INVALID: 0,
    RISK_TOO_SMALL: 0,
    RISK_TOO_WIDE: 0,
    RISK_PERCENT: 0,

    ROOM_LONG: 0,
    ROOM_SHORT: 0,

    FINAL_RR: 0,

    ACCEPT: 0,
    ACCEPT_LONG: 0,
    ACCEPT_SHORT: 0
}

const CORE_SIDE_STATS = {
    LONG: 0,
    SHORT: 0
}

// Số lần scan core được gọi
let CORE_TOTAL_CALLS = 0

// Lưu một vài detail tiêu biểu cho mỗi reject
const CORE_REJECT_DETAILS = {}

// Thời điểm bắt đầu chu kỳ thống kê
let CORE_STATS_START =
    Date.now()


// =========================================================
// REJECT
// =========================================================

const reject = (stage, details = {}) => {

    CORE_REJECT_STATS[stage] =
        (CORE_REJECT_STATS[stage] || 0) + 1

    // Chỉ giữ detail mới nhất
    CORE_REJECT_DETAILS[stage] = {
        ...details,
        timestamp: Date.now()
    }

    return null
}
// =========================================================
// BUILD CORE 24H REPORT
// =========================================================

function buildCore24hReport() {

    const now = Date.now()

    const hours =
        (now - CORE_STATS_START) /
        (60 * 60 * 1000)

    const total =
        CORE_TOTAL_CALLS

    const accepted =
        CORE_REJECT_STATS.ACCEPT

    const rejected =
        Math.max(
            total - accepted,
            0
        )

    const acceptRate =
        total > 0
            ? accepted / total * 100
            : 0

    const rejectRate =
        total > 0
            ? rejected / total * 100
            : 0


    // =====================================================
    // SORT REJECT
    // =====================================================

    const rejectList =
        Object.entries(
            CORE_REJECT_STATS
        )
        .filter(
            ([stage, count]) =>
                stage !== "ACCEPT" &&
                count > 0
        )
        .sort(
            (a, b) =>
                b[1] - a[1]
        )


    // =====================================================
    // TOP REJECTS
    // =====================================================

    const topRejects =
        rejectList
            .slice(0, 10)


    // =====================================================
    // SIDE
    // =====================================================

    const long =
        CORE_SIDE_STATS.LONG

    const short =
        CORE_SIDE_STATS.SHORT

    const sideTotal =
        long + short

    const longPct =
        sideTotal > 0
            ? long / sideTotal * 100
            : 0

    const shortPct =
        sideTotal > 0
            ? short / sideTotal * 100
            : 0


    // =====================================================
    // REPORT
    // =====================================================

    let msg = ""

    msg +=
        `📊 CORE 24H REPORT\n`

    msg +=
        `━━━━━━━━━━━━━━━━━━━━\n`

    msg +=
        `⏱ Period: ${hours.toFixed(1)}h\n`

    msg +=
        `🔎 Total scans: ${total.toLocaleString()}\n`

    msg +=
        `✅ Accept: ${accepted.toLocaleString()} (${acceptRate.toFixed(2)}%)\n`

    msg +=
        `❌ Reject: ${rejected.toLocaleString()} (${rejectRate.toFixed(2)}%)\n`

    msg +=
        `\n`

    msg +=
        `📈 ACCEPT SIDE\n`

    msg +=
        `LONG: ${long.toLocaleString()} (${longPct.toFixed(1)}%)\n`

    msg +=
        `SHORT: ${short.toLocaleString()} (${shortPct.toFixed(1)}%)\n`

    msg +=
        `\n`

    msg +=
        `🚫 TOP REJECTS\n`

    msg +=
        `━━━━━━━━━━━━━━━━━━━━\n`


    if (!topRejects.length) {

        msg +=
            `Không có reject.\n`

    } else {

        topRejects.forEach(
            ([stage, count], index) => {

                const pctTotal =
                    total > 0
                        ? count / total * 100
                        : 0

                msg +=
                    `${index + 1}. ${stage}: ` +
                    `${count.toLocaleString()} ` +
                    `(${pctTotal.toFixed(2)}%)\n`
            }
        )
    }


    // =====================================================
    // FULL STATS
    // =====================================================

    msg +=
        `\n📋 FULL CORE STATS\n`

    msg +=
        `━━━━━━━━━━━━━━━━━━━━\n`

    Object.entries(
        CORE_REJECT_STATS
    ).forEach(
        ([stage, count]) => {

            if (count <= 0)
                return

            msg +=
                `${stage}: ` +
                `${count.toLocaleString()}\n`
        }
    )


    // =====================================================
    // DEBUG DETAILS
    // =====================================================

    msg +=
        `\n🔬 LAST REJECT DETAILS\n`

    msg +=
        `━━━━━━━━━━━━━━━━━━━━\n`

    topRejects
        .slice(0, 5)
        .forEach(
            ([stage]) => {

                const detail =
                    CORE_REJECT_DETAILS[stage]

                if (!detail)
                    return

                const copy = {
                    ...detail
                }

                delete copy.timestamp

                msg +=
                    `\n${stage}:\n`

                msg +=
                    JSON.stringify(
                        copy
                    )
            }
        )

    return msg
}
// =========================================================
// RESET CORE 24H STATS
// =========================================================

function resetCore24hStats() {

    Object.keys(
        CORE_REJECT_STATS
    ).forEach(
        key => {
            CORE_REJECT_STATS[key] = 0
        }
    )

    CORE_SIDE_STATS.LONG = 0
    CORE_SIDE_STATS.SHORT = 0

    CORE_TOTAL_CALLS = 0

    Object.keys(
        CORE_REJECT_DETAILS
    ).forEach(
        key => {
            delete CORE_REJECT_DETAILS[key]
        }
    )

    CORE_STATS_START =
        Date.now()
}

async function coreLogic(data15, data1h, data5, data1m) {
    CORE_TOTAL_CALLS++

    const reject = (reason, detail = {}) => {
        try {
            if (typeof CORE_REJECTS === 'object' && CORE_REJECTS) {
                CORE_REJECTS[reason] = (CORE_REJECTS[reason] || 0) + 1
            }
            if (typeof CORE_LAST_REJECT === 'object' && CORE_LAST_REJECT) {
                CORE_LAST_REJECT[reason] = detail
            }
        } catch {}
        return null
    }

    // =========================================================
    // 0. VALIDATION
    // =========================================================

    if (![data15, data1h, data5, data1m].every(Array.isArray)) {
        return reject('VALIDATION')
    }

    data15 = data15.slice(0, -1)
    data1h = data1h.slice(0, -1)
    data5  = data5.slice(0, -1)
    data1m = data1m.slice(0, -1)

    if (
        data15.length < 120 ||
        data1h.length < 100 ||
        data5.length < 80 ||
        data1m.length < 80
    ) {
        return reject('DATA_LENGTH')
    }

    // =========================================================
    // 1. COLUMNS
    // =========================================================

    const col = (d, n) => d.map(x => Number(x[n]))

    const [o15, h15, l15, c15] =
        [col(data15,1), col(data15,2), col(data15,3), col(data15,4)]

    const [hH, lH, cH] =
        [col(data1h,2), col(data1h,3), col(data1h,4)]

    const [o5, h5, l5, c5, v5] =
        [col(data5,1), col(data5,2), col(data5,3), col(data5,4), col(data5,5)]

    const [o1, h1, l1, c1, v1] =
        [col(data1m,1), col(data1m,2), col(data1m,3), col(data1m,4), col(data1m,5)]

    if (
        [
            o15,h15,l15,c15,
            hH,lH,cH,
            o5,h5,l5,c5,v5,
            o1,h1,l1,c1,v1
        ].flat().some(x => !Number.isFinite(x))
    ) {
        return reject('INVALID_DATA')
    }

    const price = c1.at(-1)

    if (!(price > 0)) {
        return reject('INVALID_DATA')
    }

    // =========================================================
    // 2. HELPERS
    // =========================================================

    const avg = a =>
        a.length
            ? a.reduce((s,x) => s + x, 0) / a.length
            : 0

    const hi = (a,n) =>
        a.length
            ? Math.max(...a.slice(-n))
            : -Infinity

    const lo = (a,n) =>
        a.length
            ? Math.min(...a.slice(-n))
            : Infinity

    const r = (x,d=8) =>
        Number(Number(x).toFixed(d))

    const change = (a,b) =>
        b ? (a-b)/b : 0

    const body = (o,h,l,c) =>
        h > l ? Math.abs(c-o)/(h-l) : 0

    const atTop = (h,l,c) =>
        h > l ? (c-l)/(h-l) : .5

    const atBottom = (h,l,c) =>
        h > l ? (h-c)/(h-l) : .5

    const clamp = (x,min,max) =>
        Math.max(min,Math.min(max,x))

    const pivotLevels = (highs,lows,left=2,right=2) => {
        const pivotHighs = []
        const pivotLows = []

        for (
            let i=left;
            i<highs.length-right;
            i++
        ) {
            const beforeH = highs.slice(i-left,i)
            const afterH  = highs.slice(i+1,i+1+right)

            const beforeL = lows.slice(i-left,i)
            const afterL  = lows.slice(i+1,i+1+right)

            if (
                highs[i] > Math.max(...beforeH) &&
                highs[i] >= Math.max(...afterH)
            ) {
                pivotHighs.push(highs[i])
            }

            if (
                lows[i] < Math.min(...beforeL) &&
                lows[i] <= Math.min(...afterL)
            ) {
                pivotLows.push(lows[i])
            }
        }

        return {pivotHighs,pivotLows}
    }

    const nearestAbove = (levels,from) => {
        const x = levels
            .filter(v => Number.isFinite(v) && v > from)
            .sort((a,b) => a-b)

        return x[0]
    }

    const nearestBelow = (levels,from) => {
        const x = levels
            .filter(v => Number.isFinite(v) && v < from)
            .sort((a,b) => b-a)

        return x[0]
    }

    // =========================================================
    // 3. VOLATILITY
    // =========================================================

    const atr5  = Math.max(
        Number(atr(data5.slice(-60))) || 0,
        price * .001
    )

    const atr1  = Math.max(
        Number(atr(data1m.slice(-60))) || 0,
        price * .0005
    )

    const atr15 = Math.max(
        Number(atr(data15.slice(-60))) || 0,
        price * .002
    )

    const atr5Ratio = atr5 / price

    if (
        !(atr5Ratio > 0) ||
        atr5Ratio > .025
    ) {
        return reject('ATR5',{
            atrRatio5:r(atr5Ratio,6)
        })
    }

    // =========================================================
    // 4. 1H DIRECTION
    //
    // IMPORTANT:
    // Không còn bắt slope/gap quá cứng.
    // 1H chỉ xác định hướng chính.
    // =========================================================

    const e20H =
        ema(cH.slice(-60),20)

    const e50H =
        ema(cH.slice(-90),50)

    const e20HPrev =
        ema(cH.slice(-61,-1),20)

    const hSlope =
        change(e20H,e20HPrev)

    const hGap =
        Math.abs(e20H-e50H) / price

    const hPricePosition =
        change(price,e20H)

    // Trend mạnh
    const strongLong =
        e20H > e50H &&
        (
            hSlope > .00003 ||
            price > e20H
        )

    const strongShort =
        e20H < e50H &&
        (
            hSlope < -.00003 ||
            price < e20H
        )

    // Khi EMA20/50 rất sát nhau thì vẫn cho phép hướng
    // nếu giá đã xác nhận vị trí rõ ràng.
    const softLong =
    e20H > e50H &&
    hGap >= .00025 &&
    price >= e20H * .9990 &&
    hSlope > -.00010

const softShort =
    e20H < e50H &&
    hGap >= .00025 &&
    price <= e20H * 1.0010 &&
    hSlope < .00010

    let side = 'NONE'

const long1H =
    strongLong ||
    softLong

const short1H =
    strongShort ||
    softShort

if (long1H && !short1H) {
    side = 'LONG'
} else if (short1H && !long1H) {
    side = 'SHORT'
}

    if (side === 'NONE') {
        return reject('1H_DIRECTION',{
            ema20:r(e20H),
            ema50:r(e50H),
            slope:r(hSlope,6),
            gap:r(hGap,6),
            price:r(price)
        })
    }

       // =========================================================
   // 5. 15M BIAS
   // =========================================================

   const e20_15 =
       ema(c15.slice(-70),20)

   const e50_15 =
       ema(c15.slice(-110),50)

   const e20_15Prev =
       ema(c15.slice(-71,-1),20)

   const mSlope =
       change(e20_15,e20_15Prev)

   const mGap =
       Math.abs(e20_15-e50_15) / price

   const pullback15 =
       Math.max(
           atr15 * .45,
           price * .0018
       )

   let biasOK = false

   if (side === 'LONG') {

       const trend =
           e20_15 > e50_15 &&
           mGap >= .00015 &&
           mSlope > -.00003

       const pullback =
           price >= e50_15 - pullback15 &&
           price >= e20_15 * .994

       const reclaim =
           price > e20_15 &&
           c15.at(-1) >= o15.at(-1)

       biasOK =
           trend &&
           (pullback || reclaim)

   } else {

       const trend =
           e20_15 < e50_15 &&
           mGap >= .00015 &&
           mSlope < .00003

       const pullback =
           price <= e50_15 + pullback15 &&
           price <= e20_15 * 1.006

       const reclaim =
           price < e20_15 &&
           c15.at(-1) <= o15.at(-1)

       biasOK =
           trend &&
           (pullback || reclaim)
   }

   if (!biasOK) {
       return reject('15M_BIAS',{
           side,
           ema20:r(e20_15),
           ema50:r(e50_15),
           slope:r(mSlope,6),
           gap:r(mGap,6),
           price:r(price)
       })
   }
    // =========================================================
    // 6. 5M SETUP
    //
    // Tìm trong 8 nến gần nhất thay vì chỉ 4.
    // Cho phép:
    //  - SWEEP_RECLAIM
    //  - EMA20_RECLAIM
    //  - EMA50_RECLAIM
    // =========================================================

    const e20 =
        ema(c5.slice(-60),20)

    const e50 =
        ema(c5.slice(-80),50)

    const zone =
    Math.max(
        atr5 * .45,
        price * .0010
    )

    const start5 =
        Math.max(8,c5.length-8)

    let setupIndex = -1
    let setupKind = null
    let invalidation = null

    for (
        let k=c5.length-1;
        k>=start5;
        k--
    ) {

        const ema20At =
            ema(
                c5.slice(
                    Math.max(0,k-59),
                    k+1
                ),
                20
            )

        const ema50At =
            ema(
                c5.slice(
                    Math.max(0,k-79),
                    k+1
                ),
                50
            )

        const prevStart =
            Math.max(0,k-10)

        const prevL =
            lo(
                l5.slice(prevStart,k),
                Math.min(10,k-prevStart)
            )

        const prevH =
            hi(
                h5.slice(prevStart,k),
                Math.min(10,k-prevStart)
            )

        const b =
            body(
                o5[k],
                h5[k],
                l5[k],
                c5[k]
            )

        const top =
            atTop(
                h5[k],
                l5[k],
                c5[k]
            )

        const bottom =
            atBottom(
                h5[k],
                l5[k],
                c5[k]
            )

        // -----------------------------------------------------
        // LONG
        // -----------------------------------------------------

        const sweptLong =
            Number.isFinite(prevL) &&
            l5[k] <= prevL &&
            c5[k] > prevL &&
            c5[k] >= o5[k] &&
            top >= .50

        const reclaim20Long =
    l5[k] <= ema20At + zone &&
    c5[k] > ema20At &&
    c5[k] >= o5[k] &&
    b >= .28 &&
    top >= .58

const reclaim50Long =
    l5[k] <= ema50At + zone &&
    c5[k] > ema50At &&
    c5[k] >= o5[k] &&
    b >= .26 &&
    top >= .56

        // -----------------------------------------------------
        // SHORT
        // -----------------------------------------------------

        const sweptShort =
            Number.isFinite(prevH) &&
            h5[k] >= prevH &&
            c5[k] < prevH &&
            c5[k] <= o5[k] &&
            bottom >= .50

        const reclaim20Short =
    h5[k] >= ema20At - zone &&
    c5[k] < ema20At &&
    c5[k] <= o5[k] &&
    b >= .28 &&
    bottom >= .58

const reclaim50Short =
    h5[k] >= ema50At - zone &&
    c5[k] < ema50At &&
    c5[k] <= o5[k] &&
    b >= .26 &&
    bottom >= .56

        if (side === 'LONG') {

            if (sweptLong) {
                setupIndex = k
                setupKind = 'SWEEP_RECLAIM'
                invalidation = Math.min(l5[k],prevL)
                break
            }

            if (reclaim20Long) {
                setupIndex = k
                setupKind = 'PULLBACK_RECLAIM'
                invalidation = Math.min(l5[k],prevL)
                break
            }

            if (reclaim50Long) {
                setupIndex = k
                setupKind = 'EMA50_RECLAIM'
                invalidation = Math.min(l5[k],prevL)
                break
            }

        } else {

            if (sweptShort) {
                setupIndex = k
                setupKind = 'SWEEP_RECLAIM'
                invalidation = Math.max(h5[k],prevH)
                break
            }

            if (reclaim20Short) {
                setupIndex = k
                setupKind = 'PULLBACK_RECLAIM'
                invalidation = Math.max(h5[k],prevH)
                break
            }

            if (reclaim50Short) {
                setupIndex = k
                setupKind = 'EMA50_RECLAIM'
                invalidation = Math.max(h5[k],prevH)
                break
            }
        }
    }

    if (setupIndex < 0) {
        return reject('5M_RECLAIM',{
            side,
            ema20:r(e20),
            ema50:r(e50),
            zone:r(zone)
        })
    }

    // =========================================================
    // 7. SETUP AGE / INVALIDATION / CHASE
    // =========================================================

    const setupAge =
        c5.length - 1 - setupIndex

    // Setup cũ quá thì không dùng.
    if (setupAge > 4) {
        return reject('SETUP_INVALIDATED',{
            side,
            setupKind,
            setupAge5m:setupAge,
            invalidation:r(invalidation)
        })
    }

    const futureLows =
        l5.slice(setupIndex+1)

    const futureHighs =
        h5.slice(setupIndex+1)

    let invalidated = false

    if (side === 'LONG') {

        const postLow =
            futureLows.length
                ? Math.min(...futureLows)
                : Infinity

        // Chỉ invalid khi thực sự phá vùng invalidation.
        invalidated =
            postLow < invalidation - atr5*.10

    } else {

        const postHigh =
            futureHighs.length
                ? Math.max(...futureHighs)
                : -Infinity

        invalidated =
            postHigh > invalidation + atr5*.10
    }

    if (invalidated) {
        return reject('SETUP_INVALIDATED',{
            side,
            setupKind,
            setupAge5m:setupAge,
            invalidation:r(invalidation)
        })
    }

    // Chase được nới nhưng vẫn có giới hạn.
    const distance =
        Math.abs(price-e20) / price

    const maxChase =
        Math.max(
            2.10 * atr5 / price,
            .0065
        )

    if (distance > maxChase) {
        return reject('CHASE',{
            side,
            setupKind,
            distance:r(distance,6),
            maxChase:r(maxChase,6)
        })
    }

    // =========================================================
    // 8. 1M CONFIRMATION
    //
    // Không chỉ bắt break cứng.
    //
    // Trigger hợp lệ nếu:
    // A. break micro structure
    // B. strong close
    // C. reclaim + candle follow-through
    //
    // Cho cửa sổ 6 nến.
    // =========================================================

    const setupCloseTime =
        Number(data5[setupIndex]?.[6]) ||
        Number(data5[setupIndex+1]?.[0]) ||
        (
            Number(data5[setupIndex]?.[0]) +
            5*60*1000
        )

    let triggerIndex = -1
    let triggerTypeLocal = null

    const confirmStart =
        Math.max(
            3,
            c1.length-6
        )

    for (
        let j=c1.length-1;
        j>=confirmStart;
        j--
    ) {

        const candleTime =
            Number(data1m[j]?.[0])

        if (
            Number.isFinite(setupCloseTime) &&
            Number.isFinite(candleTime) &&
            candleTime < setupCloseTime
        ) {
            continue
        }

        const microHigh =
            hi(
                h1.slice(
                    Math.max(0,j-4),
                    j
                ),
                4
            )

        const microLow =
            lo(
                l1.slice(
                    Math.max(0,j-4),
                    j
                ),
                4
            )

        const b =
            body(
                o1[j],
                h1[j],
                l1[j],
                c1[j]
            )

        const top =
            atTop(
                h1[j],
                l1[j],
                c1[j]
            )

        const bottom =
            atBottom(
                h1[j],
                l1[j],
                c1[j]
            )

        const bull =
            c1[j] > o1[j] &&
            c1[j] > microHigh &&
            b >= .22 &&
            top >= .52

        const bear =
            c1[j] < o1[j] &&
            c1[j] < microLow &&
            b >= .22 &&
            bottom >= .52

        const strongBull =
            c1[j] > o1[j] &&
            b >= .52 &&
            top >= .68 &&
            c1[j] >= e20

        const strongBear =
            c1[j] < o1[j] &&
            b >= .52 &&
            bottom >= .68 &&
            c1[j] <= e20

        const followBull =
            c1[j] > o1[j] &&
            c1[j] > c1[Math.max(0,j-1)] &&
            top >= .58 &&
            b >= .18

        const followBear =
            c1[j] < o1[j] &&
            c1[j] < c1[Math.max(0,j-1)] &&
            bottom >= .58 &&
            b >= .18

        if (side === 'LONG') {

            if (bull) {
                triggerIndex = j
                triggerTypeLocal = '1M_BULLISH_BREAK_AFTER_RECLAIM'
                break
            }

            if (strongBull) {
                triggerIndex = j
                triggerTypeLocal = '1M_STRONG_CLOSE_AFTER_RECLAIM'
                break
            }

        } else {

            if (bear) {
                triggerIndex = j
                triggerTypeLocal = '1M_BEARISH_BREAK_AFTER_RECLAIM'
                break
            }

            if (strongBear) {
                triggerIndex = j
                triggerTypeLocal = '1M_STRONG_CLOSE_AFTER_RECLAIM'
                break
            }

        }
    }

    const triggerLong =
        triggerIndex >= 0 &&
        side === 'LONG'

    const triggerShort =
        triggerIndex >= 0 &&
        side === 'SHORT'

    if (triggerIndex < 0) {
        return reject('1M_CONFIRMATION',{
            side,
            setupKind,
            triggerLong:false,
            triggerShort:false,
            confirmationWindow:6
        })
    }

    // =========================================================
    // 9. ENTRY QUALITY / MICRO STRUCTURE
    // =========================================================

    const recentMicroLow =
        lo(
            l1.slice(
                Math.max(0,triggerIndex-4),
                triggerIndex+1
            ),
            5
        )

    const recentMicroHigh =
        hi(
            h1.slice(
                Math.max(0,triggerIndex-4),
                triggerIndex+1
            ),
            5
        )

    // =========================================================
    // 10. STOP LOSS
    //
    // SL dựa trên 5M invalidation + buffer.
    // Không đặt SL quá sát.
    // =========================================================

    const buffer =
        Math.max(
            atr1 * .70,
            atr5 * .18,
            price * .00035
        )

    let sl

    if (side === 'LONG') {

        const structuralLow =
            Math.min(
                invalidation,
                recentMicroLow
            )

        sl =
            structuralLow - buffer

    } else {

        const structuralHigh =
            Math.max(
                invalidation,
                recentMicroHigh
            )

        sl =
            structuralHigh + buffer
    }

    let risk =
        side === 'LONG'
            ? price-sl
            : sl-price

    if (!(risk > 0)) {
        return reject('RISK',{
            side,
            risk:r(risk)
        })
    }

    // =========================================================
    // 11. RISK NORMALIZATION
    //
    // Cho phép setup có SL rộng hơn một chút,
    // nhưng tuyệt đối không lấy risk quá lớn.
    // =========================================================

    const minRisk =
        Math.max(
            atr5*.22,
            price*.0007
        )

    const maxRisk =
        Math.max(
            atr5*3.20,
            price*.0085
        )

    if (
        risk < minRisk ||
        risk > maxRisk
    ) {
        return reject('RISK',{
            side,
            risk:r(risk),
            minRisk:r(minRisk),
            maxRisk:r(maxRisk),
            riskATR5:r(risk/atr5,3)
        })
    }

    // =========================================================
    // 12. STRUCTURE TARGET
    //
    // Tìm pivot gần nhất.
    // Nếu pivot quá gần thì không vào.
    // Nếu pivot đủ xa thì TP theo structure.
    // =========================================================

    const levels5 =
        pivotLevels(
            h5.slice(-60,-1),
            l5.slice(-60,-1),
            2,
            2
        )

    const levels15 =
        pivotLevels(
            h15.slice(-30,-1),
            l15.slice(-30,-1),
            2,
            2
        )

    const allHighs =
        levels5.pivotHighs.concat(
            levels15.pivotHighs
        )

    const allLows =
        levels5.pivotLows.concat(
            levels15.pivotLows
        )

    let obstacle =
        side === 'LONG'
            ? nearestAbove(allHighs,price)
            : nearestBelow(allLows,price)

    // Nếu pivot gần nhất quá sát, thử pivot tiếp theo.
    if (Number.isFinite(obstacle)) {

        const obstacleDistance =
            Math.abs(obstacle-price)

        if (obstacleDistance < risk*1.10) {

            const farther =
                side === 'LONG'
                    ? allHighs
                        .filter(x => x > price + risk*1.10)
                        .sort((a,b) => a-b)[0]

                    : allLows
                        .filter(x => x < price - risk*1.10)
                        .sort((a,b) => b-a)[0]

            if (Number.isFinite(farther)) {
                obstacle = farther
            }
        }
    }

    if (!Number.isFinite(obstacle)) {

        // Fallback structural target.
        // Không dùng wick tùy ý; dùng recent range.
        const rangeHigh =
            hi(h5.slice(-36,-1),35)

        const rangeLow =
            lo(l5.slice(-36,-1),35)

        obstacle =
            side === 'LONG'
                ? rangeHigh
                : rangeLow
    }

    if (!Number.isFinite(obstacle)) {
        return reject('NO_STRUCTURE_TARGET',{
            side
        })
    }

    // =========================================================
    // 13. AVAILABLE RR
    // =========================================================

    const targetBuffer =
        Math.max(
            atr1*.10,
            price*.00010
        )

    const available =
        side === 'LONG'
            ? (obstacle-targetBuffer-price)/risk
            : (price-obstacle-targetBuffer)/risk

    // Không cần 1.30 cứng như bản cũ.
    // 1.20 là ngưỡng tối thiểu.
    if (available < 1.60) {

        return reject('TP_BLOCKED',{
            side,
            nearestObstacle:r(obstacle),
            availableR:r(available,3),
            risk:r(risk)
        })
    }

    // =========================================================
    // 14. TARGET R
    // =========================================================

    let targetR

if (available >= 2.40) {
    targetR = 2.00
} else if (available >= 2.00) {
    targetR = 1.80
} else if (available >= 1.60) {
    targetR = 1.55
} else {
    targetR = 1.50
}

targetR =
    Math.min(
        targetR,
        available*.90
    )

targetR =
    Math.max(
        targetR,
        1.50
    )

    const tp =
        side === 'LONG'
            ? price + risk*targetR
            : price - risk*targetR

    // =========================================================
    // 15. VOLUME QUALITY
    // =========================================================

    const volAvg =
        avg(v5.slice(-21,-1))

    const vol5Ratio =
        volAvg > 0
            ? v5.at(-1)/volAvg
            : 1

               if (vol5Ratio < .60) {
       return reject('VOLUME',{
           side,
           setupKind,
           vol5Ratio:r(vol5Ratio,3)
       })
   }

    // =========================================================
    // 16. QUALITY SCORE
    //
    // Score chỉ mô tả chất lượng.
    // Không dùng score để chặn ACCEPT.
    // =========================================================

    let qualityScore = 60

    if (setupKind === 'SWEEP_RECLAIM') {
        qualityScore += 12
    } else if (setupKind === 'PULLBACK_RECLAIM') {
        qualityScore += 7
    } else {
        qualityScore += 5
    }

    if (hGap >= .0010) {
        qualityScore += 6
    } else if (hGap >= .0004) {
        qualityScore += 3
    }

    if (
        side === 'LONG'
            ? mSlope >= 0
            : mSlope <= 0
    ) {
        qualityScore += 5
    }

    if (vol5Ratio >= .80) {
        qualityScore += 5
    }

    if (vol5Ratio >= 1.15) {
        qualityScore += 3
    }

    if (available >= 1.80) {
        qualityScore += 5
    } else if (available >= 1.50) {
        qualityScore += 3
    }

    if (distance <= .0035) {
        qualityScore += 4
    }

    qualityScore =
        Math.round(
            clamp(
                qualityScore,
                55,
                100
            )
        )

    // =========================================================
    // 17. MARKET STATE / VOLATILITY
    // =========================================================

    const marketState =
        side === 'LONG'
            ? 'UPTREND'
            : 'DOWNTREND'

    const volatility =
        atr5Ratio < .003
            ? 'LOW'
            : atr5Ratio > .010
                ? 'HIGH'
                : 'NORMAL'

    // =========================================================
    // 18. FINAL RETURN
    //
    // GIỮ NGUYÊN CONTRACT CHO SCANNER + DYNAMIC.
    // =========================================================

    return {
        side,
        price:r(price),
        sl:r(sl),
        tp:r(tp),

        setup:
            side + '_' + setupKind,

        pullbackType:
            setupKind === 'SWEEP_RECLAIM'
                ? 'SWEEP'
                : setupKind === 'EMA50_RECLAIM'
                    ? 'EMA50_RECLAIM'
                    : 'EMA20_RECLAIM',

        triggerType:
            triggerTypeLocal ||
            (
                side === 'LONG'
                    ? '1M_BULLISH_BREAK_AFTER_RECLAIM'
                    : '1M_BEARISH_BREAK_AFTER_RECLAIM'
            ),

        marketState,

        volatility,

        qualityScore,

        // Scanner / DB / dynamic compatibility
        risk: {
            risk:r(risk),
            initialRisk:r(risk),
            rr:r(targetR),
            targetR:r(targetR)
        },

        indicators: {
            atr15:r(atr15),
            atr5:r(atr5),
            atr1:r(atr1),

            ema20_1h:r(e20H),
            ema50_1h:r(e50H),

            ema20_15:r(e20_15),
            ema50_15:r(e50_15),

            ema20_5:r(e20),
            ema50_5:r(e50)
        },

        debug: {
            setupIndex,

            setupAge5m:
                setupAge,

            setupKind,

            htfSlope:
                r(hSlope,6),

            htfGap:
                r(hGap,6),

            biasSlope:
                r(mSlope,6),

            vol5Ratio:
                r(vol5Ratio,3),

            distanceFromEma20:
                r(distance,6),

            maxChase:
                r(maxChase,6),

            invalidation:
                r(invalidation),

            risk:
                r(risk),

            riskATR5:
                r(risk/atr5,3),

            nearestObstacle:
                r(obstacle),

            availableR:
                r(available,3),

            targetR,

            triggerLong,
            triggerShort,

            triggerIndex,

            confirmationAge1m:
                c1.length - 1 - triggerIndex,

            htfDirection:
                side,

            price:
                r(price),

            sl:
                r(sl),

            tp:
                r(tp)
        }
    }
}


// =========================================================
// CORE REPORT — MỖI 6 GIỜ
// =========================================================

const CORE_REPORT_INTERVAL =
    6 * 60 * 60 * 1000

let CORE_REPORT_TIMER = null
let CORE_REPORT_RUNNING = false


// =========================================================
// SEND CORE REPORT
// =========================================================

async function sendCoreReport() {

    // Không cho phép 2 report chạy cùng lúc
    if (CORE_REPORT_RUNNING) {

        console.log(
            "⚠️ CORE REPORT ALREADY RUNNING -> SKIP"
        )

        return false
    }

    CORE_REPORT_RUNNING = true

    try {

        console.log(
            "\n🚨🚨🚨 CORE 6H REPORT TRIGGERED 🚨🚨🚨"
        )

        console.log(
            "🕐 TIME:",
            new Date().toLocaleString(
                "vi-VN",
                {
                    timeZone:
                        "Asia/Ho_Chi_Minh"
                }
            )
        )

        console.log(
            "🔎 SCANS SINCE LAST REPORT:",
            CORE_TOTAL_CALLS
        )


        // =====================================================
        // BUILD REPORT
        // =====================================================

        const report =
            buildCore24hReport()

        console.log(
            "📊 CORE REPORT BUILT"
        )

        console.log(
            "━━━━━━━━━━━━━━━━━━━━"
        )

        console.log(report)

        console.log(
            "━━━━━━━━━━━━━━━━━━━━"
        )


        // =====================================================
        // SEND TELEGRAM
        // =====================================================

        console.log(
            "📤 SENDING TO TELEGRAM..."
        )

        const sent =
            await sendTelegram(report)

        console.log(
            "📨 TELEGRAM RESULT:",
            sent
        )


        // =====================================================
        // SUCCESS
        // =====================================================

        if (sent === true) {

            console.log(
                "✅ CORE REPORT SENT SUCCESSFULLY"
            )

            // Chỉ reset khi Telegram xác nhận gửi thành công
            resetCore24hStats()

            console.log(
                "♻️ CORE STATS RESET"
            )

            console.log(
                "📊 NEW SCAN COUNT:",
                CORE_TOTAL_CALLS
            )

            return true
        }


        // =====================================================
        // FAIL
        // =====================================================

        console.error(
            "❌ CORE REPORT NOT SENT"
        )

        console.error(
            "⚠️ CORE STATS NOT RESET"
        )

        console.error(
            "⚠️ NEXT REPORT WILL KEEP CURRENT STATS"
        )

        return false


    } catch (err) {

        console.error(
            "❌ CORE REPORT ERROR:",
            err?.message || err
        )

        console.error(
            err
        )

        console.error(
            "⚠️ CORE STATS NOT RESET"
        )

        return false


    } finally {

        CORE_REPORT_RUNNING = false

        console.log(
            "🏁 CORE REPORT SEND FUNCTION FINISHED"
        )
    }
}


// =========================================================
// START CORE 6H REPORT TIMER
// =========================================================

function startCore6hReport() {

    console.log(
        "\n🔥 CORE REPORT SYSTEM STARTED"
    )

    console.log(
        "⏰ CORE REPORT: EVERY 6 HOURS"
    )

    console.log(
        "🕐 START TIME:",
        new Date().toLocaleString(
            "vi-VN",
            {
                timeZone:
                    "Asia/Ho_Chi_Minh"
            }
        )
    )


    // =====================================================
    // CHỐNG START TIMER 2 LẦN
    // =====================================================

    if (CORE_REPORT_TIMER) {

        console.log(
            "⚠️ CORE REPORT TIMER ALREADY EXISTS -> SKIP"
        )

        return
    }


    // =====================================================
    // TẠO TIMER DUY NHẤT
    // =====================================================

    CORE_REPORT_TIMER =
        setInterval(
            async () => {

                console.log(
                    "\n🚨🚨🚨 CORE REPORT INTERVAL FIRED 🚨🚨🚨"
                )

                console.log(
                    "🕐 TIME:",
                    new Date().toLocaleString(
                        "vi-VN",
                        {
                            timeZone:
                                "Asia/Ho_Chi_Minh"
                        }
                    )
                )

                console.log(
                    "🔎 SCANS SINCE LAST REPORT:",
                    CORE_TOTAL_CALLS
                )


                // =================================================
                // GỌI SEND
                // =================================================

                const result =
                    await sendCoreReport()


                // =================================================
                // RESULT LOG
                // =================================================

                if (result === true) {

                    console.log(
                        "✅ CORE 6H REPORT COMPLETED"
                    )

                } else {

                    console.error(
                        "❌ CORE 6H REPORT FAILED"
                    )

                }


                console.log(
                    "⏳ NEXT CORE REPORT IN: 6 HOURS"
                )

            },
            CORE_REPORT_INTERVAL
        )


    // =====================================================
    // TIMER CREATED
    // =====================================================

    console.log(
        "✅ CORE REPORT TIMER CREATED"
    )

    console.log(
        "⏳ NEXT CORE REPORT IN: 6 HOURS"
    )

}


// =========================================================
// START ON BOT STARTUP
// =========================================================

startCore6hReport()
// ================= SCAN =================
async function scan(symbol){

    try{

        // ==================================================
        // 1. LOAD MARKET DATA
        // ==================================================

        const [
            data15,
            data1h,
            data5,
            data1m
        ] = await Promise.all([

            getData(
                symbol,
                "15m",
                LIMIT_15M
            ),

            getData(
                symbol,
                "1h",
                LIMIT_1H
            ),

            getData(
                symbol,
                "5m",
                160
            ),

            getData(
                symbol,
                "1m",
                160
            )

        ])

        // ==================================================
        // 2. DATA VALIDATION
        // ==================================================

        if(!data15){
            console.error(`❌ DATA ERROR: ${symbol} 15m`)
            return null
        }

        if(!data1h){
            console.error(`❌ DATA ERROR: ${symbol} 1h`)
            return null
        }

        if(!data5){
            console.error(`❌ DATA ERROR: ${symbol} 5m`)
            return null
        }

        if(!data1m){
            console.error(`❌ DATA ERROR: ${symbol} 1m`)
            return null
        }

        // ==================================================
        // 3. CORE LOGIC
        // ==================================================

        let r

        try{

            r = await coreLogic(
                data15,
                data1h,
                data5,
                data1m
            )

        }catch(coreErr){

            console.error(
                `🔥 CORE ERROR: ${symbol}`,
                coreErr?.message || coreErr
            )

            console.error(
                coreErr?.stack || ""
            )

            return null
        }

        // ==================================================
        // 4. NO SIGNAL
        // ==================================================

        if(!r || !r.side){
            return null
        }

        // ==================================================
        // 5. SIGNAL FOUND
        // ==================================================

        console.log(
            `🟢 SIGNAL: ${symbol} | ` +
            `SIDE=${r.side} | ` +
            `SETUP=${r.setup || "N/A"} | ` +
            `QUALITY=${r.qualityScore ?? "N/A"}`
        )

        return {
            symbol,
            ...r
        }

    }catch(e){

        console.error(
            `🔥 SCAN ERROR: ${symbol}`,
            e?.message || e
        )

        console.error(
            e?.stack || ""
        )

        return null
    }
}
function safeFixed(value, digits = 2){

    const n = Number(value)

    if(!Number.isFinite(n)){
        return "0.00"
    }

    return n.toFixed(digits)
}
// ================= BTC REGIME =================
async function getBtcRegime() {

    // Cache 2 phút
    if(
        BTC_REGIME_CACHE &&
        Date.now() - BTC_REGIME_CACHE_TIME < 120000
    ){
        return BTC_REGIME_CACHE
    }

    const raw15 = await getData(
        "BTCUSDT",
        "15m",
        120
    )

    const raw1h = await getData(
        "BTCUSDT",
        "1h",
        120
    )

    if(!raw15 || !raw1h){
        return "NEUTRAL"
    }

    // Chỉ dùng nến đã đóng
    const data15 = raw15.slice(0, -1)
    const data1h = raw1h.slice(0, -1)

    if(
        data15.length < 60 ||
        data1h.length < 60
    ){
        return "NEUTRAL"
    }

    const close15 =
        data15.map(x => Number(x[4]))

    const close1h =
        data1h.map(x => Number(x[4]))

    const high15 =
        data15.map(x => Number(x[2]))

    const low15 =
        data15.map(x => Number(x[3]))

    const volume15 =
        data15.map(x => Number(x[5]))

    // ================= 15M =================

    const ema20_15 =
        ema(close15.slice(-60),20)

    const ema50_15 =
        ema(close15.slice(-100),50)

    const ema20_15_prev =
        ema(close15.slice(-61,-1),20)

    // ================= 1H =================

    const ema20_1h =
        ema(close1h.slice(-60),20)

    const ema50_1h =
        ema(close1h.slice(-100),50)

    const ema20_1h_prev =
        ema(close1h.slice(-61,-1),20)

    const ema50_1h_prev =
        ema(close1h.slice(-101,-1),50)

    const p15 = close15.at(-1)
    const p1h = close1h.at(-1)

    if(
        !p15 ||
        !p1h ||
        !ema20_15 ||
        !ema50_15 ||
        !ema20_1h ||
        !ema50_1h
    ){
        return "NEUTRAL"
    }

    // ================= TREND STRENGTH =================

    const strength15 =
        Math.abs(
            ema20_15 - ema50_15
        ) / p15

    const strength1h =
        Math.abs(
            ema20_1h - ema50_1h
        ) / p1h

    // ================= SLOPE =================

    const slope20_15 =
        ema20_15_prev !== 0
            ? (ema20_15 - ema20_15_prev)
                / ema20_15_prev
            : 0

    const slope20_1h =
        ema20_1h_prev !== 0
            ? (ema20_1h - ema20_1h_prev)
                / ema20_1h_prev
            : 0

    // ================= BTC BULL =================

    const bull15 =
        p15 > ema20_15 &&
        ema20_15 > ema50_15 &&
        slope20_15 > 0 &&
        strength15 >= 0.0010

    const bull1h =
        p1h > ema20_1h &&
        ema20_1h > ema50_1h &&
        slope20_1h > 0 &&
        ema50_1h >= ema50_1h_prev &&
        strength1h >= 0.0010

    // ================= BTC BEAR =================

    const bear15 =
        p15 < ema20_15 &&
        ema20_15 < ema50_15 &&
        slope20_15 < 0 &&
        strength15 >= 0.0010

    const bear1h =
        p1h < ema20_1h &&
        ema20_1h < ema50_1h &&
        slope20_1h < 0 &&
        ema50_1h <= ema50_1h_prev &&
        strength1h >= 0.0010

    // ================= FINAL REGIME =================

    let regime = "NEUTRAL"

    // BTC chỉ được BULL khi cả 15M + 1H cùng xác nhận
    if(bull15 && bull1h){
        regime = "BULL"
    }

    // BTC chỉ được BEAR khi cả 15M + 1H cùng xác nhận
    else if(bear15 && bear1h){
        regime = "BEAR"
    }

    BTC_REGIME_CACHE = regime
    BTC_REGIME_CACHE_TIME = Date.now()

    return regime
}

// Input: `best` is the core signal plus symbol:
// const best = { ...signal, symbol }
// Returns a DB-ready trade, or null when the signal is invalid.
function buildTradeFromCoreSignal(best, btcRegime, riskBudget){

    // =========================================================
    // CORE VALUES
    // =========================================================

    const entry = Number(best?.price)
    const sl = Number(best?.sl)
    const tp = Number(best?.tp)

    const initialRisk = Number(best?.risk?.risk ?? Math.abs(entry - sl))
const rr = Number(best?.risk?.rr ?? (Math.abs(tp - entry) / Math.abs(entry - sl)))
    const budget = Number(riskBudget)

    // =========================================================
    // VALIDATION
    // =========================================================

    if(
        !best?.symbol ||
        !["LONG", "SHORT"].includes(best?.side) ||
        !Number.isFinite(entry) || entry <= 0 ||
        !Number.isFinite(sl) || sl <= 0 ||
        !Number.isFinite(tp) || tp <= 0 ||
        !Number.isFinite(initialRisk) || initialRisk <= 0 ||
        !Number.isFinite(budget) || budget <= 0 ||
        !Number.isFinite(rr) || rr <= 0
    ){

        console.log(
            `❌ INVALID CORE SIGNAL ${best?.symbol || "UNKNOWN"}`
        )

        return null
    }

    // =========================================================
    // TPSL DIRECTION SAFETY
    // =========================================================

    if(
        (best.side === "LONG" &&
            (sl >= entry || tp <= entry)) ||

        (best.side === "SHORT" &&
            (sl <= entry || tp >= entry))
    ){

        console.log(
            `❌ INVALID TPSL DIRECTION ${best.symbol} ` +
            `SIDE=${best.side} ENTRY=${entry} SL=${sl} TP=${tp}`
        )

        return null
    }

    // =========================================================
    // CORE OBJECTS
    // =========================================================

    const indicators = best.indicators || {}
    const structure = best.structure || {}
    const context = best.context || {}
    const riskDetail = best.risk || {}
    const flags = best.flags || {}
    const debug = best.debug || {}

    const now = Date.now()

    // =========================================================
    // FINAL TRADE OBJECT
    // =========================================================

    return {

        // =====================================================
        // BASIC
        // =====================================================

        symbol:
            best.symbol,

        side:
            best.side,

        entry:
            entry,

        price:
            entry,

        sl:
            sl,

        tp:
            tp,

        setup:
            best.setup,

        pullbackType:
            best.pullbackType,

        triggerType:
            best.triggerType,

        marketState:
            best.marketState,

        volatility:
            best.volatility,

        btcRegime:
            btcRegime,

        qualityScore:
            Number(best.qualityScore ?? 0),

        // =====================================================
        // RISK
        // =====================================================

        // Monetary risk budget used for position sizing
        risk:
            budget,

        // Price distance Entry -> SL
        initialRisk:
            initialRisk,

        rr:
            rr,

        riskDetail: {

            risk:
                Number(
                    riskDetail.risk ??
                    initialRisk
                ),

            rr:
                Number(
                    riskDetail.rr ??
                    rr
                ),

            slDistance:
                Number(
                    riskDetail.slDistance ??
                    Math.abs(entry - sl)
                ),

            tpDistance:
                Number(
                    riskDetail.tpDistance ??
                    Math.abs(tp - entry)
                ),

            riskATR5:
                Number(
                    riskDetail.riskATR5 ??
                    (
                        Number.isFinite(Number(indicators.atr5)) &&
                        Number(indicators.atr5) > 0
                            ? initialRisk / Number(indicators.atr5)
                            : 0
                    )
                ),

            riskPercent:
                Number(
                    riskDetail.riskPercent ??
                    (
                        entry > 0
                            ? initialRisk / entry
                            : 0
                    )
                ),

            riskBudget:
                budget
        },

        // =====================================================
        // INDICATORS
        // EXACTLY MATCH CORE RETURN
        // =====================================================

        indicators: {

            ema20_1h:
                indicators.ema20_1h ?? null,

            ema50_1h:
                indicators.ema50_1h ?? null,

            ema20_15:
                indicators.ema20_15 ?? null,

            ema50_15:
                indicators.ema50_15 ?? null,

            ema9_5:
                indicators.ema9_5 ?? null,

            ema20_5:
                indicators.ema20_5 ?? null,

            ema50_5:
                indicators.ema50_5 ?? null,

            atr1h:
                indicators.atr1h ?? null,

            atr15:
                indicators.atr15 ?? null,

            atr5:
                indicators.atr5 ?? null,

            atr1m:
                indicators.atr1m ?? null,

            rsi5:
                indicators.rsi5 ?? null,

            rsi1m:
                indicators.rsi1m ?? null,

            volume1mRatio:
                indicators.volume1mRatio ?? null,

            volume5mRatio:
                indicators.volume5mRatio ?? null,

            atrRatio1h:
                indicators.atrRatio1h ?? null,

            atrRatio15:
                indicators.atrRatio15 ?? null,

            atrRatio5:
                indicators.atrRatio5 ?? null
        },

        // =====================================================
        // STRUCTURE
        // EXACTLY MATCH CORE RETURN
        // =====================================================

        structure: {

            structureHigh15:
                structure.structureHigh15 ?? null,

            structureLow15:
                structure.structureLow15 ?? null,

            swingHigh5:
                structure.swingHigh5 ?? null,

            swingLow5:
                structure.swingLow5 ?? null,

            swingHigh15:
                structure.swingHigh15 ?? null,

            swingLow15:
                structure.swingLow15 ?? null,

            resistance:
                structure.resistance ?? null,

            support:
                structure.support ?? null
        },

        // =====================================================
        // CONTEXT
        // EXACTLY MATCH CORE RETURN
        // =====================================================

        context: {

            h1Bull:
                context.h1Bull ?? false,

            h1Bear:
                context.h1Bear ?? false,

            bull15:
                context.bull15 ?? false,

            bear15:
                context.bear15 ?? false,

            trendLong5:
                context.trendLong5 ?? false,

            trendShort5:
                context.trendShort5 ?? false,

            bullishStructure15:
                context.bullishStructure15 ?? false,

            bearishStructure15:
                context.bearishStructure15 ?? false,

            structureOKLong:
                context.structureOKLong ?? false,

            structureOKShort:
                context.structureOKShort ?? false,

            pullbackLong:
                context.pullbackLong ?? false,

            pullbackShort:
                context.pullbackShort ?? false,

            pullbackEMA20Long:
                context.pullbackEMA20Long ?? false,

            pullbackEMA20Short:
                context.pullbackEMA20Short ?? false,

            pullbackEMA50Long:
                context.pullbackEMA50Long ?? false,

            pullbackEMA50Short:
                context.pullbackEMA50Short ?? false,

            structureRetestLong:
                context.structureRetestLong ?? false,

            structureRetestShort:
                context.structureRetestShort ?? false,

            bullishRejection:
                context.bullishRejection ?? false,

            bearishRejection:
                context.bearishRejection ?? false,

            bullishMicroBreak:
                context.bullishMicroBreak ?? false,

            bearishMicroBreak:
                context.bearishMicroBreak ?? false,

            bullishStrongClose:
                context.bullishStrongClose ?? false,

            bearishStrongClose:
                context.bearishStrongClose ?? false,

            bullishTrigger:
                context.bullishTrigger ?? false,

            bearishTrigger:
                context.bearishTrigger ?? false,

            slope1h:
                context.slope1h ?? null,

            slope15:
                context.slope15 ?? null,

            slope9_5:
                context.slope9_5 ?? null,

            gap1h:
                context.gap1h ?? null,

            gap15:
                context.gap15 ?? null,

            distFromEMA20:
                context.distFromEMA20 ?? null,

            maxChase:
                context.maxChase ?? null
        },

        // =====================================================
        // QUALITY
        // =====================================================

        quality:
            best.quality ?? null,

        // =====================================================
        // FLAGS
        // EXACTLY MATCH CORE RETURN
        // =====================================================

        flags: {

            longBias:
                flags.longBias ?? false,

            shortBias:
                flags.shortBias ?? false,

            pullbackLong:
                flags.pullbackLong ?? false,

            pullbackShort:
                flags.pullbackShort ?? false,

            bullishRejection:
                flags.bullishRejection ?? false,

            bearishRejection:
                flags.bearishRejection ?? false,

            bullishTrigger:
                flags.bullishTrigger ?? false,

            bearishTrigger:
                flags.bearishTrigger ?? false,

            bullishMicroBreak:
                flags.bullishMicroBreak ?? false,

            bearishMicroBreak:
                flags.bearishMicroBreak ?? false,

            bullishStrongClose:
                flags.bullishStrongClose ?? false,

            bearishStrongClose:
                flags.bearishStrongClose ?? false
        },

        // =====================================================
        // DEBUG
        // =====================================================

        debug: {

            ...debug
        },

        // =====================================================
        // EXECUTION STATE
        // =====================================================

        quantity:
            0,

        notional:
            0,

        finalRisk:
            0,

        waitingEntry:
            false,

        breakoutTriggered:
            best.setup === "BREAKOUT_RETEST",

        // =====================================================
        // TIMESTAMPS
        // =====================================================

        createdAt:
            now,

        enteredAt:
            null,

        openedAt:
            null,

        closedAt:
            null,

        updatedAt:
            now,

        result:
            "PENDING"
    }
}

// ================= SCANNER ================
async function scanner(){
    
    if(isScanning){
        console.log("⛔ Skip scan trùng")
        return
    }

    isScanning = true

     try{

        // ===== DB HEALTH =====
        if(!await ensureDB()){
            console.log("⛔ SCAN STOP: MONGODB OFFLINE")
            return
        }

        console.log("🚀 SMART SCAN...")

const btcRegime = await getBtcRegime()

console.log(`₿ BTC REGIME: ${btcRegime}`)

let now = Date.now()

        // ===== UPDATE SYMBOL =====
        if(!cachedSymbols || now - lastSymbolsUpdate > 900000){
            console.log("🔄 Updating symbols...")

            let newSymbols = await getTopSymbols()

            if(newSymbols && newSymbols.length > 0){
                cachedSymbols = newSymbols
                lastSymbolsUpdate = now
            }
        }

        // ===== SYMBOL LIST =====
        let symbols = cachedSymbols || ["BTCUSDT","ETHUSDT","BNBUSDT","SOLUSDT","XRPUSDT","ADAUSDT",
        "AVAXUSDT","LINKUSDT","DOTUSDT","MATICUSDT",
        "ATOMUSDT","NEARUSDT","FILUSDT","LTCUSDT",
        "AAVEUSDT","MKRUSDT","OPUSDT","IMXUSDT","RUNEUSDT"]

        if(symbols && symbols.length > 0){
            console.log(`✅ Using ${symbols.length} symbols`)
        }

        // ===== SCAN =====
let results = []

for(let i=0; i<symbols.length; i+=10){

    let chunk = symbols.slice(i,i+10)

    let r = await Promise.all(
        chunk.map(async s => {

            try{

                let timer

let timeoutPromise =
    new Promise(resolve => {

        timer = setTimeout(() => {

            console.log(
                `⏰ SCAN TIMEOUT: ${s}`
            )

            resolve(null)

        }, 40000)

    })

let result

try{

    result = await Promise.race([
        scan(s),
        timeoutPromise
    ])

}catch(e){

    console.error(
        `❌ SCAN RACE ERROR ${s}:`,
        e?.message || e
    )

    result = null

}finally{

    clearTimeout(timer)

}

                if(result){
                    return {
                        status:"fulfilled",
                        value:result
                    }
                }

                return {
                    status:"rejected",
                    value:null
                }

            }catch(e){

                console.log(
                    "SCAN ERROR:",
                    s,
                    e.message
                )

                return {
                    status:"rejected",
                    value:null
                }
            }
        })
    )

    results.push(...r)

    await new Promise(r =>
        setTimeout(r,300)
    )
}

let signals = results
    .filter(r =>
        r.status === "fulfilled" &&
        r.value
    )
    .map(r => r.value)

if(!signals || signals.length === 0){
    console.log("❌ No signal")
    return
}

        // ===== BUILD CANDIDATES + AI =====
let candidates = []
let dbCache = {}

for (let s of signals){

    // ===== MAIN =====
    let keyMain = `${s.setup}-${s.marketState}-${s.side}-${s.volatility}`

    if(!dbCache[keyMain]){
        dbCache[keyMain] = await getDBStats(
            s.setup,
            s.marketState,
            s.side,
            s.volatility
        )
    }

    let dbMain = dbCache[keyMain]

if(!dbMain){
    console.log(
        `⛔ DB unavailable - skip ${s.symbol}`
    )
    continue
}

let aiMain = 0

if(dbMain.total >= 30){

    const edge =
        dbMain.winrate - 0.50

    const confidence =
        Math.min(dbMain.total / 100, 1)

    aiMain =
        edge * 60 * confidence
}

// DB chỉ loại setup có lịch sử rất xấu
// ===== DB EDGE — CHỈ LOG, KHÔNG BLOCK =====

if(dbMain.total >= 30){

    const wr = dbMain.winrate

    if(wr < 0.42){

        console.log(
        `🚫 DB BAD EDGE: ${s.symbol} | ` +
        `WR=${(dbMain.winrate * 100).toFixed(1)}% | ` +
        `N=${dbMain.total}`
    )
    }
}

// CORE MỚI KHÔNG CÒN SCORE CŨ
// Không dùng s.score nữa

candidates.push({
    ...s,
    finalScore: aiMain,
    type: "MAIN"
})
}

// ================= BTC CONTEXT =================

// Chỉ lưu BTC regime.
// Không cộng/trừ score của CORE.

candidates = candidates.map(c => ({
    ...c,
    btcRegime
}))

        // ===== NO CANDIDATE =====
        if(!candidates || candidates.length === 0){
            console.log("❌ No signal")
            return
        }

        // ===== SORT =====
      candidates.sort((a,b)=>{

    if(
        a.marketState === "TREND_STRONG" &&
        b.marketState !== "TREND_STRONG"
    ) return -1

    if(
        b.marketState === "TREND_STRONG" &&
        a.marketState !== "TREND_STRONG"
    ) return 1

    return b.qualityScore - a.qualityScore
})
// ===== LỌC TẦNG 2 =====
let filtered = candidates.filter(c => {

    let rr = Math.abs(c.tp - c.price) / Math.abs(c.price - c.sl)

    // ❌ loại kèo quá xấu
    if(rr < RR_THRESHOLD){

    console.log(
        `🚫 FILTER RR: ${c.symbol} | ` +
        `RR=${safeFixed(rr, 2)} | ` +
        `required=${RR_THRESHOLD}`
    )

    return false
}

return true
})
// ===== SORT LẠI =====
filtered = filtered
.sort((a,b)=>b.qualityScore - a.qualityScore)

// ===== UNIQUE COIN =====
let unique = []
let used = new Set()

for(let c of filtered){
    if(!used.has(c.symbol)){
        unique.push(c)
        used.add(c.symbol)
    }
}

filtered = unique

if(filtered.length === 0){
    console.log("❌ No filtered signal")
    return
}
let picks = filtered//.slice(0, 3)
for (let best of picks){

    //let realActive = activeTrades.filter(
    //x =>
        //x.result === "PENDING" &&
       // !x.waitingEntry
//).length
let positions = []

try{
    positions = await getPositionsCached()
}catch(e){
    console.log("⚠ POSITION CACHE FAIL")
}

let realActive = positions.filter(p =>
    Math.abs(parseFloat(p.positionAmt || "0")) > 0
).length

    let totalPending = 0

try{
    totalPending = await trades.countDocuments({
        result:"PENDING"
    })
}catch(e){
    console.log("⚠ COUNT PENDING FAIL")
}

    if(realActive >= TRADE_CONFIG.maxActivePositions){
        console.log(`⚠️ MAX REAL ACTIVE: ${realActive}`)
        break
    }

    if(totalPending >= 50){
        console.log(`⚠️ MAX TOTAL PENDING: ${totalPending}`)
        break
    }

    // ===== BLOCK COIN =====
    let existing = await trades.findOne({
    symbol: best.symbol,
    result: "PENDING"
})

if(existing){

    // verify position thật
    let positions =
        await getPositionsCached()

    let realPos = positions.find(p =>
        p.symbol === best.symbol &&
        Math.abs(parseFloat(p.positionAmt || "0")) > 0
    )

    if(!realPos){
    console.log(
        `⏳ ${best.symbol} đã đóng — chờ checkTrades chốt TP/SL`
    )
    continue
}

console.log(`⛔ ${best.symbol} đang có lệnh`)
continue
}

    // ===== DB AI =====

let dbAI =
    await getDBStats(
        best.setup,
        best.marketState,
        best.side,
        best.volatility
    )
    if(!dbAI){
    console.log(
        `⛔ DB AI unavailable - skip ${best.symbol}`
    )
    continue
}

// ===== RR =====

let rr =
    best.side === "LONG"
        ? (best.tp - best.price) /
          (best.price - best.sl)
        : (best.price - best.tp) /
          (best.sl - best.price)

let minRR =
    best.marketState === "TREND_STRONG"
        ? 1.20
        : 1.15

if(rr < minRR){
    console.log(
        `🚫 FILTER MIN RR: ${best.symbol} | ` +
        `RR=${safeFixed(rr, 2)} | ` +
        `required=${safeFixed(minRR, 2)} | ` +
        `state=${best.marketState}`
    )
    continue
}

// ===== RISK MULTIPLIER =====

let multiplier = 1

if(dbAI.total >= 20){

    let edge =
        dbAI.winrate - 0.5

    multiplier =
        1 + edge * 2

    if(multiplier > 1.25){
        multiplier = 1.25
    }

    if(multiplier < 0.75){
        multiplier = 0.75
    }
}

let balance =
    ACCOUNT_BALANCE

let riskPercent = TRADE_CONFIG.riskPerTrade

let risk =
    balance *
    riskPercent *
    multiplier

// Không cho AI tăng risk quá mức
risk = Math.min(
    risk,
    balance * TRADE_CONFIG.maxRiskPerTrade
)
console.log(
    `🧮 RISK CALC ${best.symbol} | ` +
    `balance=${ACCOUNT_BALANCE} | ` +
    `riskPercent=${TRADE_CONFIG.riskPerTrade} | ` +
    `maxRisk=${TRADE_CONFIG.maxRiskPerTrade} | ` +
    `multiplier=${multiplier} | ` +
    `risk=${risk}`
)
if(risk <= 0){
    console.log(
        `🚫 FILTER RISK: ${best.symbol} | ` +
        `risk=${safeFixed(risk)}`
    )
    continue
}

    let diff = Math.abs(best.price - best.sl)
    if(!diff){

    console.log(
        `🚫 FILTER SL DISTANCE: ${best.symbol} | ` +
        `price=${safeFixed(best.price)} | sl=${safeFixed(best.sl)}`
    )

    continue
}



// Input: `best` is the core signal plus symbol:
// const best = { ...signal, symbol }
// Returns a DB-ready trade, or null when the signal is invalid.

const trade = buildTradeFromCoreSignal(
    best,
    btcRegime,
    risk
)

if(!trade){

    console.log(
`🚫 FILTER BUILD TRADE: ${best.symbol} | ` +
`side=${best.side} | ` +
`setup=${best.setup} | ` +
`quality=${best.qualityScore ?? 0} | ` +
`db=${safeFixed(best.finalScore, 1)}`
)

    continue
}

    // ===== RAM CHECK =====
    let isActive = activeTrades.some(x =>
        x.symbol === best.symbol && x.result === "PENDING"
    )

    if(isActive){
        continue
    }
    
// ===== BREAKOUT = MARKET ENTRY =====
{
    console.log(`⚡ INSTANT ENTRY ${best.symbol}`)

    // ===== POSITION SIZE =====
    let positionValue =
        ACCOUNT_BALANCE * TRADE_CONFIG.maxPositionPercent

    let qtyBySize =
        positionValue / best.price

    // ===== RISK BASED QTY =====
    let diff =
        Math.abs(best.price - best.sl)

    if(!diff){
        continue
    }

    let qtyByRisk =
        trade.risk / diff

    // ===== FINAL QTY =====
    let qty =
        Math.min(
            qtyBySize,
            qtyByRisk
        )

    // Hard cap 3x account
    let maxPositionValue =
        ACCOUNT_BALANCE * 3

    qty =
        Math.min(
            qty,
            maxPositionValue / best.price
        )

    if(
        !qty ||
        qty <= 0 ||
        !isFinite(qty)
    ){
        console.log("❌ QTY INVALID BEFORE SEND")
        continue
    }

    let notional =
        qty * best.price

    // ===== SYMBOL INFO =====
    let info =
        await getSymbolInfo(trade.symbol)

    if(!info || !info.filters){

    console.log(
        `🚫 SYMBOL INFO FAIL: ${best.symbol}`
    )

    continue
}

    let lotFilter =
    info.filters.find(
        f => f.filterType === "MARKET_LOT_SIZE"
    ) ||
    info.filters.find(
        f => f.filterType === "LOT_SIZE"
    )

    let minNotionalFilter =
    info.filters.find(
        f => f.filterType === "NOTIONAL"
    ) ||
    info.filters.find(
        f => f.filterType === "MIN_NOTIONAL"
    )

    let stepSize =
        parseFloat(
            lotFilter?.stepSize || 0.001
        )

    let minQty =
        parseFloat(
            lotFilter?.minQty || 0
        )

    let minNotional =
    Number(
        minNotionalFilter?.minNotional ??
        minNotionalFilter?.notional ??
        5
    )

    // ===== STEP 3: ROUND STEP =====
    qty =
        normalizeQtyFinal(
            Math.floor(qty / stepSize) * stepSize,
            stepSize
        )

    // ===== STEP 4: CHECK MIN QTY =====
    if(qty < minQty){
        console.log(
            `❌ MIN QTY FAIL ${best.symbol}`
        )
        continue
    }

    notional =
        qty * best.price

    // ===== MIN NOTIONAL =====
    if(notional < minNotional){

        let requiredQty =
            normalizeQtyFinal(
                Math.ceil(
                    (minNotional / best.price)
                    / stepSize
                ) * stepSize,
                stepSize
            )

        // Không ép qty nếu làm risk vượt quá mức cho phép
        let requiredRisk =
            requiredQty * diff

        let maxAllowedRisk =
            trade.risk * 1.10

        if(requiredRisk > maxAllowedRisk){

            console.log(
                `❌ MIN NOTIONAL EXCEEDS RISK ${best.symbol}`,
                {
                    requiredRisk,
                    maxAllowedRisk,
                    minNotional
                }
            )

            continue
        }

        qty =
            requiredQty

        notional =
            qty * best.price
    }

    // ===== FINAL RISK =====
    let finalRisk =
        qty * diff

    if(
        !isFinite(finalRisk) ||
        finalRisk <= 0
    ){
        console.log(
            `❌ FINAL RISK INVALID ${best.symbol}`
        )
        continue
    }

    if(
        finalRisk >
        trade.risk * 1.10
    ){
        console.log(
            `❌ FINAL RISK TOO HIGH ${best.symbol}`
        )
        continue
    }

    // ===== FINAL POSITION VALUE =====
    if(
        notional >
        maxPositionValue
    ){
        console.log(
            `❌ MAX POSITION VALUE ${best.symbol}`
        )
        continue
    }

    // ===== FINAL CHECK =====
    if(
        notional < minNotional ||
        !isFinite(notional) ||
        !isFinite(qty) ||
        qty <= 0
    ){
        console.log(
            "❌ FINAL NOTIONAL FAIL:",
            notional
        )
        continue
    }

    if(!qty || qty <= 0 || !isFinite(qty)){
        continue
    }

    if(!info || !info.filters){
        continue
    }

    // ===== OPENING LOCK =====
    if(OPENING_POSITIONS[trade.symbol]){
        console.log(
            `⛔ OPENING LOCK ${trade.symbol}`
        )
        continue
    }

    OPENING_POSITIONS[trade.symbol] = true

    try{

        let execution

try{

    execution =
        await openPositionWithTPSL(
            trade,
            qty
        )

}catch(e){

    console.error(
        `❌ ENTRY EXCEPTION ${trade.symbol}:`,
        e?.message || e
    )

    execution = {
        ok:false,
        error:e?.message || String(e)
    }
}

if(!execution?.ok){

    console.error(
        `❌ ENTRY FAIL ${trade.symbol}:`,
        execution?.error ||
        execution?.message ||
        "UNKNOWN"
    )

    // =====================================================
    // CRITICAL RECOVERY:
    // openPositionWithTPSL() có thể đã mở position
    // nhưng fail ở TPSL / VERIFY sau đó.
    // PHẢI kiểm tra Binance trước khi bỏ signal.
    // =====================================================

    let realPosition = null

    try{

        const positions =
            await getPositionsCached(true)

        realPosition =
            positions?.find(
                p =>
                    p.symbol === trade.symbol &&
                    Math.abs(
                        Number(p.positionAmt || 0)
                    ) > 0
            )

    }catch(e){

        console.error(
            `⚠️ POSITION RECOVERY ERROR ${trade.symbol}:`,
            e?.message || e
        )
    }

    if(realPosition){

        console.error(
            `🚨 POSITION ALREADY OPEN ${trade.symbol} — RECOVERY`
        )

        console.error(
            `SIDE=${trade.side}`,
            `QTY=${realPosition.positionAmt}`,
            `ENTRY=${realPosition.entryPrice}`
        )

        // KHÔNG continue ở đây nếu position thật đang tồn tại.
        // Phải chuyển sang recovery TPSL / DB.
    }else{

        console.log(
            `ℹ️ ${trade.symbol} confirmed no real position`
        )

        continue
    }
}

trade.waitingEntry = false

// ==================================================
// BINANCE ENTRY ĐÃ THÀNH CÔNG
// BẬT DYNAMIC TPSL NGAY LẬP TỨC
// ==================================================

TPSL_PHASE[trade.symbol] = "ACTIVE"

console.log(
    `🟢 TPSL ACTIVE ${trade.symbol} — BINANCE ENTRY CONFIRMED`
)

        trade.quantity =
            qty

        trade.notional =
            notional

        trade.finalRisk =
            finalRisk

        // ===== SAVE TRADE TO DB =====

let insertResult = null

try{

    if(!await ensureDB()){
        throw new Error(
            "MONGODB OFFLINE AFTER ENTRY"
        )
    }

    // ===== FINAL TRADE STATE =====

    trade.entry =
        Number(trade.entry)

    trade.sl =
        Number(trade.sl)

    trade.tp =
        Number(trade.tp)

    // ===== INITIAL RISK CỐ ĐỊNH =====

    trade.initialRisk =
    Number(execution.initialRisk)

if(
    !Number.isFinite(trade.initialRisk) ||
    trade.initialRisk <= 0
){
    throw new Error(
        `MISSING INITIAL RISK BEFORE DB INSERT ${trade.symbol}`
    )
}

    // ===== FILLED TIME =====

    trade.enteredAt =
        Number(
            trade.enteredAt ||
            Date.now()
        )

    trade.openedAt =
        trade.enteredAt

    trade.updatedAt =
        Date.now()

    // ===== INSERT DB =====

    insertResult =
    await trades.insertOne(trade)

if(
    !insertResult ||
    !insertResult.insertedId
){
    throw new Error(
        `DB INSERT FAILED ${trade.symbol}`
    )
}

trade._id =
    insertResult.insertedId

trade.dbSaveFailed = false
trade.dbRecoveryNeeded = false

activeTrades.push(trade)

    console.log(
        `💾 DB SAVED ${trade.symbol} ` +
        `INITIAL_RISK=${trade.initialRisk} ` +
        `ENTRY=${trade.entry} ` +
        `SL=${trade.sl} ` +
        `TP=${trade.tp}`
    )

    console.log(
        `🟢 ACTIVE TRADE ADDED ${trade.symbol}`
    )

}catch(dbErr){

    console.error(
        `🚨 DB SAVE FAIL ${trade.symbol}:`,
        dbErr?.message || dbErr
    )

    const ramTrade = {
        ...trade,
        dbSaveFailed: true,
        dbRecoveryNeeded: true
    }

    TPSL_PHASE[trade.symbol] = "ACTIVE"

    activeTrades.push(ramTrade)

    console.log(
        `🟢 ${trade.symbol} REMAINS ACTIVE FOR DYNAMIC TPSL`
    )

    continue
}
        let msg =
`🔥 BEST SIGNAL\n\n` +
`📊 ${trade.symbol}\n` +
`📈 ${trade.side}\n` +
`🎯 Entry: ${trade.entry}\n` +
`🟢 TP: ${trade.tp}\n` +
`🔴 SL: ${trade.sl}\n` +
`⚖️ RR: ${safeFixed(trade.rr, 2)}\n` +
`⭐ Quality: ${safeFixed(trade.qualityScore, 2)}\n` +
`🧠 DB Edge: ${safeFixed(best.finalScore, 1)}\n` +
`💰 Risk: ${safeFixed(trade.risk, 4)}`

        await sendTelegram(msg)

    }catch(err){

        console.error(
            `❌ ENTRY ERROR ${trade.symbol}:`,
            err?.message || err
        )

    }finally{

        delete OPENING_POSITIONS[
            trade.symbol
        ]
    }
}



    console.log(
    `✅ ADD: ${best.symbol} | DB Edge: ${safeFixed(best.finalScore, 1)}`
)
}

    }catch(e){
    console.log("❌ Scanner error:")
    console.log(e)
} finally {
    isScanning = false   // ✅ THẢ LOCK
}
}
///////////////////
const CLOSED_RESULT_FAILS = global.CLOSED_RESULT_FAILS ||= {}
async function checkTrades(){

    if(checkingTrades) return
    checkingTrades = true

    try{
        if(!await ensureDB()){
        console.log(
            "⛔ CHECK TRADES SKIP: MONGODB OFFLINE"
        )
        return
    }

        if(activeTrades.length === 0){
            return
        }

        for(let i = activeTrades.length - 1; i >= 0; i--){

            let t = activeTrades[i]
            if(t.result !== "PENDING"){
    activeTrades.splice(i,1)
    continue
}

            try{

                let data = await Promise.race([
    getData(t.symbol,"15m",2),
    new Promise(resolve =>
        setTimeout(()=>resolve(null),10000)
    )
])

                if(!data){

    DATA_FAILS[t.symbol] =
        (DATA_FAILS[t.symbol] || 0) + 1

    console.log(
        `⚠️ DATA FAIL ${t.symbol}:`,
        DATA_FAILS[t.symbol]
    )

    // chỉ close nếu fail quá nhiều
    if(DATA_FAILS[t.symbol] < 15){
        continue
    }
    console.log(`🚨 FORCE VERIFY ${t.symbol}`)

let positions

try{
    positions = await getPositionsCached()
}catch(e){
    console.error(
        `⚠ POSITION CACHE FAIL ${best.symbol}:`,
        e?.message || e
    )
    continue
}

if(!Array.isArray(positions)){
    console.error(
        `⚠ POSITION CACHE INVALID ${best.symbol}`
    )
    continue
}

let realActive = positions.filter(p =>
    Math.abs(parseFloat(p.positionAmt || "0")) > 0
).length

// không còn position
if(!realPos){

    await trades.updateOne(
        {
            symbol: t.symbol,
            createdAt: t.createdAt
        },
        {
            $set:{
                result:"AUTO_CLEAR_NO_POSITION"
            }
        }
    )
    delete DATA_FAILS[t.symbol]
    delete TPSL_PHASE[t.symbol]

    activeTrades.splice(i,1)

    continue
}

// còn position -> watchdog xử lý TPSL
continue

}else{
    DATA_FAILS[t.symbol] = 0
}

                let price = +data.at(-1)[4]

// ===== RESULT CHECK =====
if(!t.entry) continue

if(!t.enteredAt){
    t.enteredAt = Date.now()
}
// =====================================================
// 24H AUTO CLOSE
// =====================================================

let isTimeout = t.enteredAt && Date.now() - t.enteredAt > 86400000

if(isTimeout){

    console.log(`⏳ TIMEOUT CLOSE ${t.symbol}`)

    // =================================================
    // 1. CHECK POSITION THẬT
    // =================================================

    let positions = []

    try{
        POS_CACHE = null
        POS_CACHE_TIME = 0
        positions = await getPositionsCached()
    }catch(e){
        console.log(`⚠ TIMEOUT POSITION FAIL ${t.symbol}:`, e.message)
        continue
    }

    const realPos = positions.find(p =>
        p.symbol === t.symbol &&
        Math.abs(parseFloat(p.positionAmt || "0")) > 0
    )

    // =================================================
    // 2. NẾU CÒN POSITION -> ĐÓNG
    // =================================================

    if(realPos){

        const realQty = Math.abs(parseFloat(realPos.positionAmt || "0"))

        if(!Number.isFinite(realQty) || realQty <= 0){
            console.log(`❌ TIMEOUT INVALID QTY ${t.symbol}`)
            continue
        }

        const closed = await closePosition(t.symbol, t.side, realQty)

        if(!closed){
            console.log(`❌ AUTO CLOSE FAIL ${t.symbol}`)
            continue
        }

        console.log(`✅ AUTO CLOSED ${t.symbol} AFTER 24H`)
    }

    // =================================================
    // 3. CHỜ BINANCE GHI NHẬN CLOSE
    // =================================================

    await new Promise(r => setTimeout(r,1500))

    // =================================================
    // 4. LẤY CLOSED TRADE RESULT
    // =================================================

    const closed = await getClosedTradeResult(t)

    if(!closed){
        console.log(`⏳ TIMEOUT RESULT NOT READY ${t.symbol}`)
        continue
    }

    // =================================================
    // 5. TÍNH WIN / LOSS THEO PNL THỰC TẾ
    // =================================================

    const pnl = Number(closed.pnl)

    if(!Number.isFinite(pnl)){
        console.log(`❌ TIMEOUT INVALID PNL ${t.symbol}`)
        continue
    }

    const isWin = pnl > 0
    const finalResult = isWin ? "WIN" : "LOSS"

    console.log(
        `📊 24H RESULT ${t.symbol} ` +
        `${finalResult} PNL=${pnl.toFixed(4)}`
    )

    // =================================================
    // 6. UPDATE DB
    // =================================================

    const dbResult = await trades.updateOne(
        {
            symbol: t.symbol,
            result: "PENDING"
        },
        {
            $set:{
                result: finalResult,
                pnl: pnl,
                exitOrderId: closed.exitOrderId,
                closedAt: closed.closedAt,
                timeoutClosed: true,
                timeoutHours: 24,
                updatedAt: Date.now()
            }
        }
    )

    if(dbResult.matchedCount === 0){
        console.log(`⚠️ TIMEOUT DB NOT FOUND ${t.symbol}`)
        continue
    }

    // =================================================
    // 7. UPDATE BALANCE
    // =================================================

    const latestBalance = await updateBalance()

    if(Number.isFinite(latestBalance) && latestBalance > 0){
        ACCOUNT_BALANCE = latestBalance
    }

    // =================================================
    // 8. TELEGRAM
    // =================================================

    await sendTelegram2(
`⏳ AUTO CLOSE 24H
${t.symbol}
${t.side} | ₿ : ${t.btcRegime}
${isWin ? "✅ WIN" : "❌ LOSS"}
PnL: ${pnl.toFixed(4)} USDT
💰 Balance: ${ACCOUNT_BALANCE.toFixed(2)} USDT`
    )

    // =================================================
    // 9. CLEAN
    // =================================================

    delete DATA_FAILS[t.symbol]
    delete CLOSED_RESULT_FAILS[t.symbol]
    delete TPSL_PHASE[t.symbol]

    activeTrades.splice(i,1)

    continue
}
// ===== VERIFY POSITION =====

let stillOpen = null
let verifyOK = false

for(let retry = 0; retry < 5; retry++){

    try{

        POS_CACHE = null
        POS_CACHE_TIME = 0

        let positions =
            await getPositionsCached()

        if(!Array.isArray(positions)){
            throw new Error("POSITION RESPONSE INVALID")
        }

        verifyOK = true

        stillOpen = positions.find(p =>
            p.symbol === t.symbol &&
            Math.abs(
                parseFloat(p.positionAmt || "0")
            ) > 0
        )

        if(stillOpen){
            break
        }

        console.log(
            `⚠️ VERIFY POSITION ${t.symbol} ${retry + 1}/5`
        )

    }catch(e){

        console.log(
            `❌ VERIFY API FAIL ${t.symbol} ${retry + 1}/5:`,
            e?.message || e
        )

        verifyOK = false
    }

    await new Promise(r =>
        setTimeout(r, 2000)
    )
}

// ===== API VERIFY FAILED =====
if(!verifyOK){

    console.log(
        `⛔ VERIFY ABORT ${t.symbol} — API unavailable`
    )

    continue
}

if(!stillOpen){

    const closed = await getClosedTradeResult(t)

    // ===== ĐÃ TÌM THẤY RESULT =====
    if(closed){

        delete CLOSED_RESULT_FAILS[t.symbol]
        delete TPSL_PHASE[t.symbol]

        const isWin = closed.pnl > 0

        let updateQuery

if(t._id){

    updateQuery = {
        _id: t._id
    }

}else{

    // Trade Binance đã mở nhưng MongoDB
    // save thất bại → tìm lại bằng symbol + createdAt
    updateQuery = {
        symbol: t.symbol,
        createdAt: t.createdAt,
        result: "PENDING"
    }
}

await trades.updateOne(
    updateQuery,
    {
        $set:{
            result:isWin ? "WIN" : "LOSS",
            pnl:closed.pnl,
            exitOrderId:closed.exitOrderId,
            closedAt:closed.closedAt
        }
    }
)

        const latestBalance = await updateBalance()

        if(latestBalance > 0){
            ACCOUNT_BALANCE = latestBalance
        }

        const tele2Ok = await sendTelegram2(
            `📊 ${t.symbol} 
${t.side} | ${isWin ? "✅ WIN" : "❌ LOSS"}
PnL: ${closed.pnl.toFixed(4)}
💰: ${ACCOUNT_BALANCE.toFixed(2)} USDT`
        )

        if(!tele2Ok){
            console.log(
                `❌ TELEGRAM 2 REPORT FAIL: ${t.symbol}`
            )
        }

        delete DATA_FAILS[t.symbol]
        delete TPSL_PHASE[t.symbol]
        activeTrades.splice(i,1)

        continue
    }

    // ===== KHÔNG CÓ RESULT =====

    CLOSED_RESULT_FAILS[t.symbol] =
        (CLOSED_RESULT_FAILS[t.symbol] || 0) + 1

    console.log(
        `⏳ CLOSED RESULT NOT FOUND ${t.symbol} ` +
        `${CLOSED_RESULT_FAILS[t.symbol]}/3`
    )

    // Cho Binance/API thêm thời gian
    if(CLOSED_RESULT_FAILS[t.symbol] < 3){
        continue
    }

    // ===== ORPHAN =====

    console.log(
        `🧹 CLEAR ORPHAN TRADE ${t.symbol}`
    )

    await trades.updateOne(
        { _id:t._id },
        {
            $set:{
                result:"CLOSED_UNRESOLVED",
                closedAt:Date.now(),
                debugReason:
                    "NO_POSITION_AFTER_VERIFY_AND_NO_CLOSED_RESULT"
            }
        }
    )

    delete CLOSED_RESULT_FAILS[t.symbol]
    delete DATA_FAILS[t.symbol]
    delete TPSL_PHASE[t.symbol]

    activeTrades.splice(i,1)

    continue
}
            }catch(e){
                console.log(`❌ checkTrades ${t.symbol}:`, e.message)
            }
        }

    }catch(e){
        console.log("❌ checkTrades global:", e.message)
    }finally{
        checkingTrades = false
    }
}

async function closePosition(symbol, side, qty){

    try{

        // ==================================================
        // 1. LẤY POSITION THẬT TỪ BINANCE
        // ==================================================

        POS_CACHE = null
        POS_CACHE_TIME = 0

        let positions =
            await getPositionsCached()

        let pos =
            positions.find(p =>
                p?.symbol === symbol &&
                Math.abs(
                    Number(p.positionAmt || 0)
                ) > 0
            )

        if(!pos){
            return true
        }

        // ==================================================
        // 2. LUÔN DÙNG QTY THỰC TẾ CỦA BINANCE
        //    KHÔNG DÙNG QTY CŨ TRUYỀN VÀO
        // ==================================================

        const realQty =
            Math.abs(
                Number(pos.positionAmt || 0)
            )

        if(
            !Number.isFinite(realQty) ||
            realQty <= 0
        ){
            return true
        }

        const realSide =
            Number(pos.positionAmt) > 0
                ? "LONG"
                : "SHORT"

        const closeSide =
            realSide === "LONG"
                ? "SELL"
                : "BUY"

        console.log(
            `🔴 FORCE CLOSE ${symbol} ` +
            `SIDE=${realSide} ` +
            `QTY=${realQty}`
        )

        // ==================================================
        // 3. MARKET REDUCE ONLY
        // ==================================================

        await binance.futuresOrder({

            symbol,

            recvWindow: 20000,

            side: closeSide,

            type: "MARKET",

            quantity: realQty,

            reduceOnly: true
        })

        // ==================================================
        // 4. XÓA CACHE NGAY SAU KHI CLOSE
        // ==================================================

        POS_CACHE = null
        POS_CACHE_TIME = 0

        // ==================================================
        // 5. VERIFY POSITION THẬT
        //    MỖI VÒNG ĐỀU ÉP REFRESH BINANCE
        // ==================================================

        for(let i = 0; i < 30; i++){

            await new Promise(r =>
                setTimeout(r, 2000)
            )

            POS_CACHE = null
            POS_CACHE_TIME = 0

            let freshPositions

            try{

                freshPositions =
                    await getPositionsCached()

            }catch(e){

                console.log(
                    `⚠️ CLOSE VERIFY ${symbol}:`,
                    e?.message || e
                )

                continue
            }

            const stillOpen =
                freshPositions.some(p =>
                    p?.symbol === symbol &&
                    Math.abs(
                        Number(p.positionAmt || 0)
                    ) > 0
                )

            if(!stillOpen){

                console.log(
                    `✅ FORCE CLOSED ${symbol}`
                )

                return true
            }

        }

        console.log(
            `❌ FORCE CLOSE VERIFY FAILED ${symbol}`
        )

        return false

    }catch(e){

        await checkTimeError(e)

        console.log(
            `❌ FORCE CLOSE ${symbol}:`,
            e?.message || e
        )

        return false
    }
}
async function recoverOrphanPositions(){

    try{

        let positions = []

        try{
            POS_CACHE = null
            POS_CACHE_TIME = 0

            positions = await getPositionsCached()

        }catch(e){

            console.log(
                "❌ ORPHAN RECOVERY POSITION FAIL:",
                e?.message || e
            )

            return
        }

        if(!Array.isArray(positions)){
            return
        }

        for(const pos of positions){

            const symbol = pos?.symbol
            const positionAmt =
                parseFloat(pos?.positionAmt || "0")

            if(
                !symbol ||
                !Number.isFinite(positionAmt) ||
                Math.abs(positionAmt) <= 0
            ){
                continue
            }

            // ==============================
            // CHECK MONGODB PENDING
            // ==============================

            let dbTrade = null

            try{

                dbTrade =
                    await trades.findOne({
                        symbol,
                        result:"PENDING"
                    })

            }catch(e){

                console.log(
                    `❌ ORPHAN DB CHECK FAIL ${symbol}:`,
                    e?.message || e
                )

                continue
            }

            // ==========================================
            // DB ĐÃ CÓ PENDING
            // ==========================================

            if(dbTrade){

    const recoveredInitialRisk =
        Number(dbTrade.initialRisk)

    if(
        !Number.isFinite(recoveredInitialRisk) ||
        recoveredInitialRisk <= 0
    ){
        console.log(
            `⚠️ RECOVERY SKIP — MISSING INITIAL RISK ${symbol}`
        )

        continue
    }

    const exists =
        activeTrades.some(
            t =>
                t?.symbol === symbol &&
                t.result === "PENDING"
        )

    if(!exists){

        activeTrades.push(
            dbTrade
        )
    }

    TPSL_PHASE[symbol] =
        "ACTIVE"

    console.log(
        `♻️ RECOVER DB TRADE ${symbol} → TPSL ACTIVE`
    )

    continue
}

            // ==========================================
            // BINANCE CÓ POSITION
            // MONGO KHÔNG CÓ PENDING
            // ==========================================

            console.log(
                `🚨 ORPHAN BINANCE POSITION ${symbol}`
            )

            const side =
                positionAmt > 0
                    ? "LONG"
                    : "SHORT"

            const entry =
                Number(pos.entryPrice || 0)

            if(
                !entry ||
                !Number.isFinite(entry)
            ){

                console.log(
                    `❌ ORPHAN ${symbol} INVALID ENTRY`
                )

                continue
            }

            // ==========================================
            // LẤY MARK PRICE
            // ==========================================

            let markPrice =
                Number(pos.markPrice || 0)

            if(
                !markPrice ||
                !Number.isFinite(markPrice)
            ){

                try{

                    const ticker =
                        await binance.futuresMarkPrice({
                            symbol
                        })

                    markPrice =
                        Number(
                            ticker?.markPrice || entry
                        )

                }catch(e){

                    markPrice = entry
                }
            }

            // ==========================================
            // ORPHAN TRADE
            // ==========================================

            const orphanTrade = {

                symbol,

                side,

                entry,

                tp: null,
                sl: null,

                risk: 0,
                rr: 0,

                score: 0,
                finalScore: 0,

                setup: "ORPHAN_RECOVERY",
                marketState: "RECOVERY",
                volatility: "UNKNOWN",
                btcRegime: "UNKNOWN",

                quantity:
                    Math.abs(positionAmt),

                notional:
                    Math.abs(positionAmt) * entry,

                waitingEntry: false,

                breakoutTriggered: false,

                createdAt:
                    Date.now(),

                enteredAt:
                    Date.now(),

                openedAt:
                    Date.now(),

                closedAt: null,

                result:"PENDING",

                dbSaveFailed:true,
                dbRecoveryNeeded:true,

                recoveredFromBinance:true,

                recoveredAt:
                    Date.now(),

                markPrice
            }

// ==========================================
// CHỐNG DUPLICATE THEO SYMBOL
// ==========================================

const existingIndex =
    activeTrades.findIndex(
        t =>
            t?.symbol === symbol &&
            t.result === "PENDING"
    )

if(existingIndex !== -1){

    // Đã có trade trong RAM.
    // Không tạo thêm trade thứ 2.

    TPSL_PHASE[symbol] =
        "ACTIVE"

    console.log(
        `♻️ ORPHAN ${symbol} ALREADY ACTIVE → SKIP DUPLICATE`
    )

    continue
}

// ==========================================
// RAM ACTIVE
// ==========================================

activeTrades.push(
    orphanTrade
)

// ==========================================
// DYNAMIC TPSL BẬT
// ==========================================

TPSL_PHASE[symbol] =
    "ACTIVE"

console.log(
    `🟢 ORPHAN RECOVERED ${symbol} ` +
    `SIDE=${side} ` +
    `ENTRY=${entry} ` +
    `QTY=${Math.abs(positionAmt)}`
)


            // ==========================================
            // THỬ LƯU LẠI VÀO MONGO
            // ==========================================

            try{

                const insertResult =
                    await trades.insertOne(
                        orphanTrade
                    )

                orphanTrade._id =
                    insertResult.insertedId

                orphanTrade.dbSaveFailed =
                    false

                orphanTrade.dbRecoveryNeeded =
                    false

                console.log(
                    `💾 ORPHAN RECOVERY SAVED ${symbol}`
                )

            }catch(dbErr){

                console.log(
                    `⚠️ ORPHAN DB SAVE STILL FAIL ${symbol}:`,
                    dbErr?.message || dbErr
                )

                // KHÔNG xoá RAM
                // KHÔNG tắt TPSL
                // Dynamic vẫn phải chạy
            }
        }

    }catch(e){

        console.log(
            "❌ ORPHAN RECOVERY ERROR:",
            e?.message || e
        )
    }
}
//////////////
async function start(){
    try{
        // ==================================================
        // 1. CHECK CONFIG
        // ==================================================
        if(!process.env.MONGO_URI){
            throw new Error("❌ Thiếu MONGO_URI")
        }
        console.log("🚀 START BOT...")
        // ==================================================
// 2. CONNECT + VERIFY MONGODB
//    RETRY UNTIL MONGODB IS AVAILABLE
// ==================================================
let dbOK = false
while(!dbOK){
    try{
        console.log("🔌 Connecting MongoDB...")
        // Nếu connection cũ đang lỗi thì đóng nó
        try{
            await client.close()
        }catch(e){}
        await client.connect()
        await client.db("admin").command({
            ping: 1
        })
        db = client.db("trading")
        trades = db.collection("trades")
        // TEST DB THỰC SỰ ĐỌC ĐƯỢC
        await trades.findOne(
            {},
            {
                projection: {
                    _id: 1
                }
            }
        )
        dbOK = true
        console.log(
            "🟢 MongoDB CONNECTED + VERIFIED"
        )
    }catch(e){
        dbOK = false
        console.error(
            "🔴 MongoDB CONNECTION FAILED:",
            e.message
        )
        console.log(
            "⏳ MongoDB unavailable — retry in 10 seconds..."
        )
        await new Promise(r =>
            setTimeout(r,10000)
        )
    }
}
// ==================================================
// 3. MONGODB READY
// ==================================================
console.log(
    "🟢 MongoDB READY — BOT CONTINUES"
)
        // =================================================
        // 4. SYNC BINANCE TIME
        // ==================================================
        await syncTime()
        while(!TIME_SYNCED){
            console.log(
                "⏳ Waiting time sync..."
            )
            await new Promise(r =>
                setTimeout(r, 1000)
            )
        }
        setInterval(
            syncTime,
            60000
        )
        // ==================================================
        // 5. LOAD BALANCE
        // ==================================================
        let newBalance =
            await updateBalance()
        if(newBalance > 0){
            ACCOUNT_BALANCE =
                newBalance
        }
        console.log(
            "💰 BALANCE:",
            ACCOUNT_BALANCE
        )
        setInterval(
            updateBalance,
            60000
        )
        // ==================================================
        // 6. RESET TELEGRAM UPDATE STATE
        // ==================================================
        await safeFetch(
            `https://api.telegram.org/bot${BOT_TOKEN}/getUpdates?offset=-1`
        )
        await safeFetch(
            `https://api.telegram.org/bot${BOT_TOKEN_2}/getUpdates?offset=-1`
        )
        // ==================================================
        // 7. CLEAR DEAD OPENING LOCK
        // ==================================================
        await trades.updateMany(
            {
                opening: true
            },
            {
                $unset: {
                    opening: ""
                }
            }
        )
        console.log(
            "✅ DEAD LOCK CLEARED"
        )
        // ==================================================
        // 8. EXPIRE PENDING QUÁ 24H
        // ==================================================
        await trades.updateMany(
            {
                result: "PENDING",
                createdAt: {
                    $lt:
                        Date.now() -
                        24 * 60 * 60 * 1000
                }
            },
            {
                $set: {
                    result: "EXPIRED"
                }
            }
        )
        // ==================================================
// 9. LOAD PENDING TRADES TỪ DB
// ==================================================

activeTrades =
    await trades.find({
        result: "PENDING"
    }).toArray()

// ===== RESTORE TPSL PHASE =====

for(const trade of activeTrades){

    if(
        !trade?.symbol ||
        trade.result !== "PENDING"
    ){
        continue
    }

    TPSL_PHASE[trade.symbol] =
        "ACTIVE"
}

console.log(
    `♻️ Load lại ${activeTrades.length} lệnh`
)

// ==================================================
// 9.1 RECOVER BINANCE ORPHAN POSITIONS
// ==================================================

await recoverOrphanPositions()
setInterval(
    recoverOrphanPositions,
    60000
)

console.log(
    `♻️ AFTER ORPHAN RECOVERY: ${activeTrades.length} ACTIVE`
)

// ==================================================
// 9.2 START DYNAMIC TPSL
// ==================================================

console.log(
    "🟢 DYNAMIC TPSL LOOP STARTED"
)

setInterval(
    runDynamicTPSL,
    10000
)
        // ==================================================
        // 10. LOAD BINANCE SYMBOLS
        // ==================================================
        await loadValidFuturesSymbols()
        console.log(
            "🟢 FUTURES SYMBOLS READY"
        )
        // ==================================================
        // 11. CHECK TRADE LOOP
        // ==================================================
        let TELEGRAM_RUNNING = false
        async function commandLoop(){
            if(TELEGRAM_RUNNING){
                return
            }
            TELEGRAM_RUNNING = true
            console.log(
                "🟢 CHECK/COMMAND LOOP STARTED"
            )
            while(true){
                try{
                    // Telegram command
                    await checkCommand()
                    // TP / SL / position watchdog
                    await checkTrades()
                }catch(e){
                    console.error(
                        "❌ CMD LOOP:",
                        e.message
                    )
                    await new Promise(r =>
                        setTimeout(r, 5000)
                    )
                }
                await new Promise(r =>
                    setTimeout(r, 2000)
                )
            }
        }
        // ==================================================
        // 12. SCANNER LOOP
        // ==================================================
        async function scanLoop(){

    console.log(
        "🟢 SCANNER LOOP STARTED"
    )

    while(true){

        if(isScanning){

            console.log(
                "⛔ Scanner already running"
            )

            await new Promise(r =>
                setTimeout(r,5000)
            )

            continue
        }

        try{

            await scanner()

        }catch(e){

            console.error(
                "❌ SCANNER LOOP:",
                e.message
            )

        }

        // scan mỗi 2 phút
        await new Promise(r =>
            setTimeout(r,120000)
        )
    }
}
        // ==================================================
        // 13. START CHECK LOOP TRƯỚC
        // ==================================================
        commandLoop()
        // ==================================================
        // 14. SAU ĐÓ MỚI START SCANNER
        // ==================================================
        await scanLoop()
    }catch(e){

        console.error(
            "❌ START ERROR:",
            e.message
        )
        // khởi động lại bot nếu start lỗi
        process.exit(1)
    }
}
async function getDBStats(setup, market, side, volatility){

    if(!trades){
        return { winrate: 0.5, total: 0 }
    }

    try{
        const col = trades

        // ===== lấy dữ liệu db =====
        let totalDB = await col.countDocuments({
            result: { $ne: "PENDING" }
        })

        let minSample = Math.min(Math.max(10, Math.floor(totalDB * 0.1)), 50)

        // ===== QUERY CHÍNH =====
        let data = await col.find({
    setup,
    marketState: market,
    side,
    result: { $in:["WIN","LOSS"] }
}).toArray()

        // ===== FILTER VOL =====
        let filtered = data.filter(t => !t.volatility || t.volatility === volatility)

        // ===== ƯU TIÊN VOL =====
        if(filtered.length >= minSample){
    data = filtered
}
        if(data.length < minSample){

    data = await col.find({
        setup,
        side,
        result: { $in:["WIN","LOSS"] }
    }).toArray()
}

        // ===== FALLBACK 2 =====
        if(data.length < minSample){
            data = await col.find({
                side,
                result: { $in:["WIN","LOSS"] }
            }).toArray()
        }

        // ===== FINAL =====
        if(data.length === 0){
            return { winrate: 0.5, total: 0 }
        }

        // ===== TIME DECAY AI =====
        let winScore = 0
        let lossScore = 0

        for(let t of data){

            let ageHours = t.createdAt
                ? (Date.now() - t.createdAt) / 3600000
                : 999

            // 🔥 decay 48h
            let weight = Math.exp(-ageHours / 48)

            if(t.result === "WIN"){
                winScore += weight
            }
            else if(t.result === "LOSS"){
                lossScore += weight
            }
        }

        // ===== TRÁNH CHIA 0 =====
        let rawWR = (winScore + lossScore) > 0
            ? winScore / (winScore + lossScore)
            : 0.5

        // ===== CONFIDENCE =====
        let confidence = Math.min(data.length / 40, 1)

        let finalWR = 0.5 + (rawWR - 0.5) * confidence

        if(DEBUG_AI){
            console.log(
                `🤖 AI ${setup}-${market}-${side}-${volatility} | WR:${finalWR.toFixed(2)} | N:${data.length}`
            )
        }   

        if(DEBUG_AI){ 
            console.log("📊 DB used:", data.length)
        }

        return {
            winrate: finalWR,
            total: data.length
        }

    }catch(e){

    DB_READY = false

    console.log(
        "❌ DB ERROR:",
        e?.message || e
    )

    return null
}
}
            
start()

async function syncActiveTrades(){

    try{

        if(!await ensureDB()){

            console.log(
                "⛔ SYNC ACTIVE SKIP: DB OFFLINE"
            )

            return
        }

        // ==================================================
        // 1. LẤY DB PENDING
        // ==================================================

        const dbTrades =
            await trades.find({
                result: "PENDING"
            }).toArray()

        // ==================================================
        // 2. LẤY POSITION THẬT TỪ BINANCE
        // ==================================================

        POS_CACHE = null
        POS_CACHE_TIME = 0

        let positions

        try{

            positions =
                await getPositionsCached()

        }catch(e){

            console.log(
                "❌ SYNC BINANCE POSITIONS FAIL:",
                e?.message || e
            )

            // Binance không xác nhận được
            // thì TUYỆT ĐỐI KHÔNG xoá activeTrades
            return
        }

        const positionMap =
            new Map()

        for(const pos of positions){

            const symbol =
                pos?.symbol

            const amount =
                Number(pos?.positionAmt || 0)

            if(
                symbol &&
                Number.isFinite(amount) &&
                Math.abs(amount) > 0
            ){

                positionMap.set(
                    symbol,
                    pos
                )
            }
        }

        // ==================================================
        // 3. CHỈ GIỮ DB TRADE CÓ POSITION THẬT
        // ==================================================

        const merged =
            new Map()

        for(const trade of dbTrades){

            if(
                !trade?.symbol ||
                trade.result !== "PENDING"
            ){
                continue
            }

            if(
                positionMap.has(
                    trade.symbol
                )
            ){

                merged.set(
                    trade.symbol,
                    trade
                )
            }

        }

        // ==================================================
        // 4. GIỮ ORPHAN RAM CHƯA SAVE ĐƯỢC
        // ==================================================

        for(const trade of activeTrades){

            if(
                !trade?.symbol ||
                trade.result !== "PENDING"
            ){
                continue
            }

            if(
                trade.dbSaveFailed === true &&
                trade.dbRecoveryNeeded === true &&
                positionMap.has(trade.symbol) &&
                !merged.has(trade.symbol)
            ){

                merged.set(
                    trade.symbol,
                    trade
                )
            }
        }

        // ==================================================
        // 5. REBUILD ACTIVE TRADES THEO SYMBOL
        // ==================================================

        activeTrades =
            [...merged.values()]

        // ==================================================
        // 6. REBUILD TPSL PHASE
        // ==================================================

        const activeSymbols =
            new Set()

        for(const trade of activeTrades){

            if(
                trade?.symbol &&
                trade.result === "PENDING"
            ){

                activeSymbols.add(
                    trade.symbol
                )

                TPSL_PHASE[trade.symbol] =
                    "ACTIVE"
            }
        }

        // ==================================================
        // 7. XÓA PHASE KHÔNG CÒN POSITION
        // ==================================================

        for(
            const symbol
            of Object.keys(TPSL_PHASE)
        ){

            if(
                !activeSymbols.has(symbol)
            ){

                delete TPSL_PHASE[symbol]

            }
        }

        console.log(
            `♻️ SYNC ACTIVE: ${activeTrades.length}`
        )

    }catch(e){

        DB_READY = false

        console.log(
            "❌ SYNC ACTIVE ERROR:",
            e?.message || e
        )
    }
}

let DYNAMIC_TPSL_RUNNING = false
const ENABLE_DYNAMIC_TPSL= true
async function runDynamicTPSL(){
    if(!ENABLE_DYNAMIC_TPSL)return

    if(DYNAMIC_TPSL_RUNNING){
        return
    }

    DYNAMIC_TPSL_RUNNING = true

    try{

        if(
            !Array.isArray(activeTrades) ||
            activeTrades.length === 0
        ){
            return
        }

        // ==================================================
        // LẤY POSITION THẬT 1 LẦN / DYNAMIC CYCLE
        // ==================================================

        POS_CACHE = null
        POS_CACHE_TIME = 0

        let positions

        try{

            positions =
                await getPositionsCached()

        }catch(e){

            console.log(
                "❌ DYNAMIC POSITION CHECK:",
                e?.message || e
            )

            return
        }

        const positionMap =
            new Map()

        for(const pos of positions){

            const amount =
                Number(
                    pos?.positionAmt || 0
                )

            if(
                pos?.symbol &&
                Number.isFinite(amount) &&
                Math.abs(amount) > 0
            ){

                positionMap.set(
                    pos.symbol,
                    pos
                )
            }
        }

        // ==================================================
        // CHỈ DYNAMIC CHO POSITION THẬT
        // ==================================================

        for(const trade of [...activeTrades]){

            if(
                !trade ||
                !trade.symbol ||
                trade.result !== "PENDING"
            ){
                continue
            }

            const symbol =
                trade.symbol

            if(
                TPSL_PHASE[symbol] !== "ACTIVE"
            ){
                continue
            }

            if(
                TPSL_PENDING[symbol]
            ){
                continue
            }

            // ==============================================
            // BINANCE KHÔNG CÒN POSITION
            // ==============================================

            if(
                !positionMap.has(symbol)
            ){

                console.log(
                    `⛔ DYNAMIC SKIP ${symbol} → NO BINANCE POSITION`
                )

                delete TPSL_PHASE[symbol]

                continue
            }

            // ==============================================
            // DYNAMIC
            // ==============================================

            try{

                await manageDynamicTPSL(
                    trade
                )

            }catch(e){

                console.log(
                    `❌ RUN DYNAMIC ${symbol}:`,
                    e?.message || e
                )
            }
        }

    }catch(e){

        console.log(
            `❌ DYNAMIC LOOP ERROR:`,
            e?.message || e
        )

    }finally{

        DYNAMIC_TPSL_RUNNING = false
    }
}
setInterval(syncActiveTrades, 3600000)
function cleanup(){
    try{
        if(fs.existsSync(PID_FILE)){
            fs.unlinkSync(PID_FILE)
        }
    }catch(e){}
}
if (BACKTEST_ENABLED) {
    BACKTEST_60D({
        days: 60,
        startingBalance: 20,
        riskPercent: 0.01,
        symbols: [
    'BTCUSDT',
    'ETHUSDT',
    'BNBUSDT',
    'SOLUSDT',
    'XRPUSDT',
    'DOGEUSDT',
    'ADAUSDT',
    'AVAXUSDT',
    'LINKUSDT',
    'SUIUSDT'
]
    }).catch(err => {
        console.error('[BACKTEST FATAL]', err)
    })
}

process.on("exit", cleanup)
process.on("SIGINT", () => { cleanup(); process.exit() })
process.on("SIGTERM", () => { cleanup(); process.exit() })
