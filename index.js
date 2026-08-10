let DB_READY = false
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

    try{
        let existingPos = await hasPosition(symbol)

if(existingPos){

    console.log(`⛔ SKIP OPEN ${symbol}: POSITION EXISTS`)

    return null
}
let openOrders = await binance.futuresOpenOrders({
    symbol,
    recvWindow:20000
})

let pendingMarket = openOrders.find(o =>
    o.type === "MARKET"
)

if(pendingMarket){

    console.log(`⛔ MARKET ORDER EXISTS ${symbol}`)

    return null
}
         let info = await getSymbolInfo(symbol)

        let lotFilter = info.filters.find(
            f => f.filterType === "LOT_SIZE"
        )

        let stepSize = parseFloat(
            lotFilter?.stepSize || 0.001
        )

        // ===== NORMALIZE FINAL =====
        qty = normalizeQtyFinal(qty, stepSize)

        if(!qty || qty <= 0 || !isFinite(qty)){
            console.log("❌ INVALID FINAL QTY")
            return null
        }

        const baseUrl = "https://fapi.binance.com"
        const path = "/fapi/v1/order"

        // 🔥 FIX TIME
        const timestamp = getTimestamp()

const query =
    `symbol=${symbol}` +
    `&side=${side === "LONG" ? "BUY" : "SELL"}` +
    `&type=MARKET` +
    `&quantity=${qty}` +
    `&timestamp=${timestamp}` +
    `&recvWindow=10000`

        const signature = crypto
            .createHmac("sha256", process.env.BINANCE_SECRET)
            .update(query)
            .digest("hex")

        const url = `${baseUrl}${path}?${query}&signature=${signature}`

        let res = await safeFetch(url, {
            method: "POST",
            headers: {
                "X-MBX-APIKEY": process.env.BINANCE_KEY
            }
        })

        if(!res || !res.ok){
            console.log("❌ ORDER HTTP FAIL", res?.status)
            return null
        }

        let data = await res.json()
        if(
    data.code === -1021 ||
    String(data.msg || "").includes("Timestamp")
){
    console.log("🕒 BINANCE RESYNC")

    await syncTime()

    return null
}
        POS_CACHE = null
POS_CACHE_TIME = 0

        if(data.code){
            console.log("❌ BINANCE REJECT:", data)
            return null
        }

        // ===== WAIT FILL =====
if(data.status !== "FILLED"){

    let verifyPos = await waitPosition(symbol)

    if(verifyPos){

        console.log(`✅ POSITION EXISTS ${symbol}`)

        data.status = "FILLED"

    }else{

        console.log(`⏳ WAIT FILL ${symbol}: ${data.status}`)
    }

    for(let i = 0; i < 10; i++){

        await new Promise(r => setTimeout(r, 800))

        try{

            let check = await binance.futuresGetOrder({
                symbol,
                orderId: data.orderId,
                recvWindow: 60000
            })

            if(check.status === "FILLED"){

                data = check

                console.log(`✅ FILLED ${symbol}`)

                break
            }

            // cancel nếu quá lâu
            if(
                check.status === "CANCELED" ||
                check.status === "REJECTED" ||
                check.status === "EXPIRED"
            ){
                console.log(`❌ ORDER DEAD ${symbol}`)
                return null
            }

        }catch(e){
            await checkTimeError(e)
            console.log(`❌ CHECK ORDER ${symbol}:`, e.message)
        }
    }
}

// ===== FINAL VERIFY =====
if(data.status !== "FILLED"){
    

    console.log(`❌ NOT FILLED FINAL ${symbol}`)

    return null
}

        return data

    }catch(e){
        await checkTimeError(e)
        console.log("❌ OPEN ORDER FAIL:", e.message)
        return null
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
async function setTPSLAndVerify(trade){

    let pos = await waitPosition(
        trade.symbol
    )

    if(!pos){
        return false
    }

    let closeSide =
        Number(pos.positionAmt) > 0
            ? "SELL"
            : "BUY"
            let info =
    await getSymbolInfo(
        trade.symbol
    )

let priceFilter =
    info.filters.find(
        f => f.filterType === "PRICE_FILTER"
    )

let tickSize =
    parseFloat(
        priceFilter?.tickSize || "0.01"
    )

let sl =
    normalizePrice(
        trade.sl,
        tickSize
    )

let tp =
    normalizePrice(
        trade.tp,
        tickSize
    )

    try{

        await cancelAllOrders(
            trade.symbol
        )

        console.log(`SET SL ${trade.symbol}`)

let slRes =
    await binance.futuresOrder({

        symbol: trade.symbol,
        side: closeSide,
        type: "STOP_MARKET",

        stopPrice: sl,

        closePosition: true,

        workingType: "MARK_PRICE",

        recvWindow: 20000
    })

console.log(
    "SL RESPONSE:",
    JSON.stringify(slRes,null,2)
)

        console.log(`SET TP ${trade.symbol}`)

let tpRes =
    await binance.futuresOrder({

        symbol: trade.symbol,
        side: closeSide,
        type: "TAKE_PROFIT_MARKET",

        stopPrice: tp,

        closePosition: true,

        workingType: "MARK_PRICE",

        recvWindow: 20000
    })

console.log(
    "TP RESPONSE:",
    JSON.stringify(tpRes,null,2)
)

        await new Promise(r =>
            setTimeout(r,3000)
        )

        return {
    ok: true
}
    }catch(e){

    await checkTimeError(e)

    console.log(
        `TPSL FAIL ${trade.symbol}`,
        e.message
    )

    return false
}
}
async function openPositionWithTPSL(
    trade,
    qty
){

    let order = await openPosition(
        trade.symbol,
        trade.side,
        qty
    )

    if(!order){
        return false
    }

    let pos = await waitPosition(
        trade.symbol
    )

    if(!pos){

        let verifyPos =
            await hasPosition(
                trade.symbol
            )

        if(verifyPos){
            pos = verifyPos
        }else{
            return false
        }
    }

    TPSL_PENDING[trade.symbol] = true

    try{

        await new Promise(r =>
            setTimeout(r,3000)
        )

        let tpslResult = await setTPSLAndVerify(trade)

if(!tpslResult?.ok){

            console.log(
                `🚨 TPSL FAIL -> CLOSE ${trade.symbol}`
            )

            let realQty =
                Math.abs(
                    Number(
                        pos.positionAmt
                    )
                )

            let closed =
                await closePosition(
                    trade.symbol,
                    trade.side,
                    realQty
                )

            if(!closed){

                console.log(
                    `🚨 CLOSE FAIL ${trade.symbol}`
                )

                await sendTelegram2(
`🚨 CRITICAL
${trade.symbol}
TPSL FAIL
CLOSE FAIL`
                )
            }

            return false
        }

        return {
    ok: true
}

    }finally{

        delete TPSL_PENDING[trade.symbol]

    }
}
async function cancelAllOrders(symbol){

    try{

        await binance.futuresCancelAllOpenOrders({
            symbol,
            recvWindow: 20000
        })
        for(let i=0;i<35;i++){

    let openOrders =
        await binance.futuresOpenOrders({
    symbol,
    recvWindow: 20000
})

    if(openOrders.length === 0){
        break
    }

    await new Promise(r =>
        setTimeout(r, 1500)
    )
}

        console.log(`🗑 CANCEL OLD TPSL ${symbol}`)

    }catch(e){
        await checkTimeError(e)
        console.log(`❌ CANCEL TPSL ${symbol}:`, e.message)
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
        return change >= 1 && change <= 15 // 
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

    let volA = Number(a.quoteVolume)
    let volB = Number(b.quoteVolume)

    let moveA = Math.abs(Number(a.priceChangePercent))
    let moveB = Math.abs(Number(b.priceChangePercent))

    // ưu tiên move đẹp quanh 3-5%
    let scoreA =
        (volA / 1_000_000) -
        Math.abs(moveA - 5) * 4

    let scoreB =
        (volB / 1_000_000) -
        Math.abs(moveB - 5) * 4

    return scoreB - scoreA
})
    .slice(0, 100)
.map(c => c.symbol)
.filter(s =>
    validFuturesSymbols &&
    validFuturesSymbols.size > 0 &&
    validFuturesSymbols.has(s)
)
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
    slope1h > 0

const bear1h =
    ema20_1h < ema50_1h &&
    price1h < ema20_1h &&
    slope1h < 0

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
    slope15 > 0

const bear15 =
    ema20_15 < ema50_15 &&
    price15 < ema20_15 &&
    slope15 < 0

    // Không bắt buộc 1H + 15M cùng hướng.
    // Chỉ tạo bias.

    let longBias = 0
    let shortBias = 0

    if(bull1h) longBias += 3
    if(bear1h) shortBias += 3

    if(bull15) longBias += 3
    if(bear15) shortBias += 3

    if(slope15 > 0) longBias += 1
    if(slope15 < 0) shortBias += 1

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
    l5.at(-2) <= ema20_5*1.006 &&
    c0 > cPrev

const pullbackShort =
    p5 < ema20_5 &&
    ema20_5 < ema50_5 &&
    h5.at(-2) >= ema20_5*0.994 &&
    c0 < cPrev

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
        c5.at(-1) > c5.at(-2) &&
        c5.at(-2) > c5.at(-3) &&
        slope9_5 > 0 &&
        c0 > cPrev

    const momentumShort =
        c5.at(-1) < c5.at(-2) &&
        c5.at(-2) < c5.at(-3) &&
        slope9_5 < 0 &&
        c0 < cPrev

    // ================= 1M CONFIRMATION =================

    const confirmLong =
(
    microBreakLong ||
    sweepLow ||
    reclaimEmaLong ||
    retestLong ||
    pullbackLong
) &&
c0 > o0 &&
br0 >= 0.40 &&
closeLong(h0,l0,c0) >= 0.58

const confirmShort =
(
    microBreakShort ||
    sweepHigh ||
    reclaimEmaShort ||
    retestShort ||
    pullbackShort
) &&
c0 < o0 &&
br0 >= 0.40 &&
closeShort(h0,l0,c0) >= 0.58

    // ================= SETUP SELECTION =================

    let longSetup = null
    let shortSetup = null

    // Ưu tiên setup có structure rõ hơn.

    if(sweepLow && confirmLong){
        longSetup = "SWEEP_RECLAIM"
    }
    else if(retestLong && confirmLong){
        longSetup = "BREAKOUT_RETEST"
    }
    else if(pullbackLong && confirmLong){
        longSetup = "PULLBACK_RECLAIM"
    }
    else if(momentumLong && confirmLong){
        longSetup = "MOMENTUM_CONTINUATION"
    }

    if(sweepHigh && confirmShort){
        shortSetup = "SWEEP_RECLAIM"
    }
    else if(retestShort && confirmShort){
        shortSetup = "BREAKOUT_RETEST"
    }
    else if(pullbackShort && confirmShort){
        shortSetup = "PULLBACK_RECLAIM"
    }
    else if(momentumShort && confirmShort){
        shortSetup = "MOMENTUM_CONTINUATION"
    }

    // ================= SIDE =================

    // ================= SIDE =================

let side = null
let setup = null

// Ưu tiên hướng có context lớn hơn.
// 1M/5M chỉ dùng để xác nhận entry,
// không được tự ý đảo hướng 15M/1H.

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

    if(longBias > shortBias && longBias >= 2){
        side = "LONG"
        setup = longSetup
    }
    else if(shortBias > longBias && shortBias >= 2){
        side = "SHORT"
        setup = shortSetup
    }
    else{
        return null
    }
}

