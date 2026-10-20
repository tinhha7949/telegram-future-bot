// USER-EDITABLE FIXED RISK: 0.75% of equity per trade.
const RISK_PER_TRADE = 0.0075;

let DB_READY = false
let nineAiOfflineLearningService = null;
let STOP_NEW_ENTRIES = false
let signalClaims = null
let ORPHAN_RECOVERY_RUNNING = false
const OPEN_POSITION_LOCK = {}
const TPSL_PHASE = {}
let DB_RECONNECTING = false
let TIME_SYNCED = false
const TPSL_PENDING = {}
const TPSL_CLOSING = {}
const MIN_NOTIONAL_RISK_COOLDOWN = new Map()
const MIN_NOTIONAL_RISK_COOLDOWN_MS = 15 * 60 * 1000
const MAX_CANDIDATE_ATTEMPTS_PER_SCAN = 10
const MIN_TRADE_RR = 0
function envNumber(name, fallback, min, max) {
    const raw = process.env[name];
    if (raw == null || String(raw).trim() === "") return fallback;
    const value = Number(raw);
    if (!Number.isFinite(value)) {
        console.warn(`⚠️ Invalid ${name}; using default ${fallback}`);
        return fallback;
    }
    return Math.max(min, Math.min(max, value));
}

const TRADE_CONFIG = Object.freeze({
    riskPerTrade: RISK_PER_TRADE,
    maxRiskPerTrade: RISK_PER_TRADE,
    maxPositionPercent: 1.0,
    maxActivePositions: Math.round(envNumber("MAX_ACTIVE_POSITIONS", 20, 1, 50))
})
let SYNCING_TIME = false
let LAST_OFFSET_LOG = 0
let serverTimeOffset = 0
const OPENING_POSITIONS = {}
const fs = require("fs")
const path = require("path")
const os = require("os")
const crypto = require("crypto")
const nineAiPipeline = require("./ai-trading/nine-ai-pipeline")
const nineAiCentralDecisionEngine = require("./ai-trading/nine-ai-central-decision-engine")
const nineAiDecisionJournal = require("./ai-trading/nine-ai-decision-journal")
const { assessMinNotionalRisk, isRiskWithinBudget } = require("./ai-trading/execution-risk")
const nineAiDbRetention = require("./ai-trading/nine-ai-db-retention")
const nineAiOfflineLearning = require("./ai-trading/nine-ai-offline-learning");

// Use a machine-local lock keyed to this script, independent of the launch
// directory and outside OneDrive sync.
const PID_LOCK_KEY = crypto.createHash("sha256")
    .update(path.resolve(__filename))
    .digest("hex")
    .slice(0, 16)
const PID_FILE = path.join(os.tmpdir(), `tradebot-${PID_LOCK_KEY}.pid`)

function pidIsAlive(pid){
    if(!Number.isSafeInteger(pid) || pid <= 0) return false
    try{
        process.kill(pid, 0)
        return true
    }catch(e){
        // EPERM means the process exists but cannot be signalled.
        return e?.code !== "ESRCH"
    }
}

function acquirePidLock(){
    for(let attempt = 0; attempt < 2; attempt++){
        try{
            // wx is atomic: only one bot process can create this lock.
            fs.writeFileSync(PID_FILE, String(process.pid), { flag: "wx" })
            return
        }catch(e){
            if(e?.code !== "EEXIST") throw e

            let oldPid = NaN
            try{
                oldPid = Number(
                    fs.readFileSync(PID_FILE, "utf8").trim()
                )
            }catch(readError){}

            if(pidIsAlive(oldPid)){
                console.log("⛔ BOT ĐANG CHẠY SẴN → EXIT")
                process.exit(1)
            }

            // Remove a stale lock, then retry the exclusive create.
            try{
                fs.unlinkSync(PID_FILE)
            }catch(unlinkError){
                if(attempt === 1) throw unlinkError
            }
        }
    }

    throw new Error("Could not acquire bot PID lock")
}

acquirePidLock()
//
process.on("unhandledRejection", err => {
    STOP_NEW_ENTRIES = true
    console.log("UNHANDLED:", err)
    console.log("⛔ New entries paused after unhandled rejection; position management remains active")
})

process.on("uncaughtException", err => {
    console.log("UNCAUGHT:", err)
    cleanup()
    process.exit(1)
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

    // Automatically retry reads only. Repeating a timed-out order POST can
    // submit the same market action twice because the first response was lost.
    const method = String(options.method || "GET").toUpperCase()
    const maxAttempts = method === "GET" ? retry : 1
    const logUrl = String(url).replace(/([?&]signature=)[^&]*/i, "$1[redacted]")

    for(let i = 0; i < maxAttempts; i++){

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
                    `❌ FETCH FAIL: ${logUrl}`,
                    e?.message || e
                )
            }
        }

        if(i < maxAttempts - 1){
            await new Promise(r =>
                setTimeout(r, 1000)
            )
        }
    }

    return null
}
function getTradeActualRisk(trade = {}) {
  const quantity = Number(trade.actualQuantity ?? trade.entryExecution?.executedQuantity ?? trade.quantity);
  const initialRisk = Number(trade.initialRisk ?? trade.riskDetail?.initialRisk);
  const quantityRisk = quantity * initialRisk;
  if (Number.isFinite(quantityRisk) && quantityRisk > 0) return quantityRisk;
  const finalRisk = Number(trade.finalRisk);
  if (Number.isFinite(finalRisk) && finalRisk > 0) return finalRisk;
  return Number(trade.riskDetail?.riskBudget ?? trade.risk ?? 0);
}

async function getTradeFundingIncome(symbol, startTime, endTime) {
    if(!process.env.BINANCE_KEY || !process.env.BINANCE_SECRET) return null
    try{
        const params = new URLSearchParams({
            symbol: String(symbol), incomeType: "FUNDING_FEE",
            startTime: String(Number(startTime) || 0), endTime: String(Number(endTime) || Date.now()),
            limit: "1000", recvWindow: "60000", timestamp: String(getTimestamp())
        }).toString()
        const signature = crypto.createHmac("sha256", process.env.BINANCE_SECRET).update(params).digest("hex")
        const response = await safeFetch(
            `https://fapi.binance.com/fapi/v1/income?${params}&signature=${signature}`,
            { headers: { "X-MBX-APIKEY": process.env.BINANCE_KEY } }, 1
        )
        if(!response?.ok) return null
        const rows = await response.json()
        return Array.isArray(rows) ? rows : null
    }catch(error){
        console.log(`⚠️ FUNDING HISTORY UNAVAILABLE ${symbol}:`, error?.message || error)
        return null
    }
}

