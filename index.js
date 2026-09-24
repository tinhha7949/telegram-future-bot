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

        const [data5, data15, data1h] = await Promise.all([getData(symbol, '5m', 100), getData(symbol, '15m', 100), getData(symbol, '1h', 100)])
        if (!Array.isArray(data5) || !Array.isArray(data15) || !Array.isArray(data1h) || data5.length < 70 || data15.length < 70 || data1h.length < 70) return
        const closed5 = data5.slice(0, -1), closed15 = data15.slice(0, -1), closed1h = data1h.slice(0, -1)
        if (closed5.length < 60 || closed15.length < 60 || closed1h.length < 60) return

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
const R = Number.isFinite(initialRisk) && initialRisk > 0
    ? profit / initialRisk
    : 0

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

        // =========================================================
// MARKET-STRUCTURE TRAILING
// Không dùng R để trailing SL.
//
// LONG:
//   confirmed Higher-Low 15M/1H
//   + continuation xác nhận
//   => SL nằm dưới swing.
//
// SHORT:
//   confirmed Lower-High 15M/1H
//   + continuation xác nhận
//   => SL nằm trên swing.
//
// Quan trọng:
// - Swing phải hình thành SAU khi vào lệnh.
// - Không trailing chỉ vì R tăng.
// - Không trailing theo từng nhịp 5M.
// - SL chỉ được siết, tuyệt đối không được nới.
// =========================================================

let swing = null
let structureTF = 'NONE'

const entryTime = enteredAt

const h15 = closed15.map(x => Number(x[2]))
const l15 = closed15.map(x => Number(x[3]))
const c15 = closed15.map(x => Number(x[4]))

const h1 = closed1h.map(x => Number(x[2]))
const l1 = closed1h.map(x => Number(x[3]))
const c1 = closed1h.map(x => Number(x[4]))

const t15 = closed15.map(x => Number(x[0]))
const t1 = closed1h.map(x => Number(x[0]))

const findConfirmedLow = (lows, times, lookback = 32) => {
    for (
        let i = lows.length - 3;
        i >= Math.max(2, lows.length - lookback);
        i--
    ) {
        if (!Number.isFinite(lows[i]) || !Number.isFinite(times[i])) continue

        if (
            lows[i] < lows[i - 1] &&
            lows[i] <= lows[i - 2] &&
            lows[i] < lows[i + 1] &&
            lows[i] <= lows[i + 2] &&
            times[i] > entryTime
        ) {
            return {
                price: lows[i],
                index: i,
                time: times[i]
            }
        }
    }
    return null
}

const findConfirmedHigh = (highs, times, lookback = 32) => {
    for (
        let i = highs.length - 3;
        i >= Math.max(2, highs.length - lookback);
        i--
    ) {
        if (!Number.isFinite(highs[i]) || !Number.isFinite(times[i])) continue

        if (
            highs[i] > highs[i - 1] &&
            highs[i] >= highs[i - 2] &&
            highs[i] > highs[i + 1] &&
            highs[i] >= highs[i + 2] &&
            times[i] > entryTime
        ) {
            return {
                price: highs[i],
                index: i,
                time: times[i]
            }
        }
    }
    return null
}

const findConfirmationAfterLow = (highs, closes, swingIndex) => {
    for (
        let i = swingIndex + 1;
        i < closes.length;
        i++
    ) {
        if (
            Number.isFinite(highs[i]) &&
            Number.isFinite(closes[i]) &&
            closes[i] > highs[swingIndex]
        ) {
            return true
        }
    }
    return false
}

const findConfirmationAfterHigh = (lows, closes, swingIndex) => {
    for (
        let i = swingIndex + 1;
        i < closes.length;
        i++
    ) {
        if (
            Number.isFinite(lows[i]) &&
            Number.isFinite(closes[i]) &&
            closes[i] < lows[swingIndex]
        ) {
            return true
        }
    }
    return false
}

// =========================================================
// 15M STRUCTURE
// =========================================================

let swing15 = null

if (
    h15.length >= 10 &&
    l15.length >= 10 &&
    c15.length >= 10 &&
    [h15, l15, c15, t15].flat().every(Number.isFinite)
) {

    if (side === 'LONG') {

        const candidate = findConfirmedLow(l15, t15, 32)

        if (candidate) {

            const confirmed =
                findConfirmationAfterLow(
                    h15,
                    c15,
                    candidate.index
                )

            if (confirmed) {
                swing15 = candidate
            }
        }

    } else {

        const candidate = findConfirmedHigh(h15, t15, 32)

        if (candidate) {

            const confirmed =
                findConfirmationAfterHigh(
                    l15,
                    c15,
                    candidate.index
                )

            if (confirmed) {
                swing15 = candidate
            }
        }
    }
}

// =========================================================
// 1H STRUCTURE
// Chỉ dùng khi 15M chưa đủ rõ hoặc 1H tạo cấu trúc mới
// =========================================================

let swing1H = null

if (
    h1.length >= 10 &&
    l1.length >= 10 &&
    c1.length >= 10 &&
    [h1, l1, c1, t1].flat().every(Number.isFinite)
) {

    if (side === 'LONG') {

        const candidate = findConfirmedLow(l1, t1, 24)

        if (candidate) {

            const confirmed =
                findConfirmationAfterLow(
                    h1,
                    c1,
                    candidate.index
                )

            if (confirmed) {
                swing1H = candidate
            }
        }

    } else {

        const candidate = findConfirmedHigh(h1, t1, 24)

        if (candidate) {

            const confirmed =
                findConfirmationAfterHigh(
                    l1,
                    c1,
                    candidate.index
                )

            if (confirmed) {
                swing1H = candidate
            }
        }
    }
}

// =========================================================
// CHỌN CẤU TRÚC MỚI NHẤT
//
// Không chọn theo R.
// Chọn theo cấu trúc đã xác nhận gần nhất.
// =========================================================

if (side === 'LONG') {

    if (
        swing1H &&
        swing15 &&
        swing1H.time > swing15.time
    ) {
        swing = swing1H
        structureTF = '1H'
    } else if (swing15) {
        swing = swing15
        structureTF = '15M'
    } else if (swing1H) {
        swing = swing1H
        structureTF = '1H'
    }

} else {

    if (
        swing1H &&
        swing15 &&
        swing1H.time > swing15.time
    ) {
        swing = swing1H
        structureTF = '1H'
    } else if (swing15) {
        swing = swing15
        structureTF = '15M'
    } else if (swing1H) {
        swing = swing1H
        structureTF = '1H'
    }
}

// =========================================================
// STRUCTURE SL
// =========================================================

if (swing) {

    const structureBuffer =
        structureTF === '1H'
            ? Math.max(
                atr15 * .35,
                atr1H * .15,
                current * .00040
            )
            : Math.max(
                atr15 * .25,
                atr5 * .20,
                current * .00030
            )

    const structureSL =
        side === 'LONG'
            ? swing.price - structureBuffer
            : swing.price + structureBuffer

    if (Number.isFinite(structureSL)) {

        if (
            side === 'LONG' &&
            structureSL > newSL &&
            structureSL < current
        ) {
            newSL = structureSL
        }

        if (
            side === 'SHORT' &&
            structureSL < newSL &&
            structureSL > current
        ) {
            newSL = structureSL
        }
    }
}

        // TP extension is exceptional, not automatic.  It may happen only before
        // the original TP is hit: price must be close to it, 5M momentum must
        // continue, and there must be a materially farther visible structure.
        const c15TP = closed15.map(x => Number(x[4]))

const e20_15TP = ema(c15TP.slice(-80), 20)
const e50_15TP = ema(c15TP.slice(-100), 50)
const e20_15TPPrev = ema(c15TP.slice(-81, -1), 20)
const slope15TP = e20_15TPPrev > 0
    ? (e20_15TP - e20_15TPPrev) / e20_15TPPrev
    : 0

