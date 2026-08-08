let WATCHDOG_LAST_RUN = 0
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
const client = new MongoClient(process.env.MONGO_URI)
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

const RR_THRESHOLD = 1.2 // 1.3 hoặc 1.4 nếu muốn 

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
// ================= CORE LOGIC =================
async function coreLogic(data15, data1h){

    // Chỉ dùng nến đã đóng
    data15 = data15.slice(0, -1)
    data1h  = data1h.slice(0, -1)

    if(data15.length < 250 || data1h.length < 60){
        return null
    }

    // ================= DATA =================
    const opens   = data15.map(x => +x[1])
    const highs   = data15.map(x => +x[2])
    const lows    = data15.map(x => +x[3])
    const closes  = data15.map(x => +x[4])
    const volumes = data15.map(x => +x[5])

    const opens1h  = data1h.map(x => +x[1])
    const highs1h  = data1h.map(x => +x[2])
    const lows1h   = data1h.map(x => +x[3])
    const closes1h = data1h.map(x => +x[4])
    const volumes1h = data1h.map(x => +x[5])

    const price = closes.at(-1)

    if(!price || price <= 0) return null

    // ================= INDICATORS =================
    let atrVal = atr(data15.slice(-100))

    if(!atrVal || atrVal <= 0){
        atrVal = price * 0.003
    }

    const atrRatio = atrVal / price

    const ema20  = ema(closes.slice(-80),20)
    const ema50  = ema(closes.slice(-120),50)
    const ema200 = ema(closes.slice(-250),200)

    const ema20Prev = ema(closes.slice(-81,-1),20)
    const ema50Prev = ema(closes.slice(-121,-1),50)

    const ema20_1h = ema(closes1h.slice(-60),20)
    const ema50_1h = ema(closes1h.slice(-120),50)

    const ema20_1hPrev = ema(closes1h.slice(-61,-1),20)
    const ema50_1hPrev = ema(closes1h.slice(-121,-1),50)

    const r = rsi(closes.slice(-50))

    if(!Number.isFinite(r)) return null

    // Không bắt quá mua / quá bán
    if(r > 68 || r < 32){
        return null
    }

    // ================= CURRENT CANDLES =================
    const i = closes.length - 1

    const o0 = opens.at(-1)
    const h0 = highs.at(-1)
    const l0 = lows.at(-1)
    const c0 = closes.at(-1)

    const o1 = opens.at(-2)
    const h1 = highs.at(-2)
    const l1 = lows.at(-2)
    const c1 = closes.at(-2)

    const o2 = opens.at(-3)
    const h2 = highs.at(-3)
    const l2 = lows.at(-3)
    const c2 = closes.at(-3)

    const range0 = h0 - l0
    const body0 = Math.abs(c0 - o0)

    if(range0 <= 0 || body0 <= 0){
        return null
    }

    const bodyRatio = body0 / range0

    // ================= VOLUME =================
    const volWindow = volumes.slice(-20)

    const volAvg =
        volWindow.reduce((a,b)=>a+b,0) / volWindow.length

    const volNow = volumes.at(-1)

    const volRatio =
        volAvg > 0 ? volNow / volAvg : 0

    const volPrev =
        volumes.at(-2)

    // Dynamic minimum participation
    const volAvgUSDT = volAvg * price

    const dynamicMinVol =
        typeof getDynamicMinVol === "function"
            ? getDynamicMinVol(
                volAvgUSDT,
                price,
                atrRatio
              )
            : MIN_VOL_15M

    if(volAvgUSDT < dynamicMinVol){
        return null
    }

    // Không cho volume hiện tại quá yếu
    if(volRatio < 0.75){
        return null
    }

    // ================= 1H TREND ENGINE =================

    const h1Price = closes1h.at(-1)

    const h1Bull =
        ema20_1h > ema50_1h &&
        h1Price > ema20_1h &&
        ema20_1h > ema20_1hPrev &&
        ema50_1h >= ema50_1hPrev

    const h1Bear =
        ema20_1h < ema50_1h &&
        h1Price < ema20_1h &&
        ema20_1h < ema20_1hPrev &&
        ema50_1h <= ema50_1hPrev

    if(!h1Bull && !h1Bear){
        return null
    }

    // Khoảng cách EMA 1H phải có ý nghĩa
    const h1EmaGap =
        Math.abs(ema20_1h - ema50_1h) / h1Price

    if(h1EmaGap < 0.0008){
        return null
    }

    // ================= 15M TREND ENGINE =================

    const emaGap =
        Math.abs(ema20 - ema50) / price

    const emaSlope20 =
        ema20Prev !== 0
            ? (ema20 - ema20Prev) / ema20Prev
            : 0

    const emaSlope50 =
        ema50Prev !== 0
            ? (ema50 - ema50Prev) / ema50Prev
            : 0

    const bull15 =
        ema20 > ema50 &&
        ema20 > ema20Prev &&
        ema50 >= ema50Prev &&
        price > ema50

    const bear15 =
        ema20 < ema50 &&
        ema20 < ema20Prev &&
        ema50 <= ema50Prev &&
        price < ema50

    if(h1Bull && !bull15){
        return null
    }

    if(h1Bear && !bear15){
        return null
    }

    // Trend phải đủ rõ
    if(emaGap < 0.0008){
        return null
    }

    // ================= TREND STRENGTH =================

    const trendStrength =
        Math.abs(ema20 - ema50) / price

    if(trendStrength < 0.0012){
        return null
    }

    // ================= EMA DISTANCE =================

    const distEma =
        Math.abs(price - ema20) / price

    // Không được chase quá xa EMA20
    if(distEma > 0.012){
        return null
    }

    const nearEma =
        distEma <= 0.0055

    // ================= MARKET MOVE =================

    const move3 =
        (c0 - closes.at(-4)) /
        closes.at(-4)

    // Không bắt cú pump/dump đã chạy quá mạnh
    if(Math.abs(move3) > 0.022){
        return null
    }

    // ================= PULLBACK ENGINE =================
    //
    // Không còn kiểu:
    // "chạm EMA20 = pullback"
    //
    // Phải có:
    // trend → hồi → giữ cấu trúc → quay lại hướng trend

    const recentLow =
        Math.min(
            ...lows.slice(-7,-2)
        )

    const recentHigh =
        Math.max(
            ...highs.slice(-7,-2)
        )

    // LONG pullback
    const pullbackLong =
        h1Bull &&
        bull15 &&
        (
            l1 <= ema20 * 1.006 &&
            l1 >= ema50 * 0.992
        ) &&
        c1 <= ema20 * 1.012 &&
        c1 >= ema50 * 0.992 &&
        c0 > ema20

    // SHORT pullback
    const pullbackShort =
        h1Bear &&
        bear15 &&
        (
            h1 >= ema20 * 0.994 &&
            h1 <= ema50 * 1.008
        ) &&
        c1 >= ema20 * 0.988 &&
        c1 <= ema50 * 1.008 &&
        c0 < ema20

    if(!pullbackLong && !pullbackShort){
        return null
    }

    // ================= STRUCTURE =================

    // LONG:
    // nến hồi tạo đáy nhưng không phá vùng cấu trúc trước
    const higherLow =
        l1 >= recentLow * 0.996 &&
        l1 > l2

    // SHORT:
    // nến hồi tạo đỉnh thấp hơn
    const lowerHigh =
        h1 <= recentHigh * 1.004 &&
        h1 < h2

    if(pullbackLong && !higherLow){
        return null
    }

    if(pullbackShort && !lowerHigh){
        return null
    }

    // ================= TRIGGER ENGINE =================
    //
    // Đây là điểm quan trọng nhất.
    //
    // Không vào chỉ vì pullback.
    // Phải có nến xác nhận continuation.

    const triggerLong =
        pullbackLong &&
        c0 > h1 &&
        c0 > o0 &&
        bodyRatio >= 0.45 &&
        body0 >= atrVal * 0.28

    const triggerShort =
        pullbackShort &&
        c0 < l1 &&
        c0 < o0 &&
        bodyRatio >= 0.45 &&
        body0 >= atrVal * 0.28

    if(!triggerLong && !triggerShort){
        return null
    }

    // ================= VOLUME CONFIRMATION =================

    // Volume phải tăng khi continuation xảy ra.
    const volumeLong =
        triggerLong &&
        volRatio >= 1.05 &&
        volNow >= volPrev

    const volumeShort =
        triggerShort &&
        volRatio >= 1.05 &&
        volNow >= volPrev

    if(!volumeLong && !volumeShort){
        return null
    }

    // ================= CANDLE QUALITY =================

    // LONG: close phải nằm gần high
    const closeLocationLong =
        range0 > 0
            ? (c0 - l0) / range0
            : 0

    // SHORT: close phải nằm gần low
    const closeLocationShort =
        range0 > 0
            ? (h0 - c0) / range0
            : 0

    if(triggerLong && closeLocationLong < 0.65){
        return null
    }

    if(triggerShort && closeLocationShort < 0.65){
        return null
    }

    // ================= SIDE =================

    let side = null

    if(
        h1Bull &&
        triggerLong &&
        volumeLong
    ){
        side = "LONG"
    }

    if(
        h1Bear &&
        triggerShort &&
        volumeShort
    ){
        side = "SHORT"
    }

    if(!side){
        return null
    }

    const setupType =
        side === "LONG"
            ? "TREND_PULLBACK_CONTINUATION"
            : "TREND_PULLBACK_CONTINUATION"

    // ================= RSI CONTEXT =================

    // Không cần RSI cực đoan.
    // LONG ưu tiên RSI > 50.
    // SHORT ưu tiên RSI < 50.

    if(side === "LONG" && r < 48){
        return null
    }

    if(side === "SHORT" && r > 52){
        return null
    }

    // ================= SCORE =================
    //
    // Score chỉ dùng để đo chất lượng.
    // Không dùng score để biến setup yếu thành lệnh.

    let score = 0

    if(side === "LONG" && h1Bull) score += 15
    if(side === "SHORT" && h1Bear) score += 15

    if(side === "LONG" && bull15) score += 15
    if(side === "SHORT" && bear15) score += 15

    if(nearEma) score += 10

    if(side === "LONG" && higherLow) score += 15
    if(side === "SHORT" && lowerHigh) score += 15

    if(side === "LONG" && triggerLong) score += 20
    if(side === "SHORT" && triggerShort) score += 20

    if(volRatio >= 1.20) score += 10
    else if(volRatio >= 1.05) score += 5

    if(bodyRatio >= 0.60) score += 5

    if(trendStrength >= 0.0030) score += 5

    // Setup này phải đạt chất lượng tối thiểu
    if(score < 70){
        return null
    }

    // ================= STRUCTURE ZONES =================

    const swingLow =
        Math.min(...lows.slice(-12))

    const swingHigh =
        Math.max(...highs.slice(-12))

    const resistance =
        Math.max(...highs.slice(-18,-1))

    const support =
        Math.min(...lows.slice(-18,-1))

    // ================= RISK ENGINE =================

    let sl = null
    let tp = null
    let risk = null

    if(side === "LONG"){

        // SL dưới đáy pullback
        sl =
            Math.min(
                l1,
                l2,
                swingLow
            ) - atrVal * 0.35

        if(sl >= price){
            return null
        }

        risk = price - sl

        // Risk quá lớn → entry không còn đẹp
        if(risk > atrVal * 1.8){
            return null
        }

        // TP ngắn:
        // ưu tiên 1.3–1.6R
        const tp1 =
            price + risk * 1.30

        const tp2 =
            price + risk * 1.55

        // Không đặt TP xuyên qua resistance quá gần
        if(
            resistance > price &&
            resistance < tp1
        ){
            return null
        }

        tp = tp2

        // Nếu resistance nằm trong vùng TP
        if(
            resistance > tp1 &&
            resistance < tp2
        ){
            tp = resistance
        }

        if(tp <= price){
            return null
        }

    }else{

        // SHORT
        sl =
            Math.max(
                h1,
                h2,
                swingHigh
            ) + atrVal * 0.35

        if(sl <= price){
            return null
        }

        risk = sl - price

        if(risk > atrVal * 1.8){
            return null
        }

        const tp1 =
            price - risk * 1.30

        const tp2 =
            price - risk * 1.55

        if(
            support < price &&
            support > tp1
        ){
            return null
        }

        tp = tp2

        if(
            support < tp1 &&
            support > tp2
        ){
            tp = support
        }

        if(tp >= price){
            return null
        }
    }

    // ================= FINAL RR =================

    const finalRR =
        side === "LONG"
            ? (tp - price) / risk
            : (price - tp) / risk

    if(finalRR < 1.25){
        return null
    }

    // TP không được quá xa cho chiến lược ăn ngắn
    const tpDistance =
        Math.abs(tp - price)

    if(tpDistance > atrVal * 2.2){
        return null
    }

    // ================= OUTPUT =================

    function round(n, d = 6){
        if(n === null || n === undefined){
            return null
        }

        return Number(
            Number(n).toFixed(d)
        )
    }

    return {

        side,

        price: round(price),

        sl: round(sl),

        tp: round(tp),

        setup: setupType,

        marketState: "TREND",

        volatility:
            atrRatio > 0.004
                ? "HIGH"
                : "NORMAL",

        score,

        scoreBreakdown: {

            h1Trend: side === "LONG"
                ? h1Bull
                : h1Bear,

            trend15: side === "LONG"
                ? bull15
                : bear15,

            pullback:
                side === "LONG"
                    ? pullbackLong
                    : pullbackShort,

            structure:
                side === "LONG"
                    ? higherLow
                    : lowerHigh,

            trigger:
                side === "LONG"
                    ? triggerLong
                    : triggerShort,

            volume:
                round(volRatio,3),

            bodyRatio:
                round(bodyRatio,3),

            trendStrength:
                round(trendStrength,6),

            emaGap:
                round(emaGap,6),

            h1EmaGap:
                round(h1EmaGap,6),

            rsi:
                round(r,2),

            atrRatio:
                round(atrRatio,6),

            rr:
                round(finalRR,2)
        },

        indicators: {

            ema20:
                round(ema20),

            ema50:
                round(ema50),

            ema200:
                round(ema200),

            ema20_1h:
                round(ema20_1h),

            ema50_1h:
                round(ema50_1h),

            price:
                round(price),

            atr:
                round(atrVal),

            rsi:
                round(r,2),

            volumeNow:
                volNow,

            volumeAvg:
                volAvg,

            volumeRatio:
                round(volRatio,3)
        },

        structure: {

            pullbackHigh:
                h1,

            pullbackLow:
                l1,

            resistance,

            support,

            swingLow,

            swingHigh,

            higherLow,

            lowerHigh
        },

        context: {

            distEma:
                round(distEma,6),

            trendStrength:
                round(trendStrength,6),

            emaGap:
                round(emaGap,6),

            h1EmaGap:
                round(h1EmaGap,6),

            lastMove:
                round(move3,6),

            h1Bull,

            h1Bear,

            bull15,

            bear15,

            pullbackLong,

            pullbackShort,

            triggerLong,

            triggerShort
        },

        risk: {

            risk:
                round(risk),

            rr:
                round(finalRR,2),

            tpDistance:
                round(tpDistance),

            atr:
                round(atrVal)
        },
        debug: {
            reason:
                score >= 90
                    ? "A_PLUS_TREND"
                    : score >= 82
                        ? "A_TREND"
                        : "B_PLUS_TREND",
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
    let data15 = await getData(symbol,"15m",LIMIT_15M)
    let data1h = await getData(symbol,"1h",LIMIT_1H)
   if(!data15 || !data1h){
    console.log(`❌ No data: ${symbol}`)
    return null
}
    let r = await coreLogic(data15,data1h)
    if(!r || !r.side) return null

    return { symbol, ...r }
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

for(let s of chunk){

    let result = await Promise.race([
    scan(s),
    new Promise(resolve =>
        setTimeout(() => resolve(null), 20000)
    )
]).catch(e => {
    console.log("SCAN ERROR:", s, e.message)
    return null
})

    if(result){
        r.push({ status:"fulfilled", value: result })
    }

    await new Promise(r => setTimeout(r, 300))
}

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

    let weightMain = Math.min(dbMain.total / 50, 1)
    let aiMain = (dbMain.winrate - 0.5) * 80 * weightMain

    if(dbMain.total < 15) aiMain *= 0.9

    let finalMain = aiMain + (s.score * 0.15)

    if(finalMain >= - 5){
        candidates.push({
            ...s,
            finalScore: finalMain,
            type: "MAIN"
        })
    }
}

// ================= BTC CONTEXT FILTER =================
//
// BTC không quyết định entry.
// Core của coin vẫn là bộ lọc chính.
//
// BTC chỉ:
// 1. Ưu tiên trade cùng hướng BTC.
// 2. Cho phép trade ngược BTC nếu setup đủ mạnh.
// 3. Khi BTC NEUTRAL -> không ép hướng.

candidates = candidates.filter(c => {

    // ================= BTC BULL =================
    if(btcRegime === "BULL"){

        // LONG thuận BTC -> giữ nguyên
        if(c.side === "LONG"){
            return true
        }

        // SHORT ngược BTC:
        // chỉ cho phép nếu setup rất mạnh
        if(
            c.side === "SHORT" &&
            c.score >= 85 //&&
            //c.finalScore >= 5
        ){
            return true
        }

        return false
    }

    // ================= BTC BEAR =================
    if(btcRegime === "BEAR"){

        // SHORT thuận BTC -> giữ nguyên
        if(c.side === "SHORT"){
            return true
        }

        // LONG ngược BTC:
        // chỉ cho phép nếu setup rất mạnh
        if(
            c.side === "LONG" &&
            c.score >= 85 //&&
            //c.finalScore >= 5
        ){
            return true
        }

        return false
    }

    // ================= BTC NEUTRAL =================
    // Không ép hướng.
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
    .slice(0, 15)

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
let picks = filtered.slice(0, 3)
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
    let dbAI = await getDBStats(
        best.setup,
        best.marketState,
        best.side,
        best.volatility
    )

    // ===== RR =====
    let rr = best.side === "LONG"
        ? (best.tp - best.price) / (best.price - best.sl)
        : (best.price - best.tp) / (best.sl - best.price)

    let minRR = 1.1

if(best.marketState === "TREND_STRONG"){
    minRR = 1.2
}
else{
    minRR = 1.1
}

if(rr < minRR){
    continue
}

    // ===== RISK =====
    let multiplier = 1

    if(dbAI.total > 20){
        let edge = dbAI.winrate - 0.5
        multiplier = 1 + edge * 2

        if(multiplier > 1.5) multiplier = 1.5
        if(multiplier < 0.5) multiplier = 0.5
    }

    let balance = ACCOUNT_BALANCE

let riskPercent = RISK_PER_TRADE

if(best.setup === "REVERSAL_TOP" || best.setup === "REVERSAL_BOTTOM"){
    riskPercent *= 0.5
}

let risk = balance * riskPercent * multiplier
    // 🔥 minimum risk để đủ notional
risk = Math.max(risk, ACCOUNT_BALANCE * 0.005)
    if(best.setup === "REVERSAL_TOP" || best.setup === "REVERSAL_BOTTOM"){
    risk *= 0.5
}

    let diff = Math.abs(best.price - best.sl)
    if(!diff) continue


let trade = {
    // ================= BASIC =================
    symbol: best.symbol,
    side: best.side,

    entry: best.price,
    tp: best.tp,
    sl: best.sl,

    risk,
    rr,

    score: best.score,
    finalScore: best.finalScore,

    // ================= SCORE DETAIL =================
    scoreDetail: {

        trend: {
            h1Trend:
                best.side === "LONG"
                    ? best.scoreBreakdown.h1Trend
                    : best.scoreBreakdown.h1Trend,

            trend15:
                best.side === "LONG"
                    ? best.scoreBreakdown.trend15
                    : best.scoreBreakdown.trend15,

            trendStrength:
                best.scoreBreakdown.trendStrength,

            emaGap:
                best.scoreBreakdown.emaGap,

            h1EmaGap:
                best.scoreBreakdown.h1EmaGap
        },

        pullback: {
            valid:
                best.scoreBreakdown.pullback,

            side:
                best.side
        },

        structure: {
            valid:
                best.scoreBreakdown.structure,

            higherLow:
                best.side === "LONG"
                    ? best.structure.higherLow
                    : false,

            lowerHigh:
                best.side === "SHORT"
                    ? best.structure.lowerHigh
                    : false,

            pullbackHigh:
                best.structure.pullbackHigh,

            pullbackLow:
                best.structure.pullbackLow
        },

        trigger: {
            valid:
                best.scoreBreakdown.trigger,

            long:
                best.context.triggerLong,

            short:
                best.context.triggerShort,

            bodyRatio:
                best.scoreBreakdown.bodyRatio
        },

        volume: {
            ratio:
                best.indicators.volumeRatio,

            confirmed:
                best.scoreBreakdown.volume >= 1.05,

            strong:
                best.indicators.volumeRatio >= 1.20
        },

        candle: {
            bodyRatio:
                best.scoreBreakdown.bodyRatio
        },

        rsi:
            best.scoreBreakdown.rsi,

        atrRatio:
            best.scoreBreakdown.atrRatio
    },

    // ================= SETUP =================
    setup:
        best.setup,

    marketState:
        best.marketState,

    volatility:
        best.volatility,

    btcRegime,

    // ================= INDICATORS =================
    indicators: {
        ema20:
            best.indicators.ema20,

        ema50:
            best.indicators.ema50,

        ema200:
            best.indicators.ema200,

        ema20_1h:
            best.indicators.ema20_1h,

        ema50_1h:
            best.indicators.ema50_1h,

        price:
            best.indicators.price,

        atr:
            best.indicators.atr,

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
        pullbackHigh:
            best.structure.pullbackHigh,

        pullbackLow:
            best.structure.pullbackLow,

        resistance:
            best.structure.resistance,

        support:
            best.structure.support,

        swingLow:
            best.structure.swingLow,

        swingHigh:
            best.structure.swingHigh,

        higherLow:
            best.structure.higherLow,

        lowerHigh:
            best.structure.lowerHigh
    },

    // ================= CONTEXT =================
    context: {
        distEma:
            best.context.distEma,

        trendStrength:
            best.context.trendStrength,

        emaGap:
            best.context.emaGap,

        h1EmaGap:
            best.context.h1EmaGap,

        lastMove:
            best.context.lastMove,

        h1Bull:
            best.context.h1Bull,

        h1Bear:
            best.context.h1Bear,

        bull15:
            best.context.bull15,

        bear15:
            best.context.bear15,

        pullbackLong:
            best.context.pullbackLong,

        pullbackShort:
            best.context.pullbackShort,

        triggerLong:
            best.context.triggerLong,

        triggerShort:
            best.context.triggerShort
    },

    // ================= RISK =================
    riskDetail: {
        risk,
        rr,
        tpDistance:
            best.risk.tpDistance,
        atr:
            best.risk.atr
    },

    // ================= TRADE STATE =================
    waitingEntry: false,
    breakoutTriggered: false,

    createdAt: Date.now(),
    enteredAt: null,
    closedAt: null,

    result: "PENDING"
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

    // ===== 5% POSITION SIZE =====
let positionValue = ACCOUNT_BALANCE * POSITION_SIZE_PERCENT
let qtyBySize = positionValue / best.price

// ===== RISK CONTROL (SL) =====
let diff = Math.abs(best.price - best.sl)
if(!diff) continue

let risk = trade.risk
let qtyByRisk = risk / diff

// ===== FINAL QTY =====
let qty = Math.min(qtyBySize, qtyByRisk)
let maxPositionValue = ACCOUNT_BALANCE * 3

if(qty * best.price > maxPositionValue){

    qty = maxPositionValue / best.price
}
    if(!qty || qty <= 0 || !isFinite(qty)){
    console.log("❌ QTY INVALID BEFORE SEND")
    continue
}
    let notional = qty * best.price

let info = await getSymbolInfo(trade.symbol)
if(!info || !info.filters) continue

let lotFilter = info.filters.find(f => f.filterType === "LOT_SIZE")
//let minNotionalFilter = info.filters.find(f => f.filterType === "MIN_NOTIONAL")
let minNotionalFilter =
    info.filters.find(
        f =>
            f.filterType === "MIN_NOTIONAL" ||
            f.filterType === "NOTIONAL"
    )

let stepSize = parseFloat(lotFilter?.stepSize || 0.001)
let minQty = parseFloat(lotFilter?.minQty || 0)

let minNotional = parseFloat(minNotionalFilter?.notional || 5)
// ===== STEP 3: round step =====


// ===== STEP 4: check min qty =====
if(qty < minQty){
    console.log("❌ MIN QTY FAIL")
    continue
}

if(notional < minNotional){

    qty = minNotional / best.price
    qty = normalizeQtyFinal(
    Math.ceil(qty / stepSize) * stepSize,
    stepSize
)

    notional = qty * best.price
}

// ===== STEP 6: FINAL CHECK =====
if(notional < minNotional || !isFinite(qty) || qty <= 0){
    console.log("❌ FINAL MIN NOTIONAL FAIL:", notional)
    continue
}
    //if(!diff || diff <= 0) continue
    //let qty = risk / diff

    if(!qty || qty <= 0 || !isFinite(qty)){
        continue
    }


    if(!info || !info.filters){
        continue
    }

if(OPENING_POSITIONS[trade.symbol]){
    console.log(`⛔ OPENING LOCK ${trade.symbol}`)
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

const insertResult = await trades.insertOne(trade)

trade._id = insertResult.insertedId

let existsActive = activeTrades.find(
    x =>
        x.symbol === trade.symbol &&
        x.createdAt === trade.createdAt
)

if(!existsActive){
    activeTrades.push(trade)
}
        let msg = `🔥 BEST SIGNAL

${best.symbol} (${best.setup})
${best.side} | ₿ : ${btcRegime}
Score: ${best.score}
Entry: ${(trade.entry || best.price).toFixed(4)}
TP: ${trade.tp.toFixed(4)}
SL: ${trade.sl.toFixed(4)}
Size: ${qty.toFixed(2)}
AI: ${best.finalScore.toFixed(1)}
`  //Score: ${t.score || 0}
console.log(msg)
let teleSent = false
for(let retry = 0; retry < 3; retry++){
    teleSent = await sendTelegram(msg)
    if(teleSent){
        break
    }
    console.log(`⚠️ RETRY TELEGRAM ${retry + 1}`)
    await new Promise(r =>
        setTimeout(r, 2000)
    )
}
if(!teleSent){
    console.log(`🚨 TELEGRAM FAIL ${best.symbol}`)
    // gửi bot phụ backup
    await sendTelegram2(
`🚨 TELE FAIL
${best.symbol}
${best.side}
Entry: ${best.price}

TP: ${best.tp}

SL: ${best.sl}`
    )
}
}finally{

    delete OPENING_POSITIONS[trade.symbol]
}
    //console.log(msg)
    //await sendTelegram(msg)
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
async function checkTrades(){

    if(checkingTrades) return
    checkingTrades = true

    try{

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
let stillOpen = null

for(let retry = 0; retry < 5; retry++){

    POS_CACHE = null
    POS_CACHE_TIME = 0

    let positions = await getPositionsCached()

    stillOpen = positions.find(p =>
        p.symbol === t.symbol &&
        Math.abs(parseFloat(p.positionAmt || "0")) > 0
    )

    if(stillOpen){
        break
    }

    console.log(
        `⚠️ VERIFY POSITION ${t.symbol} ${retry + 1}/5`
    )

    await new Promise(r =>
        setTimeout(r, 2000)
    )
}

if(!stillOpen){

    const closed = await getClosedTradeResult(t)

if (!closed) {
    console.log(`⏳ WAIT TP/SL FILL: ${t.symbol}`)
    continue
}

const isWin = closed.pnl > 0

await trades.updateOne(
    { _id: t._id },
    {
        $set: {
            result: isWin ? "WIN" : "LOSS",
            pnl: closed.pnl,
            exitOrderId: closed.exitOrderId,
            closedAt: closed.closedAt
        }
    }
)

const latestBalance = await updateBalance()

if (latestBalance > 0) {
    ACCOUNT_BALANCE = latestBalance
}

const tele2Ok = await sendTelegram2(
`📊 ${t.symbol} (${t.setup})
${t.side} | ₿ : ${t.btcRegime}
${isWin ? "✅ WIN" : "❌ LOSS"}
PnL: ${closed.pnl.toFixed(4)}
💰: ${ACCOUNT_BALANCE.toFixed(2)} USDT`
)

if (!tele2Ok) {
    console.log(`❌ TELEGRAM 2 REPORT FAIL: ${t.symbol}`)
}

delete DATA_FAILS[t.symbol]
activeTrades.splice(i, 1)
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

        if(!process.env.MONGO_URI){
            throw new Error("❌ Thiếu MONGO_URI")
        }

        await client.connect()
        await syncTime()
// ⛔ CHẶN CHO TỚI KHI SYNC OK
while(!TIME_SYNCED){
    console.log("⏳ Waiting time sync...")
    await new Promise(r => setTimeout(r, 1000))
}

setInterval(syncTime, 60000)
        await updateBalance()
setInterval(updateBalance, 60000)
        // 🔥 RESET UPDATE STATE TRÁNH 409
await safeFetch(
  `https://api.telegram.org/bot${BOT_TOKEN}/getUpdates?offset=-1`
)

await safeFetch(
  `https://api.telegram.org/bot${BOT_TOKEN_2}/getUpdates?offset=-1`
)

        let newBalance = await updateBalance()
if(newBalance > 0){
    ACCOUNT_BALANCE = newBalance
}
console.log("💰 BALANCE:", ACCOUNT_BALANCE)

        try{
    await client.db("admin").command({ ping: 1 })
    console.log("🟢 DB CONNECTED OK")
}catch(e){
    console.log("🔴 DB CONNECT FAIL:", e.message)
}

        db = client.db("trading")
        trades = db.collection("trades")

        console.log("✅ MongoDB connected")
        
        // 🔥 CLEAR DEAD LOCK
await trades.updateMany(
    { opening:true },
    {
        $unset:{ opening:"" }
    }
)

console.log("✅ DEAD LOCK CLEARED")
/////////////////
        await trades.updateMany(
    {
        result: "PENDING",
        createdAt: {
            $lt: Date.now() - 24 * 60 * 60 * 1000
        }
    },
    {
        $set: {
            result: "EXPIRED"
        }
    }
)
// Không tự clear lệnh đã đóng.
// checkTrades() sẽ đọc tpOrderId/slOrderId để chốt đúng WIN hoặc LOSS.
activeTrades = await trades.find({
    result: "PENDING"
}).toArray()

console.log(`♻️ Load lại ${activeTrades.length} lệnh`)

        // ================= LOOP =================
        
async function scanLoop(){
    while(true){

        if(scanning){
            await new Promise(r => setTimeout(r, 5000))
            continue
        }

        scanning = true

        try{
            await scanner()
        } finally {
            scanning = false
        }

        await new Promise(r => setTimeout(r, 120000))
    }
}
let TELEGRAM_RUNNING = false
async function commandLoop(){
    if(TELEGRAM_RUNNING) return
    TELEGRAM_RUNNING = true
    while(true){
        try{
            await checkCommand()
            await checkTrades()
        }catch(e){
            console.log(
                "CMD LOOP:",
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
       await loadValidFuturesSymbols()

        commandLoop()
       await scanLoop()

    }catch(e){
        console.log("❌ Start error:", e.message)
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
        console.log("❌ DB ERROR:", e.message)
        return { winrate: 0.5, total: 0 }
    }
}
            
start()
async function syncActiveTrades(){

    let dbTrades = await trades.find({
        result:"PENDING"
    }).toArray()

    activeTrades = dbTrades

    console.log(
        `♻️ SYNC ACTIVE: ${activeTrades.length}`
    )
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