if(!side){
    return null
}
// ================= HARD DIRECTION FILTER =================

// Không LONG khi cả 1H + 15M đều bearish
if(
    side === "LONG" &&
    bear1h &&
    bear15
){
    return null
}

// Không SHORT khi cả 1H + 15M đều bullish
if(
    side === "SHORT" &&
    bull1h &&
    bull15
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

    // Context
    if(side === "LONG"){
        if(bull1h) score += 8
        if(bull15) score += 8
        if(slope15 > 0) score += 4
    }else{
        if(bear1h) score += 8
        if(bear15) score += 8
        if(slope15 < 0) score += 4
    }

    // Setup quality
    if(setup === "SWEEP_RECLAIM"){
    score += 18
}

if(setup === "BREAKOUT_RETEST"){
    score += 15
}

if(setup === "PULLBACK_RECLAIM"){
    score += 7
}

if(setup === "MOMENTUM_CONTINUATION"){
    score += 9
}

    // Entry quality
    if(side === "LONG" && microBreakLong){
        score += 8
    }

    if(side === "SHORT" && microBreakShort){
        score += 8
    }

    if(side === "LONG" && sweepLow){
        score += 8
    }

    if(side === "SHORT" && sweepHigh){
        score += 8
    }

    if(br0 >= 0.55){
        score += 5
    }

    // Volume = bonus, không phải gate
    if(vol1Ratio >= 1.5 || vol5Ratio >= 1.5){
        score += 6
    }
    else if(vol1Ratio >= 1.15 || vol5Ratio >= 1.15){
        score += 3
    }
    if(
    vol1Ratio < 0.55 &&
    vol5Ratio < 0.65
){
    score -= 5
}

    // RSI context
    if(side === "LONG"){

    if(rsi5 >= 48 && rsi5 <= 68){
        score += 4
    }

    if(rsi5 > 72){
        score -= 5
    }

}else{

    if(rsi5 <= 52 && rsi5 >= 32){
        score += 4
    }

    if(rsi5 < 28){
        score -= 5
    }
}
if(Math.abs(move5) > 0.025){
    score -= 5
}

    // Score thấp chỉ bỏ setup thực sự yếu.
    if(score < 65){
        return null
    }
    
if(
    side === "LONG" &&
    move5 > 0.018 &&
    !sweepLow &&
    !retestLong
){
    return null
}

if(
    side === "SHORT" &&
    move5 < -0.018 &&
    !sweepHigh &&
    !retestShort
){
    return null
}
// ================= QUALITY =================

let quality = 0

// Direction
if(side === "LONG"){
    if(bull15) quality += 2
    if(bull1h) quality += 1
    if(slope15 > 0) quality += 1
}else{
    if(bear15) quality += 2
    if(bear1h) quality += 1
    if(slope15 < 0) quality += 1
}

// Setup
if(setup === "SWEEP_RECLAIM"){
    quality += 2
}

if(setup === "BREAKOUT_RETEST"){
    quality += 2
}

if(setup === "PULLBACK_RECLAIM"){
    quality += 1
}

if(setup === "MOMENTUM_CONTINUATION"){
    quality += 1
}

// Candle
if(br0 >= 0.55){
    quality += 1
}

if(side === "LONG" && closeLong(h0,l0,c0) >= 0.65){
    quality += 1
}

if(side === "SHORT" && closeShort(h0,l0,c0) >= 0.65){
    quality += 1
}

if(quality < 3){
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

    // ================= RISK =================

    let sl = null
    let risk = null
    let tp = null

    if(side === "LONG"){

        sl =
            Math.min(
                microLow,
                structureLow,
                sweepLow ? l0 : Infinity
            )

        // Buffer nhỏ theo ATR 1M
        sl -= atr1*0.35

        if(sl >= entry){
            return null
        }

        risk = entry-sl

        // Không cho SL quá rộng đối với scalp
        if(risk > atr5*1.10){
            return null
        }

        // Không cho SL quá nhỏ vì dễ bị noise
        if(risk < atr1*0.45){
            sl = entry-atr1*0.45
            risk = entry-sl
        }

        tp = entry + risk*1.35

    }else{

        sl =
            Math.max(
                microHigh,
                structureHigh,
                sweepHigh ? h0 : -Infinity
            )

        sl += atr1*0.35

        if(sl <= entry){
            return null
        }

        risk = sl-entry

        if(risk > atr5*1.10){
            return null
        }

        if(risk < atr1*0.45){
            sl = entry+atr1*0.45
            risk = sl-entry
        }

        tp = entry-risk*1.35
    }

    if(!risk || risk <= 0){
        return null
    }

    // ================= NEAREST STRUCTURE =================

    const resistance =
        Math.max(
            ...h5.slice(-12,-1)
        )

    const support =
        Math.min(
            ...l5.slice(-12,-1)
        )

    // Nếu target đâm thẳng vào structure quá gần,
    // không trade.

    if(side === "LONG"){

        if(
            resistance > entry &&
            resistance < tp
        ){
            const available =
                resistance-entry

            if(
                available/risk < 1.10
            ){
                return null
            }

            tp = resistance
        }

    }else{

        if(
            support < entry &&
            support > tp
        ){
            const available =
                entry-support

            if(
                available/risk < 1.10
            ){
                return null
            }

            tp = support
        }
    }

    // ================= FINAL RR =================

    const finalRR =
        side === "LONG"
            ? (tp-entry)/risk
            : (entry-tp)/risk

    if(finalRR < RR_THRESHOLD){
        return null
    }

    // TP không quá xa đối với short-term
    if(
        Math.abs(tp-entry) > atr5*1.9
    ){
        return null
    }

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

for(let i=0;i<symbols.length;i+=10){

    let chunk = symbols.slice(i,i+10)

    let r = []

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

    await new Promise(r=>setTimeout(r,300))
}

        let signals = results
            .filter(r => r.status === "fulfilled" && r.value)
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
        trade.enteredAt = Date.now()

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

    insertResult =
        await trades.insertOne(trade)

    trade._id =
        insertResult.insertedId

    console.log(
        `💾 DB SAVED ${trade.symbol}`
    )

}catch(dbErr){

    DB_READY = false

    console.error(
        `🚨 CRITICAL DB SAVE FAIL ${trade.symbol}:`,
        dbErr?.message || dbErr
    )

    // Binance đã mở position nhưng DB chưa lưu.
    // KHÔNG được coi như entry thất bại.

    activeTrades.push({
        ...trade,
        dbSaveFailed: true
    })

    console.log(
        `🚨 ${trade.symbol} ACTIVE IN RAM — DB SAVE FAILED`
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

        const isWin = closed.pnl > 0

        await trades.updateOne(
            { _id:t._id },
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

        let pos = await hasPosition(symbol)

        if(!pos){
            return true
        }

        let closeSide =
            side === "LONG"
                ? "SELL"
                : "BUY"

        await binance.futuresOrder({

            symbol,
            recvWindow: 20000,
            side: closeSide,
            type: "MARKET",
            quantity: qty,
            reduceOnly: true
        })

        POS_CACHE = null
        POS_CACHE_TIME = 0

        // phần verify phía dưới giữ nguyên để đảm bảo position thật đã đóng, tránh trường hợp API lag hoặc lỗi mà DB đã update nhưng position vẫn còn

        // ===== VERIFY CLOSED =====
        for(let i=0;i<30;i++){

    await new Promise(r =>
        setTimeout(r, 2000)
    )

            let positions =
                await getPositionsCached()

            let pos = positions.find(p =>
                p.symbol === symbol &&
                Math.abs(parseFloat(p.positionAmt || "0")) > 0
            )

            if(!pos){

                return true
            }
        }

        return false

    }catch(e){
        await checkTimeError(e)
        console.log(
            `❌ FORCE CLOSE ${symbol}:`,
            e.message
        )

        return false
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
        console.log(
            `♻️ Load lại ${activeTrades.length} lệnh`
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

        let dbTrades =
            await trades.find({
                result:"PENDING"
            }).toArray()

        activeTrades = dbTrades

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
