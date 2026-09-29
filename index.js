let DB_READY = false
const OPEN_POSITION_LOCK = {}
const RANGE_EXIT_LOCK = {}
const RANGE_EXIT_ALERT_AT = {}
const RANGE_EXIT_DATA_FAILS = {}
const LAST_RF_SIGNAL_CANDLE = {}
const RF_CANDLE_COUNT = 1300;
const RF_FETCH_COUNT = RF_CANDLE_COUNT + 1;
let DB_RECONNECTING = false
let DB_LAST_ERROR = 0
let TIME_SYNCED = false
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

        const openTime = Number(t.enteredAt || t.openedAt || t.createdAt || 0);
        const trades = await binance.futuresUserTrades({
            symbol: t.symbol,
            startTime: Math.max(0, openTime - 5000),
            limit: 1000,
            recvWindow: 20000
        })

        if(!trades || trades.length === 0){
            return null
        }

        // Find closing-side fills after entry, including exact break-even fills.
        const closingSide = String(t.side).toUpperCase() === "LONG" ? "SELL" : "BUY";
        const exits = trades
            .filter(x =>
                String(x.side || "").toUpperCase() === closingSide &&
                Number(x.time || 0) >= openTime - 5000
            )
            .sort((a,b) => Number(a.time || 0) - Number(b.time || 0));

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