const momentumLong =
    side === 'LONG' &&
    e20_15TP > e50_15TP &&
    c15TP.at(-1) > e20_15TP &&
    slope15TP >= 0.00010

const momentumShort =
    side === 'SHORT' &&
    e20_15TP < e50_15TP &&
    c15TP.at(-1) < e20_15TP &&
    slope15TP <= -0.00010

const h15TP = closed15.map(x => Number(x[2]))
const l15TP = closed15.map(x => Number(x[3]))

const h1TP = closed1h.map(x => Number(x[2]))
const l1TP = closed1h.map(x => Number(x[3]))

const allHighs =
    h15TP.slice(-48, -1).concat(
        h1TP.slice(-80, -1)
    )

const allLows =
    l15TP.slice(-48, -1).concat(
        l1TP.slice(-80, -1)
    )

/*
 * Nếu giá đã vượt TP cũ:
 * tuyệt đối không dùng oldTP làm TP mới.
 */
const tpAlreadyPassed =
    side === 'LONG'
        ? current >= oldTP
        : current <= oldTP

const nearOriginalTP =
    side === 'LONG'
        ? current < oldTP &&
          oldTP - current <= Math.max(atr15 * .60, initialRisk * .30)
        : current > oldTP &&
          current - oldTP <= Math.max(atr15 * .60, initialRisk * .30)

/*
 * Chưa vượt TP → tìm obstacle phía trên oldTP.
 * Đã vượt TP → tìm obstacle phía trên CURRENT.
 */
const obstacleReference =
    tpAlreadyPassed
        ? current
        : oldTP

const nextObstacle =
    side === 'LONG'
        ? nearestAbove(allHighs, obstacleReference)
        : nearestBelow(allLows, obstacleReference)

let extendedTP = Number.NaN

/*
 * Có obstacle → đặt TP trước obstacle.
 */
if(Number.isFinite(nextObstacle)){

    extendedTP =
        side === 'LONG'
            ? nextObstacle - buffer * .20
            : nextObstacle + buffer * .20
}

/*
 * Không có obstacle → KHÔNG bỏ TP.
 *
 * Tạo TP mới dựa trên ATR + initialRisk,
 * và luôn đặt nó phía trước CURRENT.
 */
if(!Number.isFinite(extendedTP)){

    const fallbackDistance =
    Math.max(
        atr15 * 1.00,
        initialRisk * .80,
        current * .0015
    )

    extendedTP =
        side === 'LONG'
            ? current + fallbackDistance
            : current - fallbackDistance
}

/*
 * TP mới phải cách giá hiện tại đủ xa.
 */
const minimumExtension =
    Math.max(
        atr15 * .35,
        initialRisk * .35,
        current * .0005
    )

const enoughExtension =
    Number.isFinite(extendedTP) &&
    (
        tpAlreadyPassed
            ? (
                side === 'LONG'
                    ? extendedTP > current + minimumExtension
                    : extendedTP < current - minimumExtension
            )
            : (
                side === 'LONG'
                    ? extendedTP >= oldTP + minimumExtension
                    : extendedTP <= oldTP - minimumExtension
            )
    )

const continuation =
    (side === 'LONG' && momentumLong) ||
    (side === 'SHORT' && momentumShort)

/*
 * TP extension:
 *
 * - TP chưa bị vượt → cần gần TP + momentum.
 * - TP đã bị vượt → cho phép tìm TP mới phía trước,
 *   nhưng momentum vẫn phải còn tốt.
 */
const canExtendTP =
    continuation &&
    enoughExtension &&
    (
        tpAlreadyPassed ||
        nearOriginalTP
    )