async function getClosedTradeResult(t){

    try{

        const trades = await binance.futuresUserTrades({
            symbol: t.symbol,
            startTime: Number(t.enteredAt || t.createdAt || 0),
            limit: 1000,
            recvWindow: 20000
        })

        if(!trades || trades.length === 0){
            return null
        }

        const fundingRows = await getTradeFundingIncome(
            t.symbol, t.enteredAt || t.createdAt || 0,
            Math.max(...trades.filter(fill => Number(fill.time || 0) >= Number(t.enteredAt || t.createdAt || 0))
                .map(fill => Number(fill.time || 0)), Date.now())
        )
        return summarizeClosedTrade(t, trades, fundingRows)

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

        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), 10000)
        let res
        let data
        try{
            res = await fetch(
                "https://fapi.binance.com/fapi/v1/time",
                { signal: controller.signal, agent }
            )
            if(!res.ok) throw new Error(`TIME HTTP ${res.status}`)
            data = await res.json()
        }finally{
            clearTimeout(timeout)
        }
        if(!Number.isFinite(Number(data?.serverTime))){
            throw new Error("BINANCE SERVER TIME RESPONSE INVALID")
        }

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
async function requireOneWayPositionMode(){
    const params = new URLSearchParams({
        recvWindow: "10000",
        timestamp: String(getTimestamp())
    }).toString()
    const signature = crypto
        .createHmac("sha256", process.env.BINANCE_SECRET)
        .update(params)
        .digest("hex")
    const url = `https://fapi.binance.com/fapi/v1/positionSide/dual?${params}&signature=${signature}`
    const res = await safeFetch(url, {
        method: "GET",
        headers: { "X-MBX-APIKEY": process.env.BINANCE_KEY }
    }, 1)
    if(!res) throw new Error("Cannot verify Binance position mode; refusing to start")

    const data = await res.json()
    if(typeof data?.dualSidePosition !== "boolean"){
        throw new Error("Binance returned an invalid position-mode response")
    }
    if(data.dualSidePosition){
        throw new Error("Binance is in Hedge Mode; this bot requires One-way Mode")
    }
    return true
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

let ACCOUNT_BALANCE = 0
// const MIN_VOL_24H = 15000000

const DEBUG_AI = false

let lastUpdateId = 0
let cachedSymbols = null
let lastSymbolsUpdate = 0
//let lastSignalTime = {}
let isScanning = false
let NEXT_ENTRY_ALLOWED_AT = 0;
const ENTRY_COOLDOWN_MS = 1 * 60 * 1000;
// ===== ACTIVE TRADES =====
let exchangeInfoTime = 0
let checkingTrades = false
let syncingActiveTrades = false
let activeTrades = []
let exchangeInfoCache = null
let validFuturesSymbols = new Set()
let TELEGRAM_LOCK = 0
let DATA_FAILS = {}

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
async function hasPosition(symbol){

    // A failed Binance request must never look like a confirmed flat position.
    const positions = await getPositionsCached()
    if(!Array.isArray(positions)){
        throw new Error("BINANCE POSITION RESPONSE INVALID")
    }

    return positions.find(
        p =>
            p.symbol === symbol &&
            Math.abs(Number(p.positionAmt)) > 0
    ) || null
}
async function openPosition(symbol, side, qty, signalKey){

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

        // Clear stale protective/limit orders only after confirming there is
        // no in-flight market order whose partial fill could open a position.
        const cleared = await cancelAllOrders(symbol)
        if(!cleared){
            console.log(`⛔ SKIP OPEN ${symbol}: OLD ORDERS NOT CLEARED`)
            return {
                skipped: true,
                reason: "OLD_ORDERS_NOT_CLEARED"
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

        const clientOrderId =
            `bot_${Date.now().toString(36)}_${crypto.randomBytes(4).toString("hex")}`

        const query =
            `symbol=${symbol}` +
            `&side=${side === "LONG" ? "BUY" : "SELL"}` +
            `&type=MARKET` +
            `&quantity=${qty}` +
            `&newClientOrderId=${clientOrderId}` +
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

        // Record the point of no return before sending the MARKET request.
        const claimUpdate = await signalClaims.updateOne(
            { signalKey, state: "CLAIMED" },
            { $set: { state: "ORDER_SUBMITTING", orderClientId: clientOrderId, updatedAt: new Date() } }
        )
        if(claimUpdate.matchedCount !== 1){
            console.log(`⛔ SIGNAL CLAIM LOST BEFORE ORDER ${symbol}`)
            return null
        }

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
                },
                1
            )

        let data = null

        if(!res){

            // Resolve an ambiguous network outcome by querying the exact
            // client order ID; never blindly resubmit the market order.
            for(let attempt = 0; attempt < 6; attempt++){
                try{
                    data = await binance.futuresGetOrder({
                        symbol,
                        origClientOrderId: clientOrderId,
                        recvWindow: 60000
                    })
                    if(data) break
                }catch(queryError){
                    await checkTimeError(queryError)
                }
                await new Promise(r => setTimeout(r, 1000))
            }

            if(!data){
                POS_CACHE = null
                POS_CACHE_TIME = 0
                const recoveredPosition = await waitPosition(symbol)
                const recoveredAmount = Number(recoveredPosition?.positionAmt || 0)
                const expectedSide = side === "LONG" ? recoveredAmount > 0 : recoveredAmount < 0
                if(recoveredPosition && expectedSide){
                    data = { status: "FILLED", recovered: true }
                }else{
                    console.log(`❌ ORDER OUTCOME UNKNOWN ${symbol} CID=${clientOrderId}`)
                    return null
                }
            }
        }else if(!res.ok){

            console.log(
                `❌ ORDER HTTP FAIL ${symbol}`,
                res?.status
            )

            return null
        }else{
            data = await res.json()
        }

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
    stopPrice,
    partialQuantity = null
){
    const closeSide = side === "LONG" ? "SELL" : "BUY"
    // Binance requires clientAlgoId to be shorter than 36 characters.
    // Compact format: bot marker + order kind + base36 time + 12 hex chars.
    const clientAlgoId = `b${type === "STOP_MARKET" ? "s" : "t"}${Date.now().toString(36)}${crypto.randomBytes(6).toString("hex")}`
    if(clientAlgoId.length >= 36){
        throw new Error(`Generated clientAlgoId exceeds Binance limit (${clientAlgoId.length})`)
    }
    const baseUrl = "https://fapi.binance.com"

    const signedRequest = async (path, method, params) => {
        const query = new URLSearchParams({
            ...params,
            recvWindow: "60000",
            timestamp: String(getTimestamp())
        }).toString()
        const signature = crypto.createHmac("sha256", process.env.BINANCE_SECRET).update(query).digest("hex")
        const url = `${baseUrl}${path}?${query}&signature=${signature}`
        const res = await safeFetch(url, {
            method,
            headers: { "X-MBX-APIKEY": process.env.BINANCE_KEY }
        }, 1)
        if(!res) return null
        return res.json()
    }

    try{
        const orderParams = {
            algoType: "CONDITIONAL",
            symbol,
            side: closeSide,
            type,
            triggerPrice: String(stopPrice),
            workingType: "MARK_PRICE",
            clientAlgoId
        };
        if (Number.isFinite(Number(partialQuantity)) && Number(partialQuantity) > 0) {
            orderParams.quantity = String(partialQuantity);
            orderParams.reduceOnly = "true";
        } else {
            orderParams.closePosition = "true";
        }
        const result = await signedRequest("/fapi/v1/algoOrder", "POST", orderParams)
        if(result?.algoId) return result

        // POST may have reached Binance even if its response was lost. Query by
        // the unique client id; never blindly repeat a protection order.
        await new Promise(r => setTimeout(r, 800))
        const found = await signedRequest("/fapi/v1/algoOrder", "GET", { symbol, clientAlgoId })
        if(found?.algoId) return found
        throw new Error(`Algo order not confirmed (clientAlgoId=${clientAlgoId})`)
    }catch(e){
        await checkTimeError(e)
        console.log(`❌ TPSL ${type} FAILED ${symbol}:`, e?.message || e)
        throw e
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
        const rawTP1 =
            Number(trade.tp1)

        if(
            !Number.isFinite(rawSL) ||
            !Number.isFinite(rawTP) ||
            rawSL <= 0 ||
            rawTP <= 0 ||
            !Number.isFinite(rawTP1) || rawTP1 <= 0
        ){

            console.log(
                `❌ INVALID INITIAL TPSL ${symbol} ` +
                `SL=${rawSL} TP=${rawTP}`
            )

            return false
        }

        let sl
        let tp
        let tp1

        if(positionSide === "LONG"){

            sl =
                Math.floor(
                    rawSL / tickSize
                ) * tickSize

            // Round TP inward to a valid tick while preserving the researched level.
            tp1 =
                Math.floor(rawTP1 / tickSize) * tickSize
            tp =
                Math.floor(
                    rawTP / tickSize
                ) * tickSize

        }else{

            sl =
                Math.ceil(
                    rawSL / tickSize
                ) * tickSize

            tp1 =
                Math.ceil(rawTP1 / tickSize) * tickSize
            tp =
                Math.ceil(
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

        tp1 = Number(tp1.toFixed(decimals))
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
                tp1 <= entry || tp1 >= tp ||
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
                tp1 >= entry || tp1 <= tp ||
                tp >= entry
            ){

                console.log(
                    `❌ INVALID SHORT TPSL ${symbol} ` +
                    `ENTRY=${entry} SL=${sl} TP=${tp}`
                )

                return false
            }
        }

        const initialRR = Math.abs(tp - entry) / Math.max(Math.abs(entry - sl), Number.EPSILON);
        if (!Number.isFinite(initialRR) || initialRR < MIN_TRADE_RR) {
            console.log(`⛔ INITIAL RR INVALID ${symbol} RR=${initialRR}`);
            return false;
        }

        // =========================================
        // INITIAL 9AI TPSL from the researched entry-time plan.
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
        // SET TP1: close 50% of the actual position, TP2 protects remainder.
        // =========================================
        const lotFilter = info.filters.find(f => f.filterType === "LOT_SIZE");
        const stepSize = Number(lotFilter?.stepSize);
        const rawHalfQty = Math.abs(positionAmt) * 0.5;
        const tp1Qty = stepSize > 0 ? Math.floor((rawHalfQty + 1e-12) / stepSize) * stepSize : 0;
        const qtyPrecision = stepSize > 0 ? Math.max(0, (String(stepSize).split(".")[1] || "").length) : 0;
        const roundedTP1Qty = Number(tp1Qty.toFixed(qtyPrecision));
        if (!(roundedTP1Qty > 0) || roundedTP1Qty >= Math.abs(positionAmt)) {
            console.log(`❌ TP1 HALF-POSITION QTY INVALID ${symbol}`);
            await cancelAllOrders(symbol);
            return false;
        }
        const tp1Res = await placeTPSLWithRetry(
            symbol, positionSide, "TAKE_PROFIT_MARKET", tp1, roundedTP1Qty
        );
        if (!tp1Res || !(tp1Res.algoId || tp1Res.orderId)) {
            console.log(`❌ TP1 INVALID RESPONSE ${symbol}`);
            await cancelAllOrders(symbol);
            return false;
        }
        const tp1OrderId = tp1Res.algoId || tp1Res.orderId;

        // =========================================
        // SET TP2: close remaining position after TP1 partial fill.
        // =========================================
        console.log(
            `🎯 SET TP2 ${symbol}: ${tp}`
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
    tp1,
    tp,
    slOrderId,
    tp1OrderId,
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

    const plannedEntry = Number(trade.entry ?? trade.price)
    const plannedSL = Number(trade.sl)
    const plannedTP = Number(trade.tp)
    const plannedTP1 = Number(trade.tp1)

    const order =
        await openPosition(
            symbol,
            trade.side,
            qty,
            `${symbol}:${Number(trade.signalAt)}`
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

    // Preserve the AI-7 p50/p90 price distances when execution slippage shifts
    // the actual entry. Never reconstruct targets from an arbitrary RR ratio.
    const plannedRisk = Math.abs(plannedEntry - plannedSL)
    const plannedReward = Math.abs(plannedTP - plannedEntry)
    const plannedTP1Distance = Math.abs(plannedTP1 - plannedEntry)
    const plannedRR = plannedRisk > 0 ? plannedReward / plannedRisk : NaN
    if (!Number.isFinite(plannedRR) || plannedRR < MIN_TRADE_RR ||
        !Number.isFinite(plannedTP1Distance) || plannedTP1Distance <= 0 ||
        (trade.side === "LONG" && !(plannedEntry < plannedTP1 && plannedTP1 < plannedTP)) ||
        (trade.side === "SHORT" && !(plannedEntry > plannedTP1 && plannedTP1 > plannedTP))) {
        console.log(`❌ INVALID ORIGINAL NINE-AI TP PLAN ${symbol}`);
        return false;
    }

    trade.entry = realEntry
    trade.initialRisk = Math.abs(realEntry - plannedSL)
    trade.tp1 = trade.side === "LONG"
        ? realEntry + plannedTP1Distance
        : realEntry - plannedTP1Distance
    trade.tp = trade.side === "LONG"
        ? realEntry + plannedReward
        : realEntry - plannedReward

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

                return { ok: false, error: "INITIAL_POSITION_VERIFY_FAILED", positionMayBeOpen: true }
            }

            // Position đã biến mất → không close nữa
            if(!realPos){

                console.log(
                    `ℹ️ POSITION ALREADY CLOSED ${trade.symbol}`
                )

                return { ok: false, error: "POSITION_ALREADY_CLOSED_AFTER_TPSL_FAILURE", positionOpen: false }
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

            return {
                ok: false,
                error: closed
                    ? "INITIAL_TPSL_FAILED_POSITION_CLOSED"
                    : "INITIAL_TPSL_FAILED_CLOSE_FAILED_POSITION_MAY_BE_OPEN",
                positionOpen: !closed
            }
        }

        // =========================================
        // SAVE REAL TPSL
        // =========================================

        trade.sl =
            Number(tpslResult.sl)

        trade.tp1 = Number(tpslResult.tp1)
        trade.tp1OrderId = tpslResult.tp1OrderId
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
            initialRisk: trade.initialRisk,
            slOrderId: tpslResult.slOrderId,
            tp1OrderId: tpslResult.tp1OrderId,
            tpOrderId: tpslResult.tpOrderId,
            entryExecution: {
                orderId: order.orderId == null ? null : String(order.orderId),
                clientOrderId: String(order.clientOrderId || order.origClientOrderId || ""),
                status: String(order.status || "UNKNOWN"),
                averagePrice: Number(order.avgPrice) > 0 ? Number(order.avgPrice) : realEntry,
                executedQuantity: Number(order.executedQty) > 0 ? Number(order.executedQty) : Math.abs(Number(pos.positionAmt || qty)),
                quoteQuantity: Number(order.cumQuote) > 0 ? Number(order.cumQuote) : null,
                orderTime: Number(order.updateTime || order.transactTime || 0) || null,
                recovered: order.recovered === true,
                positionAmount: Number(pos.positionAmt || 0),
                leverage: Number(pos.leverage) || null,
                marginType: String(pos.marginType || "UNKNOWN"),
                plannedEntry, plannedSL, plannedTP,
                actualEntry: realEntry,
                actualSL: Number(trade.sl), actualTP: Number(trade.tp),
                entrySlippage: realEntry - plannedEntry
            }
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
async function getData(symbol, interval, limit){
    const url =
        `https://fapi.binance.com/fapi/v1/klines?symbol=${encodeURIComponent(symbol)}&interval=${encodeURIComponent(interval)}&limit=${encodeURIComponent(limit)}`;
    let lastError = null;

    // A fresh AbortController is required for every attempt. Reusing the
    // aborted signal would make retries fail immediately.
    for (let attempt = 0; attempt < 3; attempt++) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 15000);
        try {
            const res = await safeFetch(url, {
                headers: { "User-Agent": "Mozilla/5.0" },
                signal: controller.signal
            }, 1);

            if (res && res.ok) {
                const data = await res.json();
                if (Array.isArray(data) && data.length > 0) return data;
                lastError = new Error("EMPTY_OR_INVALID_KLINES_RESPONSE");
            } else {
                lastError = new Error("BINANCE_KLINES_HTTP_" + (res?.status ?? "NO_RESPONSE"));
            }
        } catch (error) {
            lastError = error;
        } finally {
            clearTimeout(timeout);
        }

        if (attempt < 2) {
            await new Promise(resolve => setTimeout(resolve, 250 * (attempt + 1)));
        }
    }

    console.error(`❌ DATA FAIL ${symbol} ${interval} after 3 attempts:`,
        lastError?.message || lastError || "UNKNOWN_KLINES_ERROR");
    return null;
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
        if (range24 < 0.03) continue;

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
        .slice(0, 20)
        .map(candidate => candidate.symbol);

      console.log(
        `📊 RANGE FILTER UNIVERSE ${selected.length}` +
        ` (eligible=${candidates.length}, minRange24h=3%)`
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
// Nine-AI scanner and execution pipeline.
// Keep abstentions aggregated so a WAIT-heavy scan is diagnosable without
// printing one noisy line per symbol.
let NINE_AI_SCAN_REASONS = new Map();
function recordNineAIAbstention(reason) {
    const key = String(reason || "UNKNOWN_ABSTENTION");
    NINE_AI_SCAN_REASONS.set(key, (NINE_AI_SCAN_REASONS.get(key) || 0) + 1);
}
function logNineAIScanSummary() {
    if (!NINE_AI_SCAN_REASONS.size) return;
    const summary = [...NINE_AI_SCAN_REASONS.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 6)
        .map(([reason, count]) => `${reason}=${count}`)
        .join(" | ");
    console.log(`🧠 NINE-AI SCAN DIAGNOSTIC: ${summary}`);
}
async function getNineAIMarketSnapshot(symbol, now = Date.now()) {
    const started = Date.now();
    const getJson = async (url) => {
        const response = await safeFetch(url, {}, 1);
        if (!response?.ok) return null;
        try { return await response.json(); } catch (_) { return null; }
    };
    const getLiquidationImbalance = async () => {
        if (!process.env.BINANCE_KEY || !process.env.BINANCE_SECRET) return null;
        const params = new URLSearchParams({
            symbol: String(symbol),
            startTime: String(now - 4 * 60 * 60 * 1000),
            endTime: String(now),
            limit: "100",
            recvWindow: "5000",
            timestamp: String(getTimestamp())
        });
        const signature = crypto.createHmac("sha256", process.env.BINANCE_SECRET).update(params.toString()).digest("hex");
        const url = "https://fapi.binance.com/fapi/v1/forceOrders?" + params.toString() + "&signature=" + signature;
        const response = await safeFetch(url, { headers: { "X-MBX-APIKEY": process.env.BINANCE_KEY } }, 1);
        if (!response?.ok) return null;
        let rows;
        try { rows = await response.json(); } catch (_) { return null; }
        if (!Array.isArray(rows)) return null;
        if (!rows.length) return 0;
        let shortLiquidationNotional = 0;
        let longLiquidationNotional = 0;
        for (const row of rows) {
            const price = [row.avgPrice, row.price, row.ap].map(Number).find(value => value > 0) || 0;
            const qty = [row.executedQty, row.origQty, row.q].map(Number).find(value => value > 0) || 0;
            if (!(price > 0 && qty > 0)) continue;
            const notional = price * qty;
            if (String(row.side || row.S).toUpperCase() === "BUY") shortLiquidationNotional += notional;
            else if (String(row.side || row.S).toUpperCase() === "SELL") longLiquidationNotional += notional;
        }
        const total = shortLiquidationNotional + longLiquidationNotional;
        if (!(total > 0)) return null;
        return (shortLiquidationNotional - longLiquidationNotional) / total;
    };
    const encoded = encodeURIComponent(symbol);
    const [premium, oiNow, oiHistory, book, depth, liquidationImbalance] = await Promise.all([
        getJson("https://fapi.binance.com/fapi/v1/premiumIndex?symbol=" + encoded),
        getJson("https://fapi.binance.com/fapi/v1/openInterest?symbol=" + encoded),
        getJson("https://fapi.binance.com/futures/data/openInterestHist?symbol=" + encoded + "&period=4h&limit=2"),
        getJson("https://fapi.binance.com/fapi/v1/ticker/bookTicker?symbol=" + encoded),
        getJson("https://fapi.binance.com/fapi/v1/depth?symbol=" + encoded + "&limit=20"),
        getLiquidationImbalance()
    ]);
    const bid = Number(book?.bidPrice), ask = Number(book?.askPrice);
    const spreadPct = bid > 0 && ask >= bid ? ((ask - bid) / ((ask + bid) / 2)) * 100 : null;
    const bidDepth = Array.isArray(depth?.bids) ? depth.bids.reduce((sum, level) => sum + Number(level[0]) * Number(level[1]), 0) : 0;
    const askDepth = Array.isArray(depth?.asks) ? depth.asks.reduce((sum, level) => sum + Number(level[0]) * Number(level[1]), 0) : 0;
    let oiChange = null;
    if (Array.isArray(oiHistory) && oiHistory.length >= 2) {
        const previous = Number(oiHistory[0]?.sumOpenInterest);
        const latest = Number(oiHistory[oiHistory.length - 1]?.sumOpenInterest);
        if (previous > 0 && Number.isFinite(latest)) oiChange = (latest / previous - 1) * 100;
    }
    const fundingRate = Number(premium?.lastFundingRate);
    return {
        now, snapshotAt: now,
        fundingRate: Number.isFinite(fundingRate) ? fundingRate : null,
        openInterest: Number(oiNow?.openInterest),
        openInterestChange: oiChange,
        spreadPct,
        depthNotional: Array.isArray(depth?.bids) && depth.bids.length && Array.isArray(depth?.asks) && depth.asks.length ? bidDepth + askDepth : null,
        latencyMs: Date.now() - started,
        liquidationImbalance,
        roundTripFeePct: envNumber("ROUND_TRIP_FEE_PCT", 0.1, 0, 2),
        expectedFundingCostPct: Number.isFinite(fundingRate) ? Math.abs(fundingRate) * 100 * 12 : null
    };
}
// ================= SCAN =================
async function scan(symbol){
    try {
        // Canonical strategy runs only on fully closed 4h candles.
        const data4h = await getData(symbol, "4h", 1500);
        const data1h = await getData(symbol, "1h", 100);
        const data1d = await getData(symbol, "1d", 100);
        const scanAt = Date.now();
        if (!Array.isArray(data4h)) {
            recordNineAIAbstention("MARKET_DATA_UNAVAILABLE");
            try {
                await nineAiDecisionJournal.recordDecision({
                    symbol,
                    signalTime: Math.floor(scanAt / 14400000) * 14400000,
                    scannedAt: scanAt,
                    decision: { side: "WAIT", action: "WAIT", reason: "MARKET_DATA_UNAVAILABLE",
                        authorizedForExecution: false, roles: [], rankMetrics: {} }
                });
            } catch (journalError) {
                console.error("⚠️ NINE-AI DECISION JOURNAL WRITE FAILED " + symbol + ":", journalError?.message || journalError);
            }
            return null;
        }
        const latestClosedCandle = nineAiPipeline.closedCandles(data4h, scanAt).at(-1);
        if (!latestClosedCandle) {
            recordNineAIAbstention("NO_CLOSED_4H_CANDLE");
            return null;
        }
        if (await nineAiDecisionJournal.hasDecisionForCandle(symbol, latestClosedCandle.closeTime)) {
            return null;
        }
        const marketSnapshot = await getNineAIMarketSnapshot(symbol, scanAt);
        try {
            await nineAiDecisionJournal.settleMatured(symbol, data4h);
        } catch (settleError) {
            console.error("⚠️ NINE-AI OPPORTUNITY SETTLEMENT FAILED " + symbol + ":", settleError?.message || settleError);
        }
        // Outcomes must be genuinely labeled; never fabricate MAE/MFE quantiles.
        let labeledOutcomes = [];
        try {
            const outcomeRows = await db.collection("nine_ai_outcome_labels")
                .find({ labeled: true, maePct: { $type: "number" }, mfePct: { $type: "number" } })
                .sort({ closedAt: -1 }).limit(5000).toArray();
            labeledOutcomes = outcomeRows;
        } catch (outcomeReadError) {
            console.error("⚠️ NINE-AI OUTCOME LABEL READ FAILED:", outcomeReadError?.message || outcomeReadError);
        }
        let championConfig = {};
        try {
            championConfig = nineAiOfflineLearningService
                ? await nineAiOfflineLearningService.getChampionConfig() : {};
        } catch (configError) {
            console.error("⚠️ NINE-AI CHAMPION CONFIG READ FAILED:", configError?.message || configError);
        }
        const rawDecision = nineAiPipeline.analyzeNineAI({
            symbol, candles4h: data4h, candles1h: data1h || [], candles1d: data1d || [],
            outcomes: labeledOutcomes, equity: ACCOUNT_BALANCE,
            market: { ...marketSnapshot, trackRecord: await nineAiOfflineLearningService?.getTrackRecord?.() },
            config: championConfig
        }) || {
            symbol, side: null, action: "WAIT", reason: "NO_DECISION_RETURNED",
            authorizedForExecution: false
        };
        // One authorization boundary. It can preserve Nine-AI's own decision or
        // abstain, but never invent a direction or consult a second trading brain.
        const decision = nineAiCentralDecisionEngine.finalizeDecision(rawDecision, {
            symbol, scannedAt: scanAt
        });
        if (
            decision.authorizedForExecution !== true ||
            !["LONG", "SHORT"].includes(decision.side)
        ) {
            recordNineAIAbstention(decision.reason || "WAIT_NO_AUTHORIZED_DIRECTION");
            try {
                const journalResult = await nineAiDecisionJournal.recordDecision({
                    symbol,
                    decision,
                    signalTime: Number(decision.signalAt) || Math.floor(scanAt / 14400000) * 14400000,
                    scannedAt: scanAt,
                    marketWindow: data4h
                });
                if (journalResult.decisionKey) decision.nineAiDecisionKey = journalResult.decisionKey;
            } catch (journalError) {
                console.error("⚠️ NINE-AI DECISION JOURNAL WRITE FAILED " + symbol + ":", journalError?.message || journalError);
            }
            return null;
        }

        try {
            const journalResult = await nineAiDecisionJournal.recordDecision({
                symbol, decision,
                signalTime: Number(decision.signalAt) || Math.floor(scanAt / 14400000) * 14400000,
                scannedAt: scanAt,
                learningEvidence: opportunityEvidence,
                marketWindow: data4h
            });
            if (journalResult.decisionKey) decision.nineAiDecisionKey = journalResult.decisionKey;
        } catch (journalError) {
            console.error("⚠️ NINE-AI DECISION JOURNAL WRITE FAILED " + symbol + ":", journalError?.message || journalError);
        }
        if (decision.authorizedForExecution !== true) return null;
        console.log(
            `🧠 NINE-AI SIGNAL: ${symbol} | SIDE=${decision.side} | CONF=${decision.confidence} | ROLE_SCORE=${safeFixed(decision.rankMetrics?.roleScore, 2)} | RANK=${safeFixed(decision.rankScore, 2)} | OPPORTUNITY_BONUS=${safeFixed(decision.liveOpportunityBonus, 3)} | VOTES=${decision.rankMetrics?.directionalVotes || 0}-${decision.rankMetrics?.opposingVotes || 0} | CONTRA=${decision.rankMetrics?.contrarian?.reason || "N/A"} | RR=${safeFixed(decision.rr, 2)} | ROLES=${decision.roles?.length || 0}`
        );
        const longEdge = Number(decision.edges?.LONG?.edge);
        const shortEdge = Number(decision.edges?.SHORT?.edge);
        const netEdge = Math.max(Number.isFinite(longEdge) ? longEdge : -Infinity,
            Number.isFinite(shortEdge) ? shortEdge : -Infinity);
        return {
            ...decision,
            confidence: Number.isFinite(netEdge) ? Math.max(0, Math.min(100, 50 + netEdge * 10)) : 0,
            rankScore: Number.isFinite(netEdge) ? netEdge : -Infinity,
            qualityScore: Number.isFinite(netEdge) ? netEdge : 0,
            nineAiDecisionKey: decision.nineAiDecisionKey || null,
            nineAiResearchPolicy: researchPolicyAtEntry,
            symbol,
            setup: "NINE_AI_4H",
            triggerType: "NINE_AI_CONSENSUS",
            rankDirectionMode: "NINE_AI_PRIMARY",
            rankScore: Number.isFinite(netEdge) ? netEdge : -Infinity,
            qualityScore: Number.isFinite(netEdge) ? netEdge : 0
        };
    } catch (e) {
        console.error(`🔥 NINE-AI SCAN ERROR ${symbol}:`, e?.message || e);
        return null;
    }
}
function safeFixed(value, digits = 2){

    const n = Number(value)

    if(!Number.isFinite(n)){
        return "0.00"
    }

    return n.toFixed(digits)
}

function buildTradeFromNineAISignal(best, riskBudget) {
  if (best?.authorizedForExecution !== true || best?.setup !== "NINE_AI_4H" || best?.rankDirectionMode !== "NINE_AI_PRIMARY") {
    console.log(`❌ REJECT NON-NINE-AI SIGNAL ${best?.symbol || 'UNKNOWN'}`);
    return null;
  }
  const side = String(best?.side || '').toUpperCase();
  const entry = Number(best?.entry ?? best?.price);
  const sl = Number(best?.sl);
  const tp = Number(best?.tp);
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
    !Number.isFinite(rr) || rr < MIN_TRADE_RR
  ) {
    console.log(`❌ INVALID NINE-AI SIGNAL ${best?.symbol || 'UNKNOWN'}`);
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
  const riskDetail = best?.riskDetail && typeof best.riskDetail === 'object'
    ? best.riskDetail
    : sourceRisk;
  const qualityScore = Number(best?.qualityScore ?? best?.score ?? best?.quality?.score ?? 0);
  const strategyFeatures = best?.rankMetrics?.features;
  const nineAiLearningFeatures = best?.setup === "NINE_AI_4H" && strategyFeatures
    ? {
        trend: strategyFeatures.trend === "UP" ? 1 : strategyFeatures.trend === "DOWN" ? -1 : 0,
        momentum: Number(strategyFeatures.momentum4) / Math.max(Number(strategyFeatures.atrPercent) || 0, 0.0001),
        rsi: Number(strategyFeatures.rsi14),
        volume: Number(strategyFeatures.volumeRatio),
        extension: Number(strategyFeatures.extensionAtr),
        candleBody: Number(strategyFeatures.candleBodyRatio) || 0,
        wickImbalance: (Number(strategyFeatures.lowerWickRatio) || 0) - (Number(strategyFeatures.upperWickRatio) || 0),
        breakoutStrength: Number(strategyFeatures.breakoutStrength) || 0,
        regime: strategyFeatures.marketRegime === "TREND_UP" ? 1 : strategyFeatures.marketRegime === "TREND_DOWN" ? -1 :
          strategyFeatures.marketRegime === "SIDEWAYS" ? -0.5 : 0,
        volatilityRegime: strategyFeatures.volatilityRegime === "HIGH" ? 1 : strategyFeatures.volatilityRegime === "LOW" ? -1 : 0,
        structurePosition: Number(strategyFeatures.structurePosition) || 0,
        roomToResistance: Number(strategyFeatures.roomToResistanceAtr) || 0,
        roomToSupport: Number(strategyFeatures.roomToSupportAtr) || 0,
        falseBreakoutRisk: Number(strategyFeatures.falseBreakoutRisk) || 0,
        directionalStreak: Number(strategyFeatures.directionalStreak) || 0,
        longEntryQuality: Number.isFinite(Number(strategyFeatures.longEntryQuality))
          ? Number(strategyFeatures.longEntryQuality) : 50,
        shortEntryQuality: Number.isFinite(Number(strategyFeatures.shortEntryQuality))
          ? Number(strategyFeatures.shortEntryQuality) : 50
      }
    : null;
  const nineAiLearningContext = best?.setup === "NINE_AI_4H" && strategyFeatures
    ? {
        marketRegime: String(strategyFeatures.marketRegime || best.marketState || "UNKNOWN"),
        strategyFamily: String(best?.strategyClassification?.family || "CONSENSUS_FALLBACK"),
        strategyFit: Number(best?.strategyClassification?.fit) || 0,
        strategyEdgeR: Number(best?.strategyEdge?.selectionValue) || 0,
        strategyEdgeSamples: Number(best?.strategyEdge?.samples) || 0,
        strategyEdgeSource: String(best?.strategyEdge?.edgeSource || "COLD_START"),
        volatilityRegime: String(strategyFeatures.volatilityRegime || best.volatility || "UNKNOWN"),
        structureTrend: String(strategyFeatures.structureTrend || "UNKNOWN"),
        breakoutStrength: Number(strategyFeatures.breakoutStrength) || 0,
        falseBreakoutRisk: Number(strategyFeatures.falseBreakoutRisk) || 0,
        roleScore: Number(best.rankMetrics?.roleScore) || 0,
        setupQuality: Number(best.rankMetrics?.setupQuality) || 0,
        entryQuality: Number(best.rankMetrics?.entryQuality) || 0,
        breakoutQuality: Number(best.rankMetrics?.breakoutQuality) || 0,
        roomQuality: Number(best.rankMetrics?.roomQuality) || 0,
        grossRR: Number(best.rr) || 0,
        netRR: Number.isFinite(Number(best.rankMetrics?.netRR)) ? Number(best.rankMetrics.netRR) : null,
        netRRStatus: String(best.rankMetrics?.netRRStatus || "NOT_CONFIGURED"),
        rankScore: Number(best.rankScore) || 0,
        confidence: Number(best.confidence) || 0,
        roleVotes: Array.isArray(best.roles) ? best.roles.map(role => ({
          name: String(role.name || ""),
          side: String(role.side || "NEUTRAL"),
          confidence: Number(role.confidence) || 0
        })) : []
      }
    : null;

  return {
    // Preserve the authoritative Nine-AI decision and plan through execution.
    ...best,
    symbol: String(best.symbol),
    side,
    entry,
    price: entry,
    sl,
    tp,
    setup: best.setup,
    pullbackType: best.pullbackType ?? null,
    triggerType: best.triggerType ?? null,
    marketState: best.marketState ?? null,
    volatility: best.volatility ?? null,
    qualityScore: Number.isFinite(qualityScore) ? qualityScore : 0,
    nineAiLearningFeatures,
    nineAiLearningContext,
    nineAiStrategyFamily: String(best?.strategyClassification?.family || "CONSENSUS_FALLBACK"),
    nineAiResearchPolicy: best.nineAiResearchPolicy ?? null,
    nineAiDecisionKey: best.nineAiDecisionKey ?? null,

    // `risk` remains the monetary sizing budget expected by the execution code.
    risk: budget,
    initialRisk: priceRisk,
    rr,
    riskDetail: {
      ...riskDetail,
      targetR: rr,
      coreRisk: sourceRisk,
      risk: priceRisk,
      initialRisk: priceRisk,
      rr,
      slDistance: priceRisk,
      tpDistance: Math.abs(tp - entry),
      riskPercent: entry > 0 ? priceRisk / entry : 0,
      riskBudget: budget
    },
    createdAt: Number(best?.createdAt) || now,
    enteredAt: best?.enteredAt ?? null,
    openedAt: best?.openedAt ?? null,
    closedAt: best?.closedAt ?? null,
    updatedAt: now,
    result: best?.result ?? 'PENDING',
    maxAdverseMove: Number(best?.maxAdverseMove) || 0,
    maxFavorableMove: Number(best?.maxFavorableMove) || 0,
    nineAiFeatureSnapshot: best?.featureSnapshot ? {
      ...best.featureSnapshot,
      estSlippagePct: Number(best.featureSnapshot.estSlippagePct ?? best.agents?.fill?.est_slippage)
    } : null,
    nineAiPredictionSnapshot: {
      edges: best?.edges || null,
      predictedEdgeR: Number.isFinite(Number(best?.edges?.[side]?.edge)) ? Number(best.edges[side].edge) : null,
      predictedProbability: Number.isFinite(Number(best?.edges?.[side]?.p)) ? Number(best.edges[side].p) : null,
      predictedExpectedR: Number.isFinite(Number(best?.edges?.[side]?.expectedR)) ? Number(best.edges[side].expectedR) : null
    },
    nineAiSetupKey: best?.setupKey || null,
    timeoutCandles: 24
  };
}

// ================= SCANNER ================
async function scanner(){

    if(STOP_NEW_ENTRIES){
        console.log("⛔ SCAN PAUSED: runtime error requires restart")
        return
    }
    
    if(isScanning){
        console.log("⛔ Skip scan trùng")
        return
    }

    isScanning = true
    NINE_AI_SCAN_REASONS = new Map()

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

logNineAIScanSummary()
if(!signals || signals.length === 0){
    console.log("❌ No signal")
    return
}

        // ===== BUILD CANDIDATES + AI =====
let candidates = []

for (let s of signals){

    // Nine-AI is the sole ranking authority. No database win-rate,
    // legacy score, or secondary heuristic may change its candidate rank.
    const rankScore = Number(s.rankScore);
    if (!Number.isFinite(rankScore)) {
        console.log(`🚫 INVALID NINE-AI RANK ${s.symbol}`);
        continue;
    }
    candidates.push({
        ...s,
        finalScore: rankScore,
        rankScore,
        type: "NINE_AI"
    })
}

        // ===== NO CANDIDATE =====
        if(!candidates || candidates.length === 0){
            console.log("❌ No signal")
            return
        }

        // AI-9 net edge is the only ranking key. No legacy policy or research
// module is allowed to reorder the live opportunity set.
candidates = candidates.sort((a, b) => Number(b.rankScore) - Number(a.rankScore));
console.log("🧠 NINE-AI NET-EDGE RANK: " + candidates.slice(0, 5).map(c =>
    `${c.symbol}:${c.side}[edge=${safeFixed(c.rankScore, 4)},regime=${c.regime?.regime || "UNKNOWN"}]`
).join(" | "))
// ===== LỌC TẦNG 2 =====
let filtered = candidates.filter(c => {
    const cooldownUntil = MIN_NOTIONAL_RISK_COOLDOWN.get(c.symbol) || 0;
    if (cooldownUntil > Date.now()) return false;
    if (cooldownUntil) MIN_NOTIONAL_RISK_COOLDOWN.delete(c.symbol);
    const rankScore = Number(c.rankScore);
    if (!Number.isFinite(rankScore)) {
        console.log(`🚫 FILTER INVALID NINE-AI CONFIDENCE: ${c.symbol}`);
        return false;
    }

    // NINE-AI owns direction and its ATR-derived SL/TP. Scanner validates
    // trade geometry but never infers a counter/follow direction.
    const entry = Number(c.price);
    const sl = Number(c.sl);
    const tp = Number(c.tp);
    const side = String(c.side || "").toUpperCase();
    const rr = Math.abs(tp - entry) / Math.abs(entry - sl);
    const geometryValid = Number.isFinite(entry) && entry > 0 &&
        Number.isFinite(sl) && sl > 0 && Number.isFinite(tp) && tp > 0 &&
        (side === "LONG" ? sl < entry && tp > entry :
         side === "SHORT" ? sl > entry && tp < entry : false);

    if (!geometryValid || !Number.isFinite(rr) || rr < MIN_TRADE_RR) {
        console.log(
            `🚫 FILTER NINE-AI GEOMETRY: ${c.symbol} | ` +
            `side=${side} | RR=${safeFixed(rr, 2)} | invalid positive geometry`
        );
        return false;
    }

    c.rankDirectionMode = "NINE_AI_PRIMARY";
    return true;
})
// ===== SORT LẠI =====
filtered = filtered.sort((a, b) => Number(b.rankScore) - Number(a.rankScore))

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

// Diagnostic shortlist only; execution attempts remain bounded by the risk and exchange guards.
if(filtered.length > 0){
    const shortlist = filtered.slice(0, 5).map(c =>
        `${c.symbol}(RANK=${safeFixed(c.rankScore, 2)},CONF=${safeFixed(c.confidence, 1)},VOTES=${c.rankMetrics?.directionalVotes || 0}-${c.rankMetrics?.opposingVotes || 0})`
    ).join(" | ")
    console.log(`🧠 NINE-AI TOP ${Math.min(5, filtered.length)}: ${shortlist}`)
}

if(filtered.length === 0){
    console.log("❌ No filtered signal")
    return
}
// Try several ranked candidates so one coin that cannot meet exchange minimums
// without exceeding risk does not block every other tradable candidate.
let picks = filtered.slice(0, MAX_CANDIDATE_ATTEMPTS_PER_SCAN);
for (let best of picks){
const entry = Number(best.price);
const coreSL = Number(best.sl);
const coreTP = Number(best.tp);
const side = String(best.side || "").toUpperCase();

if (
    !Number.isFinite(entry) || entry <= 0 ||
    !Number.isFinite(coreSL) || coreSL <= 0 ||
    !Number.isFinite(coreTP) || coreTP <= 0 ||
    !["LONG", "SHORT"].includes(side) ||
    (side === "LONG" && !(coreSL < entry && coreTP > entry)) ||
    (side === "SHORT" && !(coreSL > entry && coreTP < entry))
) {
    console.log(`🚫 NINE-AI INVALID GEOMETRY: ${best.symbol}`);
    continue;
}

// No legacy RF counter/follow branch. Keep the approved nine-AI
// direction and ATR-derived SL/TP; downstream risk/position caps remain.
best.side = side;
best.triggerType = "NINE_AI_CONSENSUS";
best.rankDirectionMode = "NINE_AI_PRIMARY";
console.log(
    `🧠 NINE-AI PRIMARY ${best.symbol} | SIDE=${best.side} | CONF=${best.confidence} | RANK=${safeFixed(best.rankScore, 2)} | SL=${best.sl} | TP=${best.tp}`
);
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

    // Validate the exact Nine-AI plan. Invalid plans are rejected, never
    // repaired with a legacy RR or database-derived target.
    const rr = Math.abs(Number(best.tp) - Number(best.price)) /
        Math.abs(Number(best.price) - Number(best.sl));
    if (!Number.isFinite(rr) || rr < MIN_TRADE_RR) {
        console.log(
            `🚫 FILTER NINE-AI RR: ${best.symbol} | RR=${safeFixed(rr, 2)} | invalid positive geometry`
        );
        continue;
    }

    // Position risk is an execution safety budget, not a second strategy.
    // Nine-AI owns direction and geometry; account caps can only reduce
    // exposure, never alter its SL/TP or invent a new RR.
    const balance = ACCOUNT_BALANCE;
    const riskPercent = Math.min(TRADE_CONFIG.riskPerTrade, TRADE_CONFIG.maxRiskPerTrade);
    const risk = balance * riskPercent;
console.log(
    `🧮 RISK CALC ${best.symbol} | ` +
    `balance=${balance} | ` +
    `riskPercent=${riskPercent} | ` +
    `maxRisk=${TRADE_CONFIG.maxRiskPerTrade} | ` +
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

const trade = buildTradeFromNineAISignal(
    best,
    risk
)

if(!trade){

    console.log(
`🚫 FILTER BUILD TRADE: ${best.symbol} | ` +
`side=${best.side} | ` +
`setup=${best.setup} | ` +
`quality=${best.qualityScore ?? 0} | ` +
`rank=${safeFixed(best.finalScore, 1)}`
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

        // The exchange minimum is accepted only if its rounded quantity
        // remains within the original per-trade risk budget.
        const sizing = assessMinNotionalRisk({
            minNotional,
            price: best.price,
            stopDistance: diff,
            stepSize,
            maxRisk: trade.risk
        });
        const requiredQty = normalizeQtyFinal(sizing.requiredQty, stepSize);
        const requiredRisk = requiredQty * diff;
        const maxAllowedRisk = trade.risk;

        if(!sizing.feasible || !isRiskWithinBudget(requiredRisk, maxAllowedRisk)){

            MIN_NOTIONAL_RISK_COOLDOWN.set(
                best.symbol, Date.now() + MIN_NOTIONAL_RISK_COOLDOWN_MS
            );
            console.log(
                `⏭️ SKIP ${best.symbol}: exchange min notional cannot fit risk budget; cooldown=15m`,
                {
                    requiredRisk,
                    maxAllowedRisk,
                    minNotional,
                    estimatedNotional: requiredQty * best.price
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

    if(!isRiskWithinBudget(finalRisk, trade.risk)){
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

        // Persistently consume this closed-candle signal before sending an order.
        // This prevents a fast exit or process restart from reusing the same turn.
        if(!signalClaims || !Number.isFinite(Number(trade.signalAt))){
            console.log(`⛔ SIGNAL CLAIM UNAVAILABLE ${trade.symbol}`)
            continue
        }

        const signalKey = `${trade.symbol}:${Number(trade.signalAt)}`
        const plannedTargetR = Math.abs(Number(trade.tp) - Number(trade.entry)) /
            Math.abs(Number(trade.entry) - Number(trade.sl));
        if (!Number.isFinite(plannedTargetR) || plannedTargetR < MIN_TRADE_RR) {
            console.log(`⛔ INVALID NINE-AI RR BEFORE CLAIM ${trade.symbol}: ${plannedTargetR}`);
            continue;
        }
        try{
            await signalClaims.insertOne({
                signalKey,
                symbol: trade.symbol,
                signalAt: Number(trade.signalAt),
                side: trade.side,
                plannedEntry: Number(trade.entry),
                plannedSL: Number(trade.sl),
                plannedTP: Number(trade.tp),
                initialRisk: Number(trade.initialRisk),
                riskBudget: Number(trade.risk),
                targetR: plannedTargetR,
                state: "CLAIMED",
                createdAt: new Date()
            })
        }catch(claimError){
            if(claimError?.code === 11000){
                console.log(`⏭️ SIGNAL ALREADY USED ${trade.symbol} ${trade.signalAt}`)
                continue
            }
            console.log(`⛔ SIGNAL CLAIM FAILED ${trade.symbol}: ${claimError?.message || claimError}`)
            continue
        }

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

        // Recover real exchange state before registering this as a live trade.
        const recoveredEntry = Number(realPosition.entryPrice)
        const recoveredRisk = Number(
            trade.initialRisk ||
            trade.riskDetail?.initialRisk ||
            Math.abs(Number(trade.price) - Number(trade.sl))
        )
        const targetR = Number(trade.riskDetail?.targetR ?? trade.targetR ?? trade.rr)
        if(
            !Number.isFinite(recoveredEntry) || recoveredEntry <= 0 ||
            !Number.isFinite(recoveredRisk) || recoveredRisk <= 0 ||
            !Number.isFinite(targetR) || targetR <= 0
        ){
            console.error(`🚨 CANNOT RECOVER RISK ${trade.symbol}; attempting emergency close`)
            const emergencyClosed = await closePosition(
                trade.symbol,
                trade.side,
                Math.abs(Number(realPosition.positionAmt))
            )
            if(!emergencyClosed){
                await sendTelegram2(`🚨 EMERGENCY: ${trade.symbol} is still open; entry and TPSL recovery failed. Check Binance now.`)
                trade.emergencyProtectionNeeded = true
                execution = { ok: true, initialRisk: recoveredRisk, protectionPending: true }
            }else{
                await signalClaims.updateOne(
                    { signalKey },
                    { $set: { state: "CLOSED_AFTER_FAILURE", updatedAt: new Date() } }
                )
                continue
            }
        }else{
            trade.entry = recoveredEntry
            trade.initialRisk = recoveredRisk
            trade.sl = trade.side === "LONG"
                ? recoveredEntry - recoveredRisk
                : recoveredEntry + recoveredRisk
            trade.tp = trade.side === "LONG"
                ? recoveredEntry + recoveredRisk * targetR
                : recoveredEntry - recoveredRisk * targetR

            const recoveredTPSL = await setInitialTPSL(trade)
            if(recoveredTPSL?.ok){
                trade.sl = Number(recoveredTPSL.sl)
                trade.tp = Number(recoveredTPSL.tp)
                execution = { ok: true, initialRisk: Math.abs(trade.entry - trade.sl), recovered: true,
                    slOrderId: recoveredTPSL.slOrderId, tp1OrderId: recoveredTPSL.tp1OrderId, tpOrderId: recoveredTPSL.tpOrderId }
                trade.emergencyProtectionNeeded = false
                console.log(`🛡 RECOVERED TPSL ${trade.symbol} SL=${trade.sl} TP=${trade.tp}`)
            }else{
                console.error(`🚨 TPSL RECOVERY FAILED ${trade.symbol}; attempting emergency close`)
                const emergencyClosed = await closePosition(
                    trade.symbol,
                    trade.side,
                    Math.abs(Number(realPosition.positionAmt))
                )
                if(emergencyClosed){
                    await signalClaims.updateOne(
                        { signalKey },
                        { $set: { state: "CLOSED_AFTER_FAILURE", updatedAt: new Date() } }
                    )
                    continue
                }
                trade.emergencyProtectionNeeded = true
                execution = { ok: true, initialRisk: recoveredRisk, protectionPending: true }
                await sendTelegram2(`🚨 EMERGENCY: ${trade.symbol} remains open and TPSL could not be confirmed. The bot will retry protection; check Binance now.`)
            }
        }
    }else{

        console.log(
            `ℹ️ ${trade.symbol} confirmed no real position`
        )

        await signalClaims.updateOne(
            { signalKey },
            { $set: { state: "NO_POSITION", updatedAt: new Date() } }
        )

        continue
    }
}

trade.waitingEntry = false
trade.slOrderId = execution?.slOrderId || trade.slOrderId || null
trade.tp1OrderId = execution?.tp1OrderId || trade.tp1OrderId || null
trade.tpOrderId = execution?.tpOrderId || trade.tpOrderId || null
trade.entryExecution = execution?.entryExecution || {
    plannedEntry: Number(trade.price), plannedSL: Number(trade.sl), plannedTP: Number(trade.tp),
    actualEntry: Number(trade.entry), actualSL: Number(trade.sl), actualTP: Number(trade.tp),
    entrySlippage: Number(trade.entry) - Number(trade.price), recovered: execution?.recovered === true,
    captureStatus: "POSITION_RECOVERED_WITHOUT_ORDER_RESPONSE"
}
trade.actualQuantity = Number(trade.entryExecution.executedQuantity) > 0
    ? Number(trade.entryExecution.executedQuantity)
    : Number(trade.quantity)
trade.executionSchemaVersion = 1

// ==================================================
// BINANCE ENTRY ĐÃ THÀNH CÔNG
// BẬT DYNAMIC TPSL NGAY LẬP TỨC
// ==================================================
NEXT_ENTRY_ALLOWED_AT = Date.now() + ENTRY_COOLDOWN_MS;
TPSL_PHASE[trade.symbol] = trade.emergencyProtectionNeeded
    ? "NEEDS_PROTECTION"
    : "ACTIVE"

try{
    await signalClaims.updateOne(
        { signalKey },
        { $set: {
            state: trade.emergencyProtectionNeeded ? "NEEDS_PROTECTION" : "OPEN_UNRECORDED",
            entry: Number(trade.entry),
            sl: Number(trade.sl),
            tp: Number(trade.tp),
            initialRisk: Number(execution.initialRisk),
            updatedAt: new Date()
        } }
    )
}catch(claimUpdateError){
    console.error(`⚠️ SIGNAL CLAIM UPDATE FAILED ${trade.symbol}:`, claimUpdateError?.message || claimUpdateError)
}

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
await signalClaims.updateOne(
    { signalKey },
    { $set: { state: "TRADE_SAVED", updatedAt: new Date() } }
)

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

    TPSL_PHASE[trade.symbol] = trade.emergencyProtectionNeeded
        ? "NEEDS_PROTECTION"
        : "ACTIVE"

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
`🧠 Score: ${safeFixed(best.rankScore, 1)}\n` +
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
    `✅ ADD: ${best.symbol} | NINE-AI Rank: ${safeFixed(best.finalScore, 1)}`
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
                const tradeOpenAt = Number(t.enteredAt || t.openedAt || t.createdAt);
                if (t.setup === "NINE_AI_4H" && Number.isFinite(tradeOpenAt) &&
                    Date.now() - tradeOpenAt >= 96 * 60 * 60 * 1000) {
                    const positionsForTimeout = await getPositionsCached();
                    const timedPosition = Array.isArray(positionsForTimeout)
                        ? positionsForTimeout.find(p => p.symbol === t.symbol && Math.abs(Number(p.positionAmt || 0)) > 0)
                        : null;
                    if (timedPosition) {
                        const timeoutQty = Math.abs(Number(timedPosition.positionAmt));
                        console.log(`⏱️ NINE-AI 24-CANDLE TIMEOUT ${t.symbol} | ageHours=${((Date.now()-tradeOpenAt)/3600000).toFixed(1)}`);
                        const timeoutClosed = await closePosition(t.symbol, t.side, timeoutQty);
                        if (!timeoutClosed) console.error(`🚨 NINE-AI TIMEOUT CLOSE FAILED ${t.symbol}`);
                        continue;
                    }
                }

                let data = await Promise.race([
    getData(t.symbol,"15m",2),
    new Promise(resolve =>
        setTimeout(()=>resolve(null),10000)
    )
])

                if (Array.isArray(data) && data.length) {
                    const lastCandle = data[data.length - 1];
                    const hi = Number(lastCandle?.[2]), lo = Number(lastCandle?.[3]);
                    const entryPrice = Number(t.entry);
                    if (entryPrice > 0 && Number.isFinite(hi) && Number.isFinite(lo)) {
                        const adverse = t.side === "LONG" ? Math.max(0, entryPrice - lo) : Math.max(0, hi - entryPrice);
                        const favorable = t.side === "LONG" ? Math.max(0, hi - entryPrice) : Math.max(0, entryPrice - lo);
                        t.maxAdverseMove = Math.max(Number(t.maxAdverseMove) || 0, adverse);
                        t.maxFavorableMove = Math.max(Number(t.maxFavorableMove) || 0, favorable);
                        if (t._id) {
                            trades.updateOne({ _id: t._id, result: "PENDING" }, { $set: {
                                maxAdverseMove: t.maxAdverseMove, maxFavorableMove: t.maxFavorableMove,
                                lastExcursionUpdateAt: Date.now()
                            }}).catch(error => console.error(`⚠️ EXCURSION SAVE FAILED ${t.symbol}:`, error?.message || error));
                        }
                    }
                }

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

    // Clear the sibling TP/SL algo order after the exchange confirms the position is flat.
    try {
        const clearedOrders = await cancelAllOrders(t.symbol);
        if (!clearedOrders) console.error("⚠️ CLOSED POSITION HAS UNCONFIRMED STALE ORDERS " + t.symbol);
    } catch (cleanupError) {
        console.error("⚠️ CLOSED POSITION ORDER CLEANUP FAILED " + t.symbol + ":", cleanupError?.message || cleanupError);
    }
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
            grossRealizedPnl:Number.isFinite(Number(closed.grossRealizedPnl)) ? Number(closed.grossRealizedPnl) : null,
            feesUSDT:Number.isFinite(Number(closed.feesUSDT)) ? Number(closed.feesUSDT) : null,
            exitPrice:Number.isFinite(Number(closed.exitPrice)) ? Number(closed.exitPrice) : null,
            exitQty:Number.isFinite(Number(closed.exitQty)) ? Number(closed.exitQty) : null,
            exitReason:String(closed.exitOrderId) === String(t.slOrderId || "") && t.slOrderId
                ? "SL"
                : String(closed.exitOrderId) === String(t.tpOrderId || "") && t.tpOrderId
                    ? "TP" : "UNKNOWN",
            exitOrderId:closed.exitOrderId,
            exitOrderIds:closed.exitOrderIds || [closed.exitOrderId],
            executionFills:closed.executionFills || [],
            executionFillCount:Number(closed.executionFillCount) || 0,
            executionFillsMayBeTruncated:closed.executionFillsMayBeTruncated === true,
            commissionsByAsset:closed.commissionsByAsset || {},
            fundingUSDT:closed.fundingUSDT ?? null,
            fundingByAsset:closed.fundingByAsset || {},
            fundingEntries:closed.fundingEntries || [],
            fundingIncluded:closed.fundingIncluded === true,
            pnlAccountingVersion:1,
            closedAt:closed.closedAt
        }
    }
)

if (isWin && t.nineAiSetupKey && Number(t.maxAdverseMove) > 0 && Number(t.maxFavorableMove) > 0) {
    try {
        await db.collection("nine_ai_outcome_labels").updateOne(
            { tradeId: String(t._id || `${t.symbol}:${t.createdAt}`) },
            { $setOnInsert: {
                tradeId: String(t._id || `${t.symbol}:${t.createdAt}`),
                symbol: String(t.symbol),
                setupKey: String(t.nineAiSetupKey),
                side: String(t.side),
                mae: Number(t.maxAdverseMove),
                mfe: Number(t.maxFavorableMove),
                entryPrice: Number(t.entry),
                maePct: Number(t.entry) > 0 ? Number(t.maxAdverseMove) / Number(t.entry) * 100 : null,
                mfePct: Number(t.entry) > 0 ? Number(t.maxFavorableMove) / Number(t.entry) * 100 : null,
                labeled: true,
                source: "REALIZED_WINNING_TRADE",
                closedAt: closed.closedAt
            }},
            { upsert: true }
        );
    } catch (labelError) {
        console.error(`⚠️ NINE-AI OUTCOME LABEL SAVE FAILED ${t.symbol}:`, labelError?.message || labelError);
    }
}

if (t.nineAiDecisionKey) {
    try {
        const riskBudget = getTradeActualRisk(t);
        await nineAiDecisionJournal.recordActualOutcome({
            decisionKey: t.nineAiDecisionKey,
            tradeId: String(t._id || `${t.symbol}:${t.createdAt}`),
            realizedR: riskBudget > 0 ? closed.pnl / riskBudget : NaN,
            pnl: closed.pnl,
            closedAt: closed.closedAt,
            symbol: t.symbol,
            side: t.side,
            entryExecution: t.entryExecution || null,
            exit: {
                price: closed.exitPrice,
                quantity: closed.exitQty,
                orderIds: closed.exitOrderIds || [closed.exitOrderId],
                reason: String(closed.exitOrderId) === String(t.slOrderId || "") && t.slOrderId
                    ? "SL"
                    : String(closed.exitOrderId) === String(t.tpOrderId || "") && t.tpOrderId
                        ? "TP" : "UNKNOWN",
                fillCount: closed.executionFillCount,
                fillsMayBeTruncated: closed.executionFillsMayBeTruncated === true
            },
            accounting: {
                grossRealizedPnl: closed.grossRealizedPnl,
                feesUSDT: closed.feesUSDT,
                commissionsByAsset: closed.commissionsByAsset || {},
                fundingUSDT: closed.fundingUSDT ?? null,
                fundingByAsset: closed.fundingByAsset || {},
                fundingEntries: closed.fundingEntries || [],
                fundingIncluded: closed.fundingIncluded === true,
                netPnl: closed.pnl,
                pnlAccountingVersion: 1
            }
        });
    } catch (journalOutcomeError) {
        console.error("⚠️ NINE-AI ACTUAL OUTCOME JOURNAL FAILED " + t.symbol + ":", journalOutcomeError?.message || journalOutcomeError);
    }
}

// Persist realized outcomes for daily calibration only after Binance confirms closure.
try {
    if (nineAiOfflineLearningService) {
        const recorded = await nineAiOfflineLearningService.recordClosedTrade(t, closed);
        if (recorded.recorded) console.log("🧠 NINE-AI REALIZED OUTCOME SAVED: " + t.symbol + " R=" + recorded.realizedR);
    }
} catch (offlineLearningError) {
    console.error("⚠️ NINE-AI REALIZED OUTCOME SAVE FAILED " + t.symbol + ":", offlineLearningError?.message || offlineLearningError);
}

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

    if(ORPHAN_RECOVERY_RUNNING) return
    ORPHAN_RECOVERY_RUNNING = true

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

    const storedInitialRisk = Number(
        dbTrade.initialRisk ||
        dbTrade.riskDetail?.initialRisk ||
        dbTrade.riskDetail?.risk ||
        Math.abs(Number(dbTrade.entry) - Number(dbTrade.sl))
    )

    if(
        !Number.isFinite(storedInitialRisk) ||
        storedInitialRisk <= 0
    ){
        console.log(
            `⚠️ RECOVERY SKIP — MISSING INITIAL RISK ${symbol}`
        )

        continue
    }

    // Repair older pending rows when the entry and stop are present.
    if(Number(dbTrade.initialRisk) !== storedInitialRisk){
        dbTrade.initialRisk = storedInitialRisk
        try{
            await trades.updateOne(
                { _id: dbTrade._id, result: "PENDING" },
                { $set: { initialRisk: storedInitialRisk, updatedAt: Date.now() } }
            )
        }catch(riskRepairError){
            console.log(`⚠️ RECOVERY RISK SAVE FAIL ${symbol}:`, riskRepairError?.message || riskRepairError)
        }
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

    TPSL_PHASE[symbol] = dbTrade.emergencyProtectionNeeded
        ? "NEEDS_PROTECTION"
        : "ACTIVE"

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

            let signalClaim = null
            try{
                signalClaim = await signalClaims.findOne(
                    {
                        symbol,
                        side,
                        state: { $in: ["ORDER_SUBMITTING", "OPEN_UNRECORDED", "NEEDS_PROTECTION"] }
                    },
                    { sort: { createdAt: -1 } }
                )
            }catch(claimLookupError){
                console.log(`⚠️ ORPHAN SIGNAL LOOKUP FAIL ${symbol}:`, claimLookupError?.message || claimLookupError)
            }

            const claimedRisk = Number(
                signalClaim?.initialRisk ||
                Math.abs(Number(signalClaim?.plannedEntry) - Number(signalClaim?.plannedSL))
            )
            const claimedTargetR = Number(
                signalClaim?.targetR ||
                (Math.abs(Number(signalClaim?.plannedTP) - Number(signalClaim?.plannedEntry)) / claimedRisk)
            )
            const hasRecoverableRisk =
                Number.isFinite(claimedRisk) && claimedRisk > 0 &&
                Number.isFinite(claimedTargetR) && claimedTargetR > 0

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

                tp: hasRecoverableRisk
                    ? (side === "LONG" ? entry + claimedRisk * claimedTargetR : entry - claimedRisk * claimedTargetR)
                    : null,
                sl: hasRecoverableRisk
                    ? (side === "LONG" ? entry - claimedRisk : entry + claimedRisk)
                    : null,

                risk: Number(signalClaim?.riskBudget || 0),
                rr: hasRecoverableRisk ? claimedTargetR : 0,
                initialRisk: hasRecoverableRisk ? claimedRisk : null,

                score: 0,
                finalScore: 0,

                setup: "ORPHAN_RECOVERY",
                marketState: "RECOVERY",
                volatility: "UNKNOWN",

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
                emergencyProtectionNeeded: hasRecoverableRisk,

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

    TPSL_PHASE[symbol] = orphanTrade.emergencyProtectionNeeded
        ? "NEEDS_PROTECTION"
        : "ORPHAN_UNPROTECTED"

    if(orphanTrade.emergencyProtectionNeeded){
        const protection = await setInitialTPSL(orphanTrade)
        if(protection?.ok){
            orphanTrade.sl = Number(protection.sl)
            orphanTrade.tp1 = Number(protection.tp1)
            orphanTrade.tp1OrderId = protection.tp1OrderId
            orphanTrade.tp = Number(protection.tp)
            orphanTrade.slOrderId = protection.slOrderId
            orphanTrade.tpOrderId = protection.tpOrderId
            orphanTrade.initialRisk = Math.abs(entry - orphanTrade.sl)
            orphanTrade.emergencyProtectionNeeded = false
            TPSL_PHASE[symbol] = "ACTIVE"
            if(signalClaim?.signalKey){
                await signalClaims.updateOne(
                    { signalKey: signalClaim.signalKey },
                    { $set: {
                        state: "OPEN_UNRECORDED",
                        entry,
                        sl: orphanTrade.sl,
                        tp: orphanTrade.tp,
                        initialRisk: orphanTrade.initialRisk,
                        updatedAt: new Date()
                    } }
                )
            }
        }else{
            console.error(`🚨 ORPHAN TPSL NOT CONFIRMED ${symbol}; emergency close retries enabled`)
        }
    }else{
        await sendTelegram2(`🚨 UNRECOGNIZED OPEN POSITION ${symbol} ${side}. No saved signal risk was found; bot cannot safely invent SL/TP. Please protect or close it in Binance.`)
    }

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

                if(signalClaim?.signalKey){
                    await signalClaims.updateOne(
                        { signalKey: signalClaim.signalKey },
                        { $set: { state: "TRADE_SAVED", updatedAt: new Date() } }
                    )
                }

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
    }finally{
        ORPHAN_RECOVERY_RUNNING = false
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
        if(!process.env.BINANCE_KEY || !process.env.BINANCE_SECRET){
            throw new Error("❌ Thiếu BINANCE_KEY hoặc BINANCE_SECRET")
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
        await trades.createIndex(
            { symbol: 1, result: 1 },
            { name: "trades_symbol_result" }
        )
        await trades.createIndex(
            { result: 1, setup: 1, marketState: 1, side: 1, volatility: 1, createdAt: -1 },
            { name: "trades_stats_recent" }
        )
        await trades.createIndex(
            { result: 1, createdAt: -1 },
            { name: "trades_result_recent" }
        )
        signalClaims = db.collection("trade_signal_claims");

await signalClaims.createIndex(
    { signalKey: 1 },
    { unique: true, name: "uniq_trade_signal_key" }
);

// Xóa TTL 90 ngày cũ nếu còn tồn tại
try {
    await signalClaims.dropIndex("expire_trade_signal_claims_90d");
} catch (indexError) {
    if (indexError?.codeName !== "IndexNotFound" && indexError?.code !== 27) {
        throw indexError;
    }
}

// Tự xóa bản ghi sau 10 ngày tính từ createdAt
await signalClaims.createIndex(
    { createdAt: 1 },
    {
        expireAfterSeconds: 10 * 24 * 60 * 60,
        name: "expire_trade_signal_claims_10d"
    }
);

// The canonical journal and daily offline learner are the only Nine-AI learning path.
const decisionJournalStatus = await nineAiDecisionJournal.initialize(db);
console.log("🧠 NINE-AI DECISION JOURNAL READY: samples=" + decisionJournalStatus.samples +
    " pending=" + decisionJournalStatus.pending + " matured24barSamples=" +
    decisionJournalStatus.maturedWindowSamples);
nineAiOfflineLearningService = nineAiOfflineLearning.createOfflineLearning(db);
const offlineLearningStatus = await nineAiOfflineLearningService.initialize();
console.log("🧠 NINE-AI OFFLINE LEARNING READY: champion=" +
    JSON.stringify(offlineLearningStatus.champion));
const runDailyNineAIOfflineLearning = async () => {
    try {
        const report = await nineAiOfflineLearningService.runDailyCycle();
        console.log("🧪 NINE-AI DAILY LEARNING: calibrationSamples=" + report.calibration.samples +
            " biasR=" + report.calibration.biasR +
            " candidate=" + (report.candidateResult?.status || "NONE") +
            " shadow=" + (report.shadowResult?.status || "NONE"));
    } catch (error) {
        console.error("⚠️ NINE-AI DAILY OFFLINE LEARNING FAILED:", error?.message || error);
    }
};
void runDailyNineAIOfflineLearning();
setInterval(runDailyNineAIOfflineLearning, 24 * 60 * 60 * 1000);

// Capacity-aware retention: old evaluated/research history is pruned only after
// estimated collection storage crosses the configured threshold. Failure is non-fatal.
try {
    const dbRetention = nineAiDbRetention.createRetention(db);
    const runDbRetention = async () => {
        try {
            await dbRetention.runCleanup();
        } catch (retentionError) {
            console.error("⚠️ NINE-AI DB RETENTION FAILED:", retentionError?.message || retentionError);
        }
    };
    void runDbRetention();
    setInterval(runDbRetention, dbRetention.config.intervalMs);
    console.log("🧹 NINE-AI DB RETENTION READY: limitMB=" + dbRetention.config.limitMB +
        " trigger=" + Math.round(dbRetention.config.triggerRatio * 100) + "%" +
        " target=" + Math.round(dbRetention.config.targetRatio * 100) + "%" +
        " deletionEnabled=" + dbRetention.config.enabled +
        " dryRun=" + dbRetention.config.dryRun);
} catch (retentionInitError) {
    console.error("⚠️ NINE-AI DB RETENTION INIT FAILED:", retentionInitError?.message || retentionInitError);
}

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
        for(let attempt = 1; attempt <= 10 && !TIME_SYNCED; attempt++){
            await syncTime()
            if(!TIME_SYNCED){
                console.log(`⏳ Waiting time sync ${attempt}/10`)
                await new Promise(r => setTimeout(r, 2000))
            }
        }
        if(!TIME_SYNCED){
            throw new Error("BINANCE TIME SYNC FAILED; refusing to start order loops")
        }
        await requireOneWayPositionMode()
        console.log("✅ BINANCE POSITION MODE: ONE-WAY")
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
        // Never expire a PENDING trade just because it is old: live positions
        // can legitimately remain open beyond 24 hours.
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

    TPSL_PHASE[trade.symbol] = trade.emergencyProtectionNeeded
        ? "NEEDS_PROTECTION"
        : "ACTIVE"
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
        // khởi động lại bot nếu start lỗi
        process.exit(1)
    }
}
start()

async function syncActiveTrades(){

    if(syncingActiveTrades) return
    syncingActiveTrades = true

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
        // 3. GIỮ MỌI PENDING TRADE TỪ DB ĐỂ checkTrades CÓ THỂ
        //    GHI NHẬN PNL KHI VỊ THẾ VỪA ĐÓNG TRƯỚC LẦN SYNC.
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

            // Binance flat may mean TP/SL just filled; do not discard this
            // record before checkTrades reconciles its realized PnL.
            if(!merged.has(trade.symbol)) merged.set(trade.symbol, trade)

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

                TPSL_PHASE[trade.symbol] = trade.emergencyProtectionNeeded
                    ? "NEEDS_PROTECTION"
                    : "ACTIVE"
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
    }finally{
        syncingActiveTrades = false
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

            const phase = TPSL_PHASE[symbol]
            if(phase !== "ACTIVE" && phase !== "NEEDS_PROTECTION"){
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

            if(phase === "NEEDS_PROTECTION"){
                TPSL_PENDING[symbol] = true
                try{
                    const protection = await setInitialTPSL(trade)
                    if(protection?.ok){
                        trade.sl = Number(protection.sl)
                        trade.tp1 = Number(protection.tp1)
                        trade.tp1OrderId = protection.tp1OrderId
                        trade.tp = Number(protection.tp)
                        trade.slOrderId = protection.slOrderId
                        trade.tpOrderId = protection.tpOrderId
                        trade.initialRisk = Math.abs(Number(trade.entry) - trade.sl)
                        trade.emergencyProtectionNeeded = false
                        TPSL_PHASE[symbol] = "ACTIVE"
                        await trades.updateOne(
                            { symbol, result: "PENDING" },
                            { $set: {
                                sl: trade.sl,
                                tp1: trade.tp1,
                                tp1OrderId: trade.tp1OrderId,
                                tp: trade.tp,
                                slOrderId: trade.slOrderId,
                                tpOrderId: trade.tpOrderId,
                                initialRisk: trade.initialRisk,
                                emergencyProtectionNeeded: false,
                                updatedAt: Date.now()
                            } }
                        )
                        console.log(`🛡 EMERGENCY TPSL RECOVERED ${symbol}`)
                    }else{
                        console.log(`🚨 PROTECTION STILL MISSING ${symbol}; retrying emergency close`)
                        const pos = positionMap.get(symbol)
                        const qty = Math.abs(Number(pos?.positionAmt || 0))
                        if(qty > 0){
                            const closed = await closePosition(symbol, trade.side, qty)
                            if(!closed){
                                console.log(`🚨 EMERGENCY CLOSE STILL FAILING ${symbol}`)
                            }
                        }
                    }
                }catch(protectionError){
                    console.log(`🚨 EMERGENCY PROTECTION ERROR ${symbol}:`, protectionError?.message || protectionError)
                }finally{
                    delete TPSL_PENDING[symbol]
                }
                continue
            }

            // Post-entry Nine-AI TPSL management is intentionally disabled.
            // The confirmed entry-time exchange SL/TP remains in place; the
            // emergency protection recovery above remains active.
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
        if(
            fs.existsSync(PID_FILE) &&
            fs.readFileSync(PID_FILE, "utf8").trim() === String(process.pid)
        ){
            fs.unlinkSync(PID_FILE)
        }
    }catch(e){}
}

process.on("exit", cleanup)
process.on("SIGINT", () => { cleanup(); process.exit() })
process.on("SIGTERM", () => { cleanup(); process.exit() })
