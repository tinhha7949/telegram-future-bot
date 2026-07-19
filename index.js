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
        return change >= 0.5 && change <= 15 // 
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
// ============== CORE LOGIC =================
async function coreLogic(data15, data1h){

    // Bỏ nến đang chạy, chỉ dùng nến đã đóng.
    data15 = data15.slice(0, -1)
    data1h = data1h.slice(0, -1)

    if (data15.length < 250 || data1h.length < 60) {
        return null
    }

// ================= DATA =================
let opens   = data15.map(x => +x[1])
let highs   = data15.map(x => +x[2])
let lows    = data15.map(x => +x[3])
let closes  = data15.map(x => +x[4])
let volumes = data15.map(x => +x[5])
let closes1h= data1h.map(x => +x[4])

let price = closes.at(-1)

// ================= INDICATORS =================
let atrVal = atr(data15.slice(-100))
if(!atrVal || atrVal <= 0) atrVal = price * 0.003

let atrRatio = atrVal / price

let ema20  = ema(closes.slice(-60),20)
let ema50  = ema(closes.slice(-120),50)
let ema200 = ema(closes.slice(-250),200)

let ema20_1h = ema(closes1h.slice(-60),20)
let ema50_1h = ema(closes1h.slice(-120),50)

let r = rsi(closes.slice(-50))
if(r > 72 || r < 28) return null

// ================= VOLUME ENGINE (FULL RESTORED) =================
let volAvg = volumes.slice(-30).reduce((a,b)=>a+b,0)/30
let volNow = volumes.at(-1)

let volAvgUSDT = volAvg * price
let dynamicMinVol = getDynamicMinVol(volAvgUSDT, price, atrRatio)

// market participation filter
if(volAvgUSDT < dynamicMinVol) return null
if(volNow < volAvg * 0.45) return null //0.55

let volImpulse = volNow > volAvg * 1.25 //1.3
let volTrendUp = volumes.slice(-3).reduce((a,b)=>a+b,0) > volAvg * 1.8

// ================= STRUCTURE =================
let prevHigh = Math.max(...highs.slice(-20,-2))
let prevLow  = Math.min(...lows.slice(-20,-2))

let bosUp = false
let bosDown = false

let bosAgeLong = 999
let bosAgeShort = 999

for(let i=1;i<=6;i++){
    let highRef = Math.max(...highs.slice(-(20+i),-i))
    if(closes.at(-i) > highRef){
        bosUp = true
        bosAgeLong = i
        break
    }
}
for(let i=1;i<=6;i++){
    let lowRef = Math.min(...lows.slice(-(20+i),-i))
    if(closes.at(-i) < lowRef){
        bosDown = true
        bosAgeShort = i
        break
    }
}

let sweepHigh = highs.at(-2) > Math.max(...highs.slice(-40, -2)) && closes.at(-2) < highs.at(-2)
let sweepLow  = lows.at(-2) < Math.min(...lows.slice(-40, -2)) && closes.at(-2) > lows.at(-2)

// liquidity sweep confirmation (stronger version)
let sweepConfirmLong  = sweepLow  && closes.at(-1) > closes.at(-2)
let sweepConfirmShort = sweepHigh && closes.at(-1) < closes.at(-2)

// ================= TREND =================
let trendStrength = Math.abs(ema20 - ema50) / price
let isTrending = trendStrength > 0.0022 //0.0028

let h1Bull =
    ema20_1h>ema50_1h &&
    closes1h.at(-1)>ema20_1h

let h1Bear =
    ema20_1h<ema50_1h &&
    closes1h.at(-1)<ema20_1h

// ================= EMA DIST =================
let distEma = Math.abs(price - ema20) / price
if(distEma > 0.018) return null //0.015

let nearEma = distEma < 0.005

// ================= MARKET MOVE FILTER =================
let lastMove = (closes.at(-1) - closes.at(-5)) / closes.at(-5)
if(lastMove > 0.03 || lastMove < -0.03) return null

// ================= MARKET REGIME ENGINE =================
let range30 = (Math.max(...highs.slice(-30)) - Math.min(...lows.slice(-30))) / price

//let breakoutUp = closes.at(-1) > Math.max(...highs.slice(-18, -1)) && volImpulse
//let breakoutDown = closes.at(-1) < Math.min(...lows.slice(-18, -1)) && volImpulse

let phase = "TREND"

if(sweepHigh || sweepLow) phase = "LIQUIDITY"
else if(range30 < 0.012) phase = "RANGE"
//else if(breakoutUp) phase = "BREAKOUT_UP"
//else if(breakoutDown) phase = "BREAKDOWN_DOWN"

// ================= MOMENTUM =================
let body =
Math.abs(closes.at(-1)-opens.at(-1))

let momentumUp =
    closes.at(-1)>ema20 &&
    closes.at(-1)>highs.at(-2) &&
    body>atrVal*0.30

let momentumDown =
    closes.at(-1)<ema20 &&
    closes.at(-1)<lows.at(-2) &&
    body>atrVal*0.30
// ================= CONTEXT STRUCTURE =================
let higherLow =
Math.min(...lows.slice(-3)) >
Math.min(...lows.slice(-6,-3))
let lowerHigh =
Math.max(...highs.slice(-3)) <
Math.max(...highs.slice(-6,-3))

// ================= FAKE MOVE FILTER =================
let fakePump = volNow > volAvg*2.5 && closes.at(-1) < highs.at(-1)*0.985
let fakeDump = volNow > volAvg*2.5 && closes.at(-1) > lows.at(-1)*1.015
if(fakePump || fakeDump) return null
// ================= PULLBACK ENGINE =================
// LONG
let pullbackLong =
(
    Math.min(
lows.at(-1),
lows.at(-2)
)<=ema20*1.002
)
&&
closes.at(-1)>ema20 &&
closes.at(-1)>opens.at(-1) &&
body>atrVal*0.15
// SHORT
let pullbackShort =
(
    Math.max(
highs.at(-1),
highs.at(-2)
)>=ema20*0.998
)
&&
closes.at(-1)<ema20 &&
closes.at(-1)<opens.at(-1) &&
body>atrVal*0.15
// ================= SIDE ENGINE =================
let setupType = phase
let side = null
if(phase==="TREND"){
    if(!isTrending) return null
    // ===== LONG =====
    if(
    ema20>ema50 &&
    h1Bull &&
    pullbackLong
){
    side="LONG"
}
    // ===== SHORT =====
    if(
    ema20<ema50 &&
    h1Bear &&
    pullbackShort
){
    side="SHORT"
}
}
if(phase === "LIQUIDITY"){
    // ===== REVERSAL LONG =====
    if(
sweepConfirmLong &&
pullbackLong &&
volImpulse &&
r<45
){
        side = "LONG"
        setupType = "LIQUIDITY"
    }
    // ===== REVERSAL SHORT =====
    else if(
sweepConfirmShort &&
pullbackShort &&
volImpulse &&
r>55
){
        side = "SHORT"
        setupType = "LIQUIDITY"
    }
    // ===== Sweep giả → quay lại TREND =====
    else{
    return null
}
}
if(phase === "RANGE"){
    return null
}
if(!side) return null
// ================= SCORE ENGINE (FULL) =================
let score = 0
//================ TREND =================
if(side==="LONG"){
    if(ema20>ema50) score+=20
    if(h1Bull) score+=15
    if(isTrending) score+=10
}
if(side==="SHORT"){
    if(ema20<ema50) score+=20
    if(h1Bear) score+=15
    if(isTrending) score+=10
}
//================ BOS =================
if(side==="LONG" && bosUp){
    score+=20
    if(bosAgeLong<=3) score+=10
}
if(side==="SHORT" && bosDown){
    score+=20
    if(bosAgeShort<=3) score+=10
}
//================ MOMENTUM =================
if(side==="LONG" && momentumUp)
    score+=15
if(side==="SHORT" && momentumDown)
    score+=15
//================ PULLBACK =================
if(side==="LONG" && pullbackLong)
    score+=15
if(side==="SHORT" && pullbackShort)
    score+=15
//================ VOLUME =================
if(volImpulse)
    score+=15
if(volTrendUp)
    score+=10
//================ EMA =================
if(nearEma)
    score+=10
//================ STRUCTURE =================
if(side==="LONG" && higherLow)
    score+=10
if(side==="SHORT" && lowerHigh)
    score+=10
//================ ATR =================
if(
    atrRatio>0.004 &&
    atrRatio<0.012
){
    score+=5
}
//================ LIQUIDITY =================
if(setupType==="LIQUIDITY"){
    score+=15
}
if(score < 70) return null

// ================= STRUCTURE ZONES =================
let swingLow = Math.min(...lows.slice(-20))
let swingHigh = Math.max(...highs.slice(-20))

let resistance = Math.max(...highs.slice(-25))
let support = Math.min(...lows.slice(-25))

let distToRes = (resistance - price) / price
let distToSup = (price - support) / price

if(side === "LONG" && !bosUp && distToRes < 0.002) return null
if(side === "SHORT" && !bosDown && distToSup < 0.002) return null

// ================= LIQUIDITY ZONES =================
function findLiquidityHigh(highs){
    let zone = highs.slice(-25)
    let max = Math.max(...zone)
    let count = zone.filter(h => Math.abs(h - max) / max < 0.002).length
    return count >= 2 ? max : null
}

function findLiquidityLow(lows){
    let zone = lows.slice(-25)
    let min = Math.min(...zone)
    let count = zone.filter(l => Math.abs(l - min) / min < 0.002).length
    return count >= 2 ? min : null
}

let liqHigh = findLiquidityHigh(highs)
let liqLow = findLiquidityLow(lows)

// ================= TP ENGINE =================
function pickBestTP(candidates, price, risk, side){

    let valid = []

    for(let c of candidates){

        let rr = side==="LONG"
            ? (c.price - price) / risk
            : (price - c.price) / risk

        let dist = side==="LONG"
            ? (c.price - price)
            : (price - c.price)

        if(rr >= RR_THRESHOLD && dist >= atrVal*0.7 && dist <= atrVal*4.5){
            valid.push({...c, rr, dist})
        }
    }

    if(valid.length === 0) return null

    valid.sort((a,b)=>{
        if(isTrending) return b.rr - a.rr
        return side==="LONG" ? a.price - b.price : b.price - a.price
    })

    return valid[0].price
}

// ================= RISK ENGINE =================
let sl = null
let tp = null

if(side === "LONG"){

    sl = swingLow - atrVal * 0.7
    if(sl >= price) sl = price - atrVal * 1.5

    let risk = price - sl

    let candidates = []
    if(resistance > price) candidates.push({price: resistance, type:"res"})
    if(liqHigh && liqHigh > price) candidates.push({price: liqHigh, type:"liq"})

    if(candidates.length === 0){
        candidates.push({price: price + atrVal*2, type:"atr"})
    }

    tp = pickBestTP(candidates, price, risk, "LONG")
    if(!tp) tp = price + atrVal*2

    if((tp-price)/risk < RR_THRESHOLD) return null
}

if(side === "SHORT"){

    sl = swingHigh + atrVal * 0.7
    if(sl <= price) sl = price + atrVal * 1.5

    let risk = sl - price

    let candidates = []
    if(support < price) candidates.push({price: support, type:"sup"})
    if(liqLow && liqLow < price) candidates.push({price: liqLow, type:"liq"})

    if(candidates.length === 0){
        candidates.push({price: price - atrVal*2, type:"atr"})
    }

    tp = pickBestTP(candidates, price, risk, "SHORT")
    if(!tp) tp = price - atrVal*2

    if((price-tp)/risk < RR_THRESHOLD) return null
}

function round(n, d = 4){
    if(n === null || n === undefined) return null
    return Number(Number(n).toFixed(d))
}

// ================= OUTPUT =================
return {
    side,
    price: round(price),
    sl: round(sl),
    tp: round(tp),
    setup: setupType,
    marketState: isTrending ? "TREND_STRONG" : "TREND_WEAK",
    volatility: atrRatio > 0.004 ? "HIGH" : "NORMAL",
    score,
    scoreBreakdown: {
        bosUp,
        bosDown,
        bosAgeLong,
bosAgeShort,
        sweepHigh,
        sweepLow,
        volImpulse,
        volTrendUp,
        momentumUp,
        momentumDown,
        nearEma,
        trendStrength: round(trendStrength, 6),
        rsi: round(r, 2),
        atrRatio: round(atrRatio, 6)
    },
    indicators: {
        ema20: round(ema20),
        ema50: round(ema50),
        ema20_1h: round(ema20_1h),
        price: round(price),
        atr: round(atrVal),
        rsi: round(r),
        volumeNow: volNow,
        volumeAvg: volAvg
    },
    structure: {
        prevHigh,
        prevLow,
        resistance,
        support,
        swingLow,
        swingHigh
    },
    context: {
        distEma: round(distEma, 6),
        nearEma,
        lastMove: round(lastMove, 6),
        higherLow,
        lowerHigh,
        isTrending
    },
    liquidity: {
        sweepHigh,
        sweepLow
    },
    flags: {
        fakePump,
        fakeDump,
        volImpulse,
        volTrendUp
    },
    debug: {
        reason:
            score >= 80 ? "HIGH_CONVICTION" :
            score >= 70 ? "GOOD" :
            "WEAK",
        timestamp: Date.now(),
        candle: {
            open: round(opens.at(-1)),
            high: round(highs.at(-1)),
            low: round(lows.at(-1)),
            close: round(closes.at(-1))
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
async function getBtcRegime() {
    if (
        BTC_REGIME_CACHE &&
        Date.now() - BTC_REGIME_CACHE_TIME < 120000
    ) {
        return BTC_REGIME_CACHE
    }

    const raw15 = await getData("BTCUSDT", "15m", 100)
    const raw1h = await getData("BTCUSDT", "1h", 100)

    if (!raw15 || !raw1h) {
        return "NEUTRAL"
    }

    // Chỉ dùng nến đã đóng.
    const data15 = raw15.slice(0, -1)
    const data1h = raw1h.slice(0, -1)

    const close15 = data15.map(x => Number(x[4]))
    const close1h = data1h.map(x => Number(x[4]))

    const ema20_15 = ema(close15.slice(-60), 20)
    const ema50_15 = ema(close15.slice(-100), 50)

    const ema20_1h = ema(close1h.slice(-60), 20)
    const ema50_1h = ema(close1h.slice(-100), 50)

    let regime = "NEUTRAL"

    if (
        close15.at(-1) > ema20_15 &&
        ema20_15 > ema50_15 &&
        close1h.at(-1) > ema20_1h &&
        ema20_1h > ema50_1h
    ) {
        regime = "BULL"
    } else if (
        close15.at(-1) < ema20_15 &&
        ema20_15 < ema50_15 &&
        close1h.at(-1) < ema20_1h &&
        ema20_1h < ema50_1h
    ) {
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
for(let c of candidates){
    if(
        btcRegime==="BULL" &&
        c.side==="LONG"
    ){
        c.finalScore+=10
    }
    if(
        btcRegime==="BEAR" &&
        c.side==="SHORT"
    ){
        c.finalScore+=10
    }
}
        // ===== NO CANDIDATE =====
        if(!candidates || candidates.length === 0){
            console.log("❌ No signal")
            return
        }

        // ===== SORT =====
      candidates.sort((a,b)=>{

    if(b.finalScore !== a.finalScore)
        return b.finalScore-a.finalScore

    if(b.score !== a.score)
        return b.score-a.score

    let rrA=Math.abs(a.tp-a.price)/Math.abs(a.price-a.sl)
    let rrB=Math.abs(b.tp-b.price)/Math.abs(b.price-b.sl)

    return rrB-rrA
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
if (btcRegime === "NEUTRAL") {
    filtered = filtered.filter(c =>
        c.score >= 75
    )
}
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
    symbol: best.symbol,
    side: best.side,
    risk,
    entry: best.price,

tp: best.tp,
sl: best.sl,
score: best.score,

waitingEntry: false,

    createdAt: Date.now(),
    breakoutTriggered: false,
    setup: best.setup,
    marketState: best.marketState,
    volatility: best.volatility,
    atr: best.atr,
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
${best.side} | ${best.marketState}

₿ BTC: ${btcRegime}

Score: ${best.score}
AI: ${best.finalScore.toFixed(1)}

Entry: ${(trade.entry || best.price).toFixed(4)}

TP: ${trade.tp.toFixed(4)}

SL: ${trade.sl.toFixed(4)}

Size: ${qty.toFixed(2)}
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
Entry: ${best.entry}

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
${t.side}`
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
${t.side} | ${t.marketState}
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