const TRADE_CONFIG = {
    maxPositionPercent: 0.03,  
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
const ENTRY_COOLDOWN_MS = 8 * 60 * 1000;
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
async function cancelLegacyAlgoOrders(symbol){

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
            `🗑 LEGACY ALGO ORDERS CANCELLED ${symbol}`
        )

        return true

    }catch(e){

        await checkTimeError(e)

        console.log(
            `❌ CANCEL LEGACY ALGO ORDERS ${symbol}:`,
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
// CLEAR LEGACY SYMBOL ORDERS
// =========================================

const cleared =
    await clearSymbolOrders(symbol)

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
async function clearSymbolOrders(symbol){

    if(!symbol){
        console.log("❌ CANCEL ALL NO SYMBOL")
        return false
    }

    try{

        console.log(
            `🗑 CLEAR LEGACY SYMBOL ORDERS ${symbol}`
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
        // 2. CANCEL LEGACY ALGO ORDERS
        // =========================================

        const algoCancelled =
            await cancelLegacyAlgoOrders(symbol)

        if(!algoCancelled){

            console.log(
                `❌ LEGACY ALGO CANCEL FAIL ${symbol}`
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
            `🗑 LEGACY SYMBOL ORDERS CLEARED ${symbol}`
        )

        return true

    }catch(e){

        await checkTimeError(e)

        console.log(
            `❌ CLEAR LEGACY ORDERS ${symbol}:`,
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
        .slice(0, 150)
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
// ============================================================ // RANGE FILTER CORE // // Single entry indicator: TradingView Range Filter [DW] // Chart settings: Type 1 / Close / 2.618 Average Change / period 14 / smoothing 27 / 5m // No TP/SL; exit on opposite confirmed Range Filter direction // Other timeframes remain in function signature for compatibility. // ============================================================
const finite = Number.isFinite;
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
function rangeFilter(candles, options = {}) {
  const cfg = {
    filterType: 'Type 1',
    movementSource: 'Close',
    rangeSize: 2.618,
    rangeScale: 'Average Change',
    rangePeriod: 14,
    smoothRange: true,
    smoothPeriod: 27,
    averageFilterChanges: false,
    averageChanges: 2,
    tickSize: 0.01,
    pointValue: 1,
    ...options
  };
  const { filterType, movementSource, rangeSize, rangeScale,
    rangePeriod, smoothRange, smoothPeriod, averageFilterChanges,
    averageChanges, tickSize, pointValue } = cfg;

  if (!Array.isArray(candles)) throw new TypeError('candles phải là một mảng');
  if (!Number.isInteger(rangePeriod) || rangePeriod < 1 ||
      !Number.isInteger(smoothPeriod) || smoothPeriod < 1 ||
      !Number.isInteger(averageChanges) || averageChanges < 1 ||
      !Number.isFinite(rangeSize) || rangeSize <= 0) {
    throw new RangeError('Tham số Range Filter không hợp lệ');
  }

  const n = candles.length;
  const close = candles.map(c => Number(c?.c));
  const high = candles.map((c, i) => movementSource === 'Wicks' ? Number(c?.h) : close[i]);
  const low = candles.map((c, i) => movementSource === 'Wicks' ? Number(c?.l) : close[i]);
  const basis = high.map((h, i) => (h + low[i]) / 2);

  // Pine Cond_EMA: update only when condition is true, seeding with first sample.
  function conditionalEma(values, length, condition = () => true) {
    const out = new Array(values.length).fill(NaN);
    const alpha = 2 / (length + 1);
    let state = NaN;
    for (let i = 0; i < values.length; i++) {
      const x = values[i];
      if (condition(i) && Number.isFinite(x)) {
        state = Number.isFinite(state) ? state + alpha * (x - state) : x;
      }
      out[i] = state;
    }
    return out;
  }

  const trueRange = new Array(n).fill(NaN);
  const absChange = new Array(n).fill(NaN);
  for (let i = 0; i < n; i++) {
    if (![high[i], low[i]].every(Number.isFinite)) continue;
    if (i === 0) trueRange[i] = high[i] - low[i];
    else if (Number.isFinite(close[i - 1])) {
      trueRange[i] = Math.max(
        high[i] - low[i],
        Math.abs(high[i] - close[i - 1]),
        Math.abs(low[i] - close[i - 1])
      );
    }
    if (i > 0 && Number.isFinite(basis[i]) && Number.isFinite(basis[i - 1])) {
      absChange[i] = Math.abs(basis[i] - basis[i - 1]);
    }
  }

  // DW dynamic range inputs: EMA(True Range), EMA(Average Change), or
  // population standard deviation, sampled over rangePeriod.
  const atrLike = conditionalEma(trueRange, rangePeriod);
  const avgChange = conditionalEma(absChange, rangePeriod);
  const stdev = new Array(n).fill(NaN);
  for (let i = 0; i < n; i++) {
    const start = Math.max(0, i - rangePeriod + 1);
    const values = basis.slice(start, i + 1);
    if (values.length && values.every(Number.isFinite)) {
      const mean = values.reduce((a, b) => a + b, 0) / values.length;
      const variance = values.reduce((a, x) => a + (x - mean) ** 2, 0) / values.length;
      stdev[i] = Math.sqrt(variance);
    }
  }

  const rawRange = basis.map((price, i) => {
    if (!Number.isFinite(price)) return NaN;
    switch (rangeScale) {
      case 'Points': return rangeSize * pointValue;
      case 'Pips': return rangeSize * 0.0001;
      case 'Ticks': return rangeSize * tickSize;
      case '% of Price': return close[i] * rangeSize / 100;
      case 'ATR': return rangeSize * atrLike[i];
      case 'Average Change': return rangeSize * avgChange[i];
      case 'Standard Deviation': return rangeSize * stdev[i];
      case 'Absolute': return rangeSize;
      default: throw new RangeError(`Range Scale không hợp lệ: ${rangeScale}`);
    }
  });
  const smooth = conditionalEma(rawRange, smoothPeriod);
  const range = rawRange.map((v, i) => smoothRange ? smooth[i] : v);

  const filter = new Array(n).fill(NaN);
  const upperBand = new Array(n).fill(NaN);
  const lowerBand = new Array(n).fill(NaN);
  const direction = new Array(n).fill(0);
  const buy = new Array(n).fill(false);
  const sell = new Array(n).fill(false);
  const signal = new Array(n).fill(0);
  const upward = new Array(n).fill(false);
  const downward = new Array(n).fill(false);
  let filterState = NaN;
  let heldDirection = 0;
  let avgFilterState = NaN;
  let avgUpperState = NaN;
  let avgLowerState = NaN;
  let changedSamples = 0;
  const changeAlpha = 2 / (averageChanges + 1);

  for (let i = 0; i < n; i++) {
    const h = high[i], l = low[i], r = range[i];
    if (![h, l, r].every(Number.isFinite) || r < 0) {
      direction[i] = heldDirection;
      continue;
    }

    // DW Type 1: move the filter only when price clears the prior filter
    // by the current range. Type 2 advances in discrete range increments.
    const previous = Number.isFinite(filterState) ? filterState : basis[i];
    if (filterType === 'Type 1') {
      if (h - r > previous) filterState = h - r;
      if (l + r < previous) filterState = l + r;
      if (!Number.isFinite(filterState)) filterState = basis[i];
    } else if (filterType === 'Type 2') {
      if (h >= previous + r && r > 0) {
        filterState = previous + Math.floor(Math.abs(h - previous) / r) * r;
      }
      if (l <= previous - r && r > 0) {
        filterState = previous - Math.floor(Math.abs(l - previous) / r) * r;
      }
      if (!Number.isFinite(filterState)) filterState = basis[i];
    } else {
      throw new RangeError(`Filter Type không hợp lệ: ${filterType}`);
    }

    filter[i] = filterState;
    upperBand[i] = filterState + r;
    lowerBand[i] = filterState - r;

    if (i > 0 && Number.isFinite(filter[i - 1])) {
      if (filter[i] > filter[i - 1]) heldDirection = 1;
      else if (filter[i] < filter[i - 1]) heldDirection = -1;
    }
    direction[i] = heldDirection;
    upward[i] = heldDirection === 1;
    downward[i] = heldDirection === -1;

    const changed = i > 0 && Number.isFinite(filter[i - 1]) && filter[i] !== filter[i - 1];
    if (changed) {
      changedSamples++;
      if (!Number.isFinite(avgFilterState)) {
        avgFilterState = filter[i];
        avgUpperState = upperBand[i];
        avgLowerState = lowerBand[i];
      } else {
        avgFilterState += changeAlpha * (filter[i] - avgFilterState);
        avgUpperState += changeAlpha * (upperBand[i] - avgUpperState);
        avgLowerState += changeAlpha * (lowerBand[i] - avgLowerState);
      }
    }
    if (averageFilterChanges && changedSamples > 0) {
      filter[i] = avgFilterState;
      upperBand[i] = avgUpperState;
      lowerBand[i] = avgLowerState;
    }

    if (i > 0) {
      buy[i] = direction[i] === 1 && direction[i - 1] !== 1;
      sell[i] = direction[i] === -1 && direction[i - 1] !== -1;
      signal[i] = buy[i] ? 1 : sell[i] ? -1 : 0;
    }
  }

  return { filter, upperBand, lowerBand, direction, upward, downward, signal, buy, sell, range };
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
  // Range Filter [DW], matched to the user's chart: Type 1 / Close / 2.618
  // Average Change / 14 / smoothed with period 27. prepare() excludes the
  // current forming candle so signals only come from a closed 5m candle.
  const candles = prepare(data5, RF_CANDLE_COUNT);
  if (!candles) return null;
  const rf = rangeFilter(candles, {
    filterType: 'Type 1', movementSource: 'Close',
    rangeSize: 2.618, rangeScale: 'Average Change', rangePeriod: 14,
    smoothRange: true, smoothPeriod: 27,
    averageFilterChanges: false, averageChanges: 2
  });
  const i = candles.length - 1;
  if (i < 1 || !Array.isArray(rf.direction)) return null;
  const side = rf.buy[i] ? 'LONG' : rf.sell[i] ? 'SHORT' : null;
  if (!side) return null;
  const price = candles[i].c, filter = rf.filter[i], range = rf.range[i];
  if (![price, filter, range].every(finite) || price <= 0 || range <= 0) return null;
  if (side === 'LONG' ? price <= filter : price >= filter) return null;
  const priorFilter = rf.filter[i - 1];
  if (!finite(priorFilter)) return null;
  const move = side === 'LONG' ? filter - priorFilter : priorFilter - filter;
  if (move <= 0) return null;
  const rank = scoreRF5Signal(data5, side);
  const score = clamp(Math.round(70 + rank.adjustment), 0, 100);
  const volRatio = range / price;
  return {
    side, symbol, price, isFlip: true, flipTime: candles[i].t,
    setup: 'RANGE_FILTER', pullbackType: 'NONE',
    triggerType: side === 'LONG' ? 'UP_TURN' : 'DOWN_TURN',
    marketState: side === 'LONG' ? 'DW_UP_TURN' : 'DW_DOWN_TURN',
    volatility: volRatio < 0.001 ? 'LOW' : volRatio < 0.004 ? 'NORMAL' : 'HIGH',
    qualityScore: score, score,
    rankAdjustment: rank.adjustment, filterMove: move, filterRange: range
  };
}

function scoreRF5Signal(data5, side) {
  const candles = prepare(data5, 600);
  if (!candles) return { adjustment: -100, early: false };
  const rf = rangeFilter(candles, {
    filterType: 'Type 1', movementSource: 'Close',
    rangeSize: 2.618, rangeScale: 'Average Change', rangePeriod: 14,
    smoothRange: true, smoothPeriod: 27,
    averageFilterChanges: false, averageChanges: 2
  });
  const i = candles.length - 1;
  if (i < 3) return { adjustment: -100, early: false };

  // Rank higher when the latest DW turn just began; lower as the slope ages.
  let runBars = 0;
  for (let j = i; j > 0; j--) {
    const a = rf.filter[j - 1], b = rf.filter[j];
    if (!finite(a) || !finite(b)) break;
    const d = b - a;
    if (side === 'LONG' ? d > 0 : d < 0) runBars++;
    else break;
  }
  const recent = side === 'LONG' ? rf.buy[i] : rf.sell[i];
  let path = 0;
  const lookback = 8;
  for (let j = Math.max(1, i - lookback + 1); j <= i; j++) {
    path += Math.abs(candles[j].c - candles[j - 1].c);
  }
  const net = candles[i].c - candles[Math.max(0, i - lookback)].c;
  const aligned = side === 'LONG' ? net > 0 : net < 0;
  const efficiency = path > 0 ? Math.abs(net) / path : 0;

  const anchor = Math.max(0, i - 3);
  const oldFilter = rf.filter[anchor], oldRange = rf.range[anchor];
  const currentRange = rf.range[i], price = candles[i].c;
  let extension = 0;
  if ([oldFilter, oldRange, currentRange, price].every(finite) && oldRange > 0 && currentRange > 0) {
    const oldEdge = side === 'LONG' ? oldFilter + oldRange : oldFilter - oldRange;
    extension = side === 'LONG' ? (price - oldEdge) / currentRange : (oldEdge - price) / currentRange;
  }
  extension = Math.max(0, extension);
  const early = recent && runBars <= 2;
  const freshness = early ? 12 - runBars * 2 : -Math.min(20, Math.max(0, runBars - 2) * 4);
  const adjustment = efficiency * 8 + (aligned ? 4 : -6) + freshness - Math.min(20, extension * 5);
  return { adjustment, efficiency, alignedMove: aligned, extensionUnits: extension, runBars, early };
}

// ================= SCAN =================
async function scan(symbol){

    try{

        // ==================================================
        // 1. LOAD MARKET DATA
        // ==================================================

        const data5 = await getData(symbol,"5m",RF_FETCH_COUNT);
        if(!data5) return null;
        // ==================================================
        // 3. CORE LOGIC
        // ==================================================

        let r

        try{

            r = await coreLogic(null, null, null, data5, symbol)

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
        // The scanner polls every minute while a 5m candle stays the latest
        // closed candle. Consume each Range Filter flip once, and reject an
        // old flip if the scanner/data feed was delayed by more than one bar.
        const flipTime=Number(r.flipTime);
        const flipAge=getTimestamp()-(flipTime+5*60*1000);
        if(!Number.isFinite(flipTime)||flipAge>5*60*1000){
            console.log(`⏭ STALE RANGE FLIP ${symbol} ${r.side} age=${Math.round(flipAge/60000)}m`);
            return null;
        }
        if(LAST_RF_SIGNAL_CANDLE[symbol]===flipTime){
            return null;
        }
        LAST_RF_SIGNAL_CANDLE[symbol]=flipTime;
        const rfRank = scoreRF5Signal(data5, r.side);
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
function buildTradeFromCoreSignal(best, btcRegime, positionBudget) {
  const side = String(best?.side ?? '').toUpperCase();
  const entry = Number(best?.price ?? best?.entry);
  const budget = Number(positionBudget);
  if (!best?.symbol || !['LONG', 'SHORT'].includes(side) || !Number.isFinite(entry) || entry <= 0 || !Number.isFinite(budget) || budget <= 0 || best?.isFlip !== true) {
    console.log(`❌ INVALID RANGE-FLIP SIGNAL ${best?.symbol || 'UNKNOWN'}`);
    return null;
  }
  const now = Date.now();
  return {
    ...best, symbol: String(best.symbol), side, entry, price: entry,
    setup: best.setup ?? 'RANGE_FILTER',
    marketState: best.marketState ?? null,
    volatility: best.volatility ?? null,
    btcRegime: btcRegime ?? best.btcRegime ?? null,
    qualityScore: Number(best.qualityScore ?? best.score ?? 0) || 0,
    positionBudget: budget, quantity: 0, notional: 0,
    waitingEntry: false, breakoutTriggered: false,
    createdAt: Number(best.createdAt) || now, enteredAt: null,
    openedAt: null, closedAt: null, updatedAt: now,
    result: 'PENDING'
  };
}

async function alertRangeExitProblem(symbol,detail){
    const now=Date.now();
    if(now-(RANGE_EXIT_ALERT_AT[symbol]||0)<60000) return;
    RANGE_EXIT_ALERT_AT[symbol]=now;
    await sendTelegram(`🚨 RANGE EXIT PROBLEM ${symbol}\n${detail}\nBot sẽ tiếp tục thử lại; kiểm tra vị thế trên Binance ngay.`);
}
async function closeOpenPositionOnRangeFlip(flip){
    const symbol=flip?.symbol;
    if(!symbol||flip?.isFlip!==true) return {matched:false,closed:false};
    // The independent position monitor may already be closing this confirmed flip.
    // Tell scanner to consume the event rather than falling through to its own close path.
    if(RANGE_EXIT_LOCK[symbol]) return {matched:true,closed:false,inProgress:true,reason:"EXIT_IN_PROGRESS"};
    RANGE_EXIT_LOCK[symbol]=true;
    try{
        let openTrade=null;
        try { openTrade=await trades.findOne({symbol,result:"PENDING"}); }
        catch(e) { console.log(`⚠ EXIT DB LOOKUP FAIL ${symbol}: ${e.message}; checking exchange position anyway`); }
        POS_CACHE=null; POS_CACHE_TIME=0;
        const positions=await getPositionsCached();
        const livePos=(positions||[]).find(p=>p.symbol===symbol&&Math.abs(Number(p.positionAmt||0))>0);
        if(!livePos){
            // A scanner signal with no exchange position is an ENTRY candidate, not an exit failure.
            // Return unmatched so the scanner keeps it in the new-entry flow.
            return {matched:false,closed:false,reason:"NO_LIVE_POSITION"};
        }
        const liveSide=Number(livePos.positionAmt)>0?"LONG":"SHORT";
        if(liveSide===flip.side) return {matched:false,closed:false,reason:"SAME_DIRECTION"};
        if(openTrade){
            const closeQuery=openTrade._id?{_id:openTrade._id,result:"PENDING"}:{symbol,result:"PENDING"};
            try{
                await trades.updateOne(closeQuery,{$set:{closeReason:"RANGE_FILTER_FLIP",closeFlipTime:Number(flip.flipTime),closeRequestedAt:Date.now()}});
            }catch(e){ console.log(`⚠ EXIT TAG DB FAIL ${symbol}: ${e.message}; will still attempt verified close`); }
        }
        console.log(`🔻 RANGE FILTER EXIT ${symbol}: ${liveSide} -> ${flip.side}; close only, no reverse entry`);
        const legacyOrdersCleared=await clearSymbolOrders(symbol);
        if(!legacyOrdersCleared){ console.log(`⚠ ${symbol} legacy exit orders could not be cleared before close; prioritizing market close`); await alertRangeExitProblem(symbol,"Không hủy được lệnh thoát cũ trước khi đóng."); }
        const closed=await closePosition(symbol,liveSide,Math.abs(Number(livePos.positionAmt)));
        if(!closed){ await alertRangeExitProblem(symbol,"Lệnh đóng chưa xác minh được trên sàn."); return {matched:true,closed:false,reason:"CLOSE_NOT_VERIFIED"}; }
        console.log(`✅ ${symbol} position closed; PnL will be reconciled and reported by trade monitor`);
        return {matched:true,closed:true,trade:openTrade};
    }catch(e){
        console.log(`🚨 RANGE EXIT MONITOR ERROR ${symbol}: ${e?.message||e}`);
        await alertRangeExitProblem(symbol,e?.message||"Monitor error");
        return {matched:true,closed:false,reason:"MONITOR_ERROR"};
    }finally{
        delete RANGE_EXIT_LOCK[symbol];
    }
}

async function monitorOpenRangeFlipsOnce(){
    POS_CACHE=null; POS_CACHE_TIME=0;
    const positions=await getPositionsCached();
    if(!Array.isArray(positions)) throw new Error("Binance positions response invalid");
    const symbols=[...new Set([
        ...activeTrades.filter(t=>t?.result==="PENDING").map(t=>t.symbol),
        ...positions.filter(p=>Math.abs(Number(p.positionAmt||0))>0).map(p=>p.symbol)
    ].filter(Boolean))];
    for(let i=0;i<symbols.length;i+=5){
        const batch=symbols.slice(i,i+5);
        await Promise.all(batch.map(async symbol=>{
            try{
                const data5=await Promise.race([
                    getData(symbol,"5m",RF_FETCH_COUNT),
                    new Promise((_,reject)=>setTimeout(()=>reject(new Error("5m data timeout")),12000))
                ]);
                if(!data5) throw new Error("5m data empty");
                RANGE_EXIT_DATA_FAILS[symbol]=0;
                const candles=prepare(data5,RF_CANDLE_COUNT);
                if(!candles) throw new Error("5m candles insufficient for Range Filter");
                const rf=rangeFilter(candles,{
                    filterType:"Type 1", movementSource:"Close",
                    rangeSize:2.618, rangeScale:"Average Change", rangePeriod:14,
                    smoothRange:true, smoothPeriod:27,
                    averageFilterChanges:false, averageChanges:2
                });
                const i=candles.length-1;
                const direction=rf.direction[i];
                const indicatorSide=direction===1?"LONG":direction===-1?"SHORT":null;
                if(!indicatorSide) return;
                const livePos=positions.find(p=>p.symbol===symbol&&Math.abs(Number(p.positionAmt||0))>0);
                if(!livePos) return;
                const liveSide=Number(livePos.positionAmt)>0?"LONG":"SHORT";
                if(liveSide!==indicatorSide){
                    await closeOpenPositionOnRangeFlip({symbol,side:indicatorSide,isFlip:true,flipTime:candles[i].t});
                }
            }catch(e){
                RANGE_EXIT_DATA_FAILS[symbol]=(RANGE_EXIT_DATA_FAILS[symbol]||0)+1;
                console.log(`⚠ OPEN POSITION WATCH RETRY ${symbol} ${RANGE_EXIT_DATA_FAILS[symbol]}: ${e?.message||e}`);
                if(RANGE_EXIT_DATA_FAILS[symbol]>=3) await alertRangeExitProblem(symbol,`Không đọc được nến Range Filter ${RANGE_EXIT_DATA_FAILS[symbol]} lần liên tiếp.`);
            }
        }));
    }
}

async function rangeExitMonitorLoop(){
    console.log("🟢 INDEPENDENT RANGE EXIT MONITOR STARTED (10s cycle)");
    while(true){
        try{ await monitorOpenRangeFlipsOnce(); }
        catch(e){ console.log(`🚨 RANGE EXIT MONITOR CYCLE FAIL: ${e?.message||e}`); await alertRangeExitProblem("ALL OPEN POSITIONS",e?.message||"Binance position check failed"); }
        await new Promise(r=>setTimeout(r,10000));
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
        const cooldownLeft = NEXT_ENTRY_ALLOWED_AT - Date.now();

if (cooldownLeft > 0) {
  console.log(`⏳ ENTRY COOLDOWN: ${Math.ceil(cooldownLeft / 60000)} phút; still checking Range Filter flips`);
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

        // Keep every open position in the scan universe, even if it dropped out of the top 80.
        const trackedSymbols = activeTrades.filter(t=>t?.result==="PENDING").map(t=>t.symbol).filter(Boolean);
        try {
            POS_CACHE=null; POS_CACHE_TIME=0;
            const exchangePositions=await getPositionsCached();
            for(const pos of exchangePositions||[]) if(pos?.symbol&&Math.abs(Number(pos.positionAmt||0))>0) trackedSymbols.push(pos.symbol);
        } catch(e) {
            console.log(`⚠ OPEN POSITION SYMBOL REFRESH FAIL: ${e.message}`);
        }
        symbols=[...new Set([...symbols,...trackedSymbols])];
        if(symbols && symbols.length > 0){
            console.log(`✅ Using ${symbols.length} symbols (top list + open-position monitoring)`)
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

// Process confirmed flips for open positions before candidate ranking/entry filters.
const justClosedOnFlip = new Set();
for(const flip of signals){
    const exitResult=await closeOpenPositionOnRangeFlip(flip);
    if(exitResult?.matched||exitResult?.inProgress){
        justClosedOnFlip.add(flip.symbol);
        if(!exitResult.closed&&!exitResult.inProgress) console.log(`⚠ ${flip.symbol} exit pending retry: ${exitResult.reason||"unknown"}`);
    }
}
signals=signals.filter(s=>!justClosedOnFlip.has(s.symbol));
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
// Range Filter entries are confirmed flips; no RR/TP/SL filter applies.
let filtered = candidates.slice().sort((a,b) =>
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
// Put live-position flips first so they are not delayed behind new entries.
filtered.sort((a,b) => {
  const aOpen = activeTrades.some(t => t.symbol === a.symbol && t.result === "PENDING") ? 1 : 0;
  const bOpen = activeTrades.some(t => t.symbol === b.symbol && t.result === "PENDING") ? 1 : 0;
  return bOpen - aOpen || (Number(b.rankScore) || 0) - (Number(a.rankScore) || 0);
});
const picks = filtered.slice(0, 3);
for (const best of picks) {
  const existing = await trades.findOne({symbol:best.symbol,result:"PENDING"});
  if(!existing){
    const handledFlip=await trades.findOne({symbol:best.symbol,closeFlipTime:Number(best.flipTime)});
    if(handledFlip){ console.log(`⏭ ${best.symbol} flip ${best.flipTime} already handled; waiting for a fresh signal`); continue; }
  }
  const replacingExisting = Boolean(existing);
  let positions;
  try { POS_CACHE=null; POS_CACHE_TIME=0; positions=await getPositionsCached(); }
  catch(e){ console.log(`⚠ POSITION CHECK FAIL ${best.symbol}: ${e.message}`); continue; }
  let realPos = positions.find(p => p.symbol===best.symbol && Math.abs(Number(p.positionAmt||0))>0);
  if(existing){
    if(!realPos){ console.log(`⏳ ${best.symbol} DB pending but no exchange position; wait reconciliation`); continue; }
    const realSide=Number(realPos.positionAmt)>0?'LONG':'SHORT';
    if(realSide===best.side){ console.log(`⏭ ${best.symbol} already ${realSide}; no duplicate`); continue; }
    if(best.isFlip!==true){ console.log(`⛔ ${best.symbol} opposite side without a confirmed Range Filter flip`); continue; }
    console.log(`🔁 RANGE FLIP ${best.symbol}: ${realSide} -> ${best.side}; clearing legacy exits and closing first`);
    if(!await clearSymbolOrders(best.symbol)){ console.log(`🚨 REVERSAL ABORT ${best.symbol}: legacy exits could not be cleared`); continue; }
    const closed=await closePosition(best.symbol,realSide,Math.abs(Number(realPos.positionAmt)));
    if(!closed){ console.log(`🚨 REVERSAL ABORT ${best.symbol}: close not verified`); continue; }
    const closeInfo=await getClosedTradeResult(existing);
    const closedAt=Number(closeInfo?.closedAt)||Date.now();
    const updateQuery=existing._id?{_id:existing._id}:{symbol:best.symbol,result:"PENDING"};
    const updateSet={result:closeInfo?(closeInfo.pnl>0?"WIN":"LOSS"):"REVERSED",closedAt,closeReason:"RANGE_FILTER_FLIP",closeFlipTime:Number(best.flipTime)};
    if(closeInfo){updateSet.pnl=closeInfo.pnl;updateSet.exitOrderId=closeInfo.exitOrderId;}
    try { const dbUpdate=await trades.updateOne(updateQuery,{$set:updateSet}); if(existing._id && Number(dbUpdate?.matchedCount||0)<1){ console.log(`🚨 REVERSAL DB UPDATE MATCHED NO TRADE ${best.symbol}; opposite entry blocked`); continue; } }
    catch(e){ console.log(`🚨 REVERSAL DB UPDATE FAIL ${best.symbol}: ${e.message}`); continue; }
    activeTrades=activeTrades.filter(t=>!(t.symbol===best.symbol&&t.result==="PENDING"));
    POS_CACHE=null;POS_CACHE_TIME=0;
    try { positions=await getPositionsCached(); } catch(e){ console.log(`🚨 POST-CLOSE POSITION CHECK FAIL ${best.symbol}`); continue; }
    realPos=positions.find(p=>p.symbol===best.symbol&&Math.abs(Number(p.positionAmt||0))>0);
    if(realPos){ console.log(`🚨 ${best.symbol} still has a position after close; do not open opposite`); continue; }
    console.log(`✅ ${best.symbol} closed on Range Filter flip; waiting for a fresh signal (no reverse entry)`);
    continue;
  } else if(realPos){
    console.log(`⛔ ${best.symbol} exchange position exists without matching pending record; wait orphan recovery`);
    continue;
  }
  if(cooldownLeft>0&&!replacingExisting){ console.log(`⏳ Skip new entry ${best.symbol} during cooldown`); continue; }
  const realActive=positions.filter(p=>Math.abs(Number(p.positionAmt||0))>0).length;
  if(!replacingExisting&&realActive>=TRADE_CONFIG.maxActivePositions){ console.log(`⚠️ MAX REAL ACTIVE: ${realActive}`); continue; }
  let totalPending=0;
  try { totalPending=await trades.countDocuments({result:"PENDING"}); } catch(e){ console.log("⚠ COUNT PENDING FAIL"); }
  if(!replacingExisting&&totalPending>=100){ console.log(`⚠️ MAX TOTAL PENDING: ${totalPending}`); continue; }
  console.log(`⚡ INSTANT ENTRY ${best.symbol}`);
  // This strategy has no stop distance; size by the existing notional allocation cap.
  // =====================================================
// POSITION SIZE
// CAPITAL ALLOCATION = SAME BASELINE SCANNER
// NO TP/SL — THIS STRATEGY USES NOTIONAL SIZING
// =====================================================
const balance = ACCOUNT_BALANCE;

const positionBudget =
    balance * TRADE_CONFIG.maxPositionPercent;

console.log(
    `🧮 CAPITAL CALC ${best.symbol} | ` +
    `balance=${balance} | ` +
    `maxPositionPercent=${TRADE_CONFIG.maxPositionPercent} | ` +
    `positionBudget=${positionBudget}`
);

const trade =
    buildTradeFromCoreSignal(
        best,
        btcRegime,
        positionBudget
    );

if(!trade){
    console.log(
        `🚫 FILTER BUILD TRADE: ${best.symbol}`
    );
    continue;
}

if(
    !(balance > 0) ||
    !(best.price > 0) ||
    !Number.isFinite(balance) ||
    !Number.isFinite(best.price)
){
    console.log(
        `❌ INVALID BALANCE/PRICE ${best.symbol}`
    );
    continue;
}


// =====================================================
// SYMBOL INFO
// =====================================================

let info =
    await getSymbolInfo(trade.symbol);

if(!info || !info.filters){

    console.log(
        `🚫 SYMBOL INFO FAIL: ${best.symbol}`
    );

    continue;
}


// =====================================================
// BINANCE LOT SIZE
// =====================================================

let lotFilter =
    info.filters.find(
        f => f.filterType === "MARKET_LOT_SIZE"
    ) ||
    info.filters.find(
        f => f.filterType === "LOT_SIZE"
    );


// =====================================================
// BINANCE NOTIONAL
// =====================================================

let minNotionalFilter =
    info.filters.find(
        f => f.filterType === "NOTIONAL"
    ) ||
    info.filters.find(
        f => f.filterType === "MIN_NOTIONAL"
    );


const stepSize =
    parseFloat(
        lotFilter?.stepSize || 0.001
    );

const minQty =
    parseFloat(
        lotFilter?.minQty || 0
    );

const minNotional =
    Number(
        minNotionalFilter?.minNotional ??
        minNotionalFilter?.notional ??
        0
    );


if(
    !(stepSize > 0) ||
    !Number.isFinite(stepSize)
){

    console.log(
        `❌ INVALID STEP SIZE ${best.symbol}`
    );

    continue;
}
// =====================================================
// NORMAL SIZE
// =====================================================
let targetNotional =
    positionBudget;

// =====================================================
// BUILD INITIAL QTY
// =====================================================
let qty =
    targetNotional / best.price;

if(
    !Number.isFinite(qty) ||
    qty <= 0
){
    console.log(
        `❌ QTY INVALID ${best.symbol} | ` +
        `budget=${targetNotional} | ` +
        `price=${best.price}`
    );
    continue;
}

qty = normalizeQtyFinal(
    Math.floor(qty / stepSize) * stepSize,
    stepSize
);

notional =
    qty * best.price;

// =====================================================
// FINAL MIN QTY CHECK
// =====================================================
if(
    minQty > 0 &&
    qty < minQty
){
    console.log(
        `❌ MIN QTY FAIL ${best.symbol} | ` +
        `qty=${qty} < minQty=${minQty} | ` +
        `step=${stepSize}`
    );

    continue;
}

// =====================================================
// CHECK MIN QTY AGAIN
// =====================================================

if(
    minQty > 0 &&
    qty < minQty
){

    console.log(
        `❌ MIN QTY FAIL ${best.symbol} | ` +
        `qty=${qty} < minQty=${minQty} | ` +
        `step=${stepSize}`
    );

    continue;
}
// =====================================================
// CHECK MIN NOTIONAL AGAIN
// =====================================================
if(
    minNotional > 0 &&
    notional < minNotional
){
    console.log(
        `❌ MIN NOTIONAL FAIL ${best.symbol} | ` +
        `notional=${notional.toFixed(6)} < ` +
        `min=${minNotional} | ` +
        `budget=${positionBudget.toFixed(6)}`
    );

    continue;
}

// =====================================================
// FINAL VALIDATION
// =====================================================

if(
    !Number.isFinite(qty) ||
    !Number.isFinite(notional) ||
    qty <= 0 ||
    notional <= 0
){

    console.log(
        `❌ FINAL POSITION SIZE INVALID ${best.symbol}`
    );

    continue;
}


// =====================================================
// LOG FINAL SIZE
// =====================================================

console.log(
    `💰 SIZE ${best.symbol} | ` +
    `budget=${positionBudget.toFixed(4)} | ` +
    `final=${notional.toFixed(4)} USDT | ` +
    `qty=${qty} | ` +
    `minQty=${minQty} | ` +
    `minNotional=${minNotional}`
);

    // ===== OPENING LOCK =====
    if(OPENING_POSITIONS[trade.symbol]){ console.log(`⛔ OPENING LOCK ${trade.symbol}`); continue; }
    OPENING_POSITIONS[trade.symbol]=true;
    try{
      const order=await openPosition(trade.symbol,trade.side,qty);
      POS_CACHE=null;POS_CACHE_TIME=0;
      let realPosition=await waitPosition(trade.symbol);
      if(!realPosition) realPosition=await hasPosition(trade.symbol);
      if(!realPosition){ console.error(`❌ ENTRY NOT CONFIRMED ${trade.symbol}: ${order?.status||order?.reason||'no position'}`); continue; }
      const realSide=Number(realPosition.positionAmt)>0?'LONG':'SHORT';
      if(realSide!==trade.side){ console.error(`🚨 ENTRY SIDE MISMATCH ${trade.symbol}: wanted ${trade.side}, got ${realSide}`); continue; }
      trade.entry=Number(realPosition.entryPrice)||best.price;
      trade.price=trade.entry;
      trade.quantity=Math.abs(Number(realPosition.positionAmt));
      trade.notional=trade.quantity*trade.entry;
      trade.enteredAt=Date.now();trade.openedAt=trade.enteredAt;trade.updatedAt=trade.enteredAt;
      NEXT_ENTRY_ALLOWED_AT=Date.now()+ENTRY_COOLDOWN_MS;
      let insertResult;
      try{
        if(!await ensureDB()) throw new Error("MONGODB OFFLINE AFTER ENTRY");
        insertResult=await trades.insertOne(trade);
        if(!insertResult?.insertedId) throw new Error(`DB INSERT FAILED ${trade.symbol}`);
        trade._id=insertResult.insertedId;trade.dbSaveFailed=false;trade.dbRecoveryNeeded=false;
        activeTrades.push(trade);
        console.log(`💾 DB SAVED ${trade.symbol} SIDE=${trade.side} ENTRY=${trade.entry} QTY=${trade.quantity}`);
      }catch(dbErr){
        console.error(`🚨 DB SAVE FAIL ${trade.symbol}:`,dbErr?.message||dbErr);
        activeTrades.push({...trade,dbSaveFailed:true,dbRecoveryNeeded:true});
      }
        const msg=`🔥 RANGE \n\n📊 ${trade.symbol}\n📈 ${trade.side}\n🎯 Entry: ${trade.entry}\n📦 Position: ${safeFixed(trade.notional,2)} USDT\n🧭 Wait.`

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
    getData(t.symbol,"5m",2),
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

    activeTrades.splice(i,1)

    continue
}

// Position remains open; the scanner closes it on a confirmed Range Filter flip.
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

        activeTrades.splice(i,1)

        continue
    }

    // ===== KHÔNG CÓ RESULT =====

    CLOSED_RESULT_FAILS[t.symbol] =
        (CLOSED_RESULT_FAILS[t.symbol] || 0) + 1

    console.log(
        `⏳ CLOSED RESULT NOT FOUND ${t.symbol} ` +
        `${CLOSED_RESULT_FAILS[t.symbol]}/10`
    )

    // Cho Binance/API thêm thời gian
        if(CLOSED_RESULT_FAILS[t.symbol] < 5){
            continue
        }

    // ===== ORPHAN =====

    console.log(
        `🧹 CLEAR ORPHAN TRADE ${t.symbol}`
    )

    const unresolvedQuery=t._id?{_id:t._id,result:"PENDING"}:{symbol:t.symbol,createdAt:t.createdAt,result:"PENDING"};
    await trades.updateOne(
        unresolvedQuery,
        {
            $set:{
                result:"CLOSED_UNRESOLVED",
                closedAt:Date.now(),
                debugReason:
                    "NO_POSITION_AFTER_VERIFY_AND_NO_CLOSED_RESULT"
            }
        }
    )

    await sendTelegram2(
        `⚠️ ${t.symbol} vị thế đã đóng .`
    )

    delete CLOSED_RESULT_FAILS[t.symbol]
    delete DATA_FAILS[t.symbol]

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

        activeTrades.push(
            dbTrade
        )
    }

    console.log(
        `♻️ RECOVER DB TRADE ${symbol} → ACTIVE UNTIL RANGE FLIP`
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
// Position remains active until a confirmed Range Filter flip.
// ==========================================

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
                // Keep the recovered live position tracked in RAM.
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
// 9. LOAD PENDING TRADES TỪ DB
// ==================================================

activeTrades =
    await trades.find({
        result: "PENDING"
    }).toArray()

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
        // 10. LOAD BINANCE SYMBOLS
        // ==================================================
        await loadValidFuturesSymbols()
        console.log(
            "🟢 FUTURES SYMBOLS READY"
        )
        // Remove legacy TP/SL orders left by the old bot version.
        for(const trade of activeTrades){
            if(trade?.symbol&&trade.result==="PENDING"){
                const cleared=await clearSymbolOrders(trade.symbol);
                if(!cleared) throw new Error(`Không xóa được lệnh thoát cũ của ${trade.symbol}`);
            }
        }
        // ==================================================
        rangeExitMonitorLoop()
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
                    // Reconcile exchange positions with MongoDB.
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
