let TIME_SYNCED = false
let LAST_OFFSET_LOG = 0
let serverTimeOffset = 0
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
                return res
            }

            if(res && (res.status === 429 || res.status === 418)){
                await new Promise(r => setTimeout(r, 3000))
                continue
            }

            console.log(`❌ FETCH STATUS: ${res?.status} ${url}`)

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
async function syncTime(){

    try{

        const start = Date.now()

        let res = await safeFetch(
            "https://fapi.binance.com/fapi/v1/time"
        )

        if(!res){
            TIME_SYNCED = false
            return
        }

        let data = await res.json()

        const end = Date.now()

        // latency compensation
        const latency = (end - start) / 2

        serverTimeOffset =
            data.serverTime - end + latency

        TIME_SYNCED = true

        console.log(
            `🕒 TIME OFFSET: ${serverTimeOffset}ms`
        )

    }catch(e){

        TIME_SYNCED = false

        console.log(
            "❌ TIME SYNC FAIL:",
            e.message
        )
    }
}
///////////
function getTimestamp(){
    if(!TIME_SYNCED){
        return Date.now()
    }
    return Date.now() + serverTimeOffset
}
//////////////
require("dotenv").config()
const { MongoClient } = require("mongodb")
const client = new MongoClient(process.env.MONGO_URI)
const Binance = require('binance-api-node').default

