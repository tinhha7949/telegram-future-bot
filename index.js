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
let NEXT_ENTRY_ALLOWED_AT = 0;
const ENTRY_COOLDOWN_MS = 60 * 60 * 1000;
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
        if(side !== positionSide){
    console.log(
        `⛔ DYNAMIC SIDE MISMATCH ${symbol} ` +
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

        const safeDistance = tickSize

if(positionSide === "LONG"){

    if(
        sl >= currentPrice - safeDistance ||
        tp <= currentPrice + safeDistance
    ){
        console.log(
            `⛔ DYNAMIC TPSL SKIP LONG ${symbol} ` +
            `ENTRY=${entry} ` +
            `CURRENT=${currentPrice} ` +
            `SL=${sl} TP=${tp}`
        )

        return false
    }

}else{

    if(
        sl <= currentPrice + safeDistance ||
        tp >= currentPrice - safeDistance
    ){
        console.log(
            `⛔ DYNAMIC TPSL SKIP SHORT ${symbol} ` +
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
async function manageDynamicTPSL(trade) {
  try {
    if (!trade?.symbol || !trade?.side) return;
    const symbol = trade.symbol;
    const side = String(trade.side).toUpperCase();
    if (side !== 'LONG' && side !== 'SHORT') return;
    if (TPSL_CLOSING[symbol] || TPSL_PENDING[symbol]) return;

    const enteredAt = Number(trade.enteredAt || trade.openedAt || trade.createdAt);
    if (!Number.isFinite(enteredAt) || enteredAt <= 0 || Date.now() - enteredAt < 90000) return;
    TPSL_PENDING[symbol] = true;

    const pos = await hasPosition(symbol);
    if (!pos) {
      delete DYNAMIC_LAST_UPDATE[symbol];
      delete DYNAMIC_PHASE[symbol];
      return;
    }

    const [data5, data15] = await Promise.all([
      getData(symbol, '5m', 100),
      getData(symbol, '15m', 100)
    ]);
    if (!Array.isArray(data5) || !Array.isArray(data15)) return;
    const closed5 = data5.slice(0, -1);
    const closed15 = data15.slice(0, -1);
    if (closed5.length < 60 || closed15.length < 30) return;

    const h5 = closed5.map(x => Number(x[2]));
    const l5 = closed5.map(x => Number(x[3]));
    const c5 = closed5.map(x => Number(x[4]));
    const h15 = closed15.map(x => Number(x[2]));
    const l15 = closed15.map(x => Number(x[3]));
    const c15 = closed15.map(x => Number(x[4]));
    if ([h5, l5, c5, h15, l15, c15].flat().some(x => !Number.isFinite(x))) return;

    const current = Number(pos.markPrice || trade.markPrice || trade.entry);
    const entry = Number(pos.entryPrice || trade.entry || trade.price);
    const oldSL = Number(trade.sl);
    const oldTP = Number(trade.tp);
    if (!(current > 0 && entry > 0 && oldSL > 0 && oldTP > 0)) return;

    // The initial R is fixed from the original core stop, not the trailed stop.
    let initialRisk = Number(trade.initialRisk || trade.riskDetail?.initialRisk);
    if (!(initialRisk > 0)) {
      initialRisk = Math.abs(entry - oldSL);
      if (!(initialRisk > 0)) return;
      await trades.updateOne(
        { symbol, result: 'PENDING' },
        { $set: { initialRisk, updatedAt: Date.now() } }
      );
    }
    const originalSL = side === 'LONG' ? entry - initialRisk : entry + initialRisk;
    const R = (side === 'LONG' ? current - entry : entry - current) / initialRisk;
    if (!Number.isFinite(R) || R < 1.5) return;

    // Wilder ATR(22) from completed 15m candles, matching Chandelier Exit math.
    const calcWilderATR = (candles, length) => {
      const tr = [];
      for (let i = 1; i < candles.length; i++) {
        const high = Number(candles[i][2]);
        const low = Number(candles[i][3]);
        const prevClose = Number(candles[i - 1][4]);
        tr.push(Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose)));
      }
      if (tr.length < length) return NaN;
      let value = tr.slice(0, length).reduce((a, b) => a + b, 0) / length;
      for (let i = length; i < tr.length; i++) value = ((value * (length - 1)) + tr[i]) / length;
      return value;
    };
    const atr5 = calcWilderATR(closed5.slice(-40), 14);
    const atr15 = calcWilderATR(closed15.slice(-50), 22);
    if (!(atr5 > 0 && atr15 > 0)) return;
    const buffer = Math.max(atr5 * 0.20, atr15 * 0.10, current * 0.00025);

    let newSL = oldSL;
    let newTP = oldTP;
    let phase = 1;

    // Protect gains in stages while leaving the position room to trend.
    const floorR = R >= 3.0 ? 1.50 : R >= 2.0 ? 0.75 : 0.30;
    if (R >= 2.0) phase = 2;
    if (R >= 3.0) phase = 3;
    const floor = side === 'LONG'
      ? entry + initialRisk * floorR
      : entry - initialRisk * floorR;
    if (side === 'LONG' && floor > newSL && floor < current) newSL = floor;
    if (side === 'SHORT' && floor < newSL && floor > current) newSL = floor;

    // Once the trade has room (+1.5R), trail with the 15m Chandelier Exit.
    // The stop can tighten only; it never moves back toward the original risk.
    if (R >= 2.5 && closed15.length >= 22) {
      const lookbackHigh = Math.max(...h15.slice(-22));
      const lookbackLow = Math.min(...l15.slice(-22));
      const chandelier = side === 'LONG'
        ? lookbackHigh - atr15 * 3
        : lookbackLow + atr15 * 3;
      if (Number.isFinite(chandelier)) {
        if (side === 'LONG' && chandelier > newSL && chandelier < current) newSL = chandelier;
        if (side === 'SHORT' && chandelier < newSL && chandelier > current) newSL = chandelier;
      }
    }

    // Extend the original core TP only when both 5m and 15m momentum continue
    // and the candles show room beyond the existing target.
    const emaCalc = (values, length) => {
      if (values.length < length) return NaN;
      const alpha = 2 / (length + 1);
      let value = values[0];
      for (let i = 1; i < values.length; i++) value = alpha * values[i] + (1 - alpha) * value;
      return value;
    };
    const e9_5 = emaCalc(c5.slice(-30), 9);
    const e20_5 = emaCalc(c5.slice(-40), 20);
    const e9_15 = emaCalc(c15.slice(-30), 9);
    const e20_15 = emaCalc(c15.slice(-40), 20);
    const v5 = closed5.map(x => Number(x[5]));
    const avgV = v5.slice(-21, -1).reduce((a, b) => a + b, 0) / Math.max(1, v5.slice(-21, -1).length);
    const volRatio = avgV > 0 ? v5.at(-1) / avgV : 0;
    const momentumLong = e9_5 > e20_5 && e9_15 > e20_15 && c5.at(-1) >= c5.at(-2) && c15.at(-1) >= c15.at(-2) && volRatio >= 0.80;
    const momentumShort = e9_5 < e20_5 && e9_15 < e20_15 && c5.at(-1) <= c5.at(-2) && c15.at(-1) <= c15.at(-2) && volRatio >= 0.80;

    const nearestAbove = (values, value) => values.filter(x => Number.isFinite(x) && x > value).sort((a, b) => a - b)[0];
    const nearestBelow = (values, value) => values.filter(x => Number.isFinite(x) && x < value).sort((a, b) => b - a)[0];
    const allHighs = h5.slice(-48, -1).concat(h15.slice(-48, -1));
    const allLows = l5.slice(-48, -1).concat(l15.slice(-48, -1));
    const nearTP = side === 'LONG'
      ? current < oldTP && oldTP - current <= Math.max(atr5 * 0.60, initialRisk * 0.30)
      : current > oldTP && current - oldTP <= Math.max(atr5 * 0.60, initialRisk * 0.30);
    const obstacle = side === 'LONG' ? nearestAbove(allHighs, oldTP) : nearestBelow(allLows, oldTP);
    const extendedTP = side === 'LONG' ? Number(obstacle) - buffer * 0.20 : Number(obstacle) + buffer * 0.20;
    const enoughRoom = side === 'LONG'
      ? extendedTP >= oldTP + Math.max(atr15, initialRisk * 0.50)
      : extendedTP <= oldTP - Math.max(atr15, initialRisk * 0.50);
    if (R >= 2.0 && nearTP && enoughRoom &&
        ((side === 'LONG' && momentumLong) || (side === 'SHORT' && momentumShort))) {
      newTP = extendedTP;
    }

    // Invariants: never widen the initial/current stop or pull TP closer.
    if (side === 'LONG') {
      if (newSL < originalSL || newSL < oldSL || newSL >= current) newSL = oldSL;
      if (newTP < oldTP) newTP = oldTP;
    } else {
      if (newSL > originalSL || newSL > oldSL || newSL <= current) newSL = oldSL;
      if (newTP > oldTP) newTP = oldTP;
    }

    const info = await getSymbolInfo(symbol);
    const tickSize = Number(info?.filters?.find(f => f.filterType === 'PRICE_FILTER')?.tickSize);
    if (!(tickSize > 0)) return;
    const precision = Math.max(0, String(tickSize).split('.')[1]?.length || 0);
    // Round a protective stop toward a tighter valid tick; round target outward.
    newSL = side === 'LONG'
      ? Math.ceil(newSL / tickSize) * tickSize
      : Math.floor(newSL / tickSize) * tickSize;
    newTP = side === 'LONG'
      ? Math.floor(newTP / tickSize) * tickSize
      : Math.ceil(newTP / tickSize) * tickSize;
    newSL = Number(newSL.toFixed(precision));
    newTP = Number(newTP.toFixed(precision));

    if (side === 'LONG' && newSL < oldSL) newSL = oldSL;
    if (side === 'SHORT' && newSL > oldSL) newSL = oldSL;
    if ((side === 'LONG' && newSL >= current) || (side === 'SHORT' && newSL <= current)) newSL = oldSL;
    if (side === 'LONG' && newTP < oldTP) newTP = oldTP;
    if (side === 'SHORT' && newTP > oldTP) newTP = oldTP;

    const minimumChange = Math.max(entry * 0.00005, atr15 * 0.03);
    if (Math.abs(newSL - oldSL) < minimumChange && Math.abs(newTP - oldTP) < minimumChange) return;

    const updateTrade = { ...trade, symbol, side, entry, sl: newSL, tp: newTP, initialRisk, previousSL: oldSL };
    const result = await setDynamicTPSL(updateTrade);
    if (!result?.ok) {
      console.log(`⚠️ DYNAMIC TPSL FAILED ${symbol}`);
      return;
    }
    const finalSL = Number(result.sl), finalTP = Number(result.tp);
    if (!(finalSL > 0 && finalTP > 0)) return;
    const invalidLong = side === 'LONG' && (finalSL < oldSL || finalSL >= current || finalTP < oldTP);
    const invalidShort = side === 'SHORT' && (finalSL > oldSL || finalSL <= current || finalTP > oldTP);
    if (invalidLong || invalidShort) {
      console.log(`🚨 REJECT INVALID DYNAMIC RESULT ${symbol}`);
      return;
    }

    trade.sl = finalSL;
    trade.tp = finalTP;
    DYNAMIC_LAST_UPDATE[symbol] = Date.now();
    DYNAMIC_PHASE[symbol] = phase;
    await trades.updateOne(
      { symbol, result: 'PENDING' },
      { $set: { sl: finalSL, tp: finalTP, initialRisk, dynamicPhase: phase, dynamicUpdatedAt: Date.now(), updatedAt: Date.now() } }
    );
    console.log(`🎯 DYNAMIC ${symbol} ${side} R=${R.toFixed(2)} PHASE=${phase} SL ${oldSL}->${finalSL} TP=${finalTP}`);
  } catch (e) {
    await checkTimeError(e);
    console.log(`❌ MANAGE DYNAMIC TPSL ERROR ${trade?.symbol || 'UNKNOWN'}: ${e.message}`);
  } finally {
    if (trade?.symbol) delete TPSL_PENDING[trade.symbol];
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
async function getTopSymbols() {
  const url = 'https://fapi.binance.com/fapi/v1/ticker/24hr';

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await safeFetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0' }
      });

      if (!res || !res.ok) continue;

      const data = await res.json();
      if (!Array.isArray(data) || data.length === 0) continue;

      if (
        !(validFuturesSymbols instanceof Set) ||
        validFuturesSymbols.size === 0
      ) {
        console.log('❌ SYMBOL FAIL: valid USDⓈ-M Futures symbol list is not loaded');
        return null;
      }

      const excludedBases = new Set([
        'USDC', 'BUSD', 'FDUSD', 'TUSD', 'USDP',
        'DAI', 'EUR', 'TRY', 'USD1', 'RLUSD'
      ]);

      const candidates = [];

      for (const ticker of data) {
        const symbol = String(ticker.symbol || '');

        if (!symbol.endsWith('USDT') || !validFuturesSymbols.has(symbol)) {
          continue;
        }

        const base = symbol.slice(0, -4);
        if (
          !base ||
          excludedBases.has(base) ||
          /(UP|DOWN|BULL|BEAR)$/.test(base)
        ) {
          continue;
        }

        const quoteVolume = Number(ticker.quoteVolume);
        const last = Number(ticker.lastPrice);
        const high = Number(ticker.highPrice);
        const low = Number(ticker.lowPrice);

        if (
          ![quoteVolume, last, high, low].every(Number.isFinite) ||
          last <= 0 ||
          low <= 0 ||
          high < low ||
          quoteVolume < 5_000_000
        ) {
          continue;
        }

        // Biên độ high-low của 24 giờ gần nhất, tính theo giá hiện tại.
        const range24 = (high - low) / last;
        if (range24 < 0.05) continue;

        const bid = Number(ticker.bidPrice);
        const ask = Number(ticker.askPrice);

        if (bid > 0 && ask > 0) {
          const mid = (bid + ask) / 2;
          if (mid > 0 && (ask - bid) / mid > 0.004) continue;
        }

        candidates.push({ symbol, quoteVolume, range24 });
      }

      candidates.sort((a, b) => b.quoteVolume - a.quoteVolume);

      const selected = candidates
        .slice(0, 50)
        .map(candidate => candidate.symbol);

      console.log(
        `📊 RANGE FILTER UNIVERSE ${selected.length}` +
        ` (eligible=${candidates.length}, minRange24h=5%)`
      );

      return selected;
    } catch (error) {
      if (attempt === 2) {
        console.log('❌ SYMBOL FAIL:', error?.message || error);
      }
    }
  }

  return null;
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

// ============================================================ // RANGE FILTER CORE // // Single entry indicator: TradingView Range Filter Buy and Sell // Source close / Sampling period 100 / Range multiplier 3 / 5m // Stop: opposite Range Filter envelope // Target: 1.5R // Other timeframes remain in function signature for compatibility. // ============================================================
const finite = Number.isFinite;
const CORE_REJECTS = Object.create(null);
let CORE_CALLS = 0;
function coreReject(stage) { CORE_REJECTS.REJECTED = (CORE_REJECTS.REJECTED || 0) + 1; CORE_REJECTS[stage] = (CORE_REJECTS[stage] || 0) + 1; return null; }
function getCoreRejectStats() { return { TOTAL_CALLS: CORE_CALLS, ...CORE_REJECTS }; }
function resetCoreRejectStats() { CORE_CALLS = 0; for (const key of Object.keys(CORE_REJECTS)) delete CORE_REJECTS[key]; }
// ============================================================ // BASIC // ============================================================
function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }
function avg(arr) { if (!arr.length) return NaN;
let sum = 0;
for (const x of arr) { sum += x; }
return sum / arr.length; }
// ============================================================ // CANDLE NORMALIZATION // Binance: // [time, open, high, low, close, volume] // ============================================================
function normalizeCandle(x) {
if (Array.isArray(x)) {
return {
  t: Number(x[0]),
  o: Number(x[1]),
  h: Number(x[2]),
  l: Number(x[3]),
  c: Number(x[4]),
  v: Number(x[5] ?? 0)
};
}
return { t: Number( x.t ?? x.time ?? x.timestamp ?? 0 ),
o: Number(
  x.o ??
  x.open
),

h: Number(
  x.h ??
  x.high
),

l: Number(
  x.l ??
  x.low
),

c: Number(
  x.c ??
  x.close
),

v: Number(
  x.v ??
  x.volume ??
  0
)
}; }
// ============================================================ // PREPARE // ONLY CLOSED CANDLES // ============================================================
function prepare(data, minLength) {
if (!Array.isArray(data)) { return null; }
const candles = data .map(normalizeCandle) .filter(x => finite(x.o) && finite(x.h) && finite(x.l) && finite(x.c) && finite(x.v) );
const closed = candles.length > 1 ? candles.slice(0, -1) : [];
if (closed.length < minLength) { return null; }
return closed; }
// ============================================================ // EMA // ============================================================
function ema(values, length) {
const out = new Array(values.length) .fill(NaN);
if (!values.length || length <= 0) { return out; }
const alpha = 2 / (length + 1);
let prev = NaN;
for (let i = 0; i < values.length; i++) {
const x = values[i];

if (!finite(x)) {
  out[i] = prev;
  continue;
}

if (!finite(prev)) {
  prev = x;
} else {
  prev =
    alpha * x +
    (1 - alpha) * prev;
}

out[i] = prev;
}
return out; }
// ============================================================ // WILDER RMA // Used by ATR / DMI // ============================================================
function rma(values, length) {
const out = new Array(values.length) .fill(NaN);
if (!values.length || length <= 0) { return out; }
const alpha = 1 / length;
let prev = NaN; let sum = 0; let count = 0;
for (let i = 0; i < values.length; i++) {
const x = values[i];

if (!finite(x)) {
  out[i] = prev;
  continue;
}

if (!finite(prev)) {

  sum += x;
  count++;

  if (count >= length) {
    prev = sum / length;
  }

} else {

  prev =
    alpha * x +
    (1 - alpha) * prev;

}

out[i] = prev;
}
return out; }
// ============================================================ // WMA // ============================================================
function wma(values, length) {
const out = new Array(values.length) .fill(NaN);
if (length <= 0) { return out; }
const denom = length * (length + 1) / 2;
for ( let i = length - 1; i < values.length; i++ ) {
let sum = 0;
let valid = true;

for (
  let j = 0;
  j < length;
  j++
) {

  const v =
    values[i - j];

  if (!finite(v)) {
    valid = false;
    break;
  }

  sum +=
    v * (length - j);
}

if (valid) {
  out[i] =
    sum / denom;
}
}
return out; }
// ============================================================ // TRUE RANGE // ============================================================
function trueRange(candles) {
    const out = new Array(candles.length) .fill(NaN);
for ( let i = 0; i < candles.length; i++ ) {
if (i === 0) {

  out[i] =
    candles[i].h -
    candles[i].l;

  continue;
}

out[i] =
  Math.max(
    candles[i].h -
      candles[i].l,

    Math.abs(
      candles[i].h -
      candles[i - 1].c
    ),

    Math.abs(
      candles[i].l -
      candles[i - 1].c
    )
  );
}
return out; }
// ============================================================ // ATR // ============================================================
function atr(candles, length = 14) {
return rma( trueRange(candles), length ); }
// ============================================================ // HIGHEST HIGH // ============================================================
function highestHigh( candles, endExclusive, length ) {
const start = Math.max( 0, endExclusive - length );
let result = -Infinity;
for ( let i = start; i < endExclusive; i++ ) {
result =
  Math.max(
    result,
    candles[i].h
  );
}
return result === -Infinity ? NaN : result; }
// ============================================================ // LOWEST LOW // ============================================================
function lowestLow( candles, endExclusive, length ) {
const start = Math.max( 0, endExclusive - length );
let result = Infinity;
for ( let i = start; i < endExclusive; i++ ) {
result =
  Math.min(
    result,
    candles[i].l
  );
}
return result === Infinity ? NaN : result; }
function rangeFilter(candles, period = 100, multiplier = 3) {
  const src = candles.map(candle => Number(candle.c));
  const absChange = new Array(src.length).fill(NaN);

  for (let i = 1; i < src.length; i++) {
    if (finite(src[i]) && finite(src[i - 1])) {
      absChange[i] = Math.abs(src[i] - src[i - 1]);
    }
  }

  // Guikroth: EMA(abs(close - close[1]), period),
  // sau đó EMA(..., period * 2 - 1), rồi nhân multiplier.
  const avgRange = ema(absChange, period);
  const smoothRange = ema(avgRange, period * 2 - 1);
  const smrng = smoothRange.map(value =>
    finite(value) ? value * multiplier : NaN
  );

  const filt = new Array(src.length).fill(NaN);
  const upward = new Array(src.length).fill(0);
  const downward = new Array(src.length).fill(0);
  const direction = new Array(src.length).fill(0);
  const signal = new Array(src.length).fill(0);
  const buy = new Array(src.length).fill(false);
  const sell = new Array(src.length).fill(false);

  let condIni = 0;

  for (let i = 0; i < src.length; i++) {
    const price = src[i];
    const range = smrng[i];
    const previousFilter = i > 0 ? filt[i - 1] : NaN;
    const previousUp = i > 0 ? upward[i - 1] : 0;
    const previousDown = i > 0 ? downward[i - 1] : 0;
    const previousPrice = i > 0 ? src[i - 1] : NaN;
    const priorCond = condIni;

    // Range filter dùng nz(filt[1]) = 0 khi chưa có filter trước đó.
    if (finite(price) && finite(range)) {
      const previous = finite(previousFilter) ? previousFilter : 0;

      if (price > previous) {
        filt[i] = price - range < previous
          ? previous
          : price - range;
      } else {
        filt[i] = price + range > previous
          ? previous
          : price + range;
      }
    }

    // Pine giữ bộ đếm trước đó nếu không thể so sánh filt với filt[1].
    if (finite(filt[i]) && finite(previousFilter)) {
      if (filt[i] > previousFilter) {
        upward[i] = previousUp + 1;
        downward[i] = 0;
      } else if (filt[i] < previousFilter) {
        downward[i] = previousDown + 1;
        upward[i] = 0;
      } else {
        upward[i] = previousUp;
        downward[i] = previousDown;
      }
    } else {
      upward[i] = previousUp;
      downward[i] = previousDown;
    }

    const closeChanged =
      finite(previousPrice) &&
      (price > previousPrice || price < previousPrice);

    // Giống longCond/shortCond của nhãn Buy/Sell:
    // close bằng close trước thì không phát điều kiện.
    const longCond =
      finite(price) &&
      finite(filt[i]) &&
      closeChanged &&
      price > filt[i] &&
      upward[i] > 0;

    const shortCond =
      finite(price) &&
      finite(filt[i]) &&
      closeChanged &&
      price < filt[i] &&
      downward[i] > 0;

    if (longCond) condIni = 1;
    else if (shortCond) condIni = -1;

    buy[i] = longCond && priorCond === -1;
    sell[i] = shortCond && priorCond === 1;

    if (buy[i]) signal[i] = 1;
    else if (sell[i]) signal[i] = -1;

    direction[i] = condIni;
  }

  return {
    filter: filt,
    direction,
    signal,
    buy,
    sell,
    range: smrng
  };
}
// ============================================================ // TREND TRADER // // HPotter / Andrew Abraham // // Length     = 21 // Multiplier = 3 // ============================================================
function trendTrader( candles, length = 21, multiplier = 3 ) {
const tr = trueRange(candles);
const avgTR = wma( tr, length );
const ret = new Array(candles.length) .fill(NaN);
const pos = new Array(candles.length) .fill(0);
const signal = new Array(candles.length) .fill(0);
for ( let i = 0; i < candles.length; i++ ) {
if (i === 0) {

  ret[i] =
    candles[i].c;

  continue;
}

const previousATR =
  avgTR[i - 1];

let hiLimit = NaN;
let loLimit = NaN;

if (
  i >= length &&
  finite(previousATR)
) {

  hiLimit =
    highestHigh(
      candles,
      i,
      length
    ) -
    previousATR *
    multiplier;

  loLimit =
    lowestLow(
      candles,
      i,
      length
    ) +
    previousATR *
    multiplier;
}

if (
  finite(hiLimit) &&
  candles[i].c > hiLimit &&
  candles[i].c > loLimit
) {

  ret[i] =
    hiLimit;

} else if (
  finite(loLimit) &&
  candles[i].c < loLimit &&
  candles[i].c < hiLimit
) {

  ret[i] =
    loLimit;

} else {

  ret[i] =
    finite(ret[i - 1])
      ? ret[i - 1]
      : candles[i].c;
}

if (
  candles[i].c >
  ret[i]
) {

  pos[i] = 1;

} else if (
  candles[i].c <
  ret[i]
) {

  pos[i] = -1;

} else {

  pos[i] =
    pos[i - 1];
}

if (
  pos[i] === 1 &&
  pos[i - 1] === -1
) {

  signal[i] = 1;

} else if (
  pos[i] === -1 &&
  pos[i - 1] === 1
) {

  signal[i] = -1;
}
}
return { line: ret, direction: pos, signal }; }
// ============================================================ // DMI / ADX // // Wilder 14 // ============================================================
function dmi( candles, length = 14 ) {
const tr = new Array(candles.length) .fill(NaN);
const plusDM = new Array(candles.length) .fill(0);
const minusDM = new Array(candles.length) .fill(0);
for ( let i = 1; i < candles.length; i++ ) {
const upMove =
  candles[i].h -
  candles[i - 1].h;

const downMove =
  candles[i - 1].l -
  candles[i].l;

plusDM[i] =
  upMove > downMove &&
  upMove > 0
    ? upMove
    : 0;

minusDM[i] =
  downMove > upMove &&
  downMove > 0
    ? downMove
    : 0;

tr[i] =
  Math.max(
    candles[i].h -
      candles[i].l,

    Math.abs(
      candles[i].h -
      candles[i - 1].c
    ),

    Math.abs(
      candles[i].l -
      candles[i - 1].c
    )
  );
}
const atrR = rma( tr, length );
const plusR = rma( plusDM, length );
const minusR = rma( minusDM, length );
const plus = new Array(candles.length) .fill(NaN);
const minus = new Array(candles.length) .fill(NaN);
const dx = new Array(candles.length) .fill(NaN);
for ( let i = 0; i < candles.length; i++ ) {
if (
  !finite(atrR[i]) ||
  atrR[i] <= 0
) {
  continue;
}

plus[i] =
  100 *
  plusR[i] /
  atrR[i];

minus[i] =
  100 *
  minusR[i] /
  atrR[i];

const sum =
  plus[i] +
  minus[i];

if (sum > 0) {

  dx[i] =
    100 *
    Math.abs(
      plus[i] -
      minus[i]
    ) /
    sum;
}
}
return { adx: rma(dx, length), plus, minus }; }
// ============================================================ // SUPERTREND // // Standard ATR-based SuperTrend // ATR 10 / multiplier 3 // ============================================================
function supertrend( candles, atrLength = 10, multiplier = 3 ) {
const atrSeries = atr( candles, atrLength );
const upper = new Array(candles.length) .fill(NaN);
const lower = new Array(candles.length) .fill(NaN);
const line = new Array(candles.length) .fill(NaN);
const direction = new Array(candles.length) .fill(0);
const signal = new Array(candles.length) .fill(0);
for ( let i = 0; i < candles.length; i++ ) {
if (!finite(atrSeries[i])) {
  continue;
}

const hl2 =
  (
    candles[i].h +
    candles[i].l
  ) / 2;

const basicUpper =
  hl2 +
  multiplier *
  atrSeries[i];

const basicLower =
  hl2 -
  multiplier *
  atrSeries[i];

if (
  i === 0 ||
  !finite(upper[i - 1])
) {

  upper[i] =
    basicUpper;

  lower[i] =
    basicLower;

  direction[i] =
    1;

  line[i] =
    lower[i];

  continue;
}

upper[i] =
  basicUpper < upper[i - 1] ||
  candles[i - 1].c >
    upper[i - 1]
    ? basicUpper
    : upper[i - 1];

lower[i] =
  basicLower > lower[i - 1] ||
  candles[i - 1].c <
    lower[i - 1]
    ? basicLower
    : lower[i - 1];

const previousLine =
  line[i - 1];

if (
  previousLine ===
  upper[i - 1]
) {

  direction[i] =
    candles[i].c <= upper[i]
      ? -1
      : 1;

} else {

  direction[i] =
    candles[i].c >= lower[i]
      ? 1
      : -1;
}

line[i] =
  direction[i] === 1
    ? lower[i]
    : upper[i];

if (
  direction[i] === 1 &&
  direction[i - 1] === -1
) {

  signal[i] = 1;

} else if (
  direction[i] === -1 &&
  direction[i - 1] === 1
) {

  signal[i] = -1;
}
}
return { line, direction, signal }; }
// ============================================================ // VOLUME // ============================================================
function volumeRatio( candles, length = 20 ) {
if ( candles.length <= length ) { return 1; }
const base = avg( candles .slice( -length - 1, -1 ) .map(x => x.v) );
if ( !finite(base) || base <= 0 ) { return 1; }
return ( candles.at(-1).v / base ); }
// ============================================================ // BARS SINCE SIGNAL // ============================================================
function barsSince( signal, direction, maxBars = 12 ) {
for ( let i = signal.length - 1;
i >=
  Math.max(
    0,
    signal.length - maxBars
  );

i--
) {
if (
  signal[i] ===
  direction
) {

  return (
    signal.length -
    1 -
    i
  );
}
}
return Infinity; }
// ============================================================ // MARKET STRUCTURE // ============================================================
function swingStructure( candles, lookback = 40 ) {
const recent = candles.slice( -lookback );
if ( recent.length < 20 ) {
return {
  bull: false,
  bear: false,
  high: NaN,
  low: NaN
};
}
const mid = Math.floor( recent.length / 2 );
const first = recent.slice( 0, mid );
const second = recent.slice( mid );
const firstHigh = Math.max( ...first.map( x => x.h ) );
const secondHigh = Math.max( ...second.map( x => x.h ) );
const firstLow = Math.min( ...first.map( x => x.l ) );
const secondLow = Math.min( ...second.map( x => x.l ) );
return {
bull:
  secondHigh > firstHigh &&
  secondLow >= firstLow,

bear:
  secondLow < firstLow &&
  secondHigh <= firstHigh,

high:
  Math.max(
    ...candles
      .slice(-12, -1)
      .map(x => x.h)
  ),

low:
  Math.min(
    ...candles
      .slice(-12, -1)
      .map(x => x.l)
  )
}; }
async function coreLogic(data4h, data15, data1h, data5, symbol = null) {
  CORE_CALLS++;

  // Chỉ dùng Range Filter 100/3 trên 15M.
  const candles15 = prepare(data15, 600);
  if (!candles15) return coreReject('RF_WARMUP_15M');

  const rf15 = rangeFilter(candles15, 100, 3);
  const i15 = candles15.length - 1;

  if (!Array.isArray(rf15.buy) || !Array.isArray(rf15.sell)) {
    return coreReject('RF_BUY_SELL_ARRAY_MISSING');
  }

  const buy = rf15.buy[i15] === true;
  const sell = rf15.sell[i15] === true;

  if (!buy && !sell) return coreReject('RF_15M_NO_BUY_SELL');
  if (buy && sell) return coreReject('RF_15M_CONFLICTING_SIGNAL');

  const side = buy ? 'LONG' : 'SHORT';
  const price = candles15[i15].c;
  const filter15 = rf15.filter[i15];
  const range15 = rf15.range[i15];

  if (
    ![price, filter15, range15].every(finite) ||
    price <= 0 ||
    range15 <= 0
  ) {
    return coreReject('RF_15M_INVALID_VALUE');
  }

  // SL theo envelope đối diện của Range Filter 15M.
  const sl = buy
    ? filter15 - range15
    : filter15 + range15;

  const risk = Math.abs(price - sl);

  if (
    !finite(risk) ||
    risk <= 0 ||
    (buy ? sl >= price : sl <= price)
  ) {
    return coreReject('RF_15M_INVALID_STOP');
  }

  const targetR = 3.5;
  const tp = buy
    ? price + risk * targetR
    : price - risk * targetR;

  const volRatio = range15 / price;
  const score = 80;

  CORE_REJECTS.ACCEPTED = (CORE_REJECTS.ACCEPTED || 0) + 1;

  return {
    side,
    price,
    sl,
    tp,
    setup: '15M_BUY_SELL',
    pullbackType: 'NONE',
    triggerType: buy
      ? '15M_BUY'
      : '15M_SELL',
    marketState: buy
      ? 'FILTER_BUY'
      : 'FILTER_SELL',
    volatility: volRatio < 0.001
      ? 'LOW'
      : volRatio < 0.004
        ? 'NORMAL'
        : 'HIGH',
    qualityScore: score,
    score,
    risk: { risk, initialRisk: risk, rr: targetR, targetR }
  };
}

coreLogic.getRejectStats = getCoreRejectStats;
coreLogic.resetRejectStats = resetCoreRejectStats;
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
function scoreRF15Signal(data15, side) {
  const candles = prepare(data15, 600);
  if (!candles) return { adjustment: 0 };

  const rf = rangeFilter(candles, 100, 3);
  const i = candles.length - 1;
  const lookback = 12;
  const anchor = i - 3;

  if (i < lookback || anchor < 0) {
    return { adjustment: 0 };
  }

  // ER thấp thường là giá giật qua lại;
  // ER cao nghĩa là giá đi tương đối liền mạch.
  let path = 0;
  for (let j = i - lookback + 1; j <= i; j++) {
    path += Math.abs(candles[j].c - candles[j - 1].c);
  }

  const netMove = candles[i].c - candles[i - lookback].c;
  const efficiency = path > 0
    ? Math.abs(netMove) / path
    : 0;

  const alignedMove =
    side === 'LONG' ? netMove > 0 :
    side === 'SHORT' ? netMove < 0 :
    false;

  // Đo giá đã chạy vượt envelope cũ theo hướng tín hiệu bao xa,
  // tính theo số lần Range Filter hiện tại.
  const oldFilter = rf.filter[anchor];
  const oldRange = rf.range[anchor];
  const currentRange = rf.range[i];
  const price = candles[i].c;

  let extensionUnits = 0;

  if (
    [oldFilter, oldRange, currentRange, price].every(finite) &&
    oldRange > 0 &&
    currentRange > 0
  ) {
    const oldOuterEdge = side === 'LONG'
      ? oldFilter + oldRange
      : oldFilter - oldRange;

    extensionUnits = side === 'LONG'
      ? (price - oldOuterEdge) / currentRange
      : (oldOuterEdge - price) / currentRange;
  }

  extensionUnits = Math.max(0, extensionUnits);

  const alignmentPoints = alignedMove ? 4 : -4;
  const extensionPenalty = Math.min(
    10,
    Math.max(0, extensionUnits - 1) * 3
  );

  return {
    adjustment:
      efficiency * 10 +
      alignmentPoints -
      extensionPenalty,
    efficiency,
    alignedMove,
    extensionUnits
  };
}
// ================= SCAN =================
async function scan(symbol){

    try{

        // ==================================================
        // 1. LOAD MARKET DATA
        // ==================================================

       const [
    data4h,
    data15,
    data1h,
    data5
] = await Promise.all([
    getData(symbol,"4h",1),
    getData(symbol,"15m",601),
    getData(symbol,"1h",1),
    getData(symbol,"5m",1),
])
        // ==================================================
        // 3. CORE LOGIC
        // ==================================================

        let r

        try{

            r = await coreLogic(data4h, data15, data1h, data5, symbol)

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
        const rfRank = scoreRF15Signal(data15, r.side);
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
            ...r,
            rankAdjustment: rfRank.adjustment,
rankMetrics: {
  efficiency: rfRank.efficiency,
  alignedMove: rfRank.alignedMove,
  extensionUnits: rfRank.extensionUnits
}
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
// Accepts the stable minimum core contract (side, price/entry, sl, tp),
// carries additional core fields through unchanged, and normalizes DB fields.
function buildTradeFromCoreSignal(best, btcRegime, riskBudget) {
  const side = String(best?.side ?? best?.direction ?? '').toUpperCase();
  const entry = Number(best?.price ?? best?.entry);
  const sl = Number(best?.sl ?? best?.stopLoss);
  const tp = Number(best?.tp ?? best?.takeProfit);
  const priceRisk = Math.abs(entry - sl);
  const budget = Number(riskBudget);
  const rr = priceRisk > 0 ? Math.abs(tp - entry) / priceRisk : NaN;

  if (
    !best?.symbol ||
    !['LONG', 'SHORT'].includes(side) ||
    !Number.isFinite(entry) || entry <= 0 ||
    !Number.isFinite(sl) || sl <= 0 ||
    !Number.isFinite(tp) || tp <= 0 ||
    !Number.isFinite(priceRisk) || priceRisk <= 0 ||
    !Number.isFinite(budget) || budget <= 0 ||
    !Number.isFinite(rr) || rr <= 0
  ) {
    console.log(`❌ INVALID CORE SIGNAL ${best?.symbol || 'UNKNOWN'}`);
    return null;
  }

  if (
    (side === 'LONG' && (sl >= entry || tp <= entry)) ||
    (side === 'SHORT' && (sl <= entry || tp >= entry))
  ) {
    console.log(
      `❌ INVALID TPSL DIRECTION ${best.symbol} ` +
      `SIDE=${side} ENTRY=${entry} SL=${sl} TP=${tp}`
    );
    return null;
  }

  const now = Date.now();
  const sourceRisk = best?.risk && typeof best.risk === 'object' ? best.risk : {};
  const indicators = best?.indicators && typeof best.indicators === 'object' ? best.indicators : {};
  const riskDetail = best?.riskDetail && typeof best.riskDetail === 'object'
    ? best.riskDetail
    : sourceRisk;
  const qualityScore = Number(best?.qualityScore ?? best?.score ?? best?.quality?.score ?? 0);

  return {
    // Keep new core fields without requiring this mapper to be edited each time.
    ...best,
    symbol: String(best.symbol),
    side,
    entry,
    price: entry,
    sl,
    tp,
    setup: best.setup ?? 'CORE_SIGNAL',
    pullbackType: best.pullbackType ?? null,
    triggerType: best.triggerType ?? null,
    marketState: best.marketState ?? null,
    volatility: best.volatility ?? null,
    btcRegime: btcRegime ?? best.btcRegime ?? null,
    qualityScore: Number.isFinite(qualityScore) ? qualityScore : 0,

    // `risk` remains the monetary sizing budget expected by the execution code.
    risk: budget,
    initialRisk: priceRisk,
    rr,
    riskDetail: {
      ...riskDetail,
      coreRisk: sourceRisk,
      risk: priceRisk,
      initialRisk: priceRisk,
      rr,
      slDistance: priceRisk,
      tpDistance: Math.abs(tp - entry),
      riskPercent: entry > 0 ? priceRisk / entry : 0,
      riskBudget: budget
    },
    indicators,
    structure: best?.structure && typeof best.structure === 'object' ? best.structure : {},
    context: best?.context && typeof best.context === 'object' ? best.context : {},
    flags: best?.flags && typeof best.flags === 'object' ? best.flags : {},
    debug: best?.debug && typeof best.debug === 'object' ? best.debug : {},
    quantity: 0,
    notional: 0,
    finalRisk: 0,
    waitingEntry: false,
    breakoutTriggered: Boolean(best?.breakoutTriggered ?? best?.setup === 'BREAKOUT_RETEST'),
    createdAt: Number(best?.createdAt) || now,
    enteredAt: best?.enteredAt ?? null,
    openedAt: best?.openedAt ?? null,
    closedAt: best?.closedAt ?? null,
    updatedAt: now,
    result: best?.result ?? 'PENDING'
  };
}

// ================= SCANNER ================
async function scanner(){
    
    if(isScanning){
        console.log("⛔ Skip scan trùng")
        return
    }

    isScanning = true

     try{
        const cooldownLeft = NEXT_ENTRY_ALLOWED_AT - Date.now();

if (cooldownLeft > 0) {
  console.log(
    `⏳ ENTRY COOLDOWN: còn ${Math.ceil(cooldownLeft / 60000)} phút`
  );
  return;
}

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

const coreQuality = Number(s.qualityScore ?? s.score ?? 0)
const rfAdjustment = Number(s.rankAdjustment) || 0;
const rankScore =
  coreQuality +
  rfAdjustment +
  Math.max(-10, Math.min(10, aiMain));
candidates.push({
    ...s,
    finalScore: aiMain,
    rankScore,
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

        // Rank all valid signals collected during this scan cycle.
candidates.sort((a, b) =>
    (Number(b.rankScore) || 0) - (Number(a.rankScore) || 0) ||
    (Number(b.qualityScore ?? b.score) || 0) - (Number(a.qualityScore ?? a.score) || 0)
)
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
.sort((a,b)=>
    (Number(b.rankScore) || 0) - (Number(a.rankScore) || 0) ||
    (Number(b.qualityScore ?? b.score) || 0) - (Number(a.qualityScore ?? a.score) || 0)
)

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
let picks = filtered.slice(0, 1);
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

    if(totalPending >= 25){
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
NEXT_ENTRY_ALLOWED_AT = Date.now() + ENTRY_COOLDOWN_MS;
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

    break
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

    // One successfully opened coin per scan cycle; existing duplicate/opening
    // guards above remain the final authority for this symbol.
    break
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
        `⚠ POSITION CACHE FAIL ${t.symbol}:`,
        e?.message || e
    )
    continue
}

if(!Array.isArray(positions)){
    console.error(
        `⚠ POSITION CACHE INVALID ${t.symbol}`
    )
    continue
}

const realPos = positions.find(p =>
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

        // scan mỗi 1 phút
await new Promise(r =>
    setTimeout(r, 60000)
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

process.on("exit", cleanup)
process.on("SIGINT", () => { cleanup(); process.exit() })
process.on("SIGTERM", () => { cleanup(); process.exit() })