if (canExtendTP) {
    newTP = extendedTP

    console.log(
        `🔄 DYNAMIC TP EXTEND ${symbol} ` +
        `${side} OLD=${oldTP} ` +
        `CURRENT=${current} ` +
        `NEW=${newTP} ` +
        `PASSED=${tpAlreadyPassed}`
    )
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
        if(
    (side === 'LONG' && newTP <= current) ||
    (side === 'SHORT' && newTP >= current)
){
    console.log(
        `⛔ DYNAMIC TP INVALID BEFORE SET ${symbol} ` +
        `SIDE=${side} CURRENT=${current} TP=${newTP}`
    )
    return
}
        const updateTrade = { ...trade, symbol, side, entry, sl: newSL, tp: newTP, initialRisk, previousSL: oldSL }
        const result = await setDynamicTPSL(updateTrade)
        if (!result?.ok) {
            console.log(`⚠️ DYNAMIC TPSL FAILED ${symbol}`)
            return
        }
        const finalSL = Number(result.sl), finalTP = Number(result.tp)
        if (!(finalSL > 0 && finalTP > 0)) return
        // Reject an exchange result that widens the stop or moves TP backward.
        const invalidLong =
    side === 'LONG' &&
    (
        finalSL < oldSL ||
        finalSL >= current ||
        finalTP < oldTP ||
        finalTP <= current
    )

const invalidShort =
    side === 'SHORT' &&
    (
        finalSL > oldSL ||
        finalSL <= current ||
        finalTP > oldTP ||
        finalTP >= current
    )
        if (invalidLong || invalidShort) {
            console.log(`🚨 REJECT INVALID DYNAMIC RESULT ${symbol}`)
            return
        }
        trade.sl = finalSL
trade.tp = finalTP

const dynamicPhase =
    structureTF === '1H'
        ? 2
        : swing
            ? 1
            : 0

DYNAMIC_LAST_UPDATE[symbol] = Date.now()
DYNAMIC_PHASE[symbol] = dynamicPhase

await trades.updateOne(
    { symbol, result: 'PENDING' },
    {
        $set: {
            sl: finalSL,
            tp: finalTP,
            initialRisk,
            dynamicPhase,
            dynamicUpdatedAt: Date.now(),
            updatedAt: Date.now()
        }
    }
)

console.log(
    `🎯 DYNAMIC ${symbol} ${side} ` +
    `R=${R.toFixed(2)} ` +
    `PHASE=${dynamicPhase} ` +
    `SL ${oldSL}->${finalSL} ` +
    `TP=${finalTP} ` +
    `swing=${swing?.price ?? 'none'} ` +
    `TF=${structureTF}`
)
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

    const volume =
        Number(c.quoteVolume)

    const move =
        Math.abs(
            Number(
                c.priceChangePercent
            )
        )

    if(
        !Number.isFinite(volume) ||
        !Number.isFinite(move) ||
        volume <= 0
    ){
        return -Infinity
    }

    // Thanh khoản là tiêu chí chính.
    const volumeScore =
        Math.log10(
            Math.max(volume, 1)
        ) * 3

    // Movement chỉ dùng để ưu tiên coin đang có hoạt động,
    // không để coin pump mạnh áp đảo bảng xếp hạng.
    const movementScore =
        Math.min(move, 6) * 0.50

    return (
        volumeScore +
        movementScore
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

async function coreLogic(data4h, data15, data1h, data5) {
    CORE_TOTAL_CALLS++

    const reject = (reason, detail = {}) => {
        CORE_REJECT_STATS[reason] =
            (CORE_REJECT_STATS[reason] || 0) + 1

        CORE_REJECT_DETAILS[reason] = {
            ...detail,
            timestamp: Date.now()
        }

        return null
    }

    // =========================================================
    // 0. VALIDATION
    // =========================================================

    if (![data4h, data15, data1h, data5].every(Array.isArray)) {
        return reject('VALIDATION')
    }

    data4h = data4h.slice(0, -1)
    data15 = data15.slice(0, -1)
    data1h = data1h.slice(0, -1)
    data5 = data5.slice(0, -1)

    if (
        data4h.length < 220 ||
        data15.length < 120 ||
        data1h.length < 220 ||
        data5.length < 100
    ) {
        return reject('DATA_LENGTH')
    }

    // =========================================================
    // 1. COLUMNS
    // =========================================================

    const col = (d, n) => d.map(x => Number(x[n]))

    const [o15, h15, l15, c15] = [
        col(data15, 1),
        col(data15, 2),
        col(data15, 3),
        col(data15, 4)
    ]

    const [hH, lH, cH] = [
        col(data1h, 2),
        col(data1h, 3),
        col(data1h, 4)
    ]

    const [h4, l4, c4] = [
        col(data4h, 2),
        col(data4h, 3),
        col(data4h, 4)
    ]

    const [o5, h5, l5, c5, v5] = [
        col(data5, 1),
        col(data5, 2),
        col(data5, 3),
        col(data5, 4),
        col(data5, 5)
    ]

    if (
        [
            o15, h15, l15, c15,
            hH, lH, cH,
            h4, l4, c4,
            o5, h5, l5, c5, v5
        ].flat().some(x => !Number.isFinite(x))
    ) {
        return reject('INVALID_DATA')
    }

    const price = c5.at(-1)

    if (!(price > 0)) {
        return reject('INVALID_DATA')
    }

    // =========================================================
    // 2. HELPERS
    // =========================================================

    const avg = a =>
        a.length
            ? a.reduce((s, x) => s + x, 0) / a.length
            : 0

    const hi = (a, n) =>
        a.length
            ? Math.max(...a.slice(-n))
            : -Infinity

    const lo = (a, n) =>
        a.length
            ? Math.min(...a.slice(-n))
            : Infinity

    const r = (x, d = 8) =>
        Number(Number(x).toFixed(d))

    const change = (a, b) =>
        b ? (a - b) / b : 0

    const candleBody = (o, h, l, c) =>
        h > l ? Math.abs(c - o) / (h - l) : 0

    const closeLocation = (h, l, c) =>
        h > l ? (c - l) / (h - l) : 0.5

    const clamp = (x, min, max) =>
        Math.max(min, Math.min(max, x))

    const pivotLevels = (highs, lows, left = 2, right = 2) => {
        const pivotHighs = []
        const pivotLows = []

        for (
            let i = left;
            i < highs.length - right;
            i++
        ) {
            const beforeH = highs.slice(i - left, i)
            const afterH = highs.slice(i + 1, i + 1 + right)

            const beforeL = lows.slice(i - left, i)
            const afterL = lows.slice(i + 1, i + 1 + right)

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

        return {
            pivotHighs,
            pivotLows
        }
    }

    const nearestAbove = (levels, from) => {
        const x = levels
            .filter(v => Number.isFinite(v) && v > from)
            .sort((a, b) => a - b)

        return x[0]
    }

    const nearestBelow = (levels, from) => {
        const x = levels
            .filter(v => Number.isFinite(v) && v < from)
            .sort((a, b) => b - a)

        return x[0]
    }

    // =========================================================
    // 3. VOLATILITY
    // =========================================================

    const atr5 = Math.max(
        Number(atr(data5.slice(-60))) || 0,
        price * 0.001
    )

    const atr15 = Math.max(
        Number(atr(data15.slice(-60))) || 0,
        price * 0.002
    )

    const atr1H = Math.max(
        Number(atr(data1h.slice(-60))) || 0,
        price * 0.003
    )

    const atr4H = Math.max(
        Number(atr(data4h.slice(-60))) || 0,
        price * 0.005
    )

    const atr5Ratio = atr5 / price

    if (
        !(atr5Ratio > 0) ||
        atr5Ratio > 0.025
    ) {
        return reject('ATR5', {
            atrRatio5: r(atr5Ratio, 6)
        })
    }

    // =========================================================
    // 4. 4H MAIN LONG-TERM DIRECTION
    //
    // 4H chỉ quyết định:
    //
    // LONG  = xu hướng chính tăng
    // SHORT = xu hướng chính giảm
    //
    // Không yêu cầu structure 4H hoàn hảo.
    // =========================================================

    const e20_4H =
        ema(c4.slice(-120), 20)

    const e50_4H =
        ema(c4.slice(-160), 50)

    const e200_4H =
        ema(c4.slice(-220), 200)

    const e20_4HPrev =
        ema(c4.slice(-121, -1), 20)

    const e50_4HPrev =
        ema(c4.slice(-161, -1), 50)

    const slope20_4H =
        change(e20_4H, e20_4HPrev)

    const slope50_4H =
        change(e50_4H, e50_4HPrev)

    const price4H =
        c4.at(-1)

    // 1. 4H — chỉ siết nhẹ
const bull4H =
    price4H > e200_4H &&
    e20_4H > e50_4H &&
    e50_4H > e200_4H &&
    slope20_4H > 0.00004 &&
    slope50_4H >= 0

const bear4H =
    price4H < e200_4H &&
    e20_4H < e50_4H &&
    e50_4H < e200_4H &&
    slope20_4H < -0.00004 &&
    slope50_4H <= 0

    if (!bull4H && !bear4H) {
        return reject('4H_TREND', {
            price4H: r(price4H),
            ema20_4h: r(e20_4H),
            ema50_4h: r(e50_4H),
            ema200_4h: r(e200_4H),
            slope20_4h: r(slope20_4H, 6),
            slope50_4h: r(slope50_4H, 6)
        })
    }

    // =========================================================
    // 5. 4H STRUCTURE
    //
    // Chỉ dùng để tăng/giảm quality.
    // KHÔNG dùng làm gate.
    // =========================================================

    const recent4HHigh =
        hi(h4.slice(-40, -1), 39)

    const previous4HHigh =
        hi(h4.slice(-80, -40), 40)

    const recent4HLow =
        lo(l4.slice(-40, -1), 39)

    const previous4HLow =
        lo(l4.slice(-80, -40), 40)

    const higherStructure4H =
        recent4HHigh > previous4HHigh &&
        recent4HLow > previous4HLow

    const lowerStructure4H =
        recent4HHigh < previous4HHigh &&
        recent4HLow < previous4HLow

    let side = 'NONE'

    if (bull4H && !bear4H) {
        side = 'LONG'
    } else if (bear4H && !bull4H) {
        side = 'SHORT'
    } else {
        return reject('4H_STRUCTURE', {
            bull4H,
            bear4H,
            higherStructure4H,
            lowerStructure4H,
            price4H: r(price4H)
        })
    }
    const strong4HStructure =
    side === 'LONG'
        ? higherStructure4H
        : lowerStructure4H

        const valid4HStructure =
    side === 'LONG'
        ? bull4H
        : bear4H

const structureAligned4H =
    side === 'LONG'
        ? higherStructure4H || (recent4HLow >= previous4HLow)
        : lowerStructure4H || (recent4HHigh <= previous4HHigh)

    // =========================================================
    // 6. 1H CONFIRMATION
    //
    // 1H xác nhận hướng của 4H.
    //
    // Quan trọng:
    // Không bắt buộc price phải nằm trên/dưới EMA200.
    // Pullback sâu vẫn được phép tồn tại trong trend.
    // =========================================================

    const e20H =
        ema(cH.slice(-120), 20)

    const e50H =
        ema(cH.slice(-160), 50)

    const e200H =
        ema(cH.slice(-220), 200)

    const e20HPrev =
        ema(cH.slice(-121, -1), 20)

    const hSlope =
        change(e20H, e20HPrev)

    const hGap =
        Math.abs(e20H - e50H) / price

    // 2. 1H — không bắt buộc EMA200, chỉ tăng nhẹ slope/gap
const bull1H =
    e20H > e50H &&
    hSlope >= 0.00005 &&
    hGap >= 0.00030

const bear1H =
    e20H < e50H &&
    hSlope <= -0.00005 &&
    hGap >= 0.00030

const strong1H =
    side === 'LONG'
        ? bull1H && hSlope >= 0.00008
        : bear1H && hSlope <= -0.00008

const strong1HTrend =
    side === 'LONG'
        ? bull1H
        : bear1H

if (!strong1HTrend) {
    return reject('1H_TREND_WEAK', {
        side,
        hSlope: r(hSlope, 6),
        hGap: r(hGap, 6)
    })
}

    if (
        side === 'LONG' &&
        !bull1H
    ) {
        return reject('1H_DIRECTION', {
            side,
            ema20: r(e20H),
            ema50: r(e50H),
            ema200: r(e200H),
            slope: r(hSlope, 6),
            gap: r(hGap, 6)
        })
    }

    if (
        side === 'SHORT' &&
        !bear1H
    ) {
        return reject('1H_DIRECTION', {
            side,
            ema20: r(e20H),
            ema50: r(e50H),
            ema200: r(e200H),
            slope: r(hSlope, 6),
            gap: r(hGap, 6)
        })
    }

    // =========================================================
    // 7. 15M CONTEXT
    //
    // 15M KHÔNG còn là gate bắt buộc phải nằm trong pullback zone.
    //
    // Nó chỉ xác định:
    // - trend 15M
    // - pullback
    // - recovery
    //
    // Sau đó 5M mới timing.
    // =========================================================

    const e20_15 =
        ema(c15.slice(-90), 20)

    const e50_15 =
        ema(c15.slice(-120), 50)

    const e20_15Prev =
        ema(c15.slice(-91, -1), 20)

    const mSlope =
        change(e20_15, e20_15Prev)

    const mGap =
        Math.abs(e20_15 - e50_15) / price

    const pullbackZone = Math.max(
    atr15 * 1.20,
    price * 0.0045
)

const trend15Long =
    e20_15 > e50_15 &&
    mSlope >= 0.00004

const trend15Short =
    e20_15 < e50_15 &&
    mSlope <= -0.00004

const structureLow15 =
    lo(l15.slice(-24, -1), 23)

const structureHigh15 =
    hi(h15.slice(-24, -1), 23)

const longPullbackZone =
    price >= e50_15 - pullbackZone &&
    price <= e20_15 + pullbackZone

const shortPullbackZone =
    price <= e50_15 + pullbackZone &&
    price >= e20_15 - pullbackZone

const longStructureSafe =
    price > structureLow15 + atr15 * 0.15

const shortStructureSafe =
    price < structureHigh15 - atr15 * 0.15

const recent15Low =
    lo(l15.slice(-7, -1), 6)

const recent15High =
    hi(h15.slice(-7, -1), 6)

const last15Open = o15.at(-1)
const last15High = h15.at(-1)
const last15Low = l15.at(-1)
const last15Close = c15.at(-1)

const prev15High = hi(h15.slice(-6, -1), 5)
const prev15Low = lo(l15.slice(-6, -1), 5)

const body15 = candleBody(
    last15Open,
    last15High,
    last15Low,
    last15Close
)

const closePos15 = closeLocation(
    last15High,
    last15Low,
    last15Close
)

const pullbackTouchLong15 =
    last15Low <= e20_15 + atr15 * 0.45 &&
    last15Low >= e50_15 - atr15 * 1.10

const pullbackTouchShort15 =
    last15High >= e20_15 - atr15 * 0.45 &&
    last15High <= e50_15 + atr15 * 1.10

const recovery15Long =
    pullbackTouchLong15 &&
    last15Close > e20_15 &&
    last15Close > last15Open &&
    last15Close > c15.at(-2) &&
    body15 >= 0.35 &&
    closePos15 >= 0.58

const recovery15Short =
    pullbackTouchShort15 &&
    last15Close < e20_15 &&
    last15Close < last15Open &&
    last15Close < c15.at(-2) &&
    body15 >= 0.35 &&
    closePos15 <= 0.42

const pullback15Long =
    trend15Long &&
    longStructureSafe &&
    recovery15Long

const pullback15Short =
    trend15Short &&
    shortStructureSafe &&
    recovery15Short

const context15Long =
    pullback15Long

const context15Short =
    pullback15Short

const strong15 =
    side === 'LONG'
        ? context15Long && mSlope >= 0.00006
        : context15Short && mSlope <= -0.00006
   // =========================================================
// 8. 5M ENTRY TIMING
//
// Mô hình:
// A. STRICT SWEEP
// B. TREND CONTINUATION
//
// 4H/1H quyết định hướng.
// 15M xác định pullback.
// 5M chỉ timing.
//
// SWEEP được siết mạnh.
// Nếu không có sweep sạch thì cho phép
// TREND CONTINUATION sau pullback.
// =========================================================

const e20 =
    ema(c5.slice(-80), 20)

const e50 =
    ema(c5.slice(-100), 50)

const triggerZone =
    Math.max(
        atr5 * 0.70,
        price * 0.0015
    )

let trigger5Index = -1
let triggerTypeLocal = null
let setupKind = null
let invalidation = null

const start5 =
    Math.max(
        20,
        c5.length - 3
    )

// =========================================================
// PASS 1 — STRICT SWEEP
//
// Sweep phải:
// - xảy ra rất gần hiện tại
// - phá structure trước đó
// - có độ sâu đủ lớn
// - đóng ngược trở lại vùng phá
// - candle có body/close mạnh
// - 15M đang đúng context
// =========================================================

for (
    let k = c5.length - 1;
    k >= start5;
    k--
) {
    const prevStart =
        Math.max(0, k - 8)

    const prevLow =
        lo(
            l5.slice(prevStart, k),
            k - prevStart
        )

    const prevHigh =
        hi(
            h5.slice(prevStart, k),
            k - prevStart
        )

    const b =
        candleBody(
            o5[k],
            h5[k],
            l5[k],
            c5[k]
        )

    const closePos =
        closeLocation(
            h5[k],
            l5[k],
            c5[k]
        )

    const bullishCandle =
        c5[k] > o5[k] &&
        b >= 0.50 &&
        closePos >= 0.68

    const bearishCandle =
        c5[k] < o5[k] &&
        b >= 0.50 &&
        closePos <= 0.32

    const sweepDepthLong =
    Number.isFinite(prevLow) &&
    Math.max(
        0,
        prevLow - l5[k]
    ) >= atr5 * 0.35

const sweepDepthShort =
    Number.isFinite(prevHigh) &&
    Math.max(
        0,
        h5[k] - prevHigh
    ) >= atr5 * 0.35

    const sweepLong =
        Number.isFinite(prevLow) &&
        l5[k] < prevLow &&
        c5[k] > prevLow &&
        sweepDepthLong &&
        bullishCandle

    const sweepShort =
        Number.isFinite(prevHigh) &&
        h5[k] > prevHigh &&
        c5[k] < prevHigh &&
        sweepDepthShort &&
        bearishCandle

    // Không nhận sweep nếu candle đã chạy quá xa EMA20.
    const sweepDistance =
        Math.abs(c5[k] - e20) / c5[k]

    const sweepNotChased =
    sweepDistance <=
    Math.max(
        atr5 * 1.20 / c5[k],
        0.0030
    )

const sweepRange =
    h5[k] - l5[k]

const sweepRangeATR =
    atr5 > 0
        ? sweepRange / atr5
        : 0

const sweepNotImpulse =
    sweepRangeATR <= 1.70

    if (
    side === 'LONG' &&
    sweepLong &&
    sweepNotChased &&
    sweepNotImpulse &&
    context15Long &&
    k < c5.length - 1
) {
        trigger5Index = k
        triggerTypeLocal =
            '5M_SWEEP_BULLISH'
        setupKind =
            'LONG_TERM_SWEEP'
        invalidation =
            Math.min(
                l5[k],
                prevLow
            )
        break
    }

    if (
    side === 'SHORT' &&
    sweepShort &&
    sweepNotChased &&
    sweepNotImpulse &&
    context15Short &&
    k < c5.length - 1
) {
        trigger5Index = k
        triggerTypeLocal =
            '5M_SWEEP_BEARISH'
        setupKind =
            'SHORT_TERM_SWEEP'
        invalidation =
            Math.max(
                h5[k],
                prevHigh
            )
        break
    }
}

// =========================================================
// PASS 2 — PULLBACK BREAKOUT
//
// Không vào chỉ vì candle xanh/đỏ.
// Phải:
// 1. 15M pullback
// 2. 5M pull lại EMA20
// 3. phá structure 5M
// 4. candle mạnh
// 5. volume xác nhận
// 6. không phải impulse quá lớn
// =========================================================

for (
    let k = c5.length - 1;
    k >= Math.max(20, c5.length - 2);
    k--
) {
    const prevStart =
        Math.max(0, k - 5)

    const prevLow =
        lo(
            l5.slice(prevStart, k),
            k - prevStart
        )

    const prevHigh =
        hi(
            h5.slice(prevStart, k),
            k - prevStart
        )

    const b =
        candleBody(
            o5[k],
            h5[k],
            l5[k],
            c5[k]
        )

    const closePos =
        closeLocation(
            h5[k],
            l5[k],
            c5[k]
        )

    const range5 =
        h5[k] - l5[k]

    const rangeATR =
        atr5 > 0
            ? range5 / atr5
            : 0

    const volBase =
        avg(
            v5.slice(
                Math.max(0, k - 20),
                k
            )
        )

    const volRatio =
        volBase > 0
            ? v5[k] / volBase
            : 1

    const bullishCandle =
    c5[k] > o5[k] &&
    b >= 0.48 &&
    closePos >= 0.64

const bearishCandle =
    c5[k] < o5[k] &&
    b >= 0.48 &&
    closePos <= 0.36

    const longBreak =
        Number.isFinite(prevHigh) &&
        c5[k] > prevHigh

    const shortBreak =
        Number.isFinite(prevLow) &&
        c5[k] < prevLow

    const retestLong =
    l5[k - 1] <= e20 + atr5 * 0.40 &&
    c5[k - 1] >= e20 - atr5 * 0.20

const retestShort =
    h5[k - 1] >= e20 - atr5 * 0.40 &&
    c5[k - 1] <= e20 + atr5 * 0.20

const longRecovery =
    retestLong &&
    c5[k] > e20 &&
    c5[k] > c5[k - 1]

const shortRecovery =
    retestShort &&
    c5[k] < e20 &&
    c5[k] < c5[k - 1]

    const notImpulse =
        rangeATR <= 1.80

    const volumeConfirmed =
        volRatio >= 1.05

    const nearEMA =
        Math.abs(c5[k] - e20) / c5[k] <=
        Math.max(
            atr5 * 1.20 / c5[k],
            0.0030
        )

    if (
        side === 'LONG' &&
        context15Long &&
        longBreak &&
        longRecovery &&
        bullishCandle &&
        notImpulse &&
        volumeConfirmed &&
        nearEMA
    ) {
        trigger5Index = k
        triggerTypeLocal =
            '5M_PULLBACK_BREAKOUT_BULLISH'
        setupKind =
            'LONG_TERM_TREND'
        invalidation =
            Math.min(
                l5[k],
                prevLow
            )
        break
    }

    if (
        side === 'SHORT' &&
        context15Short &&
        shortBreak &&
        shortRecovery &&
        bearishCandle &&
        notImpulse &&
        volumeConfirmed &&
        nearEMA
    ) {
        trigger5Index = k
        triggerTypeLocal =
            '5M_PULLBACK_BREAKOUT_BEARISH'
        setupKind =
            'SHORT_TERM_TREND'
        invalidation =
            Math.max(
                h5[k],
                prevHigh
            )
        break
    }
}
// ---------------------------------------------------------
// 9. FALLBACK ENTRY
// ---------------------------------------------------------

if (trigger5Index < 0) {
    return reject('5M_TRIGGER', {
        side,
        ema20: r(e20),
        ema50: r(e50),
        zone: r(triggerZone),
        pullback15Long,
        pullback15Short,
        trend15Long,
        trend15Short
    })
}

// ---------------------------------------------------------
// TRIGGER AGE
//
// Chỉ chấp nhận sweep hiện tại hoặc candle ngay trước.
// ---------------------------------------------------------

const triggerAge =
    c5.length - 1 - trigger5Index

if (triggerAge > 1) {
    return reject('TRIGGER_OLD', {
        side,
        setupKind,
        triggerAge5m: triggerAge
    })
}

// ---------------------------------------------------------
// POST-TRIGGER INVALIDATION
// ---------------------------------------------------------

const futureLows =
    l5.slice(trigger5Index + 1)

const futureHighs =
    h5.slice(trigger5Index + 1)

if (side === 'LONG') {
    const postLow =
        futureLows.length
            ? Math.min(...futureLows)
            : Infinity

    if (
        postLow <
        invalidation - atr5 * 0.15
    ) {
        return reject(
            'TRIGGER_INVALIDATED',
            {
                side,
                setupKind,
                invalidation:
                    r(invalidation),
                postLow:
                    r(postLow)
            }
        )
    }
} else {
    const postHigh =
        futureHighs.length
            ? Math.max(...futureHighs)
            : -Infinity

    if (
        postHigh >
        invalidation + atr5 * 0.15
    ) {
        return reject(
            'TRIGGER_INVALIDATED',
            {
                side,
                setupKind,
                invalidation:
                    r(invalidation),
                postHigh:
                    r(postHigh)
            }
        )
    }
}

// ---------------------------------------------------------
// RECLAIM / CONFIRMATION
//
// Nếu sweep xảy ra ở candle trước:
// candle hiện tại phải xác nhận tiếp diễn.
//
// Không chỉ cần xanh/đỏ.
// Phải vượt CLOSE của candle sweep.
// ---------------------------------------------------------

const currentOpen5 =
    o5.at(-1)

const currentHigh5 =
    h5.at(-1)

const currentLow5 =
    l5.at(-1)

const currentClose5 =
    c5.at(-1)

const triggerOpen5 =
    o5[trigger5Index]

const triggerHigh5 =
    h5[trigger5Index]

const triggerLow5 =
    l5[trigger5Index]

const triggerClose5 =
    c5[trigger5Index]

const currentClosePos5 =
    closeLocation(
        currentHigh5,
        currentLow5,
        currentClose5
    )

const reclaimLong =
    currentClose5 >
    triggerClose5 &&
    currentClose5 >
    triggerOpen5 &&
    currentClosePos5 >= 0.55

const reclaimShort =
    currentClose5 <
    triggerClose5 &&
    currentClose5 <
    triggerOpen5 &&
    currentClosePos5 <= 0.45

const sameCandleLong =
    triggerAge === 0 &&
    currentClose5 > triggerOpen5 &&
    currentClosePos5 >= 0.60

const sameCandleShort =
    triggerAge === 0 &&
    currentClose5 < triggerOpen5 &&
    currentClosePos5 <= 0.40

const trendContinuationLong =
    setupKind === 'LONG_TERM_TREND' &&
    currentClose5 > e20 &&
    currentClose5 > triggerClose5 &&
    currentClosePos5 >= 0.58

const trendContinuationShort =
    setupKind === 'SHORT_TERM_TREND' &&
    currentClose5 < e20 &&
    currentClose5 < triggerClose5 &&
    currentClosePos5 <= 0.42

const continuationLong =
    setupKind === 'LONG_TERM_TREND'
        ? trendContinuationLong
        : triggerAge === 0
            ? sameCandleLong
            : reclaimLong

const continuationShort =
    setupKind === 'SHORT_TERM_TREND'
        ? trendContinuationShort
        : triggerAge === 0
            ? sameCandleShort
            : reclaimShort

if (side === 'LONG') {
    if (!continuationLong) {
        return reject(
            'TRIGGER_NO_CONTINUATION',
            {
                side,
                triggerType:
                    triggerTypeLocal,
                triggerAge,
                triggerClose5,
                currentClose5,
                currentClosePos5,
                e20,
                e50
            }
        )
    }
} else {
    if (!continuationShort) {
        return reject(
            'TRIGGER_NO_CONTINUATION',
            {
                side,
                triggerType:
                    triggerTypeLocal,
                triggerAge,
                triggerClose5,
                currentClose5,
                currentClosePos5,
                e20,
                e50
            }
        )
    }
}

const strongContinuation =
    side === 'LONG'
        ? continuationLong &&
          currentClose5 > e20
        : continuationShort &&
          currentClose5 < e20

// ---------------------------------------------------------
// ENTRY LOCATION
// ---------------------------------------------------------

const entryLocationLong =
    side === 'LONG' &&
    price <= e20 + atr5 * 0.90 &&
    price >= e50 - atr5 * 0.80

const entryLocationShort =
    side === 'SHORT' &&
    price >= e20 - atr5 * 0.90 &&
    price <= e50 + atr5 * 0.80

const goodEntryLocation =
    side === 'LONG'
        ? entryLocationLong
        : entryLocationShort

if (!goodEntryLocation) {
    return reject(
        'ENTRY_LOCATION',
        {
            side,
            price,
            ema20: r(e20),
            ema50: r(e50),
            atr5: r(atr5),
            entryLocationLong,
            entryLocationShort
        }
    )
}

// ---------------------------------------------------------
// CONFIRMATION SCORE
// ---------------------------------------------------------
let confirmationScore = 0

if (strong4HStructure) {
    confirmationScore += 2
}

if (strong1HTrend) {
    confirmationScore += 2
}

if (strong15) {
    confirmationScore += 2
}

if (strongContinuation) {
    confirmationScore += 2
}

if (
    side === 'LONG'
        ? context15Long
        : context15Short
) {
    confirmationScore += 2
}

const requiredConfirmation =
    setupKind === 'LONG_TERM_SWEEP' ||
    setupKind === 'SHORT_TERM_SWEEP'
        ? 8
        : 7

if (confirmationScore < requiredConfirmation) {
    return reject(
        'CONFIRMATION_WEAK',
        {
            side,
            setupKind,
            confirmationScore,
            requiredConfirmation,
            strong4HStructure,
            strong1H,
            strong15,
            strongContinuation,
            pullback15Long,
            pullback15Short
        }
    )
}
    // =========================================================
    // 12. CHASE PROTECTION
    //
    // Chỉ chặn khi thực sự đuổi quá xa.
    // =========================================================

    const distanceFromEMA20 =
        Math.abs(price - e20) / price

    const maxChase =
    Math.max(
        atr5 * 1.80 / price,
        0.0045
    )

    if (distanceFromEMA20 > maxChase) {
        return reject('CHASE', {
            side,
            setupKind,
            distance: r(distanceFromEMA20, 6),
            maxChase: r(maxChase, 6)
        })
    }

    // =========================================================
// 13. LONG-TERM STRUCTURAL SL
//
// 4H/1H = cấu trúc chính
// 15M   = cấu trúc setup
// 5M    = chỉ dùng xác nhận entry
//
// Không dùng sweep 5M làm SL chính.
// =========================================================

const structure1HLow =
    lo(lH.slice(-36, -1), 35)

const structure1HHigh =
    hi(hH.slice(-36, -1), 35)

const setupLow15 =
    lo(l15.slice(-13, -1), 12)

const setupHigh15 =
    hi(h15.slice(-13, -1), 12)

const structure4HLow =
    lo(l4.slice(-30, -1), 29)

const structure4HHigh =
    hi(h4.slice(-30, -1), 29)

// Buffer theo timeframe lớn.
// SL phải nằm ngoài cấu trúc, không sát structure.
const slBuffer15 =
    Math.max(
        atr15 * 0.20,
        price * 0.0008
    )

const slBuffer1H =
    Math.max(
        atr1H * 0.18,
        atr15 * 0.10,
        price * 0.0012
    )

let structuralLow
let structuralHigh

if (side === 'LONG') {

    // Ưu tiên đáy 1H.
    // 15M chỉ hỗ trợ nếu nó sâu hơn.
    const baseLow =
        Math.min(
            structure1HLow,
            setupLow15
        )

    structuralLow =
        baseLow - slBuffer1H

    // Nếu sweep tạo đáy sâu hơn structure hiện tại,
    // cho phép SL nằm dưới sweep để tránh bị quét lại.
    if (Number.isFinite(invalidation)) {
        structuralLow =
            Math.min(
                structuralLow,
                invalidation - slBuffer15
            )
    }

    // Không để SL sâu vô hạn.
    // 4H chỉ làm giới hạn rủi ro.
    const maxStructuralRiskLow =
        structure4HLow - atr4H * 1.20

    structuralLow =
        Math.max(
            structuralLow,
            maxStructuralRiskLow
        )

    sl = structuralLow

} else {

    // SHORT đối xứng.
    const baseHigh =
        Math.max(
            structure1HHigh,
            setupHigh15
        )

    structuralHigh =
        baseHigh + slBuffer1H

    if (Number.isFinite(invalidation)) {
        structuralHigh =
            Math.max(
                structuralHigh,
                invalidation + slBuffer15
            )
    }

    const maxStructuralRiskHigh =
        structure4HHigh + atr4H * 1.20

    structuralHigh =
        Math.min(
            structuralHigh,
            maxStructuralRiskHigh
        )

    sl = structuralHigh
}

if (
    !Number.isFinite(sl) ||
    sl <= 0
) {
    return reject('SL_INVALID', {
        side,
        price,
        sl
    })
}

const risk =
    Math.abs(price - sl)

if (
    !Number.isFinite(risk) ||
    risk <= 0
) {
    return reject('RISK_INVALID', {
        side,
        price,
        sl,
        risk
    })
}

// =========================================================
// 14. LONG-TERM RISK RANGE
// =========================================================

const minRisk =
    Math.max(
        atr15 * 0.45,
        atr1H * 0.25,
        price * 0.0020
    )

const maxRisk =
    Math.min(
        Math.max(
            atr1H * 2.80,
            atr4H * 0.90,
            price * 0.045
        ),
        price * 0.055
    )

if (
    risk < minRisk ||
    risk > maxRisk
) {
    return reject('RISK', {
        side,
        risk: r(risk),
        minRisk: r(minRisk),
        maxRisk: r(maxRisk),
        riskATR1H: r(risk / atr1H, 3),
        riskATR4H: r(risk / atr4H, 3)
    })
}

// =========================================================
// 15. LONG-TERM INITIAL TP
//
// TP ưu tiên structure 4H.
// 15M/1H chỉ dùng làm obstacle tham khảo.
//
// Mục tiêu:
// - không chốt quá sớm ở 2R
// - tối thiểu khoảng 3R
// - ưu tiên 4H structure
// - TP ban đầu chỉ là target đầu tiên;
//   dynamic TPSL có thể quản lý phần còn lại.
// =========================================================

const levels15 =
    pivotLevels(
        h15.slice(-80, -1),
        l15.slice(-80, -1),
        3,
        3
    )

const levels1H =
    pivotLevels(
        hH.slice(-120, -1),
        lH.slice(-120, -1),
        3,
        3
    )

const levels4H =
    pivotLevels(
        h4.slice(-80, -1),
        l4.slice(-80, -1),
        3,
        3
    )

const allHighs =
    levels15.pivotHighs
        .concat(levels1H.pivotHighs)
        .concat(levels4H.pivotHighs)

const allLows =
    levels15.pivotLows
        .concat(levels1H.pivotLows)
        .concat(levels4H.pivotLows)

// ---------------------------------------------------------
// Tìm target theo cấu trúc lớn trước.
// ---------------------------------------------------------

let obstacle

if (side === 'LONG') {

    // Ưu tiên pivot 4H nằm phía trên giá.
    const high4H =
        levels4H.pivotHighs
            .filter(
                x =>
                    Number.isFinite(x) &&
                    x > price
            )
            .sort((a, b) => a - b)

    obstacle = high4H[0]

    // Nếu chưa có pivot 4H phù hợp,
    // mới dùng 1H rồi 15M.
    if (!Number.isFinite(obstacle)) {
        obstacle =
            nearestAbove(
                allHighs,
                price
            )
    }

} else {

    // Ưu tiên pivot 4H phía dưới giá.
    const low4H =
        levels4H.pivotLows
            .filter(
                x =>
                    Number.isFinite(x) &&
                    x < price
            )
            .sort((a, b) => b - a)

    obstacle = low4H[0]

    if (!Number.isFinite(obstacle)) {
        obstacle =
            nearestBelow(
                allLows,
                price
            )
    }
}

// ---------------------------------------------------------
// Khoảng target tối thiểu.
//
// Long-term không dùng 2.20R nữa.
// ---------------------------------------------------------

const minimumTargetR = 3.00

const minimumTargetDistance =
    risk * minimumTargetR

// ---------------------------------------------------------
// Nếu obstacle 4H quá gần,
// tìm structure lớn tiếp theo đủ khoảng.
// ---------------------------------------------------------

if (
    Number.isFinite(obstacle)
) {

    const obstacleDistance =
        side === 'LONG'
            ? obstacle - price
            : price - obstacle

    if (
        obstacleDistance <
        minimumTargetDistance
    ) {

        if (side === 'LONG') {

            const farther4H =
                levels4H.pivotHighs
                    .filter(
                        x =>
                            Number.isFinite(x) &&
                            x >=
                                price +
                                minimumTargetDistance
                    )
                    .sort((a, b) => a - b)

            if (Number.isFinite(farther4H[0])) {
                obstacle = farther4H[0]
            } else {

                const fartherAll =
                    allHighs
                        .filter(
                            x =>
                                Number.isFinite(x) &&
                                x >=
                                    price +
                                    minimumTargetDistance
                        )
                        .sort((a, b) => a - b)

                if (Number.isFinite(fartherAll[0])) {
                    obstacle = fartherAll[0]
                }
            }

        } else {

            const farther4H =
                levels4H.pivotLows
                    .filter(
                        x =>
                            Number.isFinite(x) &&
                            x <=
                                price -
                                minimumTargetDistance
                    )
                    .sort((a, b) => b - a)

            if (Number.isFinite(farther4H[0])) {
                obstacle = farther4H[0]
            } else {

                const fartherAll =
                    allLows
                        .filter(
                            x =>
                                Number.isFinite(x) &&
                                x <=
                                    price -
                                    minimumTargetDistance
                        )
                        .sort((a, b) => b - a)

                if (Number.isFinite(fartherAll[0])) {
                    obstacle = fartherAll[0]
                }
            }
        }
    }
}

// ---------------------------------------------------------
// Nếu không có structure đủ xa,
// dùng ATR4H làm fallback.
// ---------------------------------------------------------

if (
    !Number.isFinite(obstacle) ||
    (
        side === 'LONG'
            ? obstacle <= price
            : obstacle >= price
    )
) {

    obstacle =
        side === 'LONG'
            ? price +
                Math.max(
                    risk * 4.50,
                    atr4H * 2.50
                )
            : price -
                Math.max(
                    risk * 4.50,
                    atr4H * 2.50
                )
}

// ---------------------------------------------------------
// Available R
// ---------------------------------------------------------

let availableR =
    side === 'LONG'
        ? (obstacle - price) / risk
        : (price - obstacle) / risk

if (
    !Number.isFinite(availableR) ||
    availableR <= 0
) {
    return reject('TARGET_SPACE', {
        side,
        price: r(price),
        risk: r(risk),
        obstacle: r(obstacle),
        availableR: r(availableR, 3)
    })
}

// ---------------------------------------------------------
// Target R dài hạn.
//
// 3R = floor.
// 4R–5R = vùng bình thường.
// Tối đa 7R nếu structure 4H cho phép.
// ---------------------------------------------------------

const targetR =
    clamp(
        Math.max(
            3.00,
            availableR * 0.90
        ),
        3.00,
        7.00
    )

const tp =
    side === 'LONG'
        ? price + risk * targetR
        : price - risk * targetR
    // =========================================================
    // 16. VOLUME
    //
    // Chỉ dùng để quality.
    // KHÔNG reject.
    // =========================================================

    const volAvg =
        avg(v5.slice(-31, -1))

    const vol5Ratio =
        volAvg > 0
            ? v5.at(-1) / volAvg
            : 1
    // =========================================================
    // 17. QUALITY SCORE
    //
    // Chỉ mô tả.
    // KHÔNG dùng để chặn ACCEPT.
    // =========================================================

    let qualityScore = 60

    if (
        side === 'LONG'
            ? higherStructure4H
            : lowerStructure4H
    ) {
        qualityScore += 12
    }

    if (
        side === 'LONG'
            ? slope20_4H >= 0
            : slope20_4H <= 0
    ) {
        qualityScore += 8
    }

    if (
        side === 'LONG'
            ? bull1H
            : bear1H
    ) {
        qualityScore += 6
    }

    if (
        side === 'LONG'
            ? pullback15Long
            : pullback15Short
    ) {
        qualityScore += 6
    }

    if (
        side === 'LONG'
            ? trend15Long
            : trend15Short
    ) {
        qualityScore += 4
    }

    if (hGap >= 0.0010) {
        qualityScore += 6
    } else if (hGap >= 0.0004) {
        qualityScore += 3
    }

    if (
        side === 'LONG'
            ? mSlope >= 0
            : mSlope <= 0
    ) {
        qualityScore += 4
    }

    if (vol5Ratio >= 0.80) {
        qualityScore += 4
    }

    if (availableR >= 5) {
        qualityScore += 5
    }

    if (distanceFromEMA20 <= 0.004) {
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
    // 18. MARKET STATE / VOLATILITY
    // =========================================================

    const marketState =
        side === 'LONG'
            ? 'LONG_TERM_UPTREND'
            : 'LONG_TERM_DOWNTREND'

    const volatility =
        atr5Ratio < 0.003
            ? 'LOW'
            : atr5Ratio > 0.010
                ? 'HIGH'
                : 'NORMAL'

    // =========================================================
    // 19. FINAL CONTRACT
    // =========================================================

    CORE_REJECT_STATS.ACCEPT++

    CORE_SIDE_STATS[side]++

    CORE_REJECT_STATS[
        side === 'LONG'
            ? 'ACCEPT_LONG'
            : 'ACCEPT_SHORT'
    ]++

    return {
        side,
        price: r(price),
        sl: r(sl),
        tp: r(tp),

        setup:
            side + '_' + setupKind,

       pullbackType:
    setupKind === 'LONG_TERM_SWEEP'
        ? 'LONG_TERM_SWEEP_PULLBACK'
        : setupKind === 'SHORT_TERM_SWEEP'
            ? 'SHORT_TERM_SWEEP_PULLBACK'
            : setupKind === 'LONG_TERM_TREND'
                ? 'LONG_TERM_TREND_PULLBACK'
                : setupKind === 'SHORT_TERM_TREND'
                    ? 'SHORT_TERM_TREND_PULLBACK'
                    : 'LONG_TERM_TREND',

        triggerType:
            triggerTypeLocal,

        marketState,

        volatility,

        qualityScore,

        risk: {
            risk: r(risk),
            initialRisk: r(risk),
            rr: r(targetR),
            targetR: r(targetR)
        },

        indicators: {
            atr5: r(atr5),
            atr15: r(atr15),
            atr1h: r(atr1H),
            atr4h: r(atr4H),

            ema20_4h: r(e20_4H),
            ema50_4h: r(e50_4H),
            ema200_4h: r(e200_4H),

            ema20_1h: r(e20H),
            ema50_1h: r(e50H),
            ema200_1h: r(e200H),

            ema20_15: r(e20_15),
            ema50_15: r(e50_15),

            ema20_5: r(e20),
            ema50_5: r(e50)
        },

        debug: {
            trendModel:
                '4H_1H_TREND_FOLLOWING',

            side,

            price:
                r(price),

            price4H:
                r(price4H),

            bull4H,
            bear4H,

            higherStructure4H,
            lowerStructure4H,

            slope20_4H:
                r(slope20_4H, 6),

            slope50_4H:
                r(slope50_4H, 6),

            htfSlope:
                r(hSlope, 6),

            htfGap:
                r(hGap, 6),

            biasSlope:
                r(mSlope, 6),

            setupKind,

            triggerType:
                triggerTypeLocal,

            triggerIndex:
                trigger5Index,

            triggerAge5m:
                triggerAge,

            vol5Ratio:
                r(vol5Ratio, 3),

            distanceFromEma20:
                r(distanceFromEMA20, 6),

            maxChase:
                r(maxChase, 6),

            invalidation:
                r(invalidation),

            structure1HLow:
                r(structure1HLow),

            structure1HHigh:
                r(structure1HHigh),

            structure4HLow:
                r(structure4HLow),

            structure4HHigh:
                r(structure4HHigh),

            risk:
                r(risk),

            riskATR1H:
                r(risk / atr1H, 3),

            riskATR4H:
                r(risk / atr4H, 3),

            nearestObstacle:
                r(obstacle),

            availableR:
                r(availableR, 3),

            targetR:
                r(targetR),

            htfDirection:
                side,

            longTrend4H:
                bull4H,

            shortTrend4H:
                bear4H,

            bull1H,
            bear1H,

            trend15Long,
            trend15Short,

            pullback15Long,
            pullback15Short,

            pricePosition4H:
                r(change(price4H, e200_4H), 6),

            pullbackZone:
                r(pullbackZone),

            atr5Ratio:
                r(atr5Ratio, 6)
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
    data4h,
    data15,
    data1h,
    data5
] = await Promise.all([
    getData(symbol,"4h",240),
    getData(symbol,"15m",121),
    getData(symbol,"1h",221),
    getData(symbol,"5m",160),
])
        // ==================================================
        // 3. CORE LOGIC
        // ==================================================

        let r

        try{

            r = await coreLogic(
                data4h,
                data15,
                data1h,
                data5
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

function buildTradeFromCoreSignal(best, btcRegime, riskBudget){

    // =========================================================
    // CORE VALUES
    // =========================================================

    const entry = Number(best?.price)
    const sl = Number(best?.sl)
    const tp = Number(best?.tp)

    const initialRisk = Number(
        best?.risk?.initialRisk ??
        best?.risk?.risk ??
        Math.abs(entry - sl)
    )

    const rr = Number(
        best?.risk?.rr ??
        (
            Math.abs(tp - entry) /
            Math.abs(entry - sl)
        )
    )

    const targetR = Number(
        best?.risk?.targetR ??
        rr
    )

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
        !Number.isFinite(rr) || rr <= 0 ||
        !Number.isFinite(targetR) || targetR <= 0 ||
        !Number.isFinite(budget) || budget <= 0
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
    // INDICATORS
    // EXACTLY FROM CORE RETURN
    // =========================================================

    const indicators = best.indicators || {}

    const now = Date.now()

    // =========================================================
    // FINAL TRADE
    // =========================================================

    return {

        // =====================================================
        // CORE SIGNAL
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

        qualityScore:
            Number(best.qualityScore ?? 0),

        // =====================================================
        // SCANNER DATA
        // =====================================================

        btcRegime:
            btcRegime,

        // Monetary risk budget
        risk:
            budget,

        // Price distance Entry -> SL
        initialRisk:
            initialRisk,

        rr:
            rr,

        // =====================================================
        // RISK DETAIL
        // =====================================================

        riskDetail: {

            risk:
                Number(best.risk?.risk ?? initialRisk),

            rr:
                rr,

            targetR:
                targetR,

            slDistance:
                Math.abs(entry - sl),

            tpDistance:
                Math.abs(tp - entry),

            riskATR5:
                Number.isFinite(Number(indicators.atr5)) &&
                Number(indicators.atr5) > 0
                    ? initialRisk / Number(indicators.atr5)
                    : 0,

            riskPercent:
                entry > 0
                    ? initialRisk / entry
                    : 0,

            riskBudget:
                budget
        },

        // =====================================================
        // INDICATORS
        // EXACTLY FROM CORE RETURN
        // =====================================================

        indicators: {

            atr15:
                indicators.atr15 ?? null,

            atr5:
                indicators.atr5 ?? null,

            ema20_1h:
                indicators.ema20_1h ?? null,

            ema50_1h:
                indicators.ema50_1h ?? null,

            ema20_15:
                indicators.ema20_15 ?? null,

            ema50_15:
                indicators.ema50_15 ?? null,

            ema20_5:
                indicators.ema20_5 ?? null,

            ema50_5:
                indicators.ema50_5 ?? null
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
      candidates.sort(
    (a,b) =>
        Number(b.qualityScore || 0) -
        Number(a.qualityScore || 0)
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

let minRR = 2.00

if(rr < minRR){
    console.log(
        `🚫 FILTER MIN RR: ${best.symbol} | ` +
        `RR=${safeFixed(rr, 2)} | ` +
        `required=${safeFixed(minRR, 2)}`
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

    const requiredQty = normalizeQtyFinal(
        Math.ceil(minQty / stepSize) * stepSize,
        stepSize
    )

    const requiredRisk = requiredQty * diff
    const maxAllowedRisk = trade.risk * 2.0

    if(requiredRisk > maxAllowedRisk){
        console.log(
            `❌ MIN QTY + RISK FAIL ${best.symbol} | ` +
            `qty=${qty} | ` +
            `minQty=${minQty} | ` +
            `requiredQty=${requiredQty} | ` +
            `requiredRisk=${requiredRisk} | ` +
            `maxAllowedRisk=${maxAllowedRisk}`
        )
        continue
    }

    console.log(
        `⚠️ MIN QTY AUTO-FIX ${best.symbol} | ` +
        `qty=${qty} → ${requiredQty} | ` +
        `risk=${trade.risk} → ${requiredRisk}`
    )

    qty = requiredQty
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
            trade.risk * 2.0

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
        trade.risk * 2.0
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

process.on("exit", cleanup)
process.on("SIGINT", () => { cleanup(); process.exit() })
process.on("SIGTERM", () => { cleanup(); process.exit() })