const binance = Binance({
    apiKey: process.env.BINANCE_KEY,
    apiSecret: process.env.BINANCE_SECRET,
    recvWindow: 20000,
    getTime: () => Date.now() + serverTimeOffset
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

const SCORE_THRESHOLD = 35 // 110
const RR_THRESHOLD = 1.3 // 1.3 hoặc 1.4 nếu muốn 

const RISK_PER_TRADE = 0.02
const POSITION_SIZE_PERCENT = 0.1 // 0.05 5% vốn vào lệnh
let ACCOUNT_BALANCE = 0
const MIN_VOL_15M = 60000 // 100000 hoặc  nếu rác
const MIN_VOL_24H = 10000000

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
let TPSL_LOCKS = {}
let WATCHDOG_LOCKS = {}
let TPSL_MISSING = {}
let DATA_FAILS = {}
let WATCHDOG_RUNNING = false

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
async function openPosition(symbol, side, qty){

    try{
         let info = await getSymbolInfo(symbol)

        if(!info){
            console.log("❌ NO SYMBOL INFO")
            return null
        }

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
}

    console.log(`⏳ WAIT FILL ${symbol}: ${data.status}`)

    for(let i = 0; i < 10; i++){

        await new Promise(r => setTimeout(r, 800))

        try{

            let check = await binance.futuresGetOrder({
                symbol,
                orderId: data.orderId
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
        console.log("❌ OPEN ORDER FAIL:", e.message)
        return null
    }
}
async function waitPosition(symbol){

    for(let i=0;i<20;i++){

        let positions = await binance.futuresPositionRisk({
    recvWindow: 20000
})

        let pos = positions.find(p =>
            p.symbol === symbol &&
            Math.abs(Number(p.positionAmt)) > 0
        )

        if(pos){
            return pos
        }

        await new Promise(r => setTimeout(r, 1000))
    }

    return null
}
async function cancelAllOrders(symbol){

    try{

        await binance.futuresCancelAllOpenOrders({
            symbol,
            recvWindow: 20000
        })
        for(let i=0;i<20;i++){

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

        console.log(`❌ CANCEL TPSL ${symbol}:`, e.message)
    }
}
async function cancelTPSLOrders(symbol){

    try{

        let orders =
            await binance.futuresOpenOrders({
                symbol,
                recvWindow:20000
            })

        for(let o of orders){

            if(
                o.type === "STOP_MARKET" ||
                o.type === "TAKE_PROFIT_MARKET"
            ){

                try{

                    await binance.futuresCancelOrder({
                        symbol,
                        orderId:o.orderId,
                        recvWindow:20000
                    })

                }catch(e){}
            }
        }

    }catch(e){

        console.log(
            `❌ CANCEL TPSL ${symbol}:`,
            e.message
        )
    }
}
async function setTPSL(symbol, side, tp, sl){

    try{

        // ===== WAIT REAL POSITION =====
        let pos = null

        for(let i=0;i<20;i++){

            let positions =
                await binance.futuresPositionRisk({
    recvWindow: 20000
})

            pos = positions.find(p =>
                p.symbol === symbol &&
                Math.abs(Number(p.positionAmt)) > 0
            )

            if(pos){
                break
            }

            await new Promise(r =>
                setTimeout(r, 1000)
            )
        }

        if(!pos){

            return {
                ok:false,
                error:"NO_POSITION"
            }
        }

        // ===== WAIT BINANCE SYNC =====
        await new Promise(r =>
            setTimeout(r, 2500)
        )

        // ===== VERIFY POSITION AGAIN =====
        let amt = Math.abs(Number(pos.positionAmt))

        if(!amt || amt <= 0){

            return {
                ok:false,
                error:"POSITION_EMPTY"
            }
        }

        // ===== CHECK EXISTING TPSL =====
        let openOrders =
            await binance.futuresOpenOrders({
                symbol,
                recvWindow: 20000
            })

        let closeSide =
            Number(pos.positionAmt) > 0
                ? "SELL"
                : "BUY"

        let hasSL = openOrders.find(o =>
            o.type === "STOP_MARKET" &&
            o.side === closeSide &&
            o.closePosition
        )

        let hasTP = openOrders.find(o =>
            o.type === "TAKE_PROFIT_MARKET" &&
            o.side === closeSide &&
            o.closePosition
        )

        // ===== ĐỦ TPSL =====
if(hasSL && hasTP && Number(pos.positionAmt) !== 0){

    console.log(`✅ TPSL EXISTS ${symbol}`)

    return {
        ok:true,
        existed:true
    }
}

        // ===== CANCEL ONLY WRONG ORDERS =====
        for(let o of openOrders){

            if(
                o.side === closeSide &&
                (
                    o.type === "STOP_MARKET" ||
                    o.type === "TAKE_PROFIT_MARKET"
                )
            ){

                try{
                    await binance.futuresCancelOrder({
                        symbol,
                        recvWindow: 20000,
                        orderId:o.orderId,
                    })
                }catch(e){}
            }
        }

        await new Promise(r =>
            setTimeout(r, 2000)
        )

        // ===== SYMBOL INFO =====
        let info = await getSymbolInfo(symbol)

        if(!info){

            return {
                ok:false,
                error:"NO_SYMBOL_INFO"
            }
        }

        let priceFilter =
            info.filters.find(
                f => f.filterType === "PRICE_FILTER"
            )

        let tickSize =
            Number(priceFilter?.tickSize || 0.01)

        function roundPrice(price, tick, mode){

            let v

            if(mode === "DOWN"){
                v = Math.floor(price / tick) * tick
            }else{
                v = Math.ceil(price / tick) * tick
            }

            let precision =
                (tick.toString().split(".")[1] || "").length

            return Number(v.toFixed(precision))
        }

        if(side === "LONG"){

            tp = roundPrice(tp, tickSize, "DOWN")
            sl = roundPrice(sl, tickSize, "DOWN")

        }else{

            tp = roundPrice(tp, tickSize, "UP")
            sl = roundPrice(sl, tickSize, "UP")
        }

        // ===== USE ENTRY PRICE INSTEAD MARK =====
        let entryPrice = Number(pos.entryPrice)

        if(side === "LONG"){

            if(sl >= entryPrice || tp <= entryPrice){

                return {
                    ok:false,
                    error:"INVALID_LONG_PRICES"
                }
            }

        }else{

            if(sl <= entryPrice || tp >= entryPrice){

                return {
                    ok:false,
                    error:"INVALID_SHORT_PRICES"
                }
            }
        }

        // ===== CREATE SL =====
        try{

            await binance.futuresOrder({

                symbol,
                recvWindow: 20000,
                side: closeSide,
                type: "STOP_MARKET",
                stopPrice: sl,
                closePosition: true,
                workingType: "MARK_PRICE",
                priceProtect: true
            })

        }catch(e){

            return {
                ok:false,
                error:"SL_FAIL: " + e.message
            }
        }

        await new Promise(r =>
            setTimeout(r, 1500)
        )

        // ===== CREATE TP =====
        try{

            await binance.futuresOrder({
                symbol,
                recvWindow: 20000,
                side: closeSide,
                type: "TAKE_PROFIT_MARKET",
                stopPrice: tp,
                closePosition: true,
                workingType: "MARK_PRICE",
                priceProtect: true
            })

        }catch(e){

            // rollback SL
            try{
                await cancelTPSLOrders(t.symbol)
            }catch(e){}

            return {
                ok:false,
                error:"TP_FAIL: " + e.message
            }
        }

        // ===== FINAL VERIFY =====
        for(let i=0;i<20;i++){

            await new Promise(r =>
                setTimeout(r, 1500)
            )

            let verify =
                await binance.futuresOpenOrders({
                    symbol,
                    recvWindow: 20000
                })

            let finalSL = verify.find(o =>
                o.type === "STOP_MARKET" &&
                o.side === closeSide &&
                o.closePosition
            )

            let finalTP = verify.find(o =>
                o.type === "TAKE_PROFIT_MARKET" &&
                o.side === closeSide &&
                o.closePosition
            )

            if(finalSL && finalTP){

                return {
                    ok:true
                }
            }
        }

        return {
            ok:false,
            error:"TPSL_VERIFY_FAIL"
        }

    }catch(e){

        return {
            ok:false,
            error:e.message
        }
    }
}
async function safeSetTPSL(symbol, side, tp, sl){

    if(TPSL_LOCKS[symbol]){
        return false
    }

    TPSL_LOCKS[symbol] = true

    try{

        for(let i=0;i<5;i++){

            let res = await setTPSL(
                symbol,
                side,
                tp,
                sl
            )

            if(res.ok){
                return true
            }

            console.log(
                `⚠️ TPSL retry ${symbol} ${i+1}:`,
                res.error
            )

            // nếu Binance chưa sync cancel
if(
    res.error &&
    res.error.includes("existing")
){

    await cancelTPSLOrders(symbol)

    await new Promise(r =>
        setTimeout(r, 2500)
    )

}else if(
    res.error &&
    res.error.includes("immediately trigger")
){

    await new Promise(r =>
        setTimeout(r, 6000)
    )

}else{

    await new Promise(r =>
        setTimeout(r, 2500)
    )
}
        }

        return false

    }finally{

        delete TPSL_LOCKS[symbol]
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
                     // volume tối thiểu
.filter(c => Number(c.quoteVolume) > MIN_VOL_24H)
                    .sort((a,b)=> Number(b.quoteVolume) - Number(a.quoteVolume))
                .slice(0,30)
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
// ================= CORE =================
async function coreLogic(data15, data1h){

    let closes = data15.map(x=>+x[4])
    let opens = data15.map(x=>+x[1])
    let highs  = data15.map(x=>+x[2])
    let lows   = data15.map(x=>+x[3])
    let volumes= data15.map(x=>+x[5])
    let closes1h = data1h.map(x=>+x[4])

    let price = closes.at(-1)
    let prevPrice = closes.at(-2)
    let side=null, score=0
    let setupType = null
    // ===== ANTI CHASE (ĐÚNG CHỖ) =====
let lastMove = (closes.at(-1) - closes.at(-3)) / closes.at(-3)

// nếu pump/dump mạnh → bỏ luôn (không cần biết LONG hay SHORT)
if(Math.abs(lastMove) > 0.12){
    score -= 20
}
    
   let last30 = volumes.slice(-30)
if(last30.length < 15) return null

let volAvg = last30.reduce((a,b)=>a+b,0)/last30.length
    let volNow = volumes.at(-1)

    let volAvgUSDT = volAvg * price
    let volNowUSDT = volNow * price

    let atrVal = atr(data15.slice(-100))
    if(!atrVal || atrVal <= 0){
    atrVal = price * 0.003 // fallback ATR giả
}
let atrRatio = atrVal / price
    let volRatio = volNowUSDT / volAvgUSDT //cmt dòng này nếu bỏ dymic

let dynamicMinVol = getDynamicMinVol(volAvgUSDT, price, atrRatio)

    // ===== DYNAMIC VOLUME FILTER =====
if(atrRatio < 0.0015){
    // sideway → cần volume mạnh
    if(volRatio < 0.03) return null
}
else if(atrRatio > 0.005){
    // trend mạnh → nới lỏng
    if(volRatio < 0.03) return null // cũ 0.5
}
else{
    // bình thường
    if(volRatio < 0.02){
    score -= 10
}
}
//if(volNowUSDT < volAvgUSDT * 0.6) return null
    // ===== FILTER VOLUME =====
if(volAvgUSDT < dynamicMinVol * 0.7){
    score -= 15
}

    //if(volNowUSDT < volAvgUSDT * 0.2) return null //1.1
    //if(volAvgUSDT < MIN_VOL_15M) return null

    // ===== EMA =====
    let ema20 = ema(closes.slice(-100), 20)
    let ema50 = ema(closes.slice(-200), 50)
    let ema200 = ema(closes.slice(-500), 200)

    let ema20_1h = ema(closes1h.slice(-60),20)
    let ema50_1h = ema(closes1h.slice(-120),50)

    let distFromEma = (price - ema20) / ema20

    // ===== TREND =====
    let trendHTF = Math.abs(ema20_1h - ema50_1h) / price
    let trendLTF = Math.abs(ema20 - ema50) / price

    //if(trendHTF < 0.0012 && trendLTF < 0.001) return null

    let dynamicThreshold = 50

// ===== TREND STRONG =====
if(trendHTF > 0.003 && trendLTF > 0.002){
    dynamicThreshold = 40   // dễ vào hơn
}

// ===== TREND WEAK =====
else if(trendHTF > 0.0015){
    dynamicThreshold = 47
}

// ===== SIDEWAY =====
else{
    dynamicThreshold = 55   // siết mạnh
}

// ===== VOLATILITY adjustment =====
if(atrRatio > 0.005){
    dynamicThreshold -= 5   // trend mạnh → dễ vào
}

if(atrRatio < 0.002){
    dynamicThreshold += 2   // market chết → siết lại
}

    let r = rsi(closes.slice(-50))
   // let atrVal = atr(data15.slice(-100))

    let volatility = "LOW"
    if(atrVal / price > 0.0045) volatility = "HIGH"

    // ===== ANTI CHASE (GIỮ 1) =====
   // let lastMove = (closes.at(-1) - closes.at(-3)) / closes.at(-3)
   // if(Math.abs(lastMove) > 0.03) return null

    // ===== WICK =====
    if((highs.at(-1) - lows.at(-1)) > atrVal * 6){
    score -= 15
}

    // ===== MARKET =====
    let emaGap = Math.abs(ema20 - ema50) / price
    //let atrRatio = atrVal / price

    let marketState = "SIDEWAY"
    if(emaGap > 0.004 && atrRatio > 0.0045) marketState = "TREND_STRONG"
    else if(emaGap > 0.0025) marketState = "TREND_WEAK"

    let range = (Math.max(...highs.slice(-30)) - Math.min(...lows.slice(-30))) / price
    if(marketState === "SIDEWAY" && range < 0.0008) return null // 0.002

    // ===== EMA DIST =====
    let distEma = Math.abs(price - ema20) / price
    let nearEma = distEma < 0.0055

    if(marketState === "SIDEWAY"){
        if(nearEma && volNowUSDT < volAvgUSDT * 0.2) return null //0.5
    }

    // ===== STRUCTURE =====
    // ===== STRUCTURE (FIXED) =====
let hArr = highs.slice(-30)
let lArr = lows.slice(-30)

// guard chống thiếu data
if(hArr.length < 20 || lArr.length < 20) return null

let rangeHigh = Math.max(...hArr)
let rangeLow  = Math.min(...lArr)

// tránh divide by zero
if(!rangeHigh || !rangeLow || rangeHigh <= rangeLow) return null
    // ===== AVOID TOP =====
let nearHigh = (rangeHigh - price) / price < 0.01
let nearLow  = (price - rangeLow) / price < 0.01

    let rangeSize = rangeHigh - rangeLow
if(rangeSize <= 0) return null

let pos = (price - rangeLow) / rangeSize

if(marketState === "SIDEWAY"){
    if(pos > 0.45 && pos < 0.55){
        score -= 10
    }
}

    let prevHigh = Math.max(...highs.slice(-25,-5))
    let prevLow  = Math.min(...lows.slice(-25,-5))

    let bosUp = price > prevHigh
    let bosDown = price < prevLow
    // ===== SPIKE FILTER =====
let spikeCandle = (highs.at(-2) - lows.at(-2)) / lows.at(-2)

if(spikeCandle > 0.035){ // nến trước >3.5%
    bosUp = false
    bosDown = false
}

    let prevHigh50 = Math.max(...highs.slice(-51,-1))
    let prevLow50  = Math.min(...lows.slice(-51,-1))

    let sweepHigh = highs.at(-2) > prevHigh50 && closes.at(-2) < prevHigh50
    let sweepLow  = lows.at(-2) < prevLow50 && closes.at(-2) > prevLow50

    // ===== MOMENTUM =====
    let momentumStrength = (closes.at(-1) - closes.at(-4)) / closes.at(-4)

    let momentumUp = momentumStrength > 0.002
    let momentumDown = momentumStrength < -0.002

    let higherLow = lows.at(-2) > lows.at(-5)
    let lowerHigh = highs.at(-2) < highs.at(-5)

    let volTrendUp = volumes.slice(-5).every((v,i,a)=> i===0 || v>=a[i-1])
    
    // ===== TREND FILTER =====
    let trendLong = ema20>ema50 && ema50>ema200 && ema20_1h>ema50_1h
    let trendShort = ema20<ema50 && ema50<ema200 && ema20_1h<ema50_1h

    let trendStrength = Math.abs(ema20-ema50)/price
    //if(marketState === "SIDEWAY" && trendStrength < 0.0008){ //0.0011
    //return null
//}

    // ===== SIDEWAY =====
    if(marketState === "SIDEWAY"){
        if(sweepHigh){ side="SHORT"; score+=60 }
        if(sweepLow){ side="LONG"; score+=60 }
        if(!side) return null
        //if(bosUp || bosDown) return null
    }
    if(side === "LONG" && nearHigh){
    score -= 20
}

if(side === "SHORT" && nearLow){
    score -= 20
}
    // Fake breakout
    let high = highs.at(-1)
let low = lows.at(-1)
    let open = opens.at(-1)
let close = closes.at(-1)

let candleRange = high - low
let upperWick = high - Math.max(open, close)
let lowerWick = Math.min(open, close) - low
// ===== REVERSAL DETECTION (TOP + BOTTOM) =====

let strongUpperWick = candleRange > 0 && (upperWick / candleRange > 0.5)
let strongLowerWick = candleRange > 0 && (lowerWick / candleRange > 0.5)

let bearishClose = close < open
let bullishClose = close > open

// ===== ĐỈNH =====
let isTop =
    distFromEma > 0.03 &&
    r > 68 &&
    strongUpperWick &&
    bearishClose &&
    nearHigh   // 🔥 thêm
// ===== ĐÁY =====
let isBottom =
    distFromEma < -0.03 &&
    r < 32 &&
    strongLowerWick &&
    bullishClose &&
    nearLow

let reversalShortSignal = ENABLE_REVERSAL && isTop
let reversalLongSignal  = ENABLE_REVERSAL && isBottom
// 🔥 nếu giá quá xa EMA → bỏ (đu đỉnh)
if(distFromEma > 0.12 && !reversalShortSignal && !reversalLongSignal){
    return null
}
// ===== REJECTION FILTER =====
if(candleRange > 0){
    let upperWickRatio = upperWick / candleRange
    let lowerWickRatio = lowerWick / candleRange

    // ❌ bị đạp xuống → không long
    if(upperWickRatio > 0.4){
        if(side === "LONG") return null
    }

    // ❌ bị đẩy lên → không short
    if(lowerWickRatio > 0.4){
        if(side === "SHORT") return null
    }
}
    
let fakePump = volNowUSDT > volAvgUSDT * 2
    && upperWick / candleRange > 0.5

let fakeDump = volNowUSDT > volAvgUSDT * 2
    && lowerWick / candleRange > 0.5
if(fakePump || fakeDump){
    score -= 20
}

    // ===== SCORE =====
    if(!side){

    // ❌ không long ở đỉnh
    if(trendLong && !reversalShortSignal){
        side="LONG"
        score+=15
    }

    // ❌ không short ở đáy
    else if(trendShort && !reversalLongSignal){
        side="SHORT"
        score+=15
    }
}
// ===== FORCE REVERSAL =====
if(reversalShortSignal){
    side = "SHORT"
    score += 70
    setupType = "REVERSAL_TOP"
}

if(reversalLongSignal){
    side = "LONG"
    score += 70
    setupType = "REVERSAL_BOTTOM"
}
if(trendLong && side==="LONG" && !reversalLongSignal) score += 10
if(trendShort && side==="SHORT" && !reversalShortSignal) score += 10
if(!side) return null

    // ===== SETUP =====
   if(
    side==="LONG" &&
    bosUp &&
    volNowUSDT > volAvgUSDT * 1.15 &&
    momentumUp &&
    distFromEma < 0.12 
){
    score += 50
    setupType = "BREAKOUT"
}

if(
    side==="SHORT" &&
    bosDown &&
    volNowUSDT > volAvgUSDT * 1.15 &&
    momentumDown &&
    distFromEma > -0.02
){
    score += 50
    setupType = "BREAKOUT"
}
    //if(side==="LONG" && bosUp){
       // score += 40
       // setupType = "BREAKOUT"
   // }

   // if(side==="SHORT" && bosDown){
      //  score += 40
       // setupType = "BREAKOUT"
    //}

    if(side==="LONG" && nearEma){
        score += 20
        if(!setupType) setupType = "PULLBACK"
    }

    if(side==="SHORT" && nearEma){
        score += 20
        if(!setupType) setupType = "PULLBACK"
    }
    // ❌ không có hồi → không short
//if(side === "SHORT"){
    //let pulledBack = highs.at(-2) > highs.at(-4)
   // if(!pulledBack) score -= 10
//}

//if(side === "LONG"){
   // let pulledBack = lows.at(-2) < lows.at(-4)
   // if(!pulledBack) score -= 10
//}

    if(side==="LONG" && sweepLow) score+=35
    if(side==="SHORT" && sweepHigh) score+=35

    if(volTrendUp) score+=20
    if(volNowUSDT > volAvgUSDT *1.5) score+=15 

    if(side==="LONG" && momentumUp) score+=10
    if(side==="SHORT" && momentumDown) score+=10

    if(side==="LONG" && higherLow) score+=15
    if(side==="SHORT" && lowerHigh) score+=15
   
    if(side==="LONG" && r>50 && r<65) score+=10
    if(side==="SHORT" && r>35 && r<50) score+=10

    if(!side) return null
// kháng cự hỗ trợ gần quá thì tránh vào (giữ nguyên)
    let resistance = rangeHigh
let support = rangeLow
let distToRes = (resistance - price) / price
let distToSup = (price - support) / price

if(setupType !== "BREAKOUT"){
if(side === "LONG" && distToRes < 0.002) return null
if(side === "SHORT" && distToSup < 0.002) return null
}
    // ===== ANTI FOMO (GỌN - KHÔNG TRÙNG) =====
    let distance = Math.abs(price - ema20)
    // ===== ANTI FOMO =====
let isBreakout = setupType === "BREAKOUT"

if(!isBreakout){
    if(marketState !== "TREND_STRONG" && distance > atrVal * 3.5){
        score -= 25
    }
}

   // if(setupType !== "BREAKOUT"){
    //if(marketState !== "TREND_STRONG" && distance > atrVal * 3.5){ // *4
        //return null
   // }
  //  }
    // ===== SL TP (GIỮ NGUYÊN) =====
    let swingLow = Math.min(...lows.slice(-20))
    let swingHigh = Math.max(...highs.slice(-20))

    let sl = side==="LONG"
        ? swingLow - atrVal
        : swingHigh + atrVal

    let risk = Math.abs(price - sl)
    if(risk / price < 0.002){
    return null
}

let rawTP = side === "LONG"
    ? price + risk * RR_THRESHOLD
    : price - risk * RR_THRESHOLD

    let tp

if(marketState === "SIDEWAY"){
    
    if(side === "LONG"){
        tp = Math.min(rawTP, resistance * 0.999)
    }else{
        tp = Math.max(rawTP, support * 1.001)
    }

}else if(marketState === "TREND_WEAK"){

    // clamp nhẹ
    if(side === "LONG"){
        tp = rawTP > resistance ? resistance * 1.002 : rawTP
    }else{
        tp = rawTP < support ? support * 0.998 : rawTP
    }

}else{
    // TREND_STRONG
    tp = rawTP
}
// kiểm tra khoảng cách giữa tp và price
if(Math.abs(tp - price) / price < 0.001){ //0.0015
    return null
}
        // candle có thân lớn so với toàn cây không (giữ nguyên)
let body = Math.abs(close - open)
let rangeCandle = highs.at(-1) - lows.at(-1)

if(rangeCandle === 0 || body / rangeCandle < 0.1){ //0.2
    score -= 15
}

    function round(n){ return Number(n.toFixed(4)) }

    if(!setupType){
    if(bosUp || bosDown){
        setupType = "BREAKOUT"
    }else{
        setupType = "PULLBACK"
    }
}

    return {
        side,
        score,
        dynamicThreshold,
        setup: setupType,
        marketState,
        volatility,
        momentumUp,
        momentumDown,
        price: round(price),
        prevPrice: round(prevPrice),
        sl: round(sl),
        tp: round(tp),
        atr: round(atrVal)
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

// ================= SCANNER ================
async function scanner(){
    
    if(isScanning){
        console.log("⛔ Skip scan trùng")
        return
    }

    isScanning = true

    try{
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

for(let i=0;i<symbols.length;i+=5){

    let chunk = symbols.slice(i,i+5)

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

    if(dbMain.total < 15) aiMain *= 0.5

    let finalMain = s.score + aiMain

    if(finalMain >= s.dynamicThreshold - 5){
        candidates.push({
            ...s,
            finalScore: finalMain,
            type: "MAIN"
        })
    }
}
        // ===== NO CANDIDATE =====
        if(!candidates || candidates.length === 0){
            console.log("❌ No signal")
            return
        }

        // ===== SORT =====
      candidates.sort((a,b)=>{

    if(a.marketState === "TREND_STRONG" && b.marketState !== "TREND_STRONG") return -1
    if(b.marketState === "TREND_STRONG" && a.marketState !== "TREND_STRONG") return 1

    return (b.finalScore || b.score) - (a.finalScore || a.score)
})
// ===== LỌC TẦNG 2 =====
let filtered = candidates.filter(c => {

    let rr = Math.abs(c.tp - c.price) / Math.abs(c.price - c.sl)

    // ❌ loại kèo quá xấu
    if(rr < RR_THRESHOLD) return false

    // ❌ score quá thấp
    let threshold = SCORE_THRESHOLD

//if(c.marketState === "SIDEWAY"){
    //threshold += 10
//}

if((c.finalScore || c.score) < threshold) return false

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
//let picks = filtered.slice(0, 3)
for (let best of filtered){

    let realActive = activeTrades.filter(
        x => !x.waitingEntry
    ).length

    let totalPending = activeTrades.length

    if(realActive >= 10){
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
        await binance.futuresPositionRisk({
    recvWindow: 20000
})

    let realPos = positions.find(p =>
        p.symbol === best.symbol &&
        Math.abs(Number(p.positionAmt)) > 0
    )

    // không còn position -> clear DB
    if(!realPos){

        await trades.updateOne(
            {
                _id: existing._id
            },
            {
                $set:{
                    result:"AUTO_CLEAR_NO_POSITION"
                }
            }
        )

    }else{

        console.log(`⛔ ${best.symbol} đang có lệnh`)
        continue
    }
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

    // ===== MOMENTUM FILTER =====
    if(best.setup === "BREAKOUT"){

        if(best.momentumUp || best.momentumDown){
            best.finalScore += 10
        }else{
            if(best.marketState === "SIDEWAY"){
                continue
            }
            best.finalScore -= 5
        }
    }

    let weakMomentum =
        Math.abs(best.price - best.sl)/best.price < 0.0015 &&
        !best.momentumUp && !best.momentumDown
    
    if(best.setup === "PULLBACK" && weakMomentum){
        continue
    }

    // ===== RR =====
    let rr = best.side === "LONG"
        ? (best.tp - best.price) / (best.price - best.sl)
        : (best.price - best.tp) / (best.sl - best.price)

    if(rr < RR_THRESHOLD){
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
    let zoneWidth = best.atr * 1.0

    let instantEntry = best.setup === "BREAKOUT"

let trade = {
    symbol: best.symbol,
    side: best.side,
    risk,
    entry: instantEntry ? best.price : null,

    entryZoneMid: best.price,
    entryZoneLow: best.price - zoneWidth,
    entryZoneHigh: best.price + zoneWidth,

    tp: best.tp,
    sl: best.sl,
    score: best.score,

    waitingEntry: !instantEntry,

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

    activeTrades.push(trade)

    if(activeTrades.length > 50){
        activeTrades.shift()
    }

    await trades.insertOne(trade)
    // ===== BREAKOUT = MARKET ENTRY =====
if(instantEntry){

    console.log(`⚡ INSTANT ENTRY ${best.symbol}`)

    // ===== 5% POSITION SIZE =====
let positionValue = ACCOUNT_BALANCE * POSITION_SIZE_PERCENT
let qtyBySize = positionValue / best.price

// ===== RISK CONTROL (SL) =====
let diff = Math.abs(best.price - best.sl)
if(!diff) continue

let risk = ACCOUNT_BALANCE * RISK_PER_TRADE * multiplier
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
    qty = Math.ceil(qty / stepSize) * stepSize

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

    function roundStep(value, step){
        return Math.floor(value / step) * step
    }

    function precisionFromStep(step){
        return Math.max(
            0,
            (step.toString().split(".")[1] || "")
                .replace(/0+$/,"")
                .length
        )
    }
    //qty = roundStep(qty, stepSize)

   // qty = Number(
      //  qty.toFixed(
            precisionFromStep(stepSize)
       // )
   // )
   qty = normalizeQtyFinal(qty, stepSize)

if(!qty || qty <= 0 || !isFinite(qty)){
    console.log("❌ QTY INVALID BEFORE SEND")
    continue
}

    let order = await openPosition(
    trade.symbol,
    trade.side,
    qty
)

if(!order){
    console.log("❌ ORDER FAIL")
    continue
}

// 🔥 CHỜ POSITION THẬT
let pos = await waitPosition(trade.symbol)

if(!pos){
    console.log("❌ NO POSITION AFTER OPEN → SKIP TPSL")

    // lưu lại để retry sau
    await trades.updateOne(
        { symbol: trade.symbol, createdAt: trade.createdAt },
        {
    $set:{
        tpslMissing:true,
        retryTPSL:true,
        enteredAt: Date.now()
    }
}
    )

    continue
}
    await new Promise(r => setTimeout(r, 1000))

let verifyPos = await binance.futuresPositionRisk({
    recvWindow: 20000
})

let realPos = verifyPos.find(p =>
    p.symbol === trade.symbol &&
    Math.abs(Number(p.positionAmt)) > 0
)

if(!realPos){
    console.log("❌ VERIFY FAIL → NO POSITION")

    await trades.updateOne(
        { symbol: trade.symbol, createdAt: trade.createdAt },
        { $set: { result: "NO_POSITION_VERIFY_FAIL" } }
    )

    continue
}

let realQty = Math.abs(Number(pos.positionAmt))

    if(order){

    trade.waitingEntry = false
    trade.enteredAt = Date.now()

    // lấy entry thật từ position
    let realEntry = Number(realPos.entryPrice)

    if(!realEntry || realEntry <= 0){
        realEntry = best.price
    }

    trade.entry = realEntry

        await trades.updateOne(
            {
                symbol: trade.symbol,
                createdAt: trade.createdAt
            },
            {
                $set:{
                    entry: trade.entry,
                    waitingEntry: false,
                    enteredAt: Date.now()
                }
            }
        )
        let ok = true

        if(!TPSL_LOCKS[trade.symbol]){

    let ok = await safeSetTPSL(
        trade.symbol,
        trade.side,
        trade.tp,
        trade.sl
    )
}

        console.log(`🔥 MARKET ENTER ${trade.symbol}`)
        let msg = `🔥 BEST SIGNAL

${best.symbol} (${best.setup})
${best.side} | ${best.marketState}

Entry: ${(trade.entry || best.price).toFixed(4)}

TP: ${best.tp.toFixed(4)}

SL: ${best.sl.toFixed(4)}

Size: ${qty.toFixed(2)}
Score: ${best.finalScore || best.score}
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
    //console.log(msg)
    //await sendTelegram(msg)
        
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
async function checkTrades(){

    if(checkingTrades) return
    checkingTrades = true

    try{

        if(activeTrades.length === 0){
            return
        }

        for(let i = activeTrades.length - 1; i >= 0; i--){

            let t = activeTrades[i]

            try{

                let data = await Promise.race([
    getData(t.symbol,"1m",2),
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

}else{
    DATA_FAILS[t.symbol] = 0
}

                let price = +data.at(-1)[4]

                // ================= ENTRY 1M CONFIRM =================
if(t.waitingEntry){

    if(!t.entryZoneMid || !price) continue

    let drift = Math.abs(price - t.entryZoneMid) / t.entryZoneMid

// dynamic drift theo ATR (thay vì cố định 1.5%)
let maxDrift = Math.max(0.015, t.atr / t.entryZoneMid * 2.5)

if(drift > maxDrift){

    console.log(`⛔ SKIP ENTRY (too far) ${t.symbol}`)

    activeTrades.splice(i,1)

    await trades.updateOne(
        { symbol: t.symbol, createdAt: t.createdAt },
        { $set: { result: "MISSED_ENTRY" } }
    )

    continue
}
     // timeout 1h
    let waitTime = Date.now() - t.createdAt
    
    if(waitTime > 2 * 60 * 60 * 1000){
    console.log(`⛔ Timeout entry ${t.symbol}`)

    await trades.updateOne(
        { symbol: t.symbol, createdAt: t.createdAt },
        { $set: { result: "CANCEL_ENTRY" } }
    )

    await sendTelegram2(
`⛔ TIMEOUT ENTRY ${t.symbol}
${t.side}
❌ Không khớp entry `
    )

    activeTrades.splice(i,1)
    continue
}

    // ATR 
    if(!t.atr || !t.entryZoneMid){
    continue
}

   // ===== ENTRY LOGIC =====
let confirm = false

if(!price || price <= 0) continue

let atrRatio = t.atr / price
atrRatio = Math.max(0.002, Math.min(atrRatio, 0.03))

let zoneLow  = t.entryZoneLow
let zoneHigh = t.entryZoneHigh

// 🔥 entry cực thoáng
let buffer = t.atr * (0.6 + atrRatio * 4)
buffer = Math.min(buffer, t.atr * 4)

// 🔥 cho chase breakout
let breakoutBuffer = t.atr * 1.5

// 🔥 cancel xa hơn
let chaseLimit = t.atr * 6



// ================= LONG =================
if(t.side === "LONG"){

    // reversal
    if(t.setup === "REVERSAL_BOTTOM"){

        if(price >= zoneLow - buffer){
            confirm = true
        }

    }else{

        // vùng pullback rộng
        if(
            price >= zoneLow - buffer &&
            price <= zoneHigh + buffer
        ){
            confirm = true
        }

        // breakout follow
        if(
            price > zoneHigh &&
            price <= zoneHigh + breakoutBuffer
        ){
            confirm = true
        }
    }

    // cancel chase
    if(price > zoneHigh + chaseLimit){

        activeTrades.splice(i,1)

        await trades.updateOne(
            {
                symbol: t.symbol,
                createdAt: t.createdAt
            },
            {
                $set:{
                    result:"CANCEL_CHASE"
                }
            }
        )

        continue
    }
}



// ================= SHORT =================
if(t.side === "SHORT"){

    // reversal
    if(t.setup === "REVERSAL_TOP"){

        if(price <= zoneHigh + buffer){
            confirm = true
        }

    }else{

        // vùng pullback rộng
        if(
            price <= zoneHigh + buffer &&
            price >= zoneLow - buffer
        ){
            confirm = true
        }

        // breakout follow
        if(
            price < zoneLow &&
            price >= zoneLow - breakoutBuffer
        ){
            confirm = true
        }
    }

    // cancel chase
    if(price < zoneLow - chaseLimit){

        activeTrades.splice(i,1)

        await trades.updateOne(
            {
                symbol: t.symbol,
                createdAt: t.createdAt
            },
            {
                $set:{
                    result:"CANCEL_CHASE"
                }
            }
        )

        continue
    }
}
    // ===== VÀO LỆNH =====
    if(confirm){

        await trades.updateOne(
    {
        symbol:t.symbol,
        createdAt:t.createdAt
    },
    {
        $set:{
            entry:t.entry,
            waitingEntry:false,
            enteredAt: Date.now()
        }
    }
)

    let diff = Math.abs(t.entry - t.sl)
if(!diff || diff <= 0) continue

let risk = t.risk || (ACCOUNT_BALANCE * RISK_PER_TRADE)
if(!risk || risk <= 0) continue

let maxSlPercent = 0.05

if(diff / t.entry > maxSlPercent){

    console.log(`⚠️ AUTO TIGHT SL ${t.symbol}`)

    let newDiff = t.entry * maxSlPercent

    if(t.side === "LONG"){

        t.sl = t.entry - newDiff
        t.tp = t.entry + newDiff * RR_THRESHOLD

    }else{

        t.sl = t.entry + newDiff
        t.tp = t.entry - newDiff * RR_THRESHOLD
    }

    diff = Math.abs(t.entry - t.sl)
}

    if(!diff || !isFinite(diff) || diff < 1e-8){
        console.log("❌ INVALID DIFF")
        continue
    }
    let minDiff = t.entry * 0.002

if(diff < minDiff){

    console.log(`❌ SL TOO CLOSE ${t.symbol}`)

    await trades.updateOne(
        { symbol:t.symbol, createdAt:t.createdAt },
        { $set:{ result:"SL_TOO_CLOSE" } }
    )

    activeTrades.splice(i,1)

    continue
}

    if(!risk || risk <= 0){
        console.log("❌ INVALID RISK")
        continue
    }

    let rawQty = risk / diff

    if(!rawQty || !isFinite(rawQty) || rawQty <= 0){
        console.log("❌ INVALID QTY (RAW)")
        continue
    }

    let qty = rawQty

    if(!qty || !isFinite(qty) || qty <= 0){
        console.log("❌ INVALID QTY")
        continue
    }

    let maxNotional = ACCOUNT_BALANCE * 5

if(qty * t.entry > maxNotional){

    console.log(`❌ POSITION TOO BIG ${t.symbol}`)

    await trades.updateOne(
        { symbol:t.symbol, createdAt:t.createdAt },
        { $set:{ result:"POSITION_TOO_BIG" } }
    )

    activeTrades.splice(i,1)

    continue
}
    if(risk > ACCOUNT_BALANCE * 0.05){

    console.log(`❌ RISK TOO HIGH ${t.symbol}`)

    await trades.updateOne(
        {
            symbol:t.symbol,
            createdAt:t.createdAt
        },
        {
            $set:{
                result:"RISK_TOO_HIGH"
            }
        }
    )

    activeTrades.splice(i,1)

    continue
}

    let info = await getSymbolInfo(t.symbol)

    if(!info || !info.filters){
        console.log(`❌ NO SYMBOL INFO ${t.symbol}`)
        continue
    }

    let lotFilter = info.filters.find(f => f.filterType === "LOT_SIZE")
    let priceFilter = info.filters.find(f => f.filterType === "PRICE_FILTER")
    //let minNotionalFilter = info.filters.find(f => f.filterType === "MIN_NOTIONAL")
    let minNotionalFilter =
    info.filters.find(
        f =>
            f.filterType === "MIN_NOTIONAL" ||
            f.filterType === "NOTIONAL"
    )

    let stepSize = parseFloat(lotFilter?.stepSize || 0.001)
    let minQty = parseFloat(lotFilter?.minQty || 0)

    let tickSize = parseFloat(priceFilter?.tickSize || 0.01)

    let minNotional = minNotionalFilter
        ? parseFloat(minNotionalFilter.notional)
        : 5

    function roundStep(value, step){
        return Math.floor(value / step) * step
    }

    function precisionFromStep(step){
        return Math.max(
            0,
            (step.toString().split(".")[1] || "")
                .replace(/0+$/,"")
                .length
        )
    }
        
    function roundToTick(price, tickSize, mode="down"){
    if(mode === "down"){
        return Math.floor(price / tickSize) * tickSize
    }
    return Math.ceil(price / tickSize) * tickSize
}

if(t.side === "LONG"){
    t.tp = roundToTick(t.tp, tickSize, "down")
    t.sl = roundToTick(t.sl, tickSize, "down")
}else{
    t.tp = roundToTick(t.tp, tickSize, "up")
    t.sl = roundToTick(t.sl, tickSize, "up")
}

    function countDecimals(value){
        if(!value || Math.floor(value) === value) return 0
        return value.toString().split(".")[1]?.length || 0
    }

    let pricePrecision = countDecimals(tickSize)

    t.tp = Number(t.tp.toFixed(pricePrecision))
    t.sl = Number(t.sl.toFixed(pricePrecision))
    diff = Math.abs(t.entry - t.sl)

if(
    !diff ||
    !isFinite(diff) ||
    diff <= tickSize
){

    console.log(`❌ INVALID DIFF ${t.symbol}`)

    await trades.updateOne(
        {
            symbol:t.symbol,
            createdAt:t.createdAt
        },
        {
            $set:{
                result:"INVALID_DIFF"
            }
        }
    )

    activeTrades.splice(i,1)

    continue
}

    if(qty < minQty){
        console.log(`❌ QTY < MIN_QTY ${t.symbol}`)
        continue
    }

    let notional = qty * t.entry

    if(notional < minNotional){

        qty = Math.ceil((minNotional / t.entry) / stepSize) * stepSize

        notional = qty * t.entry

        console.log(`⚡ AUTO FIX NOTIONAL ${t.symbol}`)
    }

    if(notional < minNotional){
        console.log(`❌ NOTIONAL TOO SMALL ${t.symbol}`)
        continue
    }

    let lock = await trades.findOneAndUpdate(
    {
        symbol: t.symbol,
        createdAt: t.createdAt,
        opening: { $ne: true }
    },
    {
        $set: { opening: true }
    },
    {
        returnDocument: "before"
    }
)

if(!lock){
    console.log(`⛔ LOCKED ${t.symbol}`)
    continue
}

    let positions = await binance.futuresPositionRisk({
    recvWindow: 20000
})

    let hasPos = positions.find(p =>
        p.symbol === t.symbol &&
        Math.abs(Number(p.positionAmt)) > 0
    )

    if(hasPos){

        console.log(`⛔ POSITION EXISTS ${t.symbol}`)

        await trades.updateOne(
            { symbol: t.symbol, createdAt: t.createdAt },
            { $set: { result: "POSITION_EXISTS" } }
        )

        activeTrades.splice(i,1)
        continue
    }

    let order = await openPosition(t.symbol, t.side, qty)

    if(!order){

        console.log("❌ ORDER FAIL")

        await trades.updateOne(
            { symbol: t.symbol, createdAt: t.createdAt },
            { $set: { result: "ORDER_FAIL" } }
        )

        activeTrades.splice(i,1)
        continue
    }

    await new Promise(r => setTimeout(r, 1500))

    let realQty = Math.abs(Number(order.executedQty))

    if((!realQty || realQty <= 0) && order.status === "FILLED"){
        realQty = qty
    }

    if(!realQty || realQty <= 0){
        console.log(`❌ ORDER NOT FILLED ${t.symbol}`)
        continue 
    }
    //await sendTelegram(msg)

    await cancelTPSLOrders(t.symbol)

await new Promise(r => setTimeout(r, 500))

const tpsl = await setTPSL( t.symbol, t.side, t.tp, t.sl, realQty )
        await trades.updateOne(
{
    symbol: t.symbol,
    createdAt: t.createdAt
},
{
    $unset: { opening: "" }
}
)

    if(!tpsl.ok){

    console.log(`❌ TPSL FAIL ${t.symbol}`)

    await sendTelegram2(
`❌ TPSL FAIL ${t.symbol}
${t.side}

Đang force close position
${tpsl.error}`
    )

    await closePosition(
        t.symbol,
        t.side,
        realQty
    )
        await new Promise(r => setTimeout(r, 2000))

let positionsAfter = await binance.futuresPositionRisk({
    recvWindow: 20000
})

let stillOpen = positionsAfter.find(p =>
    p.symbol === t.symbol &&
    Math.abs(Number(p.positionAmt)) > 0
)

if(stillOpen){

    console.log(`🚨 FORCE CLOSE FAILED ${t.symbol}`)

    await sendTelegram2(
`🚨 NGUY HIỂM
${t.symbol} vẫn còn position mở
TPSL chưa tồn tại`
    )
}

    await trades.updateOne(
        {
            symbol: t.symbol,
            createdAt: t.createdAt
        },
        {
            $set: {
                result: "TPSL_FAIL"
            }
        }
    )

    activeTrades.splice(i,1)

    continue
}
} else {
    continue
}
}
// ===== RESULT CHECK =====
if(!t.entry) continue

let win = false
let done = false

if(t.side === "LONG"){
    if(price >= t.tp){ win = true; done = true }
    if(price <= t.sl){ done = true }
}

if(t.side === "SHORT"){
    if(price <= t.tp){ win = true; done = true }
    if(price >= t.sl){ done = true }
}

if(!t.enteredAt){
    t.enteredAt = Date.now()
}
let isTimeout =
    t.enteredAt &&
    Date.now() - t.enteredAt > 43200000 // 12h

if(isTimeout){

    await trades.updateOne(
        { symbol: t.symbol, createdAt: t.createdAt },
        { $set: { result: "TIMEOUT" } }
    )

    await sendTelegram2(
`⏳ TIMEOUT ${t.symbol}
${t.side}`
    )

    activeTrades.splice(i,1)
    continue
}

if(done){

    await trades.updateOne(
        { symbol: t.symbol, createdAt: t.createdAt },
        { $set: { result: win ? "WIN" : "LOSS" } }
    )

    await sendTelegram2(
`📊 RESULT ${t.symbol}
${t.side}
${win ? "WIN" : "LOSS"}`
    )

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

        await cancelAllOrders(symbol)

        await new Promise(r =>
            setTimeout(r, 1000)
        )

        let closeSide =
            side === "LONG"
                ? "SELL"
                : "BUY"

        let order = await binance.futuresOrder({

            symbol,
            recvWindow: 20000,
            side: closeSide,
            type: "MARKET",
            quantity: qty,
            reduceOnly: true
        })

        // ===== VERIFY CLOSED =====
        for(let i=0;i<20;i++){

            await new Promise(r =>
                setTimeout(r, 1500)
            )

            let positions =
                await binance.futuresPositionRisk({
    recvWindow: 20000
})

            let pos = positions.find(p =>
                p.symbol === symbol &&
                Math.abs(Number(p.positionAmt)) > 0
            )

            if(!pos){

                return true
            }
        }

        return false

    }catch(e){

        console.log(
            `❌ FORCE CLOSE ${symbol}:`,
            e.message
        )

        return false
    }
}
/////////
async function watchdogTPSL(){

    // 🔒 CHẶN WATCHDOG CHẠY ĐÈ
    if(WATCHDOG_RUNNING){
        return
    }
    WATCHDOG_RUNNING = true
    try{
        let positions = await binance.futuresPositionRisk({
    recvWindow: 20000
})
        for(let p of positions){
             if(TPSL_LOCKS[symbol]){
    continue
}
            let amt = Math.abs(Number(p.positionAmt))
            if(amt <= 0){
                continue
            }
            let symbol = p.symbol
            // 🔒 LOCK THEO SYMBOL
            if(WATCHDOG_LOCKS[symbol]){
                continue
            }
            WATCHDOG_LOCKS[symbol] = true
            try{
                // 🔒 đang set TPSL thì skip
                if(TPSL_LOCKS[symbol]){
                    continue
                }
                let orders = await binance.futuresOpenOrders({
                    symbol,
                    recvWindow: 20000
                })
                let closeSide =
                    Number(p.positionAmt) > 0
                        ? "SELL"
                        : "BUY"
                let hasSL = orders.find(
                    o =>
                        o.type === "STOP_MARKET" &&
                        o.side === closeSide &&
                        o.closePosition
                )
                let hasTP = orders.find(
                    o =>
                        o.type === "TAKE_PROFIT_MARKET" &&
                        o.side === closeSide &&
                        o.closePosition
                )
                // ✅ ĐỦ TPSL
                if(hasSL && hasTP){
                    delete TPSL_MISSING[symbol]
                    continue
                }
                // ===== MARK MISSING =====
                if(!TPSL_MISSING[symbol]){
                    TPSL_MISSING[symbol] = Date.now()
                }
                console.log(`🚨 NO TPSL ${symbol}`)
                let trade = activeTrades.find(
                    x => x.symbol === symbol
                )
                // ===== RECOVER DB =====
                if(!trade || !trade.tp || !trade.sl){
                    try{
                        let dbTrade = await trades.findOne({
                            symbol,
                            result:"PENDING"
                        })
                        if(dbTrade){
                            trade = dbTrade
                            let exists = activeTrades.find(
                                x => x.symbol === symbol
                            )
                            if(!exists){
                                activeTrades.push(dbTrade)
                            }
                            console.log(
                                `♻️ RECOVER TRADE ${symbol}`
                            )
                        }

                    }catch(e){
                        console.log(
                            `❌ RECOVER DB ${symbol}:`,
                            e.message
                        )
                    }
                }
                // ===== KHÔNG RECOVER ĐƯỢC =====
                if(!trade || !trade.tp || !trade.sl){
                    let missingTime =
                        Date.now() - TPSL_MISSING[symbol]
                    // ⏳ CHỜ BINANCE SYNC
                    if(missingTime < 180000){
                        console.log(
                            `⏳ WAIT TPSL ${symbol}`
                        )
                        continue
                    }
                    console.log(
                        `🚨 FORCE CLOSE NO DATA ${symbol}`
                    )
                    await closePosition(
                        symbol,
                        Number(p.positionAmt) > 0
                            ? "LONG"
                            : "SHORT",
                        amt
                    )
                    continue
                }
                // ===== RETRY TPSL =====
                let ok = await safeSetTPSL(
                    symbol,
                    trade.side,
                    trade.tp,
                    trade.sl
                )
                // ===== TPSL FAIL =====
                if(!ok){
                    let missingTime =
                        Date.now() - TPSL_MISSING[symbol]
                    // ⏳ CHỜ BINANCE SYNC
                    if(missingTime < 180000){
                        console.log(
                            `⏳ WAIT TPSL ${symbol}`
                        )
                        continue
                    }
                    console.log(
                        `🚨 FORCE CLOSE ${symbol}`
                    )
                    await closePosition(
                        symbol,
                        trade.side,
                        amt
                    )
                }
            }catch(e){

                console.log(
                    `WATCHDOG ${symbol}:`,
                    e.message
                )
                if(
        e.message &&
        e.message.includes("recvWindow")
    ){

        console.log("🕒 RESYNC TIME")

        await syncTime()
    }
            }finally{
                // 🔓 RELEASE SYMBOL LOCK
                delete WATCHDOG_LOCKS[symbol]
            }
        }
    }catch(e){
        console.log(
            "WATCHDOG TPSL:",
            e.message
        )
    }finally{
        // 🔓 RELEASE GLOBAL LOCK
        WATCHDOG_RUNNING = false
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
setInterval(watchdogTPSL, 15000)
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
/////////////////
        await trades.updateMany(
    {
        result: "PENDING",
        createdAt: {
            $lt: Date.now() - 12 * 60 * 60 * 1000
        }
    },
    {
        $set: {
            result: "EXPIRED"
        }
    }
)

        // 🔥 LOAD LẠI LỆNH
        activeTrades = await trades.find({ result: "PENDING" }).toArray()
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

    if(TELEGRAM_RUNNING) return   // 🔥 CHẶN CHẠY 2 LẦN
    TELEGRAM_RUNNING = true

    while(true){
        try{
            await checkCommand()
            await checkTrades() // 👈 thêm luôn vào đây
        }catch(e){
            console.log("CMD LOOP:", e.message)
        }

        await new Promise(r => setTimeout(r, 2000))
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

        let minSample = Math.min(Math.max(20, Math.floor(totalDB * 0.1)), 50)

        // ===== QUERY CHÍNH =====
        let data = await col.find({
            setup,
            marketState: market,
            side,
            result: { $ne: "PENDING" }
        }).toArray()

        // ===== FILTER VOL =====
        let filtered = data.filter(t => !t.volatility || t.volatility === volatility)

        // ===== ƯU TIÊN VOL =====
        if(filtered.length >= minSample){
            data = filtered
        }

        // ===== FALLBACK 1 =====
        if(data.length < minSample){
            data = await col.find({
                setup,
                side,
                result: { $ne: "PENDING" }
            }).toArray()
        }

        // ===== FALLBACK 2 =====
        if(data.length < minSample){
            data = await col.find({
                side,
                result: { $ne: "PENDING" }
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
            let weight = Math.exp(-ageHours / 120)

            if(t.result === "WIN"){
                winScore += weight
            }
            else if(t.result === "LOSS"){
                lossScore += weight
            }
            else{
                lossScore += weight * 0.5
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
async function getBestTPSL(setup, market, side){

    if(!trades) return null

    let data = await trades.find({
        setup,
        marketState: market,
        side,
        result: { $in: ["WIN","LOSS","TIMEOUT"] }
    }).toArray()

    if(data.length < 30) return null

    let rrArr = []

    for(let t of data){

        let risk = Math.abs(t.entry - t.sl)
        if(!risk || risk === 0) continue

        let rr = t.side === "LONG"
            ? (t.tp - t.entry) / risk
            : (t.entry - t.tp) / risk

        if(rr > 0.5 && rr < 5){
            rrArr.push(rr)
        }
    }

    if(rrArr.length === 0) return null

    rrArr.sort((a,b)=>a-b)

    let best = rrArr[Math.floor(rrArr.length * 0.6)]

    return { rr: best }
}
            
start()
async function fixTPSL(){

    for(let t of activeTrades){

        if(!t.tpslMissing) continue

        let pos = await waitPosition(t.symbol)
        

        if(!pos) continue

        let qty = Math.abs(Number(pos.positionAmt))

        let ok = await safeSetTPSL(
            t.symbol,
            t.side,
            t.tp,
            t.sl,
            qty
        )

        if(ok){
            t.retryTPSL = false
            console.log(`✅ FIX TPSL ${t.symbol}`)
        }
    }
}

setInterval(fixTPSL, 15000)
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
