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

const TRADE_CONFIG = {
    riskPerTrade: 0.02,      
    maxRiskPerTrade: 0.02,    
    maxPositionPercent: 3.0,  
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

async function manageDynamicTPSL(trade){

try{

    if(!trade)return
    if(!trade.symbol||!trade.side)return

    const symbol=trade.symbol
    const side=String(trade.side).toUpperCase()

    if(side!=="LONG"&&side!=="SHORT")return
    if(TPSL_CLOSING[symbol])return
    if(TPSL_PENDING[symbol])return

    const entryTime=Number(
        trade.enteredAt||
        trade.openedAt||
        trade.createdAt
    )

    if(
        !Number.isFinite(entryTime)||
        entryTime<=0
    ){
        return
    }

    const now=Date.now()

    if(now-entryTime<90000){
        return
    }

    TPSL_PENDING[symbol]=true

    const pos=await hasPosition(symbol)

    if(!pos){

        delete DYNAMIC_LAST_UPDATE[symbol]
        delete DYNAMIC_PHASE[symbol]

        return
    }

    const[
        data15,
        data5
    ]=await Promise.all([
        getData(symbol,"15m",160),
        getData(symbol,"5m",160)
    ])

    if(
        !Array.isArray(data15)||
        !Array.isArray(data5)||
        data15.length<80||
        data5.length<80
    ){
        return
    }

    const closed15=data15.slice(0,-1)
    const closed5=data5.slice(0,-1)

    if(
        closed15.length<60||
        closed5.length<60
    ){
        return
    }

    const h5=closed5.map(x=>Number(x[2]))
    const l5=closed5.map(x=>Number(x[3]))
    const c5=closed5.map(x=>Number(x[4]))

    if(
        h5.some(x=>!Number.isFinite(x))||
        l5.some(x=>!Number.isFinite(x))||
        c5.some(x=>!Number.isFinite(x))
    ){
        return
    }

    const current=Number(
        pos.markPrice||
        pos.entryPrice||
        trade.entry
    )

    const currentEntry=Number(
        pos.entryPrice||
        trade.entry
    )

    if(
        !Number.isFinite(current)||
        current<=0||
        !Number.isFinite(currentEntry)||
        currentEntry<=0
    ){
        return
    }

    const oldSL=Number(trade.sl)
    const oldTP=Number(trade.tp)

    if(
        !Number.isFinite(oldSL)||
        !Number.isFinite(oldTP)||
        oldSL<=0||
        oldTP<=0
    ){
        return
    }

    let initialRisk=Number(trade.initialRisk)

    if(
        !Number.isFinite(initialRisk)||
        initialRisk<=0
    ){

        const fallbackEntry=Number(
            trade.entry||currentEntry
        )

        const fallbackSL=Number(trade.sl)

        if(
            !Number.isFinite(fallbackEntry)||
            !Number.isFinite(fallbackSL)||
            fallbackEntry<=0||
            fallbackSL<=0
        ){
            return
        }

        initialRisk=Math.abs(
            fallbackEntry-fallbackSL
        )

        if(
            !Number.isFinite(initialRisk)||
            initialRisk<=0
        ){
            return
        }

        await trades.updateOne(
            {
                symbol,
                result:"PENDING"
            },
            {
                $set:{
                    initialRisk,
                    updatedAt:Date.now()
                }
            }
        )
    }

    const originalSL=
        side==="LONG"
            ?currentEntry-initialRisk
            :currentEntry+initialRisk

    if(
        !Number.isFinite(originalSL)||
        originalSL<=0
    ){
        return
    }

    const atrRaw=atr(
        closed15.slice(-80)
    )

    const atr15=
        Number.isFinite(atrRaw)&&atrRaw>0
            ?atrRaw
            :current*.003

    if(
        !Number.isFinite(atr15)||
        atr15<=0
    ){
        return
    }

    const profit=
        side==="LONG"
            ?current-currentEntry
            :currentEntry-current

    const R=profit/initialRisk

    if(!Number.isFinite(R)){
        return
    }

    // =========================================================
// STRUCTURE WINDOWS
// =========================================================

const recentHigh=Math.max(
    ...h5.slice(-13,-1)
)

const recentLow=Math.min(
    ...l5.slice(-13,-1)
)

const previousHigh=Math.max(
    ...h5.slice(-25,-13)
)

const previousLow=Math.min(
    ...l5.slice(-25,-13)
)

const runnerHigh=Math.max(
    ...h5.slice(-49,-1)
)

const runnerLow=Math.min(
    ...l5.slice(-49,-1)
)


// =========================================================
// CONFIRMED 5M SWING
//
// Không dùng wick đơn lẻ làm structure trailing.
//
// Swing Low:
//
//        candle
//           ↓
//      \    ↓    /
//       \   ↓   /
//        \_____/
//
// Phải có 2 candle xác nhận bên phải.
//
// Swing High ngược lại.
//
// Chỉ lấy swing trong vùng 5M gần đây.
// =========================================================

function getConfirmedSwingLow(highs,lows,closes){

    const start=Math.max(2,lows.length-30)
    const end=lows.length-3

    for(let i=end;i>=start;i--){

        const left1=lows[i-1]
        const left2=lows[i-2]
        const current=lows[i]
        const right1=lows[i+1]
        const right2=lows[i+2]

        if(
            !Number.isFinite(left1)||
            !Number.isFinite(left2)||
            !Number.isFinite(current)||
            !Number.isFinite(right1)||
            !Number.isFinite(right2)
        ){
            continue
        }

        if(
            current<left1&&
            current<=left2&&
            current<right1&&
            current<=right2
        ){
            return current
        }
    }

    return null
}


function getConfirmedSwingHigh(highs,lows,closes){

    const start=Math.max(2,highs.length-30)
    const end=highs.length-3

    for(let i=end;i>=start;i--){

        const left1=highs[i-1]
        const left2=highs[i-2]
        const current=highs[i]
        const right1=highs[i+1]
        const right2=highs[i+2]

        if(
            !Number.isFinite(left1)||
            !Number.isFinite(left2)||
            !Number.isFinite(current)||
            !Number.isFinite(right1)||
            !Number.isFinite(right2)
        ){
            continue
        }

        if(
            current>left1&&
            current>=left2&&
            current>right1&&
            current>=right2
        ){
            return current
        }
    }

    return null
}


const confirmedSwingLow=
    getConfirmedSwingLow(
        h5,
        l5,
        c5
    )

const confirmedSwingHigh=
    getConfirmedSwingHigh(
        h5,
        l5,
        c5
    )


// =========================================================
// TRAILING STRUCTURE
//
// Nếu chưa có confirmed swing thì fallback
// về recent structure cũ.
//
// Như vậy không làm bot mất khả năng trailing
// chỉ vì thiếu swing.
// =========================================================

const trailingLow=
    Number.isFinite(confirmedSwingLow)
        ?confirmedSwingLow
        :recentLow

const trailingHigh=
    Number.isFinite(confirmedSwingHigh)
        ?confirmedSwingHigh
        :recentHigh

    if(
        !Number.isFinite(recentHigh)||
        !Number.isFinite(recentLow)||
        !Number.isFinite(previousHigh)||
        !Number.isFinite(previousLow)||
        !Number.isFinite(runnerHigh)||
        !Number.isFinite(runnerLow)
    ){
        return
    }

    const last5Close=c5.at(-1)

    if(!Number.isFinite(last5Close)){
        return
    }

    // =========================================================
    // STRUCTURE
    // =========================================================

    const breakoutLong=
        last5Close>previousHigh

    const breakoutShort=
        last5Close<previousLow

    const higherLowLong=
        recentLow>previousLow

    const lowerHighShort=
        recentHigh<previousHigh

    const reclaimLong=
        last5Close>recentHigh

    const reclaimShort=
        last5Close<recentLow

    const structureLong=
        breakoutLong||
        (
            higherLowLong&&
            reclaimLong
        )

    const structureShort=
        breakoutShort||
        (
            lowerHighShort&&
            reclaimShort
        )

    // =========================================================
    // PHASE
    // =========================================================

    let phase=0

    if(R>=3.00){

        phase=4

    }else if(R>=2.20){

        phase=3

    }else if(R>=1.60){

        phase=2

    }else if(R>=1.20){

        phase=1
    }

    const previousPhase=
        Number(
            DYNAMIC_PHASE[symbol]||0
        )

    const effectivePhase=
        Math.max(
            previousPhase,
            phase
        )

    DYNAMIC_PHASE[symbol]=
        effectivePhase

    let newSL=oldSL
    let newTP=oldTP

    // =========================================================
    // PHASE 1
    //
    // 1.20R
    //
    // CHO THỞ.
    // Không kéo SL sát entry.
    // =========================================================

    if(
        effectivePhase>=1
    ){

        if(
            side==="LONG"&&
            structureLong
        ){

            const structureSL=
                trailingLow-
                atr15*.45

            const profitFloor=
                currentEntry+
                initialRisk*.02

            const candidate=
                Math.max(
                    structureSL,
                    profitFloor
                )

            if(
                candidate>newSL&&
                candidate<current
            ){
                newSL=candidate
            }

        }else if(
            side==="SHORT"&&
            structureShort
        ){

            const structureSL=
                trailingHigh+
                atr15*.45

            const profitFloor=
                currentEntry-
                initialRisk*.02

            const candidate=
                Math.min(
                    structureSL,
                    profitFloor
                )

            if(
                candidate<newSL&&
                candidate>current
            ){
                newSL=candidate
            }
        }
    }

    // =========================================================
    // PHASE 2
    //
    // 1.60R
    //
    // LOCK NHẸ + VẪN CHO THỞ.
    // =========================================================

    if(
        effectivePhase>=2
    ){

        if(
            side==="LONG"&&
            structureLong
        ){

            const structureSL=
                trailingLow-
                atr15*.40

            const profitFloor=
                currentEntry+
                initialRisk*.20

            const candidate=
                Math.max(
                    structureSL,
                    profitFloor
                )

            if(
                candidate>newSL&&
                candidate<current
            ){
                newSL=candidate
            }

        }else if(
            side==="SHORT"&&
            structureShort
        ){

            const structureSL=
                trailingHigh+
                atr15*.40

            const profitFloor=
                currentEntry-
                initialRisk*.20

            const candidate=
                Math.min(
                    structureSL,
                    profitFloor
                )

            if(
                candidate<newSL&&
                candidate>current
            ){
                newSL=candidate
            }
        }
    }

    // =========================================================
    // PHASE 3
    //
    // 2.20R
    //
    // STRUCTURE TRAILING.
    // =========================================================

    if(
        effectivePhase>=3
    ){

        if(side==="LONG"){

            const structureSL=
                trailingLow-
                atr15*.35

            const profitFloor=
                currentEntry+
                initialRisk*.60

            const candidate=
                Math.max(
                    structureSL,
                    profitFloor
                )

            if(
                candidate>newSL&&
                candidate<current
            ){
                newSL=candidate
            }

        }else{

            const structureSL=
                trailingHigh+
                atr15*.35

            const profitFloor=
                currentEntry-
                initialRisk*.60

            const candidate=
                Math.min(
                    structureSL,
                    profitFloor
                )

            if(
                candidate<newSL&&
                candidate>current
            ){
                newSL=candidate
            }
        }
    }

    // =========================================================
    // PHASE 4
    //
    // 3R+
    //
    // RUNNER.
    // =========================================================

    if(
        effectivePhase>=4
    ){

        if(side==="LONG"){

            const runnerSL=
                runnerLow-
                atr15*.30

            const profitFloor=
                currentEntry+
                initialRisk*.95

            const candidate=
                Math.max(
                    runnerSL,
                    profitFloor
                )

            if(
                candidate>newSL&&
                candidate<current
            ){
                newSL=candidate
            }

        }else{

            const runnerSL=
                runnerHigh+
                atr15*.30

            const profitFloor=
                currentEntry-
                initialRisk*.95

            const candidate=
                Math.min(
                    runnerSL,
                    profitFloor
                )

            if(
                candidate<newSL&&
                candidate>current
            ){
                newSL=candidate
            }
        }
    }

    // =========================================================
    // BREAKOUT TRAILING
    //
    // Chỉ khi breakout thật sự.
    // =========================================================

    if(R>=1.80){

        if(
            side==="LONG"&&
            breakoutLong
        ){

            const breakoutSL=
                previousHigh-
                atr15*.40

            if(
                breakoutSL>newSL&&
                breakoutSL<current
            ){
                newSL=breakoutSL
            }

        }else if(
            side==="SHORT"&&
            breakoutShort
        ){

            const breakoutSL=
                previousLow+
                atr15*.40

            if(
                breakoutSL<newSL&&
                breakoutSL>current
            ){
                newSL=breakoutSL
            }
        }
    }

    // =========================================================
    // ORIGINAL SL PROTECTION
    // =========================================================

    if(side==="LONG"){

        if(newSL<originalSL){
            newSL=originalSL
        }

    }else{

        if(newSL>originalSL){
            newSL=originalSL
        }
    }

    // =========================================================
    // NEVER MOVE SL BACKWARD
    // =========================================================

    if(side==="LONG"){

        if(newSL<oldSL){
            newSL=oldSL
        }

    }else{

        if(newSL>oldSL){
            newSL=oldSL
        }
    }

    // =========================================================
    // SL MUST STAY BEHIND PRICE
    // =========================================================

    if(side==="LONG"){

        if(newSL>=current){
            newSL=oldSL
        }

    }else{

        if(newSL<=current){
            newSL=oldSL
        }
    }

    // =========================================================
// DYNAMIC TP - EXTREME RUNNER
//
// TP KHÔNG PHẢI CƠ CHẾ CHỐT LỜI CHÍNH.
//
// Dynamic SL = chốt lời thực tế
// 24H        = hard exit
// Dynamic TP = safety cap cực xa
//
// MỤC TIÊU:
// - Không để wick/spike bình thường hit TP
// - TP luôn nằm rất xa phía trước giá
// - Volatility càng mạnh -> TP càng xa
// - TP chỉ được mở rộng, tuyệt đối không thu hẹp
// =========================================================

// =========================================================
// ATR 5M
//
// ATR15 phản ứng chậm với spike.
// ATR5 phản ứng nhanh hơn với volatility hiện tại.
// =========================================================

const atr5Raw =
    atr(
        closed5.slice(-80)
    )

const atr5 =
    Number.isFinite(atr5Raw)&&
    atr5Raw>0
        ?atr5Raw
        :atr15

// =========================================================
// VOLATILITY FOR TP
//
// Không dùng ATR15 đơn độc.
// Khi 5M giật mạnh -> khoảng cách TP tự động tăng.
// =========================================================

const tpVolatility =
    Math.max(
        atr15,
        atr5*1.50
    )

if(
    !Number.isFinite(tpVolatility)||
    tpVolatility<=0
){
    return
}

// =========================================================
// SPIKE DETECTION
//
// Nếu candle 5M gần nhất có range cực lớn,
// không cho TP nằm gần giá.
// =========================================================

const last5High=
    h5.at(-1)

const last5Low=
    l5.at(-1)

const last5Range=
    last5High-last5Low

let spikeMultiplier=1

if(
    Number.isFinite(last5Range)&&
    last5Range>tpVolatility*2.0
){
    spikeMultiplier=1.50
}

if(
    Number.isFinite(last5Range)&&
    last5Range>tpVolatility*3.0
){
    spikeMultiplier=2.00
}

if(
    Number.isFinite(last5Range)&&
    last5Range>tpVolatility*4.0
){
    spikeMultiplier=2.50
}

// =========================================================
// RUNNER DISTANCE
//
// TP cực xa.
// Không dùng targetR cố định nữa.
//
// R càng lớn -> TP càng xa.
// =========================================================

let runnerATR=5.0

if(R>=1.50){
    runnerATR=6.0
}

if(R>=2.50){
    runnerATR=7.0
}

if(R>=3.50){
    runnerATR=8.0
}

if(R>=5.00){
    runnerATR=10.0
}

// =========================================================
// VOLATILITY ADAPTATION
// =========================================================

const volatilityDistance=
    tpVolatility*
    runnerATR*
    spikeMultiplier

// =========================================================
// RISK DISTANCE
//
// Không cho initialRisk quá nhỏ làm TP quá gần.
// =========================================================

const riskDistance=
    initialRisk*
    (
        R>=5
            ?8.0
            :R>=3
                ?6.0
                :R>=1.5
                    ?5.0
                    :4.0
    )

// =========================================================
// FINAL MINIMUM DISTANCE
// =========================================================

const minimumTPDistance=
    Math.max(
        volatilityDistance,
        riskDistance
    )

// =========================================================
// TARGET
// =========================================================

const runnerTP=
    side==="LONG"
        ?current+
            minimumTPDistance
        :current-
            minimumTPDistance

// =========================================================
// EXTEND TP ONLY
//
// LONG:
// TP chỉ được tăng.
//
// SHORT:
// TP chỉ được giảm.
// =========================================================

if(side==="LONG"){

    if(
        Number.isFinite(runnerTP)&&
        runnerTP>newTP&&
        runnerTP>current
    ){
        newTP=runnerTP
    }

}else{

    if(
        Number.isFinite(runnerTP)&&
        runnerTP<newTP&&
        runnerTP<current
    ){
        newTP=runnerTP
    }
}

// =========================================================
// STRUCTURE EXTENSION
//
// Structure KHÔNG được kéo TP gần lại.
// Chỉ dùng để mở rộng thêm.
// =========================================================

if(effectivePhase>=2){

    if(side==="LONG"){

        const structureTP=
            runnerHigh+
            tpVolatility*2.0

        if(
            Number.isFinite(structureTP)&&
            structureTP>newTP&&
            structureTP>current
        ){
            newTP=structureTP
        }

    }else{

        const structureTP=
            runnerLow-
            tpVolatility*2.0

        if(
            Number.isFinite(structureTP)&&
            structureTP<newTP&&
            structureTP<current
        ){
            newTP=structureTP
        }
    }
}

// =========================================================
// EXTREME RUNNER
//
// Khi R >= 3:
// TP phải càng ngày càng xa.
// =========================================================

if(R>=3){

    const extremeDistance=
        Math.max(
            tpVolatility*9.0,
            initialRisk*7.0
        )

    const extremeTP=
        side==="LONG"
            ?current+
                extremeDistance
            :current-
                extremeDistance

    if(side==="LONG"){

        if(
            Number.isFinite(extremeTP)&&
            extremeTP>newTP
        ){
            newTP=extremeTP
        }

    }else{

        if(
            Number.isFinite(extremeTP)&&
            extremeTP<newTP
        ){
            newTP=extremeTP
        }
    }
}

// =========================================================
// NEVER MOVE TP BACKWARD
// =========================================================

if(side==="LONG"){

    if(newTP<oldTP){
        newTP=oldTP
    }

}else{

    if(newTP>oldTP){
        newTP=oldTP
    }
}

// =========================================================
// TP MUST STAY AHEAD
// =========================================================

if(side==="LONG"){

    if(newTP<=current){

        newTP=
            current+
            minimumTPDistance
    }

}else{

    if(newTP>=current){

        newTP=
            current-
            minimumTPDistance
    }
}

// =========================================================
// FINAL EXTREME DISTANCE PROTECTION
//
// Nếu TP vẫn còn quá gần giá vì bất kỳ lý do nào,
// ép nó ra xa lần cuối.
//
// Đây là lớp chống TP bị ăn bởi wick.
// =========================================================

const finalSafetyDistance=
    Math.max(
        tpVolatility*5.0,
        initialRisk*4.0
    )

if(side==="LONG"){

    const safetyTP=
        current+
        finalSafetyDistance

    if(newTP<safetyTP){

        newTP=safetyTP
    }

}else{

    const safetyTP=
        current-
        finalSafetyDistance

    if(newTP>safetyTP){

        newTP=safetyTP
    }
}

    // =========================================================
    // FINAL VALIDATION
    // =========================================================

    if(
        !Number.isFinite(newSL)||
        !Number.isFinite(newTP)||
        newSL<=0||
        newTP<=0
    ){
        return
    }

    if(side==="LONG"){

        if(newSL<originalSL){
            newSL=originalSL
        }

        if(newSL<oldSL){
            newSL=oldSL
        }

        if(newSL>=current){
            newSL=oldSL
        }

        if(newTP<oldTP){
            newTP=oldTP
        }

        if(newTP<=current){
            newTP=oldTP
        }

    }else{

        if(newSL>originalSL){
            newSL=originalSL
        }

        if(newSL>oldSL){
            newSL=oldSL
        }

        if(newSL<=current){
            newSL=oldSL
        }

        if(newTP>oldTP){
            newTP=oldTP
        }

        if(newTP>=current){
            newTP=oldTP
        }
    }

    // =========================================================
    // MINIMUM CHANGE
    // =========================================================
    const info=await getSymbolInfo(symbol)

const priceFilter=
    info?.filters?.find(
        f=>f.filterType==="PRICE_FILTER"
    )

const tickSize=
    Number(priceFilter?.tickSize)

if(
    !Number.isFinite(tickSize)||
    tickSize<=0
){
    return
}

const precision=
    Math.max(
        0,
        String(tickSize).split(".")[1]?.length||0
    )

if(side==="LONG"){
    newSL=Math.ceil(newSL/tickSize)*tickSize
    newTP=Math.ceil(newTP/tickSize)*tickSize
}else{
    newSL=Math.floor(newSL/tickSize)*tickSize
    newTP=Math.floor(newTP/tickSize)*tickSize
}

newSL=Number(newSL.toFixed(precision))
newTP=Number(newTP.toFixed(precision))

if(side==="LONG"&&newSL<oldSL)newSL=oldSL
if(side==="SHORT"&&newSL>oldSL)newSL=oldSL

newSL=Number(newSL.toFixed(precision))
newTP=Number(newTP.toFixed(precision))

    const minimumChange=
        Math.max(
            currentEntry*.00005,
            atr15*.03
        )

    const slChanged=
        Math.abs(newSL-oldSL)>=minimumChange

    const tpChanged=
        Math.abs(newTP-oldTP)>=minimumChange

    if(
        !slChanged&&
        !tpChanged
    ){
        return
    }

    // =========================================================
    // UPDATE TRADE
    // =========================================================

    const updateTrade={
        ...trade,
        symbol,
        side,
        entry:currentEntry,
        sl:newSL,
        tp:newTP,
        initialRisk,
        previousSL:oldSL
    }

    console.log(
        `🎯 DYNAMIC ${symbol} `+
        `${side} `+
        `R=${R.toFixed(2)} `+
        `PHASE=${effectivePhase} `+
        `SL ${oldSL}->${newSL} `+
        `TP ${oldTP}->${newTP}`
    )

    // =========================================================
    // BINANCE
    // =========================================================

    try{

        const result=
            await setDynamicTPSL(
                updateTrade
            )

        if(!result?.ok){

            console.log(
                `⚠️ DYNAMIC TPSL FAILED ${symbol}`
            )

            return
        }

        const finalSL=
            Number(result.sl)

        const finalTP=
            Number(result.tp)

        if(
            !Number.isFinite(finalSL)||
            !Number.isFinite(finalTP)||
            finalSL<=0||
            finalTP<=0
        ){
            return
        }

        // =====================================================
        // RESULT PROTECTION
        // =====================================================

        if(side==="LONG"){

            if(finalSL<originalSL){

                console.log(
                    `🚨 REJECT WIDEN SL ${symbol}`
                )

                return
            }

            if(finalSL<oldSL){

                console.log(
                    `🚨 REJECT BACKWARD SL ${symbol}`
                )

                return
            }

            if(finalTP<oldTP){

                console.log(
                    `🚨 REJECT BACKWARD TP ${symbol}`
                )

                return
            }

        }else{

            if(finalSL>originalSL){

                console.log(
                    `🚨 REJECT WIDEN SL ${symbol}`
                )

                return
            }

            if(finalSL>oldSL){

                console.log(
                    `🚨 REJECT BACKWARD SL ${symbol}`
                )

                return
            }

            if(finalTP>oldTP){

                console.log(
                    `🚨 REJECT BACKWARD TP ${symbol}`
                )

                return
            }
        }

        // =====================================================
        // MEMORY
        // =====================================================

        trade.sl=finalSL
        trade.tp=finalTP

        DYNAMIC_LAST_UPDATE[symbol]=
            Date.now()

        DYNAMIC_PHASE[symbol]=
            Math.max(
                Number(
                    DYNAMIC_PHASE[symbol]||0
                ),
                effectivePhase
            )

        // =====================================================
        // DB
        // =====================================================

        const dbResult=
            await trades.updateOne(
                {
                    symbol,
                    result:"PENDING"
                },
                {
                    $set:{
                        sl:finalSL,
                        tp:finalTP,
                        initialRisk,
                        dynamicPhase:
                            DYNAMIC_PHASE[symbol],
                        dynamicUpdatedAt:
                            Date.now(),
                        updatedAt:
                            Date.now()
                    }
                }
            )

        if(
            dbResult.matchedCount===0
        ){

            console.log(
                `⚠️ DYNAMIC DB NOT FOUND ${symbol}`
            )

            return
        }

        console.log(
            `💾 DYNAMIC TPSL SAVED `+
            `${symbol} `+
            `R=${R.toFixed(2)} `+
            `PHASE=${effectivePhase} `+
            `SL=${finalSL} `+
            `TP=${finalTP}`
        )

    }catch(e){

        await checkTimeError(e)

        console.log(
            `❌ DYNAMIC TPSL ERROR `+
            `${symbol}:`,
            e.message
        )
    }

}catch(e){

    await checkTimeError(e)

    console.log(
        `❌ MANAGE DYNAMIC TPSL ERROR `+
        `${trade?.symbol||"UNKNOWN"}:`,
        e.message
    )

}finally{

    if(trade?.symbol){
        delete TPSL_PENDING[trade.symbol]
    }
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
                        .slice(0, 120)
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
    // =========================================================
    // 0. VALIDATION
    // =========================================================

    if (
        !Array.isArray(data15) ||
        !Array.isArray(data1h) ||
        !Array.isArray(data5) ||
        !Array.isArray(data1m)
    ) return reject("VALIDATION")

    // Bỏ candle đang chạy
    data15 = data15.slice(0, -1)
    data1h = data1h.slice(0, -1)
    data5  = data5.slice(0, -1)
    data1m = data1m.slice(0, -1)

    if (
        data15.length < 120 ||
        data1h.length < 100 ||
        data5.length < 100 ||
        data1m.length < 100
    ) {
    return reject("DATA_LENGTH", {
        data15: data15.length,
        data1h: data1h.length,
        data5: data5.length,
        data1m: data1m.length
    })
}

    const col = (data, n) =>
        data.map(x => Number(x[n]))

    const o15 = col(data15, 1)
    const h15 = col(data15, 2)
    const l15 = col(data15, 3)
    const c15 = col(data15, 4)

    const o1h = col(data1h, 1)
    const h1h = col(data1h, 2)
    const l1h = col(data1h, 3)
    const c1h = col(data1h, 4)

    const o5 = col(data5, 1)
    const h5 = col(data5, 2)
    const l5 = col(data5, 3)
    const c5 = col(data5, 4)
    const v5 = col(data5, 5)

    const o1 = col(data1m, 1)
    const h1 = col(data1m, 2)
    const l1 = col(data1m, 3)
    const c1 = col(data1m, 4)
    const v1 = col(data1m, 5)

    const all = [
        o15, h15, l15, c15,
        o1h, h1h, l1h, c1h,
        o5, h5, l5, c5, v5,
        o1, h1, l1, c1, v1
    ]

    if (
        all.flat().some(
            x => !Number.isFinite(x)
        )
    ) {
        return reject("INVALID_DATA")
    }

    const price = c1.at(-1)

    if (
        !Number.isFinite(price) ||
        price <= 0
    ) {
        return reject("INVALID_DATA")
    }

    // =========================================================
    // HELPERS
    // =========================================================

    const avg = arr =>
        arr.length
            ? arr.reduce(
                (sum, x) => sum + x,
                0
            ) / arr.length
            : 0

    const highest = (arr, n) =>
        arr.length >= n
            ? Math.max(...arr.slice(-n))
            : Math.max(...arr)

    const lowest = (arr, n) =>
        arr.length >= n
            ? Math.min(...arr.slice(-n))
            : Math.min(...arr)

    const range = (h, l) =>
        Math.max(h - l, 0)

    const bodyRatio = (o, h, l, c) => {

        const r = range(h, l)

        return r > 0
            ? Math.abs(c - o) / r
            : 0
    }

    const closeLocationLong = (h, l, c) => {

        const r = range(h, l)

        return r > 0
            ? (c - l) / r
            : 0
    }

    const closeLocationShort = (h, l, c) => {

        const r = range(h, l)

        return r > 0
            ? (h - c) / r
            : 0
    }

    const pct = (a, b) =>
        b !== 0
            ? (a - b) / b
            : 0

    const round = (n, d = 8) =>
        Number(
            Number(n).toFixed(d)
        )

    // =========================================================
    // 1. ATR
    // =========================================================

    const atr1hRaw =
        atr(data1h.slice(-80))

    const atr15Raw =
        atr(data15.slice(-80))

    const atr5Raw =
        atr(data5.slice(-80))

    const atr1Raw =
        atr(data1m.slice(-80))

    const atr1h =
        Number.isFinite(atr1hRaw) &&
        atr1hRaw > 0
            ? atr1hRaw
            : price * 0.004

    const atr15 =
        Number.isFinite(atr15Raw) &&
        atr15Raw > 0
            ? atr15Raw
            : price * 0.002

    const atr5 =
        Number.isFinite(atr5Raw) &&
        atr5Raw > 0
            ? atr5Raw
            : price * 0.001

    const atr1 =
        Number.isFinite(atr1Raw) &&
        atr1Raw > 0
            ? atr1Raw
            : price * 0.0005

    const atrRatio1h =
        atr1h / price

    const atrRatio15 =
        atr15 / price

    const atrRatio5 =
        atr5 / price

    if (
        !Number.isFinite(atrRatio5) ||
        atrRatio5 <= 0 ||
        atrRatio5 > 0.025
    ) {
    return reject("ATR5", {
        atrRatio5: round(atrRatio5, 6)
    })
}
// =========================================================
// 2. 1H DIRECTION
//
// 1H chỉ xác định phe.
// Cho phép giá pullback nhẹ quanh EMA20.
// =========================================================

const ema20_1h =
    ema(c1h.slice(-60), 20)

const ema50_1h =
    ema(c1h.slice(-90), 50)

const ema20_1hPrev =
    ema(c1h.slice(-61, -1), 20)

const price1h =
    c1h.at(-1)

const slope1h =
    pct(
        ema20_1h,
        ema20_1hPrev
    )

const gap1h =
    Math.abs(
        ema20_1h - ema50_1h
    ) / price1h

// Nới 1H:
// Không bắt giá phải nằm đúng phía EMA20.
// Chỉ cần EMA20/EMA50 xác nhận hướng,
// hoặc giá đang pullback rất gần EMA20.

const bull1h =
    ema20_1h > ema50_1h &&
    (
        slope1h > -0.0008 &&
        price1h >= ema20_1h * 0.994
    )

const bear1h =
    ema20_1h < ema50_1h &&
    (
        slope1h < 0.0008 &&
        price1h <= ema20_1h * 1.006
    )

if (
    !bull1h &&
    !bear1h
) {
    return reject("1H_DIRECTION", {
        price1h: round(price1h),
        ema20: round(ema20_1h),
        ema50: round(ema50_1h),
        slope: round(slope1h, 6),
        gap: round(gap1h, 6)
    })
}
    // =========================================================
    // 3. 15M TREND
    // =========================================================

    const ema20_15 =
        ema(c15.slice(-70), 20)

    const ema50_15 =
        ema(c15.slice(-110), 50)

    const ema20_15Prev =
        ema(c15.slice(-71, -1), 20)

    const price15 =
        c15.at(-1)

    const slope15 =
        pct(
            ema20_15,
            ema20_15Prev
        )

    const gap15 =
        Math.abs(
            ema20_15 -
            ema50_15
        ) / price15

    const bull15 =
    ema20_15 > ema50_15 &&
    slope15 > -0.0003 &&
    price15 >= ema20_15 * 0.993
    
    const bear15 =
    ema20_15 < ema50_15 &&
    slope15 < 0.0003 &&
    price15 <= ema20_15 * 1.007

const longBias =
    bull15 &&
    (
        bull1h ||
        (
            ema20_1h > ema50_1h &&
            price1h >= ema20_1h * 0.990
        ) ||
        (
            price1h >= ema20_1h * 0.985 &&
            slope15 > 0
        )
    )

const shortBias =
    bear15 &&
    (
        bear1h ||
        (
            ema20_1h < ema50_1h &&
            price1h <= ema20_1h * 1.010
        ) ||
        (
            price1h <= ema20_1h * 1.015 &&
            slope15 < 0
        )
    )
    if (
    !longBias &&
    !shortBias
) {
    return reject("BIAS", {
        bull1h,
        bear1h,
        bull15,
        bear15,
        longBias,
        shortBias,
        slope1h: round(slope1h, 6),
        slope15: round(slope15, 6),
        gap1h: round(gap1h, 6),
        gap15: round(gap15, 6)
    })
}
const coreSide =
    longBias
        ? "LONG"
        : shortBias
            ? "SHORT"
            : "NONE"
    // =========================================================
    // 4. 15M STRUCTURE
    //
    // Không yêu cầu structure quá cứng.
    // Chỉ cần structure không đi ngược trend.
    // =========================================================

    const structureHigh15 =
        highest(
            h15.slice(0, -2),
            24
        )

    const structureLow15 =
        lowest(
            l15.slice(0, -2),
            24
        )

    const oldHigh15 =
        highest(
            h15.slice(0, -14),
            12
        )

    const oldLow15 =
        lowest(
            l15.slice(0, -14),
            12
        )

    const bullishStructure15 =
        structureHigh15 >= oldHigh15 &&
        structureLow15 >= oldLow15

    const bearishStructure15 =
        structureHigh15 <= oldHigh15 &&
        structureLow15 <= oldLow15

    // Không bắt structure quá cứng.
    // EMA + slope đã xác nhận trend.
    const structureOKLong =
    bullishStructure15 ||
    (
        longBias &&
        structureLow15 >= oldLow15 * 0.996
    ) ||
    (
        longBias &&
        structureLow15 >= oldLow15 * 0.994 &&
        ema20_15 > ema50_15
    )

const structureOKShort =
    bearishStructure15 ||
    (
        shortBias &&
        structureHigh15 <= oldHigh15 * 1.004
    ) ||
    (
        shortBias &&
        structureHigh15 <= oldHigh15 * 1.006 &&
        ema20_15 < ema50_15
    )

    // =========================================================
    // 5. 5M TREND
    // =========================================================

    const p5 =
        c5.at(-1)

    const ema9_5 =
        ema(c5.slice(-40), 9)

    const ema20_5 =
        ema(c5.slice(-60), 20)

    const ema50_5 =
        ema(c5.slice(-100), 50)

    const ema9_5Prev =
        ema(c5.slice(-41, -1), 9)

    const slope9_5 =
        pct(
            ema9_5,
            ema9_5Prev
        )

    // 5M trend nới nhẹ
const trendLong5 =
    ema20_5 > ema50_5 &&
    (
        (
            p5 >= ema20_5 * 0.992 &&
            ema9_5 >= ema20_5 * 0.993 &&
            slope9_5 >= -0.0008
        )
        ||
        (
            p5 >= ema50_5 * 0.996 &&
            ema9_5 >= ema20_5 * 0.991
        )
    )

const trendShort5 =
    ema20_5 < ema50_5 &&
    (
        (
            p5 <= ema20_5 * 1.008 &&
            ema9_5 <= ema20_5 * 1.007 &&
            slope9_5 <= 0.0008
        )
        ||
        (
            p5 <= ema50_5 * 1.004 &&
            ema9_5 <= ema20_5 * 1.009
        )
    )

    // =========================================================
    // 6. 5M VOLUME
    // =========================================================

    const vol5Avg =
        avg(v5.slice(-21, -1))

    const vol5Now =
        v5.at(-1)
const vol5Ratio =
        vol5Avg > 0
            ? vol5Now / vol5Avg
            : 1

    // Không bắt buộc volume spike.
    if (
        vol5Ratio < 0.30
    ) {
        return reject("VOL5", {
            side: coreSide,
        vol5Ratio: round(vol5Ratio, 3)
    })
    }

    // =========================================================
    // 7. PULLBACK LOCATION
    //
    // 3 kiểu pullback:
    //
    // A. EMA20
    // B. EMA50
    // C. Retest structure
    //
    // Chỉ cần MỘT kiểu hợp lệ.
    // =========================================================

    const recentLow5 =
        lowest(
            l5.slice(0, -1),
            8
        )

    const recentHigh5 =
        highest(
            h5.slice(0, -1),
            8
        )

    const recentClose5 =
        c5.at(-1)

    const pullbackTolerance =
Math.max(
    atr5 * 0.85,
    price * 0.0020
)

    // EMA20 pullback
    const pullbackEMA20Long =
    recentLow5 <= ema20_5 + pullbackTolerance &&
    recentClose5 >= ema20_5 * 0.997

    const pullbackEMA20Short =
    recentHigh5 >= ema20_5 - pullbackTolerance &&
    recentClose5 <= ema20_5 * 1.003

    // EMA50 pullback
    const pullbackEMA50Long =
    recentLow5 <= ema50_5 + pullbackTolerance &&
    recentClose5 >= ema50_5 * 0.994

    const pullbackEMA50Short =
    recentHigh5 >= ema50_5 - pullbackTolerance &&
    recentClose5 <= ema50_5 * 1.006

    // Structure retest
    const structureTolerance =
    Math.max(
        atr5 * 0.75,
        price * 0.0020
    )

    const structureRetestLong =
        recentLow5 <=
        structureHigh15 +
        structureTolerance &&
        recentClose5 >=
        structureHigh15 -
        structureTolerance

    const structureRetestShort =
        recentHigh5 >=
        structureLow15 -
        structureTolerance &&
        recentClose5 <=
        structureLow15 +
        structureTolerance

    const pullbackLong =
    pullbackEMA20Long ||
    pullbackEMA50Long ||
    structureRetestLong

const pullbackShort =
    pullbackEMA20Short ||
    pullbackEMA50Short ||
    structureRetestShort

if (
    longBias &&
    !pullbackLong &&
    !pullbackShort
) {
    return reject("PULLBACK", {
        side: "LONG",

        pullbackEMA20Long,
        pullbackEMA50Long,
        structureRetestLong,

        atr5: round(atr5),
        pullbackTolerance: round(pullbackTolerance)
    })
}

if (
    shortBias &&
    !pullbackShort &&
    !pullbackLong
) {
    return reject("PULLBACK", {
        side: "SHORT",

        pullbackEMA20Short,
        pullbackEMA50Short,
        structureRetestShort,

        atr5: round(atr5),
        pullbackTolerance: round(pullbackTolerance)
    })
}

    // =========================================================
    // 8. 5M REJECTION
    //
    // Không bắt buộc phải là candle khổng lồ.
    // Chỉ cần có phản ứng rõ.
    // =========================================================

    const o5Now =
        o5.at(-1)

    const h5Now =
        h5.at(-1)

    const l5Now =
        l5.at(-1)

    const c5Now =
        c5.at(-1)

    const body5 =
        bodyRatio(
            o5Now,
            h5Now,
            l5Now,
            c5Now
        )

    const closeLong5 =
        closeLocationLong(
            h5Now,
            l5Now,
            c5Now
        )

    const closeShort5 =
        closeLocationShort(
            h5Now,
            l5Now,
            c5Now
        )

    const lowerWick5 =
        Math.min(
            o5Now,
            c5Now
        ) - l5Now

    const upperWick5 =
        h5Now -
        Math.max(
            o5Now,
            c5Now
        )

    const bullishRejection =
        (
            c5Now > o5Now &&
            body5 >= 0.30 &&
            closeLong5 >= 0.58
        )
        ||
        (
            lowerWick5 >=
            Math.abs(c5Now - o5Now) * 0.8 &&
            closeLong5 >= 0.62
        )

    const bearishRejection =
        (
            c5Now < o5Now &&
            body5 >= 0.30 &&
            closeShort5 >= 0.58
        )
        ||
        (
            upperWick5 >=
            Math.abs(c5Now - o5Now) * 0.8 &&
            closeShort5 >= 0.62
        )

    // =========================================================
    // 9. 1M MICRO TRIGGER
    //
    // Hai kiểu:
    //
    // A. Micro breakout
    // B. Strong close sau rejection
    //
    // Không chase.
    // =========================================================

    const i =
        c1.length - 1

    if (i < 3) {
        return reject("INVALID_DATA", {
        index: i
    })
    }

    const o0 = o1[i]
const h0 = h1[i]
    const l0 = l1[i]
    const c0 = c1[i]

    const oPrev = o1[i - 1]
    const hPrev = h1[i - 1]
    const lPrev = l1[i - 1]
    const cPrev = c1[i - 1]

    const h2 = h1[i - 2]
    const l2 = l1[i - 2]

    const br1 =
        bodyRatio(
            o0,
            h0,
            l0,
            c0
        )

    const closeLong1 =
        closeLocationLong(
            h0,
            l0,
            c0
        )

    const closeShort1 =
        closeLocationShort(
            h0,
            l0,
            c0
        )

    const microHigh =
        Math.max(
            hPrev,
            h2
        )

    const microLow =
        Math.min(
            lPrev,
            l2
        )

    
        const bullishMicroBreak =
    c0 > o0 &&
    br1 >= 0.20 &&
    closeLong1 >= 0.52 &&
    c0 > microHigh

const bearishMicroBreak =
    c0 < o0 &&
    br1 >= 0.20 &&
    closeShort1 >= 0.52 &&
    c0 < microLow

    // Strong continuation candle
    const bullishStrongClose =
    c0 > o0 &&
    br1 >= 0.50 &&
    closeLong1 >= 0.68 &&
    c0 >= cPrev

const bearishStrongClose =
    c0 < o0 &&
    br1 >= 0.50 &&
    closeShort1 >= 0.68 &&
    c0 <= cPrev

    const bullishTrigger =
        bullishMicroBreak ||
        bullishStrongClose

    const bearishTrigger =
        bearishMicroBreak ||
        bearishStrongClose

        // =========================================================
// FLEXIBLE CONFIRMATION
//
// Không bắt 5M rejection + 1M trigger cùng lúc.
// Chỉ cần một tín hiệu xác nhận đủ rõ.
// =========================================================

const longConfirmation =
    bullishRejection ||
    bullishTrigger //||
    //(
        //bullishStrongClose &&
        //closeLong1 >= 0.65
    //)

const shortConfirmation =
    bearishRejection ||
    bearishTrigger //||
   // (
       // bearishStrongClose &&
        //closeShort1 >= 0.65
    //)
    if (
    !longConfirmation &&
    !shortConfirmation
) {
    return reject("CONFIRMATION", {
        side: coreSide,

        pullbackLong,
        pullbackShort,

        bullishRejection,
        bearishRejection,

        bullishTrigger,
        bearishTrigger,

        bullishMicroBreak,
        bearishMicroBreak,

        bullishStrongClose,
        bearishStrongClose
    })
}

    // =========================================================
    // 10. 1M VOLUME
    // =========================================================

    const vol1Avg =
        avg(v1.slice(-21, -1))

    const vol1Now =
        v1.at(-1)

    const vol1Ratio =
        vol1Avg > 0
            ? vol1Now / vol1Avg
            : 1

    // Volume chỉ loại khi quá yếu.
    if (
        vol1Ratio < 0.18
    ) {
        return reject("VOL1", {
            side: coreSide,
        vol1Ratio: round(vol1Ratio, 3)
    })
    }

    // =========================================================
    // 11. CHASE FILTER
    //
    // Đây là filter rất quan trọng.
    // Không mua/short khi giá đã chạy quá xa.
    // =========================================================

    const distFromEMA20 =
        Math.abs(
            price - ema20_5
        ) / price

    const maxChase =
    Math.max(
        (atr5 / price) * 2.60,
        0.0100
    )

    if (
        distFromEMA20 >
        maxChase
    ) {
        return reject("CHASE", {
            side: coreSide,
            distFromEMA20: round(distFromEMA20, 6),
            maxChase: round(maxChase, 6)
        })
    }

    // =========================================================
    // 12. RSI EXTREME FILTER
    //
    // RSI chỉ dùng để tránh entry quá nóng.
    // Không dùng RSI để reversal.
    // =========================================================

    const rsi5 =
        rsi(c5.slice(-50))

    const rsi1 =
        rsi(c1.slice(-50))

    if (
        !Number.isFinite(rsi5) ||
        !Number.isFinite(rsi1)
    ) {
        return reject("RSI_INVALID", {
            side: coreSide,
            rsi5,
            rsi1
        })
    }

    if (
        longBias &&
        rsi5 > 83
    ) {
        return reject("RSI_LONG_EXTREME", {
            side: "LONG",
        rsi5: round(rsi5, 2)
    })
    }

    if (
        shortBias &&
        rsi5 < 17
    ) {
        return reject("RSI_SHORT_EXTREME", {
            side: "SHORT",
        rsi5: round(rsi5, 2)
    })
    }

    // =========================================================
    // 13. FINAL SETUP
    // =========================================================

    const longSetup =
    longBias &&
    pullbackLong &&
    (
        longConfirmation ||
        bullishTrigger
    ) &&
    (
        trendLong5 ||
        bullishTrigger
    )

const shortSetup =
    shortBias &&
    pullbackShort &&
    (
        shortConfirmation ||
        bearishTrigger
    ) &&
    (
        trendShort5 ||
        bearishTrigger
    )

    if (
    !longSetup &&
    !shortSetup
) {
    return reject("FINAL_SETUP", {
        side: coreSide,

        longBias,
        shortBias,

        structureOKLong,
        structureOKShort,

        trendLong5,
        trendShort5,

        pullbackLong,
        pullbackShort,

        longConfirmation,
        shortConfirmation
    })
}

    // =========================================================
    // 14. SWING / STRUCTURE FOR SL
    // =========================================================

    const swingHigh5 =
        highest(
            h5.slice(0, -1),
            20
        )

    const swingLow5 =
        lowest(
            l5.slice(0, -1),
            20
        )

    const swingHigh15 =
        highest(
            h15.slice(0, -1),
            16
        )

    const swingLow15 =
        lowest(
            l15.slice(0, -1),
            16
        )

    // =========================================================
    // 15. SUPPORT / RESISTANCE
    // =========================================================

    const resistanceCandidates = [
        swingHigh5,
        swingHigh15,
        structureHigh15
    ]
        .filter(
            x =>
                Number.isFinite(x) &&
                x > price
        )

    const supportCandidates = [
        swingLow5,
        swingLow15,
        structureLow15
    ]
        .filter(
            x =>
                Number.isFinite(x) &&
                x < price
        )

    const resistance =
        resistanceCandidates.length
            ? Math.min(
                ...resistanceCandidates
            )
            : null

    const support =
        supportCandidates.length
            ? Math.max(
                ...supportCandidates
            )
            : null

    // =========================================================
    // 16. STOP LOSS
    //
    // SL theo structure.
    // Không bóp SL quá sát.
    // Không cho SL quá rộng.
    // =========================================================

    const slBuffer =
        Math.max(
            atr1 * 0.50,
            atr5 * 0.15
        )

    const entry =
        price

    let sl
    let risk
    let tp

    if (longSetup) {

        const structureStop =
            Math.min(
                swingLow5,
                swingLow15
            )

        sl =
            structureStop -
            slBuffer

        risk =
            entry -
            sl

        if (
            !Number.isFinite(risk) ||
            risk <= 0
        ) {
            return reject("RISK_INVALID", {
        side: "LONG",
        risk: round(risk)
    })
        }

        // Không quá nhỏ
        if (
            risk <
            atr5 * 0.30
        ) {
            return reject("RISK_TOO_SMALL", {
        side: "LONG",
        risk: round(risk),
        atr5: round(atr5),
        riskATR: round(risk / atr5, 3)
    })
        }

        // Không quá rộng
        if (
            risk >
            atr5 * 2.50
        ) {
            return reject("RISK_TOO_WIDE", {
        side: "LONG",
        risk: round(risk),
        atr5: round(atr5),
        riskATR: round(risk / atr5, 3)
    })
        }

        if (
            risk / entry >
            0.018
        ) {
            return reject("RISK_PERCENT", {
        side: "LONG",
        riskPercent: round(risk / entry, 6),
        risk: round(risk),
        entry: round(entry)
    })
        }

        // Room phía trước
        if (resistance) {

            const room =
                resistance -
                entry

            if (
                room <
                risk * 1.15
            ) {
                return reject("ROOM_LONG", {
                    side: "LONG",
        room: round(room),
        required: round(risk * 1.30),
        risk: round(risk),
        resistance: round(resistance),
        entry: round(entry)
    })
            }
        }

        tp =
            entry +
            risk * 2.0

    } else {

        const structureStop =
            Math.max(
                swingHigh5,
                swingHigh15
            )

        sl =
            structureStop +
            slBuffer

        risk =
            sl -
            entry

        if (
            !Number.isFinite(risk) ||
            risk <= 0
        ) {
            return reject("RISK_INVALID", {
        side: "SHORT",
        risk: round(risk)
    })
        }

        if (
            risk <
            atr5 * 0.30
        ) {
            return reject("RISK_TOO_SMALL", {
        side: "SHORT",
        risk: round(risk),
        atr5: round(atr5),
        riskATR: round(risk / atr5, 3)
    })
        }

        if (
            risk >
            atr5 * 2.50
        ) {
            return reject("RISK_TOO_WIDE", {
        side: "SHORT",
        risk: round(risk),
        atr5: round(atr5),
        riskATR: round(risk / atr5, 3)
    })
        }

        if (
            risk / entry >
            0.018
        ) {
            return reject("RISK_PERCENT", {
        side: "SHORT",
        riskPercent: round(risk / entry, 6),
        risk: round(risk),
        entry: round(entry)
    })
        }

        if (support) {

            const room =
                entry -
                support

            if (
                room <
                risk * 1.15
            ) {
                return reject("ROOM_SHORT", {
                    side: "SHORT",
        room: round(room),
        required: round(risk * 1.30),
        risk: round(risk),
        support: round(support),
        entry: round(entry)
    })
            }
        }

        tp =
            entry -
            risk * 2.0
    }

    // =========================================================
    // 17. FINAL RR
    // =========================================================

    const finalRR =
        longSetup
            ? (tp - entry) / risk
            : (entry - tp) / risk

    if (
        !Number.isFinite(finalRR) ||
        finalRR < 1.65
    ) {
        return reject("FINAL_RR", {
            side: coreSide,
        finalRR: round(finalRR, 2),
        requiredRR: 1.65,
        risk: round(risk),
        entry: round(entry),
        tp: round(tp)
    })
    }

    // =========================================================
    // 18. QUALITY
    //
    // Không cộng điểm trùng.
    // Chỉ kiểm tra những yếu tố quan trọng.
    // =========================================================

    const quality = {

        higherTimeframeAligned:
            longSetup
                ? bull1h && bull15: bear1h && bear15,

        structureConfirmed:
            longSetup
                ? structureOKLong
                : structureOKShort,

        trend5Confirmed:
            longSetup
                ? trendLong5
                : trendShort5,

        pullbackConfirmed:
            longSetup
                ? pullbackLong
                : pullbackShort,

        rejectionConfirmed:
            longSetup
                ? bullishRejection
                : bearishRejection,

        triggerConfirmed:
            longSetup
                ? bullishTrigger
                : bearishTrigger,

        volumeAcceptable:
            vol1Ratio >= 0.50,

        chaseControlled:
            distFromEMA20 <= maxChase,

        roomAcceptable:
            longSetup
                ? (
                    !resistance ||
                    resistance - entry >=
                    risk * 1.50
                )
                : (
                    !support ||
                    entry - support >=
                    risk * 1.50
                )
    }

    const qualityCount =
        Object.values(quality)
            .filter(Boolean)
            .length

// KHÔNG dùng qualityCount để reject setup
// if (qualityCount < 8) return null

    // =========================================================
    // 19. MARKET STATE
    // =========================================================

    const strongTrend =
        gap1h >= 0.0015 &&
        gap15 >= 0.0010

    const marketState =
        strongTrend
            ? "TREND_STRONG"
            : "TREND_NORMAL"

    // =========================================================
    // 20. VOLATILITY
    // =========================================================

    const volatility =
        atrRatio5 >= 0.004
            ? "HIGH"
            : atrRatio5 <= 0.0012
                ? "LOW"
                : "NORMAL"

    // =========================================================
    // 21. PULLBACK TYPE
    // =========================================================

    let pullbackType = "EMA20"

    if (
        pullbackEMA50Long ||
        pullbackEMA50Short
    ) {
        pullbackType = "EMA50"
    }

    if (
        structureRetestLong ||
        structureRetestShort
    ) {
        pullbackType = "STRUCTURE_RETEST"
    }

    // =========================================================
    // 22. TRIGGER TYPE
    // =========================================================

    let triggerType = "STRONG_CLOSE"

    if (
        bullishMicroBreak ||
        bearishMicroBreak
    ) {
        triggerType = "MICRO_BREAK"
    }

    // =========================================================
    // 23. SETUP
    // =========================================================

    const setup =
        "TREND_PULLBACK_CONTINUATION"
        // =========================================================
// CORE ACCEPT STATS
// =========================================================

CORE_REJECT_STATS.ACCEPT++

if (longSetup) {

    CORE_REJECT_STATS.ACCEPT_LONG++

} else if (shortSetup) {

    CORE_REJECT_STATS.ACCEPT_SHORT++
}

if (longSetup) {

    CORE_SIDE_STATS.LONG++

} else if (shortSetup) {

    CORE_SIDE_STATS.SHORT++
}

    // =========================================================
    // 24. RETURN
    // =========================================================

    return {

        side:
            longSetup
                ? "LONG"
                : "SHORT",

        price:
            round(entry),

        sl:
            round(sl),

        tp:
            round(tp),

        setup,

        pullbackType,

        triggerType,

        marketState,

        volatility,

        qualityScore:
            qualityCount,

        indicators: {

            ema20_1h:
                round(ema20_1h),

            ema50_1h:
                round(ema50_1h),

            ema20_15:
                round(ema20_15),

            ema50_15:
                round(ema50_15),

            ema9_5:
                round(ema9_5),

            ema20_5:
                round(ema20_5),

            ema50_5:
                round(ema50_5),

            atr1h:
                round(atr1h),

            atr15:
                round(atr15),

            atr5:
                round(atr5),

            atr1m:
                round(atr1),

            rsi5:
                round(rsi5, 2),

            rsi1m:
                round(rsi1, 2),

            volume1mRatio:round(vol1Ratio, 3),

            volume5mRatio:
                round(vol5Ratio, 3),

            atrRatio1h:
                round(atrRatio1h, 6),

            atrRatio15:
                round(atrRatio15, 6),

            atrRatio5:
                round(atrRatio5, 6)
        },

        structure: {

            structureHigh15:
                round(structureHigh15),

            structureLow15:
                round(structureLow15),

            swingHigh5:
                round(swingHigh5),

            swingLow5:
                round(swingLow5),

            swingHigh15:
                round(swingHigh15),

            swingLow15:
                round(swingLow15),

            resistance:
                resistance !== null
                    ? round(resistance)
                    : null,

            support:
                support !== null
                    ? round(support)
                    : null
        },

        context: {

            h1Bull:
                bull1h,

            h1Bear:
                bear1h,

            bull15,

            bear15,

            trendLong5,

            trendShort5,

            bullishStructure15:
                bullishStructure15,

            bearishStructure15:
                bearishStructure15,

            structureOKLong,

            structureOKShort,

            pullbackLong,

            pullbackShort,

            pullbackEMA20Long,

            pullbackEMA20Short,

            pullbackEMA50Long,

            pullbackEMA50Short,

            structureRetestLong,

            structureRetestShort,

            bullishRejection,

            bearishRejection,

            bullishMicroBreak,

            bearishMicroBreak,

            bullishStrongClose,

            bearishStrongClose,

            bullishTrigger,

            bearishTrigger,

            slope1h:
                round(slope1h, 6),

            slope15:
                round(slope15, 6),

            slope9_5:
                round(slope9_5, 6),

            gap1h:
                round(gap1h, 6),

            gap15:
                round(gap15, 6),

            distFromEMA20:
                round(distFromEMA20, 6),

            maxChase:
                round(maxChase, 6)
        },

        risk: {

            risk:
                round(risk),

            rr:
                round(finalRR, 2),

            slDistance:
                round(
                    Math.abs(
                        entry - sl
                    )
                ),

            tpDistance:
                round(
                    Math.abs(
                        tp - entry
                    )
                ),

            riskATR5:
                round(
                    risk / atr5,
                    3
                ),

            riskPercent:
                round(
                    risk / entry,
                    6
                )
        },

        quality,

        flags: {

            longBias,

            shortBias,

            pullbackLong,

            pullbackShort,

            bullishRejection,

            bearishRejection,

            bullishTrigger,

            bearishTrigger,

            bullishMicroBreak,

            bearishMicroBreak,

            bullishStrongClose,

            bearishStrongClose
        },

        debug: {

            reason:
                "TREND_PULLBACK_CONTINUATION",

            timestamp:
                Date.now(),

            candle1m: {

                open:
                    round(o0),

                high:
                    round(h0),

                low:
                    round(l0),

                close:
                    round(c0)
            },

            candle5m: {

                open:
                    round(o5Now),

                high:
                    round(h5Now),

                low:
                    round(l5Now),

                close:
                    round(c5Now)
            }
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

    const initialRisk = Number(best?.risk?.risk)
    const rr = Number(best?.risk?.rr)
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

if(risk <= 0){
    continue
}

    let diff = Math.abs(best.price - best.sl)
    if(!diff) continue



// Input: `best` is the core signal plus symbol:
// const best = { ...signal, symbol }
// Returns a DB-ready trade, or null when the signal is invalid.

const trade = buildTradeFromCoreSignal(
    best,
    btcRegime,
    risk
)

if(!trade){
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
//const ENABLE_DYNAMIC_TPSL=false
async function runDynamicTPSL(){
    //if(!ENABLE_DYNAMIC_TPSL)return

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
