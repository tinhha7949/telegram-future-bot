let DB_READY = false
const OPEN_POSITION_LOCK = {}
const TPSL_LOCK = {}
const TPSL_PHASE = {}
let DB_RECONNECTING = false
let DB_LAST_ERROR = 0
let TIME_SYNCED = false
const TPSL_PENDING = {}
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
        let timeout

        try{
           let isTelegramGetUpdates = url.includes("api.telegram.org") && url.includes("getUpdates")

let controller = new AbortController()

let signal = options.signal || controller.signal

if(!options.signal){
    timeout = setTimeout(() => {
        controller.abort()
    }, 10000)
}

            let res = await fetch(url, {
                ...options,
                signal,
                ...(url.includes("telegram.org") ? {} : { agent })
            })

            if(timeout) clearTimeout(timeout)

            if(res && res.ok){
    if(timeout) clearTimeout(timeout)
    return res
}

            if(res && (res.status === 429 || res.status === 418)){
                await new Promise(r => setTimeout(r, 3000))
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
    e.message &&
    (
        e.message.includes("recvWindow") ||
        e.message.includes("Timestamp")
    )
){
    await syncTime()
}
            if(timeout) clearTimeout(timeout)

            if(!url.includes("telegram.org")){
                console.log(`❌ FETCH FAIL: ${url}`)
            }

            await new Promise(r => setTimeout(r, 1500))
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

const RISK_PER_TRADE = 0.1  // 0.1 = 10% // 0.01 = 1% 
const POSITION_SIZE_PERCENT = 0.15 // 0.05 5% vốn // 0.1 =10%
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
async function sendTelegram(msg){
    try{
        let url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`
        let res = await safeFetch(url,{
            method:"POST",
            headers:{"Content-Type":"application/json"},
            body: JSON.stringify({ chat_id: CHAT_ID, text: msg })
        })

       if(!res) return false

let data = await res.json()
        return data.ok   // 👈 QUAN TRỌNG

    }catch(e){
        console.log("❌ TELE:", e.message)
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

if(side !== positionSide){
    console.log(
        `🚨 DYNAMIC SIDE MISMATCH ${symbol} ` +
        `TRADE=${side} POSITION=${positionSide}`
    )
    return false
}

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

        if(positionSide === "LONG"){

            // SL phải nằm phía dưới
            sl =
                Math.floor(
                    rawSL / tickSize
                ) * tickSize

            // TP phải nằm phía trên
            tp =
                Math.ceil(
                    rawTP / tickSize
                ) * tickSize

        }else{

            // SHORT:
            // SL phải nằm phía trên
            sl =
                Math.ceil(
                    rawSL / tickSize
                ) * tickSize

            // TP phải nằm phía dưới
            tp =
                Math.floor(
                    rawTP / tickSize
                ) * tickSize
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
                tp <= currentPrice ||
                sl >= entry ||
                tp <= entry
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
                tp >= currentPrice ||
                sl <= entry ||
                tp >= entry
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
                await binance.futuresOrder({

                    symbol,
                    side: closeSide,
                    type: "STOP_MARKET",
                    stopPrice: sl,
                    closePosition: true,
                    workingType: "MARK_PRICE",
                    recvWindow: 60000
                })

        }catch(e){

            await checkTimeError(e)

            console.log(
                `❌ DYNAMIC SL SET FAIL ${symbol}:`,
                e.message
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
                await binance.futuresOrder({

                    symbol,
                    side: closeSide,
                    type: "TAKE_PROFIT_MARKET",
                    stopPrice: tp,
                    closePosition: true,
                    workingType: "MARK_PRICE",
                    recvWindow: 60000
                })

        }catch(e){

            await checkTimeError(e)

            console.log(
                `❌ DYNAMIC TP SET FAIL ${symbol}:`,
                e.message
            )

            /*
             * TP fail.
             *
             * Không được để SL mới tồn tại
             * mà caller tưởng rằng cả TPSL active.
             */

            try{
                await cancelAllOrders(symbol)
            }catch(_){}

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
        `❌ DYNAMIC TP INVALID RESPONSE ${symbol}:`,
        JSON.stringify(tpRes)
    )

    try{
        await cancelAllOrders(symbol)
    }catch(_){}

    return false
}

const tpOrderId =
    tpRes.algoId ||
    tpRes.orderId

        console.log(
            `🎯 DYNAMIC TP SET ${symbol}: ${tp}`
        )

        // =================================================
        // 11. VERIFY BOTH
        // =================================================

        const verified =
            await verifyDynamicTPSL(
                symbol,
                positionSide,
                sl,
                tp
            )

        if(!verified){

            console.log(
                `❌ DYNAMIC TPSL VERIFY FAIL ${symbol}`
            )

            try{
                await cancelAllOrders(symbol)
            }catch(_){}

            return false
        }

        // =================================================
        // 12. FINAL POSITION VERIFY
        // =================================================

        POS_CACHE = null
        POS_CACHE_TIME = 0

        const finalPos =
    await hasPosition(symbol)

if(!finalPos){

    console.log(
        `⚠️ POSITION CLOSED DURING DYNAMIC ${symbol}`
    )

    try{
        await cancelAllOrders(symbol)
    }catch(e){
        console.log(
            `⚠️ CLEANUP TPSL AFTER POSITION CLOSED FAIL ${symbol}:`,
            e.message
        )
    }

    return false
}

        // =================================================
        // 13. SUCCESS
        // =================================================

        console.log(
            `✅ DYNAMIC TPSL VERIFIED ${symbol} ` +
            `SL=${sl} TP=${tp}`
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
async function verifyDynamicTPSL(
    symbol,
    side,
    sl,
    tp
){

    const expectedSide =
        side === "LONG"
            ? "SELL"
            : "BUY"

    const targetSL =
        Number(sl)

    const targetTP =
        Number(tp)

    if(
        !Number.isFinite(targetSL) ||
        !Number.isFinite(targetTP)
    ){
        return false
    }

    for(
        let attempt = 1;
        attempt <= 6;
        attempt++
    ){

        try{

            const orders =
                await binance.futuresOpenOrders({

                    symbol,
                    recvWindow: 60000
                })

            if(!Array.isArray(orders)){
                throw new Error(
                    "OPEN ORDERS RESPONSE INVALID"
                )
            }

            const slOrders =
                orders.filter(o =>
                    (
                        o.type === "STOP_MARKET" ||
                        o.type === "STOP"
                    ) &&
                    o.side === expectedSide
                )

            const tpOrders =
                orders.filter(o =>
                    (
                        o.type === "TAKE_PROFIT_MARKET" ||
                        o.type === "TAKE_PROFIT"
                    ) &&
                    o.side === expectedSide
                )

            const tolerance =
                Math.max(
                    Math.abs(targetSL) * 0.000002,
                    Math.abs(targetTP) * 0.000002,
                    0.00000001
                )

            const hasSL =
                slOrders.some(o =>
                    Math.abs(
                        Number(o.stopPrice) -
                        targetSL
                    ) <= tolerance
                )

            const hasTP =
                tpOrders.some(o =>
                    Math.abs(
                        Number(o.stopPrice) -
                        targetTP
                    ) <= tolerance
                )

            console.log(
                `🔎 DYNAMIC VERIFY ${symbol} ` +
                `ATTEMPT=${attempt} ` +
                `SL=${hasSL} TP=${hasTP}`
            )

            if(hasSL && hasTP){
                return true
            }

        }catch(e){

            await checkTimeError(e)

            console.log(
                `⚠️ DYNAMIC VERIFY ERROR ${symbol}:`,
                e.message
            )
        }

        if(attempt < 6){

            await new Promise(r =>
                setTimeout(r, 1000)
            )
        }
    }

    return false
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
            await binance.futuresOrder({

                symbol,
                side: closeSide,
                type: "STOP_MARKET",
                stopPrice: sl,
                closePosition: true,
                workingType: "MARK_PRICE",
                recvWindow: 20000
            })

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
            await binance.futuresOrder({

                symbol,
                side: closeSide,
                type: "TAKE_PROFIT_MARKET",
                stopPrice: tp,
                closePosition: true,
                workingType: "MARK_PRICE",
                recvWindow: 20000
            })

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
const verified =
    await verifyDynamicTPSL(
        symbol,
        positionSide,
        sl,
        tp
    )

if(!verified){

    console.log(
        `❌ INITIAL TPSL VERIFY FAIL ${symbol}`
    )

    try{
        await cancelAllOrders(symbol)
    }catch(_){}

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

        trade.enteredAt =
            Date.now()

        trade.openedAt =
            trade.enteredAt

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

        const saved =
            await updateTradeTPSLData(trade)

        if(!saved){

            console.log(
                `🚨 TPSL DB SAVE FAIL ${symbol}`
            )

            /*
             * Binance đã có TPSL.
             * Không được đặt lại TPSL.
             * Chỉ báo lỗi DB.
             */

        }

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
async function updateTradeTPSLData(trade){

    try{

        const symbol =
            String(trade?.symbol || "").trim()

        if(!symbol){

            console.log(
                `❌ DB SAVE NO SYMBOL`
            )

            return false
        }

        const updateData = {

            entry:
                Number(trade.entry),

            sl:
                Number(trade.sl),

            tp:
                Number(trade.tp),

            initialRisk:
                Number(trade.initialRisk),

            openedAt:
                Number(trade.openedAt),

            enteredAt:
                Number(
                    trade.enteredAt ||
                    Date.now()
                ),

            updatedAt:
                Date.now()
        }

        // =========================================
        // VALIDATE DATA
        // =========================================

        if(
            !Number.isFinite(updateData.entry) ||
            updateData.entry <= 0 ||

            !Number.isFinite(updateData.sl) ||
            updateData.sl <= 0 ||

            !Number.isFinite(updateData.tp) ||
            updateData.tp <= 0 ||

            !Number.isFinite(updateData.initialRisk) ||
            updateData.initialRisk <= 0
        ){

            console.log(
                `❌ INVALID TRADE DB DATA ${symbol}`,
                updateData
            )

            return false
        }

        // =========================================
        // UPDATE BY SYMBOL + PENDING
        // =========================================

        const result =
            await trades.updateOne(

                {
                    symbol: symbol,
                    result: "PENDING"
                },

                {
                    $set: updateData
                }
            )

        console.log(
            `💾 DB UPDATE ${symbol} ` +
            `MATCHED=${result.matchedCount} ` +
            `MODIFIED=${result.modifiedCount}`
        )

        if(
            result.matchedCount === 0
        ){

            console.log(
                `❌ TRADE NOT FOUND DB ${symbol}`
            )

            return false
        }

        console.log(
            `💾 TRADE STATE SAVED ${symbol}`
        )

        return true

    }catch(e){

        console.log(
            `❌ SAVE TRADE STATE ${trade?.symbol || "UNKNOWN"}:`,
            e.message
        )

        return false
    }
}
// =====================================================
// DYNAMIC TPSL MANAGER
// =====================================================
async function verifyCurrentTPSL(
    symbol,
    side
){

    try{

        const expectedSide =
            side === "LONG"
                ? "SELL"
                : "BUY"

        const orders =
            await binance.futuresOpenOrders({

                symbol,
                recvWindow: 60000
            })

        if(!Array.isArray(orders)){
            return false
        }

        const sl =
            orders.some(o =>
                (
                    o.type === "STOP_MARKET" ||
                    o.type === "STOP"
                ) &&
                o.side === expectedSide
            )

        const tp =
            orders.some(o =>
                (
                    o.type === "TAKE_PROFIT_MARKET" ||
                    o.type === "TAKE_PROFIT"
                ) &&
                o.side === expectedSide
            )

        return sl && tp

    }catch(e){

        await checkTimeError(e)

        console.log(
            `❌ VERIFY CURRENT TPSL ${symbol}:`,
            e.message
        )

        return false
    }
}
const TPSL_CLOSING = {}
async function manageDynamicTPSL(trade){


try{

    // =============================================
    // SAFETY
    // =============================================

    if(!trade){
        return
    }

    if(
        !trade.symbol ||
        !trade.side
    ){
        return
    }
    if(TPSL_CLOSING[trade.symbol]){
    return
}
    if(
    TPSL_PENDING[trade.symbol]
){
    return
}
    // =============================================
// DYNAMIC TPSL COOLDOWN 60S AFTER ENTRY
// =============================================

const entryTime =
    Number(
        trade.enteredAt ||
        trade.createdAt
    )

if(!entryTime){
    console.log(
        `⚠️ NO ENTRY TIME ${trade.symbol}`
    )
    return
}

const elapsedSinceEntry =
    Date.now() - entryTime

if(elapsedSinceEntry < 60000){

    console.log(
        `⏳ DYNAMIC TPSL WAIT ${trade.symbol} ` +
        `${Math.ceil((60000 - elapsedSinceEntry) / 1000)}s`
    )

    return
}

    TPSL_PENDING[trade.symbol] = true

    // =============================================
    // CHECK POSITION
    // =============================================

    let pos =
        await hasPosition(
            trade.symbol
        )

    if(!pos){
        return
    }

    // =============================================
    // GET DATA
    // =============================================

    const [
        data15,
        data5
    ] = await Promise.all([

        getData(
            trade.symbol,
            "15m",
            160
        ),

        getData(
            trade.symbol,
            "5m",
            160
        )
    ])

    if(
        !data15 ||
        !data5
    ){
        return
    }

    if(
        data15.length < 30 ||
        data5.length < 30
    ){
        return
    }

    // =====================================================
    // STRUCTURE DATA
    // =====================================================

    const h5 = data5.map(x => +x[2])
    const l5 = data5.map(x => +x[3])
    const c5 = data5.map(x => +x[4])

    const current =
    Number(
        pos.markPrice ||
        pos.entryPrice
    )

    if(
        !Number.isFinite(current) ||
        current <= 0
    ){
        return
    }

    // Vùng cản gần
    const resistance =
        Math.max(
            ...h5.slice(-24,-1)
        )

    const support =
        Math.min(
            ...l5.slice(-24,-1)
        )

    // Vùng cản xa
    const resistanceFar =
        Math.max(
            ...h5.slice(-48,-24)
        )

    const supportFar =
        Math.min(
            ...l5.slice(-48,-24)
        )

    // =============================================
    // CURRENT POSITION PRICE
    // =============================================

    const currentEntry =
        Number(
            pos.entryPrice ||
            trade.entry
        )

    if(
        !Number.isFinite(currentEntry) ||
        currentEntry <= 0
    ){
        return
    }

    // =============================================
    // INITIAL RISK
    // =============================================

    let initialRisk =
    Number(trade.initialRisk)

if(
    !Number.isFinite(initialRisk) ||
    initialRisk <= 0
){

    const fallbackSL =
        Number(trade.sl)

    if(
        Number.isFinite(fallbackSL) &&
        fallbackSL > 0
    ){

        initialRisk =
            Math.abs(
                currentEntry -
                fallbackSL
            )

        if(
            Number.isFinite(initialRisk) &&
            initialRisk > 0
        ){

            trade.initialRisk = initialRisk

await trades.updateOne(
    {
    symbol: trade.symbol,
    result: "PENDING"
},
    {
        $set: {
            initialRisk: initialRisk,
            updatedAt: Date.now()
        }
    }
)

            console.log(
                `🔧 INITIAL RISK RECOVERED ${trade.symbol} ` +
                `RISK=${initialRisk}`
            )

        }else{

            console.log(
                `⚠️ NO INITIAL RISK ${trade.symbol}`
            )

            return
        }

    }else{

        console.log(
            `⚠️ NO INITIAL RISK ${trade.symbol}`
        )

        return
    }
}

    // =============================================
    // ATR 15M
    // =============================================

    const atrRaw =
        atr(
            data15.slice(-80)
        )

    const atr15 =
        Number.isFinite(atrRaw) &&
        atrRaw > 0
            ? atrRaw
            : current * 0.003

    // =============================================
    // PROFIT / R
    // =============================================

    const profit =
        trade.side === "LONG"
            ? current - currentEntry
            : currentEntry - current

    const R =
        profit / initialRisk

    // =============================================
    // OPEN TIME
    // =============================================

    const openedAt =
        Number(
            trade.openedAt
        )

    if(!openedAt){

        console.log(
            `⚠️ NO openedAt ${trade.symbol}`
        )

        return
    }

    const elapsedHours =
        (
            Date.now() -
            openedAt
        ) / 3600000

    // =============================================
    // CURRENT SL / TP
    // =============================================

    let newSL =
        Number(trade.sl)

    let newTP =
        Number(trade.tp)

    // =====================================================
    // FIND NEAREST STRUCTURE
    // =====================================================

    let resistanceCandidates = [
        resistance,
        resistanceFar
    ].filter(
        x =>
            Number.isFinite(x) &&
            x > current
    )

    let supportCandidates = [
        support,
        supportFar
    ].filter(
        x =>
            Number.isFinite(x) &&
            x < current
    )

    let nextResistance =
        resistanceCandidates.length
            ? Math.min(...resistanceCandidates)
            : null

    let nextSupport =
        supportCandidates.length
            ? Math.max(...supportCandidates)
            : null

    const breakoutLong =
        trade.side === "LONG" &&
        current > resistance

    const breakoutShort =
        trade.side === "SHORT" &&
        current < support

    if(
        !Number.isFinite(newSL) ||
        !Number.isFinite(newTP)
    ){
        return
    }

    // =================================================
    // 0 → 0.60R
    // NO TRAILING
    // =================================================

    if(R < 0.60){

        // Giữ SL nguyên.
    }

    // =================================================
    // 0.60R → 0.90R
    // REDUCE RISK
    // =================================================

    if(
        R >= 0.60 &&
        R < 0.90
    ){

        if(
            trade.side === "LONG"
        ){

            const candidate =
                currentEntry -
                atr15 * 0.20

            if(candidate > newSL){
                newSL = candidate
            }

        }else{

            const candidate =
                currentEntry +
                atr15 * 0.20

            if(candidate < newSL){
                newSL = candidate
            }
        }
    }

    // =================================================
    // >= 0.90R
    // BREAK EVEN
    // =================================================

    if(R >= 0.90){

        const buffer =
            Math.max(
                atr15 * 0.05,
                currentEntry * 0.0002
            )

        if(
            trade.side === "LONG"
        ){

            const candidate =
                currentEntry + buffer

            if(candidate > newSL){
                newSL = candidate
            }

        }else{

            const candidate =
                currentEntry - buffer

            if(candidate < newSL){
                newSL = candidate
            }
        }
    }

    // =================================================
    // >= 1.20R
    // LOCK PROFIT
    // =================================================

    if(R >= 1.20){

        let lockR = 0.30

        if(R >= 2.00){
            lockR = 0.75
        }
        else if(R >= 1.60){
            lockR = 0.55
        }

        if(
            trade.side === "LONG"
        ){

            const candidate =
                currentEntry +
                initialRisk * lockR

            if(candidate > newSL){
                newSL = candidate
            }

        }else{

            const candidate =
                currentEntry -
                initialRisk * lockR

            if(candidate < newSL){
                newSL = candidate
            }
        }
    }

    // =================================================
    // >= 1.40R
    // ATR 15M TRAILING
    // =================================================

    if(R >= 1.40){

        let multiplier = 1.20

        if(R >= 2.50){
            multiplier = 0.90
        }
        else if(R >= 2.00){
            multiplier = 1.05
        }

        if(
            trade.side === "LONG"
        ){

            const candidate =
                current -
                atr15 * multiplier

            if(candidate > newSL){
                newSL = candidate
            }

        }else{

            const candidate =
                current +
                atr15 * multiplier

            if(candidate < newSL){
                newSL = candidate
            }
        }
    }

    // =====================================================
// DYNAMIC TP BY R
// =====================================================

let targetR = 1.45

if(R >= 0.80){
    targetR = 1.70
}

if(R >= 1.20){
    targetR = 2.00
}

if(R >= 1.60){
    targetR = 2.30
}

if(R >= 2.00){
    targetR = 2.60
}

if(R >= 2.50){
    targetR = 3.00
}

/*
 * QUAN TRỌNG:
 *
 * TP mới phải luôn nằm phía trước current.
 *
 * Nếu R đã vượt targetR,
 * targetR cũ có thể nằm sau current.
 */

const minimumFutureR =
    Math.max(
        targetR,
        R + 0.50
    )

const dynamicTP =
    trade.side === "LONG"
        ? currentEntry +
            initialRisk *
            minimumFutureR
        : currentEntry -
            initialRisk *
            minimumFutureR

if(trade.side === "LONG"){

    if(
        dynamicTP > current &&
        dynamicTP > newTP
    ){

        newTP =
            dynamicTP
    }

}else{

    if(
        dynamicTP < current &&
        dynamicTP < newTP
    ){

        newTP =
            dynamicTP
    }
}

    // =====================================================
    // APPROACHING STRUCTURE
    // =====================================================

    const structureBuffer =
        atr15 * 0.35

    // ================= LONG =================

    if(
        trade.side === "LONG" &&
        nextResistance &&
        nextResistance > current
    ){

        const distance =
            nextResistance - current

        if(
            distance <= structureBuffer
        ){

            // Đã có lời -> khóa lợi nhuận
            if(R >= 0.70){

                const lock =
                    currentEntry +
                    initialRisk * 0.40

                if(lock > newSL){
                    newSL = lock
                }
            }

            // TP đặt ngay trước resistance
            const target =
                nextResistance -
                atr15 * 0.10

            if(
                target > current &&
                target < newTP
            ){
                newTP = target
            }
        }
    }

    // ================= SHORT =================

    if(
        trade.side === "SHORT" &&
        nextSupport &&
        nextSupport < current
    ){

        const distance =
            current - nextSupport

        if(
            distance <= structureBuffer
        ){

            if(R >= 0.70){

                const lock =
                    currentEntry -
                    initialRisk * 0.40

                if(lock < newSL){
                    newSL = lock
                }
            }

            const target =
                nextSupport +
                atr15 * 0.10

            if(
                target < current &&
                target > newTP
            ){
                newTP = target
            }
        }
    }

    // =====================================================
    // STRUCTURE EXIT
    // =====================================================

    if(
        trade.side === "LONG" &&
        nextResistance &&
        nextResistance > current
    ){

        const distance =
            nextResistance - current

        if(
            distance <= atr15 * 0.15 &&
            R >= 0.50
        ){

            const qty =
                Math.abs(
                    Number(pos.positionAmt)
                )

            if(qty > 0){

                console.log(
                    `🏁 RESISTANCE EXIT ${trade.symbol} ` +
                    `R=${R.toFixed(2)} ` +
                    `DIST=${distance}`
                )

                const closed =
                    await closePosition(
                        trade.symbol,
                        trade.side,
                        qty
                    )

                if(closed){
                    return
                }
            }
        }
    }

    // =====================================================
    // AFTER BREAKOUT
    // =====================================================

    if(
        breakoutLong &&
        R >= 1.00
    ){

        // SL xuống dưới vùng vừa phá
        const candidateSL =
            resistance -
            atr15 * 0.35

        if(candidateSL > newSL){
            newSL = candidateSL
        }

        // Tìm resistance tiếp theo
        if(
            resistanceFar > current
        ){

            const candidateTP =
                resistanceFar -
                atr15 * 0.10

            if(candidateTP > newTP){
                newTP = candidateTP
            }
        }
    }

    if(
        breakoutShort &&
        R >= 1.00
    ){

        const candidateSL =
            support +
            atr15 * 0.35

        if(candidateSL < newSL){
            newSL = candidateSL
        }

        if(
            supportFar < current
        ){

            const candidateTP =
                supportFar +
                atr15 * 0.10

            if(candidateTP < newTP){
                newTP = candidateTP
            }
        }
    }

    // =====================================================
    // TIME EXIT
    // =====================================================

    // Không đóng lệnh chỉ vì đã 12h.
    //
    // Chỉ đóng nếu:
    // 1. Đã giữ >= 8h
    // 2. Lệnh gần như không chạy
    // 3. R < 0.30

    if(
        elapsedHours >= 8 &&
        R < 0.30
    ){

        const qty =
            Math.abs(
                Number(
                    pos.positionAmt
                )
            )

        console.log(
            `⏰ STALE TRADE EXIT ${trade.symbol} ` +
            `R=${R.toFixed(2)} ` +
            `H=${elapsedHours.toFixed(2)}`
        )

        await closePosition(
            trade.symbol,
            trade.side,
            qty
        )

        return
    }

    // Safety cực xa.
    // Chỉ dùng để tránh position bị treo vô hạn.

    if(
        elapsedHours >= 24
    ){

        const qty =
            Math.abs(
                Number(
                    pos.positionAmt
                )
            )

        console.log(
            `🚨 MAX TIME EXIT ${trade.symbol} ` +
            `R=${R.toFixed(2)} ` +
            `H=${elapsedHours.toFixed(2)}`
        )

        await closePosition(
            trade.symbol,
            trade.side,
            qty
        )

        return
    }

    // =================================================
    // NEVER MOVE SL BACKWARD
    // =================================================

    const oldSL =
        Number(trade.sl)

    if(
        trade.side === "LONG" &&
        newSL < oldSL
    ){
        newSL = oldSL
    }

    if(
        trade.side === "SHORT" &&
        newSL > oldSL
    ){
        newSL = oldSL
    }

    // =================================================
    // CHECK WHETHER CHANGE IS REAL
    // =================================================

    const slChanged =
        Math.abs(
            newSL - oldSL
        ) >
        Math.max(
            currentEntry * 0.00001,
            atr15 * 0.01
        )

    const tpChanged =
        Math.abs(
            newTP -
            Number(trade.tp)
        ) >
        Math.max(
            currentEntry * 0.00001,
            atr15 * 0.01
        )

    if(
        !slChanged &&
        !tpChanged
    ){
        return
    }

    // =================================================
    // UPDATE BINANCE
    // =================================================

    try{

        const updateTrade = {

            ...trade,

            entry:
                currentEntry,

            sl:
                newSL,

            tp:
                newTP
        }

        const result =
    await setDynamicTPSL(
        updateTrade
    )

if(!result?.ok){

    console.log(
        `⚠️ DYNAMIC TPSL UPDATE FAILED ${trade.symbol}`
    )

    /*
     * KHÔNG CLOSE NGAY.
     *
     * Kiểm tra position thật trước.
     */

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

        console.log(
            `⚠️ DYNAMIC POSITION VERIFY FAIL ${trade.symbol}:`,
            e.message
        )

        /*
         * API verify fail:
         * KHÔNG được close mù.
         */

        return
    }

    /*
     * Position đã không còn.
     * checkTrades sẽ xử lý kết quả.
     */

    if(!realPos){

        console.log(
            `ℹ️ DYNAMIC POSITION ALREADY CLOSED ${trade.symbol}`
        )

        return
    }

    /*
     * Position vẫn còn.
     * Kiểm tra TPSL hiện tại.
     */

    let currentTPSL = false

    try{

        currentTPSL =
            await verifyCurrentTPSL(
                trade.symbol,
                trade.side
            )

    }catch(e){

        console.log(
            `⚠️ CURRENT TPSL VERIFY ERROR ${trade.symbol}:`,
            e.message
        )

        return
    }

    /*
     * Nếu TPSL vẫn còn:
     * KHÔNG đóng lệnh.
     */

    if(currentTPSL){

        console.log(
            `🛡 EXISTING TPSL STILL ACTIVE ${trade.symbol}`
        )

        return
    }

    /*
     * Position còn nhưng không còn TPSL.
     * Đây mới là emergency.
     */

    if(TPSL_CLOSING[trade.symbol]){
        return
    }

    TPSL_CLOSING[trade.symbol] = true

    try{

        const realQty =
            Math.abs(
                Number(realPos.positionAmt)
            )

        if(realQty <= 0){
            return
        }

        console.log(
            `🚨 EMERGENCY CLOSE ${trade.symbol} ` +
            `QTY=${realQty}`
        )

        const closed =
            await closePosition(
                trade.symbol,
                trade.side,
                realQty
            )

        if(closed){

            console.log(
                `✅ EMERGENCY CLOSE SUCCESS ${trade.symbol}`
            )

        }else{

            console.log(
                `🚨 CRITICAL EMERGENCY CLOSE FAIL ${trade.symbol}`
            )

            await sendTelegram2(
                `🚨 CRITICAL TPSL FAILURE\n` +
                `${trade.symbol}\n` +
                `POSITION STILL OPEN\n` +
                `NO ACTIVE TPSL`
            )
        }

    }catch(e){

        await checkTimeError(e)

        console.log(
            `🚨 EMERGENCY CLOSE ERROR ${trade.symbol}:`,
            e.message
        )

    }finally{

        delete TPSL_CLOSING[trade.symbol]
    }

    return
}

// =================================================
// BINANCE TPSL ĐÃ SET THÀNH CÔNG
// =================================================

trade.sl =
    Number(result.sl)

trade.tp =
    Number(result.tp)

// =================================================
// SAVE DB — KHÔNG SET TPSL BINANCE LẦN 2
// =================================================

const dbResult =
    await trades.updateOne(

        {
            symbol: trade.symbol,
            result: "PENDING"
        },

        {
            $set: {

                sl:
                    Number(result.sl),

                tp:
                    Number(result.tp),

                updatedAt:
                    Date.now()
            }
        }
    )

if(
    dbResult.matchedCount === 0
){

    console.log(
        `⚠️ DYNAMIC TPSL DB NOT FOUND ${trade.symbol}`
    )

    return
}

console.log(
    `💾 DYNAMIC TPSL SAVED ${trade.symbol} ` +
    `SL=${result.sl} ` +
    `TP=${result.tp}`
)

console.log(
    `🔄 DYNAMIC ${trade.symbol} ` +
    `${trade.side} ` +
    `R=${R.toFixed(2)} ` +
    `SL=${result.sl} ` +
    `TP=${result.tp}`
)

    }catch(e){

        await checkTimeError(e)

        console.log(
            `❌ DYNAMIC TPSL ERROR ${trade.symbol}:`,
            e.message
        )
    }

}catch(e){

    await checkTimeError(e)

    console.log(
        `❌ MANAGE DYNAMIC TPSL ERROR ${trade?.symbol || "UNKNOWN"}:`,
        e.message
    )

}finally{

    if(trade?.symbol){
        delete TPSL_PENDING[trade.symbol]
    }

}


}

async function cancelAllOrders(symbol){

    try{

        console.log(
            `🗑 CANCEL OLD TPSL ${symbol}`
        )

        await binance.futuresCancelAllOpenOrders({

            symbol,
            recvWindow: 60000
        })

        for(let i = 0; i < 10; i++){

            await new Promise(r =>
                setTimeout(r, 500)
            )

            const openOrders =
                await binance.futuresOpenOrders({

                    symbol,
                    recvWindow: 60000
                })

            if(!Array.isArray(openOrders)){
                continue
            }

            const remainingTPSL =
                openOrders.filter(o =>
                    (
                        o.type === "STOP_MARKET" ||
                        o.type === "TAKE_PROFIT_MARKET" ||
                        o.type === "STOP" ||
                        o.type === "TAKE_PROFIT"
                    )
                )

            if(
                remainingTPSL.length === 0
            ){

                console.log(
                    `🗑 OLD TPSL CLEARED ${symbol}`
                )

                return true
            }

            console.log(
                `⏳ WAIT TPSL CLEAR ${symbol} ` +
                `REMAINING=${remainingTPSL.length}`
            )
        }

        console.log(
            `❌ OLD TPSL STILL EXISTS ${symbol}`
        )

        return false

    }catch(e){

        await checkTimeError(e)

        console.log(
            `❌ CANCEL TPSL ${symbol}:`,
            e.message
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

    const urls = [
        `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`
    ]

    for(let url of urls){

        for(let attempt=0; attempt<2; attempt++){

            try{

                const controller = new AbortController()
                const timeout = setTimeout(() => controller.abort(), 8000)

                let res = await safeFetch(url, {
                    headers: { "User-Agent": "Mozilla/5.0" },
                    signal: controller.signal
                })

                clearTimeout(timeout)

                if(!res || !res.ok) continue

                let data = await res.json()

                if(Array.isArray(data) && data.length > 0){
                    return data
                }

            }catch(e){

    await new Promise(r =>
        setTimeout(r, 1000 + attempt * 2000)
    )

    console.log("❌ DATA FAIL:", symbol)
}
        }
    }

    return null
}
// ================= SYMBOL (PRO) =================
async function getTopSymbols(){

    const urls = [
        "https://api.binance.com/api/v3/ticker/24hr",
        "https://data-api.binance.vision/api/v3/ticker/24hr"
    ]

    for(let url of urls){
        for(let attempt=0; attempt<2; attempt++){
            try{
                let res = await safeFetch(url, { headers:{"User-Agent":"Mozilla/5.0"} })
                if(!res || !res.ok) continue

                let data = await res.json()

                if(Array.isArray(data) && data.length>0){
                    return data
                        .filter(c =>
    c.symbol.endsWith("USDT") &&
    !c.symbol.includes("UP") &&
    !c.symbol.includes("DOWN") &&
    !c.symbol.includes("BUSD") &&
    !c.symbol.includes("USD1") &&
    !c.symbol.includes("FDUSD") &&
    !c.symbol.includes("USDC") &&
    !c.symbol.includes("EUR") &&
    !c.symbol.includes("TRY") &&
    !c.symbol.includes("RLUSD")
)
                      // 🔥 1. SQUEEZE (quan trọng nhất)
    .filter(c => {
        let change = Math.abs(Number(c.priceChangePercent))
        // coin chưa chạy nhưng có dấu hiệu tích lực
        return change >= 1 && change <= 35 // 
    })
    // 🔥 2. LIQUIDITY nhẹ (KHÔNG dùng minVol 24h nữa)
    .filter(c =>
        Number(c.quoteVolume) > 2_000_000 //3_000_000
    )
    .filter(c => {

    let high = Number(c.highPrice)
    let low  = Number(c.lowPrice)
    let last = Number(c.lastPrice)

    if(!high || !low || !last) return false

    let dayRange = (high - low) / last

    return dayRange > 0.015
})
    // 🔥 3. SORT
    .sort((a,b)=>{

    const volA = Number(a.quoteVolume)
    const volB = Number(b.quoteVolume)

    const moveA = Math.abs(Number(a.priceChangePercent))
    const moveB = Math.abs(Number(b.priceChangePercent))

    // Ưu tiên coin đang chuyển động,
    // nhưng vẫn giữ thanh khoản đủ tốt.
    const scoreA =
        moveA * 3 +
        Math.log10(Math.max(volA,1)) * 2

    const scoreB =
        moveB * 3 +
        Math.log10(Math.max(volB,1)) * 2

    return scoreB - scoreA
})
    .filter(c =>
    validFuturesSymbols &&
    validFuturesSymbols.size > 0 &&
    validFuturesSymbols.has(c.symbol)
)
.slice(0, 120)
.map(c => c.symbol)
                }
            }catch(e){
                if(attempt===1){
                    console.log("❌ SYMBOL FAIL:", url)
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
// ============== dyminic minvol15m========
function getDynamicMinVol(volAvgUSDT, price, atrRatio){

    let base = MIN_VOL_15M

    // coin giá thấp → cần vol cao hơn
    if(price < 1){
        base *= 1.5
    }

    // coin giá cao → giảm yêu cầu
    if(price > 100){
        base *= 0.7
    }

    // volatility cao → giảm yêu cầu
    if(atrRatio > 0.005){
        base *= 0.8
    }

    // volatility thấp → tăng yêu cầu
    if(atrRatio < 0.002){
        base *= 1.3
    }

    return base
}
// ================= CORE LOGIC V2 - SHORT TERM =================
// 1H = BIAS
// 15M = STRUCTURE
// 5M = SETUP
// 1M = ENTRY TIMING
//
// Mục tiêu:
// - Bắt nhiều cơ hội short-term
// - Không phụ thuộc duy nhất vào pullback EMA
// - Không dùng volume/RSI làm hard filter
// - Entry phải có price-action confirmation
// - SL dựa trên structure 5M/1M
// =============================================================

async function coreLogic(data15, data1h, data5, data1m){

    // ================= VALIDATE =================

    if(!data15 || !data1h || !data5 || !data1m){
        return null
    }

    // Chỉ dùng nến đã đóng
    data15 = data15.slice(0,-1)
    data1h = data1h.slice(0,-1)
    data5  = data5.slice(0,-1)
    data1m = data1m.slice(0,-1)

    if(
        data15.length < 100 ||
        data1h.length < 60 ||
        data5.length < 80 ||
        data1m.length < 80
    ){
        return null
    }

    // ================= ARRAY =================

    const o15 = data15.map(x=>+x[1])
    const h15 = data15.map(x=>+x[2])
    const l15 = data15.map(x=>+x[3])
    const c15 = data15.map(x=>+x[4])
    const v15 = data15.map(x=>+x[5])

    const o1h = data1h.map(x=>+x[1])
    const h1h = data1h.map(x=>+x[2])
    const l1h = data1h.map(x=>+x[3])
    const c1h = data1h.map(x=>+x[4])

    const o5 = data5.map(x=>+x[1])
    const h5 = data5.map(x=>+x[2])
    const l5 = data5.map(x=>+x[3])
    const c5 = data5.map(x=>+x[4])
    const v5 = data5.map(x=>+x[5])

    const o1 = data1m.map(x=>+x[1])
    const h1 = data1m.map(x=>+x[2])
    const l1 = data1m.map(x=>+x[3])
    const c1 = data1m.map(x=>+x[4])
    const v1 = data1m.map(x=>+x[5])

    const price = c1.at(-1)

    if(!price || price <= 0){
        return null
    }

    // ================= HELPERS =================

    const pct = (a,b) =>
        b !== 0 ? (a-b)/b : 0

    const candleBody = (o,c) =>
        Math.abs(c-o)

    const candleRange = (h,l) =>
        Math.max(h-l,0)

    const bodyRatio = (o,h,l,c) => {
        const range = candleRange(h,l)
        return range > 0
            ? Math.abs(c-o)/range
            : 0
    }

    const closeLong = (h,l,c) => {
        const range = h-l
        return range > 0
            ? (c-l)/range
            : 0
    }

    const closeShort = (h,l,c) => {
        const range = h-l
        return range > 0
            ? (h-c)/range
            : 0
    }

    const avg = arr =>
        arr.length
            ? arr.reduce((a,b)=>a+b,0)/arr.length
            : 0

    // ================= INDICATORS =================

    const atr15Raw = atr(data15.slice(-80))
    const atr5Raw  = atr(data5.slice(-80))
    const atr1Raw  = atr(data1m.slice(-80))

    const atr15 =
        Number.isFinite(atr15Raw) && atr15Raw > 0
            ? atr15Raw
            : price*0.003

    const atr5 =
        Number.isFinite(atr5Raw) && atr5Raw > 0
            ? atr5Raw
            : price*0.002

    const atr1 =
        Number.isFinite(atr1Raw) && atr1Raw > 0
            ? atr1Raw
            : price*0.0008

    const atrRatio5 = atr5/price

    // ================= 1H BIAS =================

    const ema20_1h = ema(c1h.slice(-60),20)
    const ema50_1h = ema(c1h.slice(-100),50)

    const ema20_1hPrev =
        ema(c1h.slice(-61,-1),20)

    const ema50_1hPrev =
        ema(c1h.slice(-101,-1),50)

    const price1h = c1h.at(-1)

    const slope1h =
        ema20_1hPrev
            ? (ema20_1h-ema20_1hPrev)/ema20_1hPrev
            : 0

    const gap1h =
        price1h > 0
            ? Math.abs(ema20_1h-ema50_1h)/price1h
            : 0

    const bull1h =
    ema20_1h > ema50_1h &&
    price1h > ema20_1h &&
    slope1h > 0.0002

const bear1h =
    ema20_1h < ema50_1h &&
    price1h < ema20_1h &&
    slope1h < -0.0002

    // ================= 15M STRUCTURE =================

    const ema20_15 = ema(c15.slice(-60),20)
    const ema50_15 = ema(c15.slice(-100),50)

    const ema20_15Prev =
        ema(c15.slice(-61,-1),20)

    const ema50_15Prev =
        ema(c15.slice(-101,-1),50)

    const price15 = c15.at(-1)

    const slope15 =
        ema20_15Prev
            ? (ema20_15-ema20_15Prev)/ema20_15Prev
            : 0

    const gap15 =
        price15 > 0
            ? Math.abs(ema20_15-ema50_15)/price15
            : 0

    const bull15 =
    ema20_15 > ema50_15 &&
    price15 > ema20_15 &&
    slope15 > 0.0002

const bear15 =
    ema20_15 < ema50_15 &&
    price15 < ema20_15 &&
    slope15 < -0.0002

    // Không bắt buộc 1H + 15M cùng hướng.
    // Chỉ tạo bias.

    let longBias = 0
    let shortBias = 0

    if(bull1h) longBias += 2
    if(bear1h) shortBias += 2

    if(bull15) longBias += 2
    if(bear15) shortBias += 2

    if(slope15 > 0.00015) longBias += 1
    if(slope15 < -0.00015) shortBias += 1

    // ================= 5M DATA =================

    const p5 = c5.at(-1)
    const p5Prev = c5.at(-2)

    const ema9_5 = ema(c5.slice(-40),9)
    const ema20_5 = ema(c5.slice(-60),20)
    const ema50_5 = ema(c5.slice(-80),50)
    const ema9_5Prev =
    ema(c5.slice(-41,-1),9)

const slope9_5 =
    ema9_5Prev
        ? (ema9_5-ema9_5Prev)/ema9_5Prev
        : 0

            // ================= SHORT-TERM TREND ENGINE =================

const ema9_5Prev2 =
    ema(c5.slice(-42,-2),9)

const slope9_5_fast =
    ema9_5Prev2
        ? (ema9_5-ema9_5Prev2)/ema9_5Prev2/2
        : 0

const move5m =
    pct(p5,p5Prev)

const move15m =
    pct(
        c15.at(-1),
        c15.at(-2)
    )

const trendLong5 =
    p5 > ema9_5 &&
    ema9_5 > ema20_5 &&
    slope9_5 > 0.00015

const trendShort5 =
    p5 < ema9_5 &&
    ema9_5 < ema20_5 &&
    slope9_5 < -0.00015

const accelerationLong =
    slope9_5 > 0.00015 &&
    slope9_5 > slope9_5_fast

const accelerationShort =
    slope9_5 < -0.00015 &&
    slope9_5 < slope9_5_fast

    const recent5Low =
        Math.min(...l5.slice(-12,-2))

    const recent5High =
        Math.max(...h5.slice(-12,-2))

    const structureLow =
        Math.min(...l5.slice(-20,-1))

    const structureHigh =
        Math.max(...h5.slice(-20,-1))

    // ================= 5M VOLUME =================

    const vol5Avg =
        avg(v5.slice(-21,-1))

    const vol5Now =
        v5.at(-1)

    const vol5Ratio =
        vol5Avg > 0
            ? vol5Now/vol5Avg
            : 1

    // Volume chỉ là điểm cộng.
    // Không còn hard filter.

    // ================= 1M CURRENT =================

    const i = c1.length-1

    const c0 = c1[i]
    const o0 = o1[i]
    const h0 = h1[i]
    const l0 = l1[i]

    const cPrev = c1[i-1]
    const oPrev = o1[i-1]
    const hPrev = h1[i-1]
    const lPrev = l1[i-1]

    const c2 = c1[i-2]
    const h2 = h1[i-2]
    const l2 = l1[i-2]

    const range0 = h0-l0
    const body0 = Math.abs(c0-o0)

    if(range0 <= 0 || body0 <= 0){
        return null
    }

    const br0 =
        body0/range0

    // ================= 1M VOLUME =================

    const vol1Avg =
        avg(v1.slice(-21,-1))

    const vol1Now =
        v1.at(-1)

    const vol1Ratio =
        vol1Avg > 0
            ? vol1Now/vol1Avg
            : 1

    // ================= RSI =================

    const rsi5 = rsi(c5.slice(-50))
    const rsi1 = rsi(c1.slice(-50))

    // RSI không còn hard filter.
    // Chỉ dùng để tăng/giảm score.

    // ================= MOMENTUM =================

    const move1 =
        pct(c0,cPrev)

    const move3 =
        pct(c0,c1.at(-4))

    const move5 =
        pct(c0,c1.at(-6))

    // Không chase cú đã chạy quá mạnh.
    // Nhưng ngưỡng rộng hơn core cũ.

    //if(Math.abs(move5) > 0.035){
        //return null
    //}

    // ================= LIQUIDITY SWEEP =================

    const sweepLow =
        l0 < recent5Low &&
        c0 > recent5Low

    const sweepHigh =
        h0 > recent5High &&
        c0 < recent5High

    // ================= MICRO STRUCTURE =================

    const microBreakLong =
        c0 > Math.max(hPrev,h2)

    const microBreakShort =
        c0 < Math.min(lPrev,l2)

    // ================= 5M RECLAIM =================

    const reclaimEmaLong =
        p5 > ema20_5 &&
        p5Prev <= ema20_5*1.002

    const reclaimEmaShort =
        p5 < ema20_5 &&
        p5Prev >= ema20_5*0.998

    // ================= PULLBACK =================

    const pullbackLong =
    p5 > ema20_5 &&
    ema20_5 > ema50_5 &&
    (
        bull15 ||
        bull1h ||
        slope15 > 0.00015
    ) &&
    (
        l5.at(-2) <= ema9_5 * 1.008 ||
        l5.at(-2) <= ema20_5 * 1.015
    ) &&
    c0 > cPrev

const pullbackShort =
    p5 < ema20_5 &&
    ema20_5 < ema50_5 &&
    (
        bear15 ||
        bear1h ||
        slope15 < -0.00015
    ) &&
    (
        h5.at(-2) >= ema9_5 * 0.992 ||
        h5.at(-2) >= ema20_5 * 0.985
    ) &&
    c0 < cPrev

    const pullbackReclaimLong =
    pullbackLong &&
    (
        reclaimEmaLong ||
        microBreakLong ||
        c0 > hPrev
    )

const pullbackReclaimShort =
    pullbackShort &&
    (
        reclaimEmaShort ||
        microBreakShort ||
        c0 < lPrev
    )
// ================= TREND CONTINUATION =================

const trendContinuationLong =
    trendLong5 &&
    (
        bull15 ||
        bull1h ||
        slope15 > 0.00015
    ) &&
    c0 > cPrev &&
    (
        microBreakLong ||
        reclaimEmaLong ||
        pullbackReclaimLong ||
        accelerationLong ||
        c0 > hPrev
    )

const trendContinuationShort =
    trendShort5 &&
    (
        bear15 ||
        bear1h ||
        slope15 < -0.00015
    ) &&
    c0 < cPrev &&
    (
        microBreakShort ||
        reclaimEmaShort ||
        pullbackReclaimShort ||
        accelerationShort ||
        c0 < lPrev
    )
    // ================= REVERSAL ENGINE =================

const reversalLong =
    sweepLow &&
    c0 > recent5Low &&
    c0 > cPrev &&
    (
        microBreakLong ||
        reclaimEmaLong
    ) &&
    closeLong(h0,l0,c0) >= 0.55

const reversalShort =
    sweepHigh &&
    c0 < recent5High &&
    c0 < cPrev &&
    (
        microBreakShort ||
        reclaimEmaShort
    ) &&
    closeShort(h0,l0,c0) >= 0.55
    // ================= BREAKOUT / RETEST =================

// Breakout phải xảy ra trước đó.
// Không coi chính cây breakout là retest.

const breakoutLong =
    p5Prev <= recent5High &&
    p5 > recent5High

const breakoutShort =
    p5Prev >= recent5Low &&
    p5 < recent5Low

// Retest thật:
// 5M đã nằm trên/dưới vùng breakout,
// giá 1M quay lại vùng đó,
// sau đó reclaim lại.

const retestLong =
    !breakoutLong &&
    p5 > recent5High &&
    l0 <= recent5High * 1.003 &&
    c0 > recent5High

const retestShort =
    !breakoutShort &&
    p5 < recent5Low &&
    h0 >= recent5Low * 0.997 &&
    c0 < recent5Low

    // ================= MOMENTUM =================

    const momentumLong =
    p5 > ema9_5 &&
    ema9_5 > ema20_5 &&
    slope9_5 > 0.00010 &&
    c0 > cPrev

const momentumShort =
    p5 < ema9_5 &&
    ema9_5 < ema20_5 &&
    slope9_5 < -0.00010 &&
    c0 < cPrev

const strongBullContext =
    bull15 &&
    slope15 > 0.0008 &&
    p5 > ema20_5

const strongBearContext =
    bear15 &&
    slope15 < -0.0008 &&
    p5 < ema20_5

    const validReversalLong =
    reversalLong &&
    !strongBearContext 

const validReversalShort =
    reversalShort &&
    !strongBullContext
    
    // ================= 1M CONFIRMATION =================
const longTrigger =
    pullbackLong ||
    trendContinuationLong ||
    retestLong ||
    momentumLong ||
    reversalLong ||
    microBreakLong ||
    reclaimEmaLong

const shortTrigger =
    pullbackShort ||
    trendContinuationShort ||
    retestShort ||
    momentumShort ||
    reversalShort ||
    microBreakShort ||
    reclaimEmaShort

const longMomentumConfirm =
    c0 > cPrev ||
    accelerationLong

const shortMomentumConfirm =
    c0 < cPrev ||
    accelerationShort


    const confirmLong =
    longTrigger &&
    longMomentumConfirm &&
    c0 > o0 &&
    br0 >= 0.30 &&
    closeLong(h0,l0,c0) >= 0.50

const confirmShort =
    shortTrigger &&
    shortMomentumConfirm &&
    c0 < o0 &&
    br0 >= 0.30 &&
    closeShort(h0,l0,c0) >= 0.50

    // ================= SETUP SELECTION =================

let longSetup = null
let shortSetup = null

// LONG

if(validReversalLong && confirmLong){
    longSetup = "REVERSAL_LONG"
}
else if(retestLong && confirmLong){
    longSetup = "BREAKOUT_RETEST"
}
else if(pullbackLong && confirmLong){
    longSetup = "PULLBACK_RECLAIM"
}
else if(trendContinuationLong && confirmLong){
    longSetup = "TREND_CONTINUATION"
}
else if(momentumLong && confirmLong){
    longSetup = "MOMENTUM_CONTINUATION"
}

// SHORT

if(validReversalShort && confirmShort){
    shortSetup = "REVERSAL_SHORT"
}
else if(retestShort && confirmShort){
    shortSetup = "BREAKOUT_RETEST"
}
else if(pullbackShort && confirmShort){
    shortSetup = "PULLBACK_RECLAIM"
}
else if(trendContinuationShort && confirmShort){
    shortSetup = "TREND_CONTINUATION"
}
else if(momentumShort && confirmShort){
    shortSetup = "MOMENTUM_CONTINUATION"
}

    // ================= SIDE =================

let side = null
let setup = null

if(longSetup && !shortSetup){

    if(longBias >= 1){
        side = "LONG"
        setup = longSetup
    }

}
else if(shortSetup && !longSetup){

    if(shortBias >= 1){
        side = "SHORT"
        setup = shortSetup
    }

}
else if(longSetup && shortSetup){

    if(longBias > shortBias && longBias >= 1){

        side = "LONG"
        setup = longSetup

    }
    else if(shortBias > longBias && shortBias >= 1){

        side = "SHORT"
        setup = shortSetup

    }
}

if(!side){
    return null
}
// ================= DIRECTION FILTER =================

// LONG ngược bearish lớn -> chỉ cho nếu reversal thật
if(
    side === "LONG" &&
    bear1h &&
    bear15 &&
    setup !== "REVERSAL_LONG"
){
    return null
}

// SHORT ngược bullish lớn -> chỉ cho nếu reversal thật
if(
    side === "SHORT" &&
    bull1h &&
    bull15 &&
    setup !== "REVERSAL_SHORT"
){
    return null
}

// Reversal counter-trend phải có sweep
if(
    side === "LONG" &&
    bear15 &&
    setup === "REVERSAL_LONG" &&
    !sweepLow
){
    return null
}

if(
    side === "SHORT" &&
    bull15 &&
    setup === "REVERSAL_SHORT" &&
    !sweepHigh
){
    return null
}
    // ================= ANTI COUNTER-MOVE =================

if(
    side === "LONG" &&
    move1 < -0.004
){
    return null
}

if(
    side === "SHORT" &&
    move1 > 0.004
){
    return null
}

   // ================= SCORE =================

let score = 50

// ===== DIRECTION =====

if(side === "LONG"){

    if(bull1h) score += 8
    if(bull15) score += 8
    if(slope15 > 0.0002) score += 4

}else{

    if(bear1h) score += 8
    if(bear15) score += 8
    if(slope15 < -0.0002) score += 4
}

// ===== SETUP =====

if(
    setup === "REVERSAL_LONG" ||
    setup === "REVERSAL_SHORT"
){
    score += 18
}

if(setup === "BREAKOUT_RETEST"){
    score += 15
}

if(setup === "PULLBACK_RECLAIM"){
    score += 10
}

if(setup === "TREND_CONTINUATION"){
    score += 13
}

if(setup === "MOMENTUM_CONTINUATION"){
    score += 9
}

// ===== MICRO STRUCTURE =====

if(side === "LONG" && microBreakLong){
    score += 7
}

if(side === "SHORT" && microBreakShort){
    score += 7
}

// ===== SWEEP =====

if(side === "LONG" && sweepLow){
    score += 7
}

if(side === "SHORT" && sweepHigh){
    score += 7
}

// ===== TREND SPEED =====

if(side === "LONG" && accelerationLong){
    score += 6
}

if(side === "SHORT" && accelerationShort){
    score += 6
}

// ===== VOLUME =====

if(
    vol1Ratio >= 1.5 ||
    vol5Ratio >= 1.5
){
    score += 6
}
else if(
    vol1Ratio >= 1.15 ||
    vol5Ratio >= 1.15
){
    score += 3
}

if(
    vol1Ratio < 0.45 &&
    vol5Ratio < 0.55
){
    score -= 5
}

// ===== CANDLE =====

if(br0 >= 0.55){
    score += 5
}

// ===== RSI =====

if(side === "LONG"){

    if(rsi5 >= 45 && rsi5 <= 70){
        score += 3
    }

    if(rsi5 > 78){
        score -= 5
    }

}else{

    if(rsi5 <= 55 && rsi5 >= 30){
        score += 3
    }

    if(rsi5 < 22){
        score -= 5
    }
}

// ===== EXTENSION =====

if(score < 58){
    return null
}
    
// ================= EXTENSION FILTER =================

if(
    side === "LONG" &&
    move5 > 0.04 &&
    !retestLong &&
    !pullbackLong &&
    !sweepLow
){
    return null
}

if(
    side === "SHORT" &&
    move5 < -0.04 &&
    !retestShort &&
    !pullbackShort &&
    !sweepHigh
){
    return null
}
// ================= QUALITY =================

let quality = 0

// Direction
if(side === "LONG"){

    if(bull15) quality += 2
    if(bull1h) quality += 1
    if(slope15 > 0.0002) quality += 1

}else{

    if(bear15) quality += 2
    if(bear1h) quality += 1
    if(slope15 < -0.0002) quality += 1
}

// Setup
if(
    setup === "REVERSAL_LONG" ||
    setup === "REVERSAL_SHORT"
){
    quality += 2
}

if(setup === "BREAKOUT_RETEST"){
    quality += 2
}

if(setup === "PULLBACK_RECLAIM"){
    quality += 1
}

if(setup === "TREND_CONTINUATION"){
    quality += 2
}

if(setup === "MOMENTUM_CONTINUATION"){
    quality += 1
}

// Momentum
if(side === "LONG" && accelerationLong){
    quality += 1
}

if(side === "SHORT" && accelerationShort){
    quality += 1
}

// Candle
if(br0 >= 0.55){
    quality += 1
}

if(
    side === "LONG" &&
    closeLong(h0,l0,c0) >= 0.62
){
    quality += 1
}

if(
    side === "SHORT" &&
    closeShort(h0,l0,c0) >= 0.62
){
    quality += 1
}

// Volume
if(
    vol1Ratio >= 1.2 ||
    vol5Ratio >= 1.2
){
    quality += 1
}

// Reversal bonus
if(
    setup === "REVERSAL_LONG" ||
    setup === "REVERSAL_SHORT"
){
    if(
        (side === "LONG" && sweepLow) ||
        (side === "SHORT" && sweepHigh)
    ){
        quality += 1
    }
}

if(quality < 2){
    return null
}

    // ================= MARKET STATE =================

    let marketState = "TREND_WEAK"

    if(
        gap15 >= 0.003 ||
        gap1h >= 0.003
    ){
        marketState = "TREND_STRONG"
    }
    else if(
        gap15 < 0.001 ||
        gap1h < 0.001
    ){
        marketState = "RANGE"
    }

    // ================= ENTRY =================

    const entry = price

    // ================= STRUCTURE =================

    const microLow =
        Math.min(
            ...l1.slice(-8)
        )

    const microHigh =
        Math.max(
            ...h1.slice(-8)
        )
// ================= DYNAMIC RISK / TP / SL =================

// Mục tiêu:
// - Không dùng SL quá sát theo 1M.
// - Ưu tiên cấu trúc 5M + ATR15.
// - TP thích nghi theo volatility + structure.
// - Giữ lệnh đủ lâu để bắt move vài giờ.
// - Không cho target quá xa khiến lệnh kéo dài vô lý.

// ATR15 được dùng cho swing/hold nhiều giờ.
// ATR5 dùng để tinh chỉnh entry.
// ATR1 chỉ dùng làm buffer nhỏ.

const atr15Safe =
    Number.isFinite(atr15) && atr15 > 0
        ? atr15
        : entry * 0.003

const atr5Safe =
    Number.isFinite(atr5) && atr5 > 0
        ? atr5
        : entry * 0.002

const atr1Safe =
    Number.isFinite(atr1) && atr1 > 0
        ? atr1
        : entry * 0.0008

// ================= VOLATILITY FACTOR =================

// ATR15 / price cho biết biên độ thực tế của thị trường.
// Volatility càng cao -> cho lệnh rộng hơn.
// Volatility thấp -> không cho SL quá rộng.

const atr15Ratio =
    atr15Safe / entry

let volFactor = 1.0

if(atr15Ratio >= 0.008){
    volFactor = 1.35
}
else if(atr15Ratio >= 0.005){
    volFactor = 1.20
}
else if(atr15Ratio >= 0.003){
    volFactor = 1.05
}
else if(atr15Ratio <= 0.0015){
    volFactor = 0.85
}

// ================= STRUCTURE =================

// Structure 5M quan trọng hơn micro structure 1M.
// Micro structure chỉ dùng làm buffer.

const swingLow5 =
    Math.min(
        ...l5.slice(-24,-1)
    )

const swingHigh5 =
    Math.max(
        ...h5.slice(-24,-1)
    )

const swingLow15 =
    Math.min(
        ...l15.slice(-12,-1)
    )

const swingHigh15 =
    Math.max(
        ...h15.slice(-12,-1)
    )

// Dùng cấu trúc gần nhất nhưng không để một wick 1M quá nhỏ
// quyết định toàn bộ SL.

let sl = null
let risk = null
let tp = null

// ================= LONG =================

if(side === "LONG"){

    // SL chính:
    // - swing 5M
    // - swing 15M nếu cần
    // - sweep low
    //
    // Không dùng microLow 1M làm SL chính nữa.

    let structuralSL =
        Math.min(
            swingLow5,
            structureLow
        )

    if(
        sweepLow &&
        Number.isFinite(l0)
    ){
        structuralSL =
            Math.min(
                structuralSL,
                l0
            )
    }

    // Nếu structure 15M quá xa thì không dùng trực tiếp,
    // nhưng vẫn đảm bảo SL có khoảng thở theo ATR15.

    const atrBasedSL =
        entry -
        atr15Safe *
        (0.80 * volFactor)

    // Chọn mức rộng hơn giữa structure và ATR.
    // Mục tiêu tránh SL bị wick 1M quét quá dễ.

    sl =
        Math.min(
            structuralSL,
            atrBasedSL
        )

    // Buffer nhỏ sau structure.
    sl -= atr5Safe * 0.12

    if(sl >= entry){
        return null
    }

    risk =
        entry - sl

    // ================= SL BOUNDARIES =================

    // SL tối thiểu.
    // Không dùng ATR1 quá thấp làm SL.

    const minRisk =
        Math.max(
            atr5Safe * 0.55,
            atr1Safe * 2.0
        )

    if(risk < minRisk){

        sl =
            entry - minRisk

        risk =
            entry - sl
    }

    // SL tối đa dựa trên ATR15.
    // Nếu structure quá xa, bỏ lệnh thay vì đặt SL vô lý.

    const maxRisk =
        atr15Safe *
        (1.35 * volFactor)

    if(risk > maxRisk){

        const fallbackSL =
            entry - maxRisk

        // Nếu fallback SL nằm trên structure,
        // nghĩa là structure đang quá gần / không đẹp.

        if(
            fallbackSL >
            structuralSL
        ){
            return null
        }

        sl =
            fallbackSL

        risk =
            entry - sl
    }

    // ================= LONG TARGET =================

    // Target cơ bản theo ATR15.
    // Đây là target cho move vài giờ,
    // không phải scalp vài phút.

    let targetATR =
        atr15Safe *
        (1.45 * volFactor)

    let rawTP =
        entry + targetATR

    // Resistance 5M / 15M gần nhất.

    const resistance5 =
        Math.max(
            ...h5.slice(-24,-1)
        )

    const resistance15 =
        Math.max(
            ...h15.slice(-12,-1)
        )

    // Ưu tiên target structure nếu nó nằm hợp lý.
    // Không đặt TP ngay trước resistance quá sát.

    let structureTP =
        Infinity

    if(
        resistance5 > entry
    ){
        structureTP =
            Math.min(
                structureTP,
                resistance5
            )
    }

    if(
        resistance15 > entry
    ){
        structureTP =
            Math.min(
                structureTP,
                resistance15
            )
    }

    if(
        Number.isFinite(structureTP)
    ){

        const structureDistance =
            structureTP - entry

        if(
            structureDistance >= risk * 1.25
        ){
            rawTP =
                Math.min(
                    rawTP,
                    structureTP
                )
        }
    }

    tp = rawTP

// ================= SHORT =================

}else{

    let structuralSL =
        Math.max(
            swingHigh5,
            structureHigh
        )

    if(
        sweepHigh &&
        Number.isFinite(h0)
    ){
        structuralSL =
            Math.max(
                structuralSL,
                h0
            )
    }

    const atrBasedSL =
        entry +
        atr15Safe *
        (0.80 * volFactor)

    sl =
        Math.max(
            structuralSL,
            atrBasedSL
        )

    sl += atr5Safe * 0.12

    if(sl <= entry){
        return null
    }

    risk =
        sl - entry

    // ================= SL BOUNDARIES =================

    const minRisk =
        Math.max(
            atr5Safe * 0.55,
            atr1Safe * 2.0
        )

    if(risk < minRisk){

        sl =
            entry + minRisk

        risk =
            sl - entry
    }

    const maxRisk =
        atr15Safe *
        (1.35 * volFactor)

    if(risk > maxRisk){

        const fallbackSL =
            entry + maxRisk

        if(
            fallbackSL <
            structuralSL
        ){
            return null
        }

        sl =
            fallbackSL

        risk =
            sl - entry
    }

    // ================= SHORT TARGET =================

    let targetATR =
        atr15Safe *
        (1.45 * volFactor)

    let rawTP =
        entry - targetATR

    const support5 =
        Math.min(
            ...l5.slice(-24,-1)
        )

    const support15 =
        Math.min(
            ...l15.slice(-12,-1)
        )

    let structureTP =
        -Infinity

    if(
        support5 < entry
    ){
        structureTP =
            Math.max(
                structureTP,
                support5
            )
    }

    if(
        support15 < entry
    ){
        structureTP =
            Math.max(
                structureTP,
                support15
            )
    }

    if(
        Number.isFinite(structureTP)
    ){

        const structureDistance =
            entry - structureTP

        if(
            structureDistance >= risk * 1.25
        ){
            rawTP =
                Math.max(
                    rawTP,
                    structureTP
                )
        }
    }

    tp = rawTP
}

// ================= FINAL INITIAL RR =================

if(
    !Number.isFinite(sl) ||
    !Number.isFinite(tp) ||
    !Number.isFinite(risk) ||
    risk <= 0
){
    return null
}

const initialRR =
    side === "LONG"
        ? (tp-entry)/risk
        : (entry-tp)/risk

// Không nhận setup có reward quá thấp.

if(
    initialRR < 1.25
){
    return null
}

// ================= MAX TARGET =================

// Không cho TP quá xa đến mức dễ biến thành
// lệnh giữ qua ngày.
//
// Dùng ATR15 thay vì ATR5.

const maxTargetDistance =
    atr15Safe *
    (3.20 * volFactor)

if(
    Math.abs(tp-entry) >
    maxTargetDistance
){

    tp =
        side === "LONG"
            ? entry + maxTargetDistance
            : entry - maxTargetDistance
}

// ================= FINAL RR AFTER CAP =================

const finalRR =
    side === "LONG"
        ? (tp-entry)/risk
        : (entry-tp)/risk

// Sau khi cap TP phải kiểm tra lại RR.

if(
    finalRR < 1.20
){
    return null
}

// ================= NEAREST STRUCTURE =================

// Chỉ reject structure nếu nó nằm quá gần entry.
// Không còn ép TP phải nằm ngay tại resistance/support
// như core cũ.

const nearestResistance =
    Math.max(
        ...h5.slice(-18,-1)
    )

const nearestSupport =
    Math.min(
        ...l5.slice(-18,-1)
    )

if(side === "LONG"){

    if(
        nearestResistance > entry
    ){

        const distance =
            nearestResistance-entry

        // Nếu resistance nằm trước TP nhưng quá gần,
        // setup không có đủ room.

        if(
            distance < risk * 1.05 &&
            distance < tp-entry
        ){
            return null
        }
    }

}else{

    if(
        nearestSupport < entry
    ){

        const distance =
            entry-nearestSupport

        if(
            distance < risk * 1.05 &&
            distance < entry-tp
        ){
            return null
        }
    }
}

// ================= TIME TARGET =================

// Ước lượng thời gian dự kiến dựa trên ATR15.
// Đây không phải hard guarantee, chỉ là metadata.
//
// ATR15 = biến động trung bình của 15M.
// Target càng lớn -> thời gian dự kiến càng dài.

const tpDistance =
    Math.abs(tp-entry)

const estimated15mBars =
    atr15Safe > 0
        ? tpDistance / atr15Safe
        : 0

const estimatedHours =
    estimated15mBars * 0.25

// Không cho target mang tính "swing dài ngày".

if(
    estimatedHours > 12
){
    return null
}

// ================= DYNAMIC PROFILE =================

let tpProfile = "NORMAL"

if(
    estimatedHours <= 2
){
    tpProfile = "FAST"
}
else if(
    estimatedHours <= 5
){
    tpProfile = "NORMAL"
}
else if(
    estimatedHours <= 8
){
    tpProfile = "EXTENDED"
}
else{
    tpProfile = "MAX_HOLD"
}
const resistance =
    Math.max(
        ...h5.slice(-18,-1)
    )

const support =
    Math.min(
        ...l5.slice(-18,-1)
    )
    // ================= OUTPUT =================

    const round = (n,d=8) =>
        Number(
            Number(n).toFixed(d)
        )

    const volatility =
        atrRatio5 >= 0.004
            ? "HIGH"
            : atrRatio5 <= 0.0012
                ? "LOW"
                : "NORMAL"

    return {

        side,

        price:
            round(entry),

        sl:
            round(sl),

        tp:
            round(tp),

        setup,

        marketState,

        volatility,

        score,

        scoreBreakdown: {

            h1Trend:
                side === "LONG"
                    ? bull1h
                    : bear1h,

            trend15:
                side === "LONG"
                    ? bull15
                    : bear15,

            setup,

            sweep:
                side === "LONG"
                    ? sweepLow
                    : sweepHigh,

            breakoutRetest:
                side === "LONG"
                    ? retestLong
                    : retestShort,

            momentum:
                side === "LONG"
                    ? momentumLong
                    : momentumShort,

            microBreak:
                side === "LONG"
                    ? microBreakLong
                    : microBreakShort,

            bodyRatio:
                round(br0,3),

            volume1m:
                round(vol1Ratio,3),

            volume5m:
                round(vol5Ratio,3),

            rsi1m:
                round(rsi1,2),

            rsi5m:
                round(rsi5,2),

            atrRatio:
                round(atrRatio5,6),

            rr:
                round(finalRR,2)
        },

        indicators: {

            ema20_15:
                round(ema20_15),

            ema50_15:
                round(ema50_15),

            ema20_1h:
                round(ema20_1h),

            ema50_1h:
                round(ema50_1h),

            ema9_5:
                round(ema9_5),

            ema20_5:
                round(ema20_5),

            ema50_5:
                round(ema50_5),

            atr:
                round(atr5),

            atr1m:
                round(atr1),

            rsi:
                round(rsi5,2),

            volumeNow:
                vol1Now,

            volumeAvg:
                vol1Avg,

            volumeRatio:
                round(vol1Ratio,3)
        },

        structure: {

            support,

            resistance,

            recent5Low,

            recent5High,

            structureLow,

            structureHigh,

            microLow,

            microHigh,

            sweepLow,

            sweepHigh
        },

        context: {

            h1Bull:
                bull1h,

            h1Bear:
                bear1h,

            bull15,

            bear15,

            slope1h:
                round(slope1h,6),

            slope15:
                round(slope15,6),

            gap1h:
                round(gap1h,6),

            gap15:
                round(gap15,6),

            move1:
                round(move1,6),

            move3:
                round(move3,6),

            move5:
                round(move5,6),

            longBias,

            shortBias
        },

        risk: {

            risk:
                round(risk),

            rr:
                round(finalRR,2),

            tpDistance:
                round(Math.abs(tp-entry)),

            atr:
                round(atr5),

            atr1m:
                round(atr1)
        },

        debug: {

            reason:
                setup,

            timestamp:
                Date.now(),

            candle: {

                open:
                    round(o0),

                high:
                    round(h0),

                low:
                    round(l0),

                close:
                    round(c0)
            }
        }
    }
}
// ================= SCAN =================

async function scan(symbol){

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

    if(
        !data15 ||
        !data1h ||
        !data5 ||
        !data1m
    ){
        console.log(`❌ No data: ${symbol}`)
        return null
    }

    const r =
        await coreLogic(
            data15,
            data1h,
            data5,
            data1m
        )

    if(!r || !r.side){
        return null
    }

    return {
        symbol,
        ...r
    }
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

                let result =
                    await Promise.race([
                        scan(s),
                        new Promise(resolve =>
                            setTimeout(
                                () => resolve(null),
                                20000
                            )
                        )
                    ])

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

if(
    dbMain.total >= 30 &&
    dbMain.winrate < 0.42
){
    continue
}

let finalMain =
    (s.score * 0.45) +
    aiMain

if(finalMain >= -5){
    candidates.push({
        ...s,
        finalScore: finalMain,
        type: "MAIN"
    })
}
}

// ================= BTC CONTEXT =================

candidates = candidates.filter(c => {

    if(btcRegime === "BULL"){

    if(c.side === "LONG"){
        c.finalScore += 4
    }

    if(c.side === "SHORT"){
        c.finalScore -= 1
    }

    return true
}

if(btcRegime === "BEAR"){

    if(c.side === "SHORT"){
        c.finalScore += 4
    }

    if(c.side === "LONG"){
        c.finalScore -= 1
    }

    return true
}

    // BTC neutral: không can thiệp
    return true
})

        // ===== NO CANDIDATE =====
        if(!candidates || candidates.length === 0){
            console.log("❌ No signal")
            return
        }

        // ===== SORT =====
      candidates.sort((a,b)=>{

    if(a.marketState === "TREND_STRONG" && b.marketState !== "TREND_STRONG") return -1
    if(b.marketState === "TREND_STRONG" && a.marketState !== "TREND_STRONG") return 1

    return b.finalScore - a.finalScore
})
// ===== LỌC TẦNG 2 =====
let filtered = candidates.filter(c => {

    let rr = Math.abs(c.tp - c.price) / Math.abs(c.price - c.sl)

    // ❌ loại kèo quá xấu
    if(rr < RR_THRESHOLD) return false
    return true
})
// ===== SORT LẠI =====
filtered = filtered
    .sort((a,b)=>b.finalScore - a.finalScore)
    //.slice(0, 15)

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

    if(realActive >= 25){
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

    if(existing){
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

let riskPercent =
    RISK_PER_TRADE

let risk =
    balance *
    riskPercent *
    multiplier

// Không cho AI tăng risk quá mức
risk =
    Math.min(
        risk,
        balance * 0.005
    )

if(risk <= 0){
    continue
}

    let diff = Math.abs(best.price - best.sl)
    if(!diff) continue


let trade = {

    // ================= BASIC =================

    symbol:
        best.symbol,

    side:
        best.side,

    entry:
        best.price,

    tp:
        best.tp,

    sl:
        best.sl,

    risk:
        risk,

    rr:
        rr,

    score:
        best.score,

    finalScore:
        best.finalScore,

    // ================= SETUP =================

    setup:
        best.setup,

    marketState:
        best.marketState,

    volatility:
        best.volatility,

    btcRegime,

    // ================= SCORE DETAIL =================

    scoreDetail: {

        h1Trend:
            best.scoreBreakdown.h1Trend,

        trend15:
            best.scoreBreakdown.trend15,

        setup:
            best.scoreBreakdown.setup,

        sweep:
            best.scoreBreakdown.sweep,

        breakoutRetest:
            best.scoreBreakdown.breakoutRetest,

        momentum:
            best.scoreBreakdown.momentum,

        microBreak:
            best.scoreBreakdown.microBreak,

        bodyRatio:
            best.scoreBreakdown.bodyRatio,

        volume1m:
            best.scoreBreakdown.volume1m,

        volume5m:
            best.scoreBreakdown.volume5m,

        rsi1m:
            best.scoreBreakdown.rsi1m,

        rsi5m:
            best.scoreBreakdown.rsi5m,

        atrRatio:
            best.scoreBreakdown.atrRatio,

        rr:
            best.scoreBreakdown.rr
    },

    // ================= INDICATORS =================

    indicators: {

        ema20_15:
            best.indicators.ema20_15,

        ema50_15:
            best.indicators.ema50_15,

        ema20_1h:
            best.indicators.ema20_1h,

        ema50_1h:
            best.indicators.ema50_1h,

        ema9_5:
            best.indicators.ema9_5,

        ema20_5:
            best.indicators.ema20_5,

        ema50_5:
            best.indicators.ema50_5,

        atr:
            best.indicators.atr,

        atr1m:
            best.indicators.atr1m,

        rsi:
            best.indicators.rsi,

        volumeNow:
            best.indicators.volumeNow,

        volumeAvg:
            best.indicators.volumeAvg,

        volumeRatio:
            best.indicators.volumeRatio
    },

    // ================= STRUCTURE =================

    structure: {

        support:
            best.structure.support,

        resistance:
            best.structure.resistance,

        recent5Low:
            best.structure.recent5Low,

        recent5High:
            best.structure.recent5High,

        structureLow:
            best.structure.structureLow,

        structureHigh:
            best.structure.structureHigh,

        microLow:
            best.structure.microLow,

        microHigh:
            best.structure.microHigh,

        sweepLow:
            best.structure.sweepLow,

        sweepHigh:
            best.structure.sweepHigh
    },

    // ================= CONTEXT =================

    context: {

        h1Bull:
            best.context.h1Bull,

        h1Bear:
            best.context.h1Bear,

        bull15:
            best.context.bull15,

        bear15:
            best.context.bear15,

        slope1h:
            best.context.slope1h,

        slope15:
            best.context.slope15,

        gap1h:
            best.context.gap1h,

        gap15:
            best.context.gap15,

        move1:
            best.context.move1,

        move3:
            best.context.move3,

        move5:
            best.context.move5,

        longBias:
            best.context.longBias,

        shortBias:
            best.context.shortBias
    },

    // ================= RISK DETAIL =================

    riskDetail: {

        risk:
            risk,

        rr:
            rr,

        tpDistance:
            best.risk.tpDistance,

        atr:
            best.risk.atr,

        atr1m:
            best.risk.atr1m
    },

    // ================= DEBUG =================

    debug:
        best.debug,

    // ================= TRADE STATE =================

    waitingEntry:
        false,

    breakoutTriggered:
        best.setup === "BREAKOUT_RETEST",

    createdAt:
        Date.now(),

    enteredAt:
        null,

    closedAt:
        null,

    result:
        "PENDING"
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
        ACCOUNT_BALANCE * POSITION_SIZE_PERCENT

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
        continue
    }

    let lotFilter =
        info.filters.find(
            f => f.filterType === "LOT_SIZE"
        )

    //let minNotionalFilter =
    //    info.filters.find(
    //        f => f.filterType === "MIN_NOTIONAL"
    //    )

    let minNotionalFilter =
        info.filters.find(
            f =>
                f.filterType === "MIN_NOTIONAL" ||
                f.filterType === "NOTIONAL"
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
        parseFloat(
            minNotionalFilter?.notional || 5
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

        let execution =
    await openPositionWithTPSL(
        trade,
        qty
    )

if(!execution?.ok){

    console.log(
        `❌ ENTRY FAIL ${trade.symbol}`
    )

    continue
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
        Number(
            execution.initialRisk ||
            Math.abs(
                trade.entry -
                trade.sl
            )
        )

    if(
        !Number.isFinite(trade.initialRisk) ||
        trade.initialRisk <= 0
    ){
        throw new Error(
            `INVALID INITIAL RISK ${trade.symbol}`
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

    trade._id =
        insertResult.insertedId

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

    DB_READY = false

    const ramTrade = {
        ...trade,
        dbSaveFailed: true,
        dbRecoveryNeeded: true
    }

    TPSL_PHASE[trade.symbol] = "ACTIVE"

    activeTrades.push(ramTrade)

    console.error(
        `🚨 DB SAVE FAIL ${trade.symbol}`
    )

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
            `⚖️ RR: ${trade.rr.toFixed(2)}\n` +
            `🧠 Setup: ${trade.setup}\n` +
            `⭐ Score: ${trade.score}\n` +
            `🏆 Final: ${trade.finalScore.toFixed(1)}\n` +
            `💰 Risk: ${trade.risk.toFixed(4)}`

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



    console.log(`✅ ADD: ${best.symbol} | Score: ${best.finalScore.toFixed(1)}`)
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

let positions = []

try{
    positions = await getPositionsCached()
}catch(e){
    console.log("⚠ POSITION VERIFY FAIL")
}

let realPos = positions.find(p =>
    p.symbol === t.symbol &&
    Math.abs(parseFloat(p.positionAmt || "0")) > 0
)

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
let isTimeout =
    t.enteredAt &&
    Date.now() - t.enteredAt > 86400000 //43200000 // 12h

if(isTimeout){

    console.log(`⏳ TIMEOUT CLOSE ${t.symbol}`)
    // ===== CHECK POSITION THẬT =====
    let positions = []
    try{
        positions = await getPositionsCached()
    }catch(e){
        console.log("⚠ TIMEOUT POSITION FAIL")
    }
    let realPos = positions.find(p =>
        p.symbol === t.symbol &&
        Math.abs(parseFloat(p.positionAmt || "0")) > 0
    )
    // ===== NẾU CÒN POSITION -> CLOSE =====
    if(realPos){
        let realQty = Math.abs(parseFloat(realPos.positionAmt || "0"))
        let closed = await closePosition(
    t.symbol,
    t.side,
    realQty
)

if(closed){
    console.log(`✅ AUTO CLOSED ${t.symbol}`)
}else{
    console.log(`❌ AUTO CLOSE FAIL ${t.symbol}`)
    continue
}
    }
    // ===== UPDATE DB =====
    await trades.updateOne(
        {
            symbol: t.symbol,
            createdAt: t.createdAt
        },
        {
            $set:{
                result:"TIMEOUT_CLOSED"
            }
        }
    )
    // ===== TELEGRAM =====
    await sendTelegram2(
`⏳ AUTO CLOSE TIMEOUT
${t.symbol}
${t.side} | ₿ : ${t.btcRegime}`
    )
    delete DATA_FAILS[t.symbol]

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
            `📊 ${t.symbol} (${t.setup})
${t.side} | ₿ : ${t.btcRegime}
${isWin ? "✅ WIN" : "❌ LOSS"}
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

                const exists =
                    activeTrades.some(
                        t =>
                            t?.symbol === symbol &&
                            t.result === "PENDING"
                    )

                if(!exists){

                    activeTrades.push(dbTrade)
                }

                TPSL_PHASE[symbol] = "ACTIVE"

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
        // ==================================================
        let dbOK = false
        try{
            console.log("🔌 Connecting MongoDB...")
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
                    projection: { _id: 1 }
                }
            )
            dbOK = true
            console.log("🟢 MongoDB CONNECTED + VERIFIED")
        }catch(e){
            console.error(
                "🔴 MongoDB CONNECTION FAILED:",
                e.message
            )
            dbOK = false
        }
        // ==================================================
        // 3. KHÔNG CÓ DB -> KHÔNG CHẠY BOT
        // ==================================================
        if(!dbOK){
            console.log(
                "🛑 BOT STOPPED: MongoDB unavailable"
            )
            return
        }
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
    30000
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
                if(scanning){
                    console.log(
                        "⛔ Scanner already running"
                    )
                    await new Promise(r =>
                        setTimeout(r, 5000)
                    )
                    continue
                }
                scanning = true
                try{
                    await scanner()
                }catch(e){
                    console.error(
                        "❌ SCANNER LOOP:",
                        e.message
                    )
                }finally{
                    scanning = false
                }
                // scan mỗi 2 phút
                await new Promise(r =>
                    setTimeout(r, 120000)
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
        // Quan trọng:
        // Không chạy scanner nếu start thất bại.
        return
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

async function runDynamicTPSL(){

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

process.on("exit", cleanup)
process.on("SIGINT", () => { cleanup(); process.exit() })
process.on("SIGTERM", () => { cleanup(); process.exit() })
