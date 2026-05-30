let TPSL_GLOBAL_LOCK = {}
let WATCHDOG_LAST_RUN = 0
let TIME_SYNCED = false
let TPSL_PENDING = {}
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

        serverTimeOffset = Math.floor(
    data.serverTime - end + latency
)

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
    recvWindow: 20000,
    getTime: () => getTimestamp()
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

const SCORE_THRESHOLD = 52 // 110
const RR_THRESHOLD = 0.9 // 1.3 hoặc 1.4 nếu muốn 

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
async function hasPosition(symbol){

    try{

        let positions =
            await binance.futuresPositionRisk({
                recvWindow: 20000
            })

        return positions.find(p =>
            p.symbol === symbol &&
            Math.abs(Number(p.positionAmt)) > 0.00001
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

    }else{

        console.log(`⏳ WAIT FILL ${symbol}: ${data.status}`)
    }

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

    for(let i=0;i<15;i++){

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
        // ===== WAIT REAL CANCEL =====
        for(let i=0;i<35;i++){
            await new Promise(r =>
                setTimeout(r, 1000)
            )
            let remain =
                await binance.futuresOpenOrders({
                    symbol,
                    recvWindow:20000
                })
            let stillHas = remain.find(o =>
                o.type === "STOP_MARKET" ||
                o.type === "TAKE_PROFIT_MARKET"
            )
            if(!stillHas){
                return true
            }
        }
        return false
    }catch(e){
        console.log(
            `❌ CANCEL TPSL ${symbol}:`,
            e.message
        )
        return false
    }
}
async function hasFullTPSL(symbol){

    try{

        let positions =
            await binance.futuresPositionRisk({
                recvWindow:20000
            })

        let pos = positions.find(p =>
            p.symbol === symbol &&
            Math.abs(Number(p.positionAmt)) > 0
        )

        if(!pos){
            return false
        }

        let closeSide =
            Number(pos.positionAmt) > 0
                ? "SELL"
                : "BUY"

        let orders =
            await binance.futuresOpenOrders({
                symbol,
                recvWindow:20000
            })

        let hasSL = orders.find(o =>

            (
                o.type === "STOP_MARKET" ||
                o.type === "STOP"
            ) &&
            o.side === closeSide &&
            (
                o.closePosition === true ||
                String(o.closePosition) === "true"
            )
        )

        let hasTP = orders.find(o =>

            (
                o.type === "TAKE_PROFIT_MARKET" ||
                o.type === "TAKE_PROFIT"
            ) &&
            o.side === closeSide &&
            (
                o.closePosition === true ||
                String(o.closePosition) === "true"
            )
        )

        return !!(hasSL && hasTP)

    }catch(e){

        console.log(
            `❌ hasFullTPSL ${symbol}:`,
            e.message
        )

        return false
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
    (
        o.type === "STOP_MARKET" ||
        o.type === "STOP"
    ) &&
    o.side === closeSide &&
    (
        o.closePosition === true ||
        String(o.closePosition) === "true"
    )
)
let hasTP = openOrders.find(o =>

    (
        o.type === "TAKE_PROFIT_MARKET" ||
        o.type === "TAKE_PROFIT"
    ) &&
    o.side === closeSide &&
    (
        o.closePosition === true ||
        String(o.closePosition) === "true"
    )
)
        // ===== ĐỦ TPSL =====
let alreadyOK = await hasFullTPSL(symbol)

if(alreadyOK){

    console.log(`✅ TPSL EXISTS ${symbol}`)

    return {
        ok:true,
        existed:true
    }
}

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
        let slAlreadyExists = false
        let tpAlreadyExists = false
        // ===== CREATE SL =====
if(!hasSL){

    try{
        
        let slOrder = await binance.futuresOrder({
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

        const msg = String(e.message || e)

        if(
            msg.includes("already exists") ||
            msg.includes("closePosition in the direction is existing")
        ){

            console.log(`⚠️ SL MAY EXIST ${symbol}`)

        }else{

            return {
                ok:false,
                error:"SL_FAIL: " + msg
            }
        }
    }
}

        await new Promise(r =>
            setTimeout(r, 1500)
        )

        // ===== CREATE TP =====
if(!hasTP){

    try{

        let tpOrder = await binance.futuresOrder({
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

        const msg = String(e.message || e)

        if(
            msg.includes("already exists") ||
            msg.includes("closePosition in the direction is existing")
        ){

            console.log(`⚠️ TP MAY EXIST ${symbol}`)

        }else{

            return {
                ok:false,
                error:"TP_FAIL: " + msg
            }
        }
    }
}

        // ===== FINAL VERIFY =====
await new Promise(r =>
    setTimeout(r, 2500)
)

let verify =
    await binance.futuresOpenOrders({
        symbol,
        recvWindow:20000
    })

let finalSL = verify.find(o =>
    o.side === closeSide &&
    o.type.includes("STOP")
)

let finalTP = verify.find(o =>
    o.side === closeSide &&
    o.type.includes("TAKE_PROFIT")
)

if(finalSL && finalTP){
    console.log(`✅ TPSL VERIFIED ${symbol}`)
    delete TPSL_MISSING[symbol]

    return {
        ok:true
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
    try{

    let posCheck = await binance.futuresPositionRisk({
        recvWindow: 20000
    })

    let pos = posCheck.find(p =>
        p.symbol === symbol &&
        Math.abs(Number(p.positionAmt)) > 0
    )

    // ❌ không còn position
    if(!pos){

        delete TPSL_CONFIRMED[symbol]
        delete TPSL_MISSING[symbol]

    }else{

        // ===== VERIFY TPSL THẬT =====
        let verify =
            await binance.futuresOpenOrders({
                symbol,
                recvWindow:20000
            })

        let closeSide =
            Number(pos.positionAmt) > 0
                ? "SELL"
                : "BUY"

        let hasSL = verify.find(o =>

    (
        o.type === "STOP_MARKET" ||
        o.type === "STOP"
    ) &&
    o.side === closeSide &&
    (
        o.closePosition === true ||
        String(o.closePosition) === "true"
    )
)

let hasTP = verify.find(o =>

    (
        o.type === "TAKE_PROFIT_MARKET" ||
        o.type === "TAKE_PROFIT"
    ) &&
    o.side === closeSide &&
    (
        o.closePosition === true ||
        String(o.closePosition) === "true"
    )
)

        // ✅ TPSL thật sự tồn tại
        if(hasSL && hasTP){

            TPSL_CONFIRMED[symbol] = Date.now()

            return {
                ok:true,
                existed:true
            }
        }

        // ❌ fake confirmed
        delete TPSL_CONFIRMED[symbol]
    }

}catch(e){
}

   if(
    (
        TPSL_LOCKS[symbol] &&
        Date.now() - TPSL_LOCKS[symbol] < 60000
    ) ||
    (
        TPSL_PENDING[symbol] &&
        Date.now() - TPSL_PENDING[symbol] < 60000
    ) ||
    (
        TPSL_GLOBAL_LOCK[symbol] &&
        Date.now() - TPSL_GLOBAL_LOCK[symbol] < 60000
    )
){
    return {
    ok:false,
    error:"LOCKED"
}
}

TPSL_GLOBAL_LOCK[symbol] = Date.now()

TPSL_PENDING[symbol] = Date.now()

TPSL_LOCKS[symbol] = Date.now()

    try{

        for(let i=0;i<3;i++){

            let res = await setTPSL(
                symbol,
                side,
                tp,
                sl
            )

            if(res && res.ok){

    // VERIFY REAL TPSL AGAIN
    let verify = await binance.futuresOpenOrders({
        symbol,
        recvWindow:20000
    })

    let posCheck = await binance.futuresPositionRisk({
        recvWindow:20000
    })

    let pos = posCheck.find(p =>
        p.symbol === symbol &&
        Math.abs(Number(p.positionAmt)) > 0
    )

    if(!pos){

        return {
            ok:false,
            error:"POSITION_LOST"
        }
    }

    let closeSide =
        Number(pos.positionAmt) > 0
            ? "SELL"
            : "BUY"

    let finalSL = verify.find(o =>
        (
            o.type === "STOP_MARKET" ||
            o.type === "STOP"
        ) &&
        o.side === closeSide &&
        String(o.closePosition) === "true"
    )

    let finalTP = verify.find(o =>
        (
            o.type === "TAKE_PROFIT_MARKET" ||
            o.type === "TAKE_PROFIT"
        ) &&
        o.side === closeSide &&
        String(o.closePosition) === "true"
    )

    if(finalSL && finalTP){

        console.log(`✅ TPSL VERIFIED ${symbol}`)

        delete TPSL_MISSING[symbol]

        return {
            ok:true
        }
    }

    console.log(`⚠️ TPSL FAKE CONFIRMED ${symbol}`)


    await new Promise(r =>
        setTimeout(r, 3000)
    )

    continue
}

            console.log(
    `⚠️ TPSL retry ${symbol} ${i+1}:`,
    res?.error || "UNKNOWN"
)

            // jika Binance chưa sync cancel
if(
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

        return {
    ok:false,
    error:"TPSL_RETRY_FAIL"
}

    }finally{
        delete TPSL_GLOBAL_LOCK[symbol]
        delete TPSL_PENDING[symbol]
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
                      // 🔥 1. SQUEEZE (quan trọng nhất)
    .filter(c => {
        let change = Math.abs(Number(c.priceChangePercent))
        // coin chưa chạy nhưng có dấu hiệu tích lực
        return change >= 1.5 && change <= 7 // 
    })
    // 🔥 2. LIQUIDITY nhẹ (KHÔNG dùng minVol 24h nữa)
    .filter(c =>
        Number(c.quoteVolume) > 3_000_000
    )
    .filter(c => {

    let high = Number(c.highPrice)
    let low  = Number(c.lowPrice)
    let last = Number(c.lastPrice)

    if(!high || !low || !last) return false

    let dayRange = (high - low) / last

    return dayRange > 0.02
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
        Math.abs(moveA - 4) * 8

    let scoreB =
        (volB / 1_000_000) -
        Math.abs(moveB - 4) * 8

    return scoreB - scoreA
})
    .slice(0, 50)
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
// ================= CORE (FIXED FOR FREQUENT SIGNALS) =================
async function coreLogic(data15, data1h){

    let closes = data15.map(x=>+x[4])
    let opens  = data15.map(x=>+x[1])
    let highs  = data15.map(x=>+x[2])
    let lows   = data15.map(x=>+x[3])
    let volumes= data15.map(x=>+x[5])
    let closes1h = data1h.map(x=>+x[4])

    let price = closes.at(-1)
    let prevPrice = closes.at(-2)

    let last30 = volumes.slice(-30)
    if(last30.length < 15) return null

    let volAvg = last30.reduce((a,b)=>a+b,0)/last30.length
    let volNow = volumes.at(-1)

    let volAvgUSDT = volAvg * price
    let volNowUSDT = volNow * price

    let atrVal = atr(data15.slice(-100))
    if(!atrVal || atrVal <= 0){
        atrVal = price * 0.003
    }
    let atrRatio = atrVal / price

    // ================= MARKET FILTER (SOFT, KHÔNG KILL) =================
    if(atrRatio < 0.0008) return null   // chỉ bỏ market chết thật

    // ================= EMA =================
    let ema20  = ema(closes.slice(-100), 20)
    let ema50  = ema(closes.slice(-200), 50)
    let ema200 = ema(closes.slice(-500), 200)

    let ema20_1h  = ema(closes1h.slice(-60),20)
    let ema50_1h  = ema(closes1h.slice(-120),50)

    let emaGap = Math.abs(ema20 - ema50) / price

    // ================= MARKET STATE (KHÔNG RETURN NULL) =================
    let marketState =
        emaGap > 0.003 ? "TREND_STRONG" :
        emaGap > 0.0015 ? "TREND_WEAK" :
        "RANGE"

    // ================= BIAS =================
    let trendLong  = ema20 > ema50
    let trendShort = ema20 < ema50

    let r = rsi(closes.slice(-50))

    // ================= MOMENTUM (SOFT) =================
    let momentum = (closes.at(-1) - closes.at(-4)) / closes.at(-4)

    // ================= SCORE SYSTEM (KEY FIX) =================
    let scoreLong = 0
    let scoreShort = 0

    if(trendLong) scoreLong += 2
    if(trendShort) scoreShort += 2

    if(momentum > atrRatio * 0.15) scoreLong += 1
    if(momentum < -atrRatio * 0.15) scoreShort += 1

    if(r > 50 && r < 75) scoreLong += 1
    if(r < 50 && r > 25) scoreShort += 1

    if(volNowUSDT > volAvgUSDT) {
        scoreLong += 0.5
        scoreShort += 0.5
    }

    // ================= STRUCTURE (SOFT, KHÔNG BLOCK) =================
    let hArr = highs.slice(-30)
    let lArr = lows.slice(-30)

    let rangeHigh = Math.max(...hArr)
    let rangeLow  = Math.min(...lArr)

    let pos = (price - rangeLow) / (rangeHigh - rangeLow || 1)

    if(pos > 0.45 && pos < 0.55){
        // giảm nhẹ điểm, KHÔNG return
        scoreLong -= 0.5
        scoreShort -= 0.5
    }

    // ================= WICK FILTER (SOFT) =================
    let high = highs.at(-1)
    let low  = lows.at(-1)
    let open = opens.at(-1)
    let close= closes.at(-1)

    let candleRange = high - low || 1
    let upperWick = high - Math.max(open, close)
    let lowerWick = Math.min(open, close) - low

    let wickRatio = Math.max(upperWick, lowerWick) / candleRange

    if(wickRatio > 0.65){
        scoreLong -= 1
        scoreShort -= 1
    }

    // ================= DECISION (IMPORTANT FIX) =================
    let side = null

    if(scoreLong >= 2.5 && scoreLong > scoreShort){
        side = "LONG"
    }
    else if(scoreShort >= 2.5 && scoreShort > scoreLong){
        side = "SHORT"
    }
    else{
        return null
    }

    // ================= SL / TP =================
    let swingLow = Math.min(...lows.slice(-20))
    let swingHigh = Math.max(...highs.slice(-20))

    let sl = side === "LONG"
        ? swingLow - atrVal * 0.8
        : swingHigh + atrVal * 0.8

    let risk = Math.abs(price - sl)
    if(risk / price < 0.0015) return null

    let rr = 1.05
    if(marketState === "TREND_STRONG") rr = 1.2
    if(atrRatio > 0.006) rr += 0.1

    let tp = side === "LONG"
        ? price + risk * rr
        : price - risk * rr

    return {
        side,
        setup: "GROWTH_CORE_V2",
        marketState,
        volatility: atrRatio > 0.004 ? "HIGH" : "MID",
        price,
        prevPrice,
        sl,
        tp,
        atr: atrVal,
        scoreLong,
        scoreShort
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

    if(dbMain.total < 15) aiMain *= 0.9

    let finalMain = aiMain

    if(finalMain >= - 5){
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

    return b.finalScore - a.finalScore
})
// ===== LỌC TẦNG 2 =====
let filtered = candidates.filter(c => {

    let rr = Math.abs(c.tp - c.price) / Math.abs(c.price - c.sl)

    // ❌ loại kèo quá xấu
    if(rr < RR_THRESHOLD) return false

    // ❌ score quá thấp
    if(c.finalScore < -10){
    return false
}
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

    //let realActive = activeTrades.filter(
    //x =>
        //x.result === "PENDING" &&
       // !x.waitingEntry
//).length
let positions = await binance.futuresPositionRisk({
    recvWindow: 20000
})

let realActive = positions.filter(p =>
    Math.abs(Number(p.positionAmt)) > 0
).length

    let totalPending = activeTrades.filter(
    x => x.result === "PENDING"
).length

    if(realActive >= 15){
        console.log(`⚠️ MAX REAL ACTIVE: ${realActive}`)
        break
    }

    if(totalPending >= 30){
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
        existing = null // 🔥 QUAN TRỌNG

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

    let weakMomentum =
        Math.abs(best.price - best.sl)/best.price < 0.003 &&
        !best.momentumUp && !best.momentumDown
    
    if(best.setup === "PULLBACK" && weakMomentum){
        continue
    }

    // ===== RR =====
    let rr = best.side === "LONG"
        ? (best.tp - best.price) / (best.price - best.sl)
        : (best.price - best.tp) / (best.sl - best.price)

    let minRR = 0.9

if(best.marketState === "TREND_STRONG"){
    minRR = 1.1
}
else{
    minRR = 0.9
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
    let existingMem = activeTrades.some(x =>
    x.symbol === trade.symbol &&
    x.result === "PENDING"
)

if(existingMem){
    continue
}

    await trades.insertOne(trade)
    // ===== BREAKOUT = MARKET ENTRY =====
{
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
let existingPos = await hasPosition(trade.symbol)

if(existingPos){

    console.log(`⛔ SKIP OPEN ${trade.symbol}: POSITION EXISTS`)
    await trades.updateOne(
        {
            symbol: trade.symbol,
            createdAt: trade.createdAt
        },
        {
            $unset:{
                opening:""
            }
        }
    )
    continue
}
if(OPENING_POSITIONS[trade.symbol]){
    console.log(`⛔ OPENING LOCK ${trade.symbol}`)
    continue
}

OPENING_POSITIONS[trade.symbol] = true
try{
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
let existsActive = activeTrades.find(
    x =>
        x.symbol === trade.symbol &&
        x.createdAt === trade.createdAt
)

if(!existsActive){
    activeTrades.push(trade)
}

let realQty = Math.abs(Number(realPos.positionAmt))

    trade.waitingEntry = false
    trade.enteredAt = Date.now()

    // lấy entry thật từ position
    let realEntry = Number(realPos.entryPrice)

    if(!realEntry || realEntry <= 0){
        realEntry = best.price
    }

    trade.entry = realEntry
    trade.sl = best.sl
    let realRisk = Math.abs(realEntry - best.sl)

let rr =
    best.side === "LONG"
    ? (best.tp - best.price) / (best.price - best.sl)
    : (best.price - best.tp) / (best.sl - best.price)

trade.tp =
    best.side === "LONG"
    ? realEntry + realRisk * rr
    : realEntry - realRisk * rr

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

    ok = await safeSetTPSL(
        trade.symbol,
        trade.side,
        trade.tp,
        trade.sl
    )
}

if(ok){

    delete TPSL_MISSING[trade.symbol]

}else{

    TPSL_MISSING[trade.symbol] = Date.now()

    console.log(`❌ TPSL NOT SET ${trade.symbol}`)
}

        console.log(`🔥 MARKET ENTER ${trade.symbol}`)
        let msg = `🔥 BEST SIGNAL

${best.symbol} (${best.setup})
${best.side} | ${best.marketState}

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

let positions = await binance.futuresPositionRisk({
    recvWindow: 20000
})

let realPos = positions.find(p =>
    p.symbol === t.symbol &&
    Math.abs(Number(p.positionAmt)) > 0
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
    Date.now() - t.enteredAt > 86400000 //43200000 // 12h

if(isTimeout){

    console.log(`⏳ TIMEOUT CLOSE ${t.symbol}`)
    // ===== CHECK POSITION THẬT =====
    let positions = await binance.futuresPositionRisk({
        recvWindow: 20000
    })
    let realPos = positions.find(p =>
        p.symbol === t.symbol &&
        Math.abs(Number(p.positionAmt)) > 0
    )
    // ===== NẾU CÒN POSITION -> CLOSE =====
    if(realPos){
        let realQty = Math.abs(Number(realPos.positionAmt))
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

    activeTrades.splice(i,1)

    continue
}
let positions = await binance.futuresPositionRisk({
    recvWindow: 20000
})

let stillOpen = positions.find(p =>
    p.symbol === t.symbol &&
    Math.abs(Number(p.positionAmt)) > 0
)

if(!stillOpen){

    await new Promise(r=>setTimeout(r,2000))

    let retryPos = await binance.futuresPositionRisk({
        recvWindow: 20000
    })

    stillOpen = retryPos.find(p =>
        p.symbol === t.symbol &&
        Math.abs(Number(p.positionAmt)) > 0
    )

    if(!stillOpen){

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

        activeTrades.splice(i,1)

        continue
    }
}
if(done){

    let positions = await binance.futuresPositionRisk({
        recvWindow: 20000
    })
    let stillOpen = positions.find(p =>
        p.symbol === t.symbol &&
        Math.abs(Number(p.positionAmt)) > 0
    )
    // còn position thật => chưa tính win/loss
    if(stillOpen){
        continue
    }
    await trades.updateOne(
        {
            symbol: t.symbol,
            createdAt: t.createdAt
        },
        {
            $set:{
                result: win ? "WIN" : "LOSS"
            }
        }
    )
    let latestBalance = await updateBalance()

    if(latestBalance > 0){
        ACCOUNT_BALANCE = latestBalance
    }
    await sendTelegram2(
`📊 ${t.symbol}
${t.side}
${win ? "✅ WIN" : "❌ LOSS"}
💰 Balance: ${ACCOUNT_BALANCE.toFixed(2)} USDT`
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
        for(let i=0;i<30;i++){

    await new Promise(r =>
        setTimeout(r, 2000)
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
    if(!trades){
        return
    }
    // 🔒 CHẶN WATCHDOG CHẠY ĐÈ
    if(WATCHDOG_RUNNING){
        return
    }
    WATCHDOG_RUNNING = true
    try{
        let positions = await binance.futuresPositionRisk({
    recvWindow: 20000
})
let openOrdersCache = {}
        for(let p of positions){
            if(Math.abs(Number(p.positionAmt)) <= 0){
    continue
}
            let symbol = p.symbol

let hasSL = false
let hasTP = false

let closeSide =
    Number(p.positionAmt) > 0
        ? "SELL"
        : "BUY"

let orders = openOrdersCache[symbol]

if(!orders){

    orders = await binance.futuresOpenOrders({
        symbol,
        recvWindow: 20000
    })

    openOrdersCache[symbol] = orders
}

hasSL = orders.find(
    o =>
        (
            o.type === "STOP_MARKET" ||
            o.type === "STOP"
        ) &&
        o.side === closeSide &&
        (
            o.closePosition === true ||
            String(o.closePosition) === "true"
        )
)

hasTP = orders.find(
    o =>
        (
            o.type === "TAKE_PROFIT_MARKET" ||
            o.type === "TAKE_PROFIT"
        ) &&
        o.side === closeSide &&
        (
            o.closePosition === true ||
            String(o.closePosition) === "true"
        )
)

if(hasSL && hasTP){
    delete openOrdersCache[symbol]
    delete TPSL_MISSING[symbol]
    continue
}

if(!TPSL_MISSING[symbol]){

    console.log(`🚨 FAKE TPSL CONFIRMED ${symbol}`)

    TPSL_MISSING[symbol] = Date.now()
}

if(
    TPSL_LOCKS[symbol] &&
    Date.now() - TPSL_LOCKS[symbol] < 60000
){
    continue
}
            let amt = Math.abs(Number(p.positionAmt))
            if(amt <= 0){
                continue
            }
            
            // 🔒 LOCK THEO SYMBOL
            if(WATCHDOG_LOCKS[symbol]){
                continue
            }
            WATCHDOG_LOCKS[symbol] = true
            try{
                // 🔒 đang set TPSL thì skip
                if(
    TPSL_LOCKS[symbol] &&
    Date.now() - TPSL_LOCKS[symbol] < 60000
){
    continue
}

                // ===== BINANCE CHƯA SYNC ĐỦ =====
// ===== PARTIAL TPSL =====
if(hasSL || hasTP){
    if(!TPSL_MISSING[symbol]){
        TPSL_MISSING[symbol] = Date.now()
    }

    console.log(`⚠️ PARTIAL TPSL ${symbol}`)

    // chờ ngắn cho Binance sync
    await new Promise(r =>
        setTimeout(r, 5000)
    )
    delete openOrdersCache[symbol]

    let verify =
        await binance.futuresOpenOrders({
            symbol,
            recvWindow: 20000
        })
    openOrdersCache[symbol] = verify

    let verifySL = verify.find(o =>
    (
        o.type === "STOP_MARKET" ||
        o.type === "STOP"
    ) &&
    o.side === closeSide &&
    (
        o.closePosition === true ||
        String(o.closePosition) === "true"
    )
)

let verifyTP = verify.find(o =>
    (
        o.type === "TAKE_PROFIT_MARKET" ||
        o.type === "TAKE_PROFIT"
    ) &&
    o.side === closeSide &&
    (
        o.closePosition === true ||
        String(o.closePosition) === "true"
    )
)

    // vẫn thiếu -> recreate
    if(!(verifySL && verifyTP)){

        console.log(`🚨 REBUILD TPSL ${symbol}`)
        delete openOrdersCache[symbol]
        let trade = activeTrades.find(
            x => x.symbol === symbol
        )

        if(trade){

            await safeSetTPSL(
                symbol,
                trade.side,
                trade.tp,
                trade.sl
            )
        }
    }

    continue
}

// ===== MARK MISSING =====
if(!TPSL_MISSING[symbol]){
    TPSL_MISSING[symbol] = Date.now()
}

{
    console.log(`🚨 NO TPSL ${symbol}`)
}
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
                            if(
    !exists &&
    dbTrade.result === "PENDING"
){
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
                    if(missingTime < 1200000){
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
delete TPSL_MISSING[symbol]

if(trade){

    trade.result = "FORCE_CLOSED"

    await trades.updateOne(
        {
            symbol: trade.symbol,
            createdAt: trade.createdAt
        },
        {
            $set:{
                result:"FORCE_CLOSED"
            }
        }
    )

    let idx = activeTrades.findIndex(
        x =>
            x.symbol === trade.symbol &&
            x.createdAt === trade.createdAt
    )

    if(idx !== -1){
        activeTrades.splice(idx,1)
    }
}
                    continue
                }
                // ===== RETRY TPSL =====
                let res = await safeSetTPSL(
    symbol,
    trade.side,
    trade.tp,
    trade.sl
)
if(res && res.ok){
    delete openOrdersCache[symbol]
}

// ===== TPSL FAIL =====
if(!res || !res.ok){
                    let missingTime =
                        Date.now() - TPSL_MISSING[symbol]
                    // ⏳ CHỜ BINANCE SYNC
                    if(missingTime < 1200000){
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
                    
delete TPSL_MISSING[symbol]
if(trade){
    trade.result = "FORCE_CLOSED"

    await trades.updateOne(
        {
            symbol: trade.symbol,
            createdAt: trade.createdAt
        },
        {
            $set:{
                result:"FORCE_CLOSED"
            }
        }
    )
    let idx = activeTrades.findIndex(
        x =>
            x.symbol === trade.symbol &&
            x.createdAt === trade.createdAt
    )
    if(idx !== -1){
        activeTrades.splice(idx,1)
    }
}
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
async function watchdogLoop(){

    while(true){

        try{
            await watchdogTPSL()
        }catch(e){
            console.log("WATCHDOG LOOP:", e.message)
        }

        await new Promise(r =>
            setTimeout(r, 15000)
        )
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
activeTrades = await trades.find({
    result: "PENDING"
}).toArray()

let positions = await binance.futuresPositionRisk({
    recvWindow: 20000
})

let openSymbols = new Set(
    positions
        .filter(
            p => Math.abs(Number(p.positionAmt)) > 0
        )
        .map(p => p.symbol)
)
let cleaned = []
for(let t of activeTrades){
    // giữ waiting entry
    if(t.waitingEntry){

        cleaned.push(t)

        continue
    }
    // còn position thật
    if(openSymbols.has(t.symbol)){

        cleaned.push(t)

        continue
    }
    // ===== GHOST TRADE =====
    await trades.updateOne(
        {
            _id: t._id
        },
        {
            $set:{
                result:"AUTO_CLEAR_NO_POSITION"
            }
        }
    )
    console.log(
        `🧹 CLEAR GHOST ${t.symbol}`
    )
}
activeTrades = cleaned
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
        watchdogLoop()

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
        if(
    !t.tpslMissing &&
    !t.retryTPSL
) continue
        if(TPSL_LOCKS[t.symbol]) continue
if(TPSL_PENDING[t.symbol]) continue
if(TPSL_GLOBAL_LOCK[t.symbol]) continue

        let pos = await waitPosition(t.symbol)
        

        if(!pos) continue

        let qty = Math.abs(Number(pos.positionAmt))

         let ok = await safeSetTPSL(
            t.symbol,
            t.side,
            t.tp,
            t.sl
        )

        if(ok && ok.ok){

    t.retryTPSL = false
    t.tpslMissing = false
    delete TPSL_MISSING[t.symbol]

    await trades.updateOne(
        {
            symbol: t.symbol,
            createdAt: t.createdAt
        },
        {
            $unset:{
                retryTPSL:"",
                tpslMissing:""
            }
        }
    )

    console.log(`✅ FIX TPSL ${t.symbol}`)
}
    }
}

setInterval(fixTPSL, 15000)
async function syncActiveTrades(){

    activeTrades = await trades.find({
        result:"PENDING"
    }).toArray()

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
