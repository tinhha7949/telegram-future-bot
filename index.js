const { MongoClient } = require("mongodb")

const client = new MongoClient(process.env.MONGO_URI)

let db, trades
// ================= CONFIG =================
const BOT_TOKEN = process.env.BOT_TOKEN
const CHAT_ID = process.env.CHAT_ID

const BOT_TOKEN_2 = process.env.BOT_TOKEN_2
const AI_CHAT_ID = process.env.AI_CHAT_ID

const LIMIT_15M = 300 //300
const LIMIT_1H  = 200 //100

const SCORE_THRESHOLD = 60 // 110
const RR_THRESHOLD = 1.1 // 1.3 hoặc 1.4 nếu muốn 
    
const RISK_PER_TRADE = 0.01
const ACCOUNT_BALANCE = 1000
const MIN_VOL_15M = 60000 // 100000 hoặc  nếu rác

const DEBUG_AI = false
const ENABLE_REVERSAL = true

let lastUpdateId = 0
let cachedSymbols = null
let lastSymbolsUpdate = 0
//let lastSignalTime = {}
let isScanning = false
// ===== ACTIVE TRADES =====
let activeTrades = []

// ================= TELEGRAM =================
async function sendTelegram(msg){
    try{
        let url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`
        let res = await fetch(url,{
            method:"POST",
            headers:{"Content-Type":"application/json"},
            body: JSON.stringify({ chat_id: CHAT_ID, text: msg })
        })

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
        let res = await fetch(url,{
            method:"POST",
            headers:{"Content-Type":"application/json"},
            body: JSON.stringify({ chat_id: AI_CHAT_ID, text: msg })
        })
        let data = await res.json()
        return data.ok

    }catch(e){
        console.log("❌ TELE 2:", e.message)
        return false
    }
}

// ================= COMMAND =================
async function checkCommand(){
    try{
        let url = `https://api.telegram.org/bot${BOT_TOKEN}/getUpdates?offset=${lastUpdateId+1}`
        let res = await fetch(url)
        let data = await res.json()
        if(!data.result) return

        for(let u of data.result){
            lastUpdateId = u.update_id
            if(!u.message?.text) continue

            if(u.message.text === "/status"){
                await sendTelegram("🤖 BOT đang chạy OK")
            }
        }
    }catch(e){
        console.log("⚠️ CMD:", e.message)
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
    if(trs.length < p) return 0

    let slice = trs.slice(-p)
    return slice.reduce((a,b)=>a+b,0) / slice.length
}

// ================= DATA (PRO) =================
async function getData(symbol, interval, limit){

    const urls = [
        `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`,
        `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`,
        `https://data-api.binance.vision/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`
    ]

    for(let url of urls){
        for(let attempt=0; attempt<2; attempt++){
            try{
                let res = await fetch(url, { headers:{"User-Agent":"Mozilla/5.0"} })
                if(!res.ok) continue
                let data = await res.json()
                if(Array.isArray(data) && data.length>0) return data
            }catch(e){
                if(attempt===1) console.log("❌ DATA FAIL:", symbol)
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
                let res = await fetch(url, { headers:{"User-Agent":"Mozilla/5.0"} })
                if(!res.ok) continue

                let data = await res.json()

                if(Array.isArray(data) && data.length>0){
                    return data
                        .filter(c =>
                            c.symbol.endsWith("USDT") &&
                            !c.symbol.includes("UP") &&
                            !c.symbol.includes("DOWN") &&
                            !c.symbol.includes("BUSD")
                        )
                    //   .filter(c => Number(c.quoteVolume) > 30000000)
                    .sort((a,b)=> Number(b.quoteVolume) - Number(a.quoteVolume))
                .slice(0,30)
                        .map(c => c.symbol)
                }

            }catch(e){
                if(attempt===1) console.log("❌ SYMBOL FAIL:", url)
            }
        }
    }

    return null
}
// ============== dyminic minvol15m========
//function getDynamicMinVol(volAvgUSDT, price, atrRatio){

   // let base = MIN_VOL_15M

    // coin giá thấp → cần vol cao hơn
    //if(price < 1){
        //base *= 1.5
   // }

    // coin giá cao → giảm yêu cầu
    //if(price > 100){
       // base *= 0.7
    //}

    // volatility cao → giảm yêu cầu
    //if(atrRatio > 0.005){
        //base *= 0.8
    //}

    // volatility thấp → tăng yêu cầu
   // if(atrRatio < 0.002){
        //base *= 1.3
    //}

   // return base
//}
// ================= CORE =================
async function coreLogic(data15, data1h){

    let closes = data15.map(x=>+x[4])
    let opens = data15.map(x=>+x[1])
    let highs  = data15.map(x=>+x[2])
    let lows   = data15.map(x=>+x[3])
    let volumes= data15.map(x=>+x[5])
    let closes1h = data1h.map(x=>+x[4])

    if(closes.length < 5) return null

    let price = closes.at(-1)
    let prevPrice = closes.length >= 2 ? closes.at(-2) : price

    let atrVal = atr(data15.slice(-100))
    if(!atrVal || atrVal <= 0 || isNaN(atrVal)) return null
    let atrRatio = atrVal / price
    
   let last30 = volumes.slice(-30)
if(last30.length < 20) return null

let volAvg = last30.reduce((a,b)=>a+b,0)/last30.length
    let volNow = volumes.at(-1)

    let volAvgUSDT = volAvg * price
    let volNowUSDT = volNow * price

    if(!volAvgUSDT || volAvgUSDT === 0) return null
    let volRatio = volNowUSDT / volAvgUSDT //cmt dòng này nếu bỏ dymic
    
//let dynamicMinVol = getDynamicMinVol(volAvgUSDT, price, atrRatio)

    // ===== DYNAMIC VOLUME FILTER =====
let volThreshold = 0.05 - atrRatio * 1.2 // 0.18 2
volThreshold = Math.max(0.03, Math.min(volThreshold, 0.15))

if(volRatio < volThreshold) return null
    // ===== FILTER VOLUME =====
//if(volAvgUSDT < dynamicMinVol * 0.7) return null

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
    //let trendLTF = Math.abs(ema20 - ema50) / price

    //if(trendHTF < 0.0012 && trendLTF < 0.001) return null

    let dynamicThreshold = 55
    if(trendHTF > 0.003) dynamicThreshold = 50
    else if(trendHTF > 0.0015) dynamicThreshold = 55
    else dynamicThreshold = 60
    //if(trendHTF > 0.003 && trendLTF > 0.002) dynamicThreshold = 60 //90
    //else if(trendHTF > 0.0015) dynamicThreshold = 65 // 95
   // else dynamicThreshold = 70 // 105

    let r = rsi(closes.slice(-50))
   // let atrVal = atr(data15.slice(-100))
   // ===== MARKET =====
    let emaGap = Math.abs(ema20 - ema50) / price
    //let atrRatio = atrVal / price

    let marketState = "SIDEWAY"
    if(emaGap > 0.004 && atrRatio > 0.0045) marketState = "TREND_STRONG"
    else if(emaGap > 0.0025) marketState = "TREND_WEAK"
   // ===== RSI HARD FILTER =====
    let longValidRSI = true
    let shortValidRSI = true

    if(r > 80) longValidRSI = false //80
if(r < 20) shortValidRSI = false // 25

// riêng TREND_STRONG thì nới nhẹ
if(marketState === "TREND_STRONG"){
    if(r > 82) longValidRSI = false
    if(r < 18) shortValidRSI = false
}

    let volatility = "LOW"
    if(atrVal / price > 0.0045) volatility = "HIGH"

    // ===== WICK =====
    if((highs.at(-1) - lows.at(-1)) > atrVal * 3.0) return null

    // ===== ANTI CHASE (ĐÚNG CHỖ) =====
    let prevHigh = Math.max(...highs.slice(-25,-5))
    let prevLow  = Math.min(...lows.slice(-25,-5))

    let bosUp = price > prevHigh
    let bosDown = price < prevLow
let lastMove = (closes.at(-1) - closes.at(-3)) / closes.at(-3)

// nếu pump/dump mạnh → bỏ luôn (không cần biết LONG hay SHORT)
if(marketState !== "TREND_STRONG"){
    let antiChaseLimit = Math.max(0.02, Math.min(atrRatio * 20, 0.08))

if(Math.abs(lastMove) > antiChaseLimit * 2.5){
        return null
    }
}

    //let range = (Math.max(...highs.slice(-30)) - Math.min(...lows.slice(-30))) / price
    //if(marketState === "SIDEWAY" && range < 0.002) return null // 0.002

    // ===== EMA DIST =====
    let distEma = Math.abs(price - ema20) / price
    //let nearEma = distEma < 0.0055

   // if(marketState === "SIDEWAY"){
       // if(nearEma && volNowUSDT < volAvgUSDT * 0.2) return null
   // }

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
let nearHigh = (rangeHigh - price) / rangeHigh < 0.01
let nearLow  = (price - rangeLow) / rangeLow < 0.01

    let rangeSize = rangeHigh - rangeLow
if(rangeSize <= 0) return null

let pos = (price - rangeLow) / rangeSize

if(marketState === "SIDEWAY"){
}

     // ===== MOMENTUM =====
    let momentumStrength = (closes.at(-1) - closes.at(-4)) / closes.at(-4)

    let momentumUp = momentumStrength > 0.002
    let momentumDown = momentumStrength < -0.002

    let higherLow = lows.at(-2) > lows.at(-5)
    let lowerHigh = highs.at(-2) < highs.at(-5)

    let volTrendUp = volumes.slice(-5).every((v,i,a)=> i===0 || v>=a[i-1])
    let volTrendDown = volumes.slice(-5).every((v,i,a)=> i===0 || v<=a[i-1])
    
    // ===== TREND FILTER =====
    let trendLong = ema20>ema50 && ema50>ema200 && ema20_1h>ema50_1h
    let trendShort = ema20<ema50 && ema50<ema200 && ema20_1h<ema50_1h

    //let trendStrength = Math.abs(ema20-ema50)/price
    //if(marketState === "SIDEWAY" && trendStrength < 0.0003){ //0.0011
   // return null
//}
    // ===== mới =======
    // ===== LONG / SHORT TÁCH RIÊNG =====

let longScore = 0
let shortScore = 0
let longValid = false
let shortValid = false

// ===== LONG =====
if(trendLong && longValidRSI){

    longValid = true
    // ❌ không đu giá
    if(distFromEma > 0.02) longValid = false

    // breakout
    if(bosUp && momentumUp && volNowUSDT > volAvgUSDT * 1.3){
        longScore += 30
    }

    // pullback + bật lên
    let bounce = closes.at(-1) > closes.at(-2)
    if(nearEma && bounce){
        longScore += 35
    }

    // structure
    if(higherLow) longScore += 15

    // RSI đẹp
    //if(r > 50 && r < 75) longScore += 10
    if(r > 45) longScore += 5

    // volume
    if(volTrendUp && volNowUSDT > volAvgUSDT * 1.2){
    longScore += 10
}

    // tránh đỉnh
    if(nearHigh) longScore -= 20
}

// ===== SHORT =====
if(trendShort && shortValidRSI){

    shortValid = true
    // ❌ không đu giá
    if(distFromEma < -0.02) shortValid = false

    // breakdown
    if(bosDown && momentumDown && volNowUSDT > volAvgUSDT * 1.3){
        shortScore += 30
    }

    // pullback + bị đạp xuống
    let reject = closes.at(-1) < closes.at(-2)
    if(nearEma && reject){
        shortScore += 35
    }

    // structure
    if(lowerHigh) shortScore += 15

    // RSI đẹp
    //if(r > 25 && r < 50) shortScore += 10
    if(r < 55) shortScore += 5

    // volume
   if(volTrendDown && volNowUSDT > volAvgUSDT * 1.2){
    shortScore += 10
}

    // tránh đáy
    if(nearLow) shortScore -= 20
}

// ===== CHỌN SIDE =====
let prevHigh50 = Math.max(...highs.slice(-51,-1))
    let prevLow50  = Math.min(...lows.slice(-51,-1))

    let sweepHigh = highs.at(-2) > prevHigh50 && closes.at(-2) < prevHigh50
    let sweepLow  = lows.at(-2) < prevLow50 && closes.at(-2) > prevLow50
let side = null
let score = 0

// ===== SIDEWAY ƯU TIÊN RIÊNG =====
if(marketState === "SIDEWAY"){
    //if(volNowUSDT < volAvgUSDT * 0.6){
    //return null
//}

    if(sweepHigh && !sweepLow){
        if(!momentumDown) return null
        side = "SHORT"
        score = 25
        dynamicThreshold += 10
    }
    else if(sweepLow && !sweepHigh){
        if(!momentumUp) return null
        side = "LONG"
        score = 25
        dynamicThreshold += 10
    }
    else{
        return null
    }

    if(side === "LONG" && nearHigh) return null
    if(side === "SHORT" && nearLow) return null
}
else{
    // ===== TREND MODE =====
    if(longValid && longScore > shortScore){
        side = "LONG"
        score = longScore
    }
    else if(shortValid && shortScore > longScore){
        side = "SHORT"
        score = shortScore
    }
    else{
        return null
    }

    if(Math.abs(longScore - shortScore) < 5){
        return null
    }
}
    // ===== SPIKE FILTER =====
//let spikeCandle = (highs.at(-2) - lows.at(-2)) / lows.at(-2)

//let validBreakout = true

//if(spikeCandle > 0.06){
    //validBreakout = false
//}

       // if(!side) return null
        //if(bosUp || bosDown) return null
    // Fake breakout
    let high = highs.at(-1)
let low = lows.at(-1)
    let open = opens.at(-1)
let close = closes.at(-1)

let candleRange = high - low
let upperWick = high - Math.max(open, close)
let lowerWick = Math.min(open, close) - low

if(candleRange === 0) return null

let upperWickRatio = upperWick / candleRange
let lowerWickRatio = lowerWick / candleRange
// ===== REJECTION FILTER =====
if(upperWickRatio > 0.7 && side === "LONG") return null
if(lowerWickRatio > 0.7 && side === "SHORT") return null
    
//let fakePump = volNowUSDT > volAvgUSDT * 2
   // && upperWick / candleRange > 0.5

//let fakeDump = volNowUSDT > volAvgUSDT * 2
   // && lowerWick / candleRange > 0.5

// kháng cự hỗ trợ gần quá thì tránh vào (giữ nguyên)
    let resistance = rangeHigh
let support = rangeLow
    // ===== SL TP (GIỮ NGUYÊN) =====
    let swingLow = Math.min(...lows.slice(-20))
    let swingHigh = Math.max(...highs.slice(-20))

    let sl = side==="LONG"
    ? swingLow - atrVal
    : swingHigh + atrVal

let maxSL = atrVal * (2 + atrRatio * 20)

if(Math.abs(price - sl) > maxSL){
    sl = side==="LONG"
        ? price - maxSL
        : price + maxSL
}

    let risk = Math.abs(price - sl)

let rawTP = side === "LONG"
    ? price + risk * RR_THRESHOLD
    : price - risk * RR_THRESHOLD

    let tp

if(marketState === "SIDEWAY"){
    
    if(side === "LONG"){
        tp = Math.min(rawTP, resistance * 0.997)
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

if(rangeCandle === 0 || body / rangeCandle < 0.05){ //0.2
    return null
}

    function round(n){ return Number(n.toFixed(4)) }

    let setupType = null

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
        let results = await Promise.allSettled(symbols.map(scan))

        let signals = results
            .filter(r => r.status === "fulfilled" && r.value)
            .map(r => r.value)

        if(!signals || signals.length === 0){
            console.log("❌ No signal")
            isScanning = false
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

    if(dbMain.total < 25) aiMain *= 0.5

    let finalMain = s.score + aiMain

    //if(finalMain >= s.dynamicThreshold){
        candidates.push({
            ...s,
            finalScore: finalMain,
            type: "MAIN"
        })
    //}
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
    //if(rr < 1.1) return false

    // ❌ score quá thấp
   let threshold = c.dynamicThreshold

if(c.marketState === "SIDEWAY"){
    threshold += 5
}
if((c.finalScore || c.score) < threshold) return false
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
let picks = filtered.slice(0, 1)
for (let best of picks){

    // ===== BLOCK COIN =====
    let existing = await trades.findOne({
        symbol: best.symbol,
        result: "PENDING"
    })

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

    //if(rr < 1.15){
        //continue
    //}

    // ===== RISK =====
    let multiplier = 1

    if(dbAI.total > 20){
        let edge = dbAI.winrate - 0.5
        multiplier = 1 + edge * 2

        if(multiplier > 1.5) multiplier = 1.5
        if(multiplier < 0.5) multiplier = 0.5
    }

    let risk = ACCOUNT_BALANCE * RISK_PER_TRADE * multiplier
    if(best.setup === "REVERSAL_TOP" || best.setup === "REVERSAL_BOTTOM"){
    risk *= 0.5
}

    let diff = Math.abs(best.price - best.sl)
    if(!diff) continue

    let trade = {
        symbol: best.symbol,
        side: best.side,
        risk,
        entry: null,
        entryZone: best.price,
        tp: best.tp,
        sl: best.sl,
        score: best.score,
        waitingEntry: true,
        createdAt: Date.now(),
        breakoutTriggered: false,
        setup: best.setup,
        marketState: best.marketState,
        volatility: best.volatility,
        atr: best.atr,
        time: Date.now(),
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

    console.log(`✅ ADD: ${best.symbol} | Score: ${best.finalScore.toFixed(1)}`)
}

    }catch(e){
    console.log("❌ Scanner error:")
    console.log(e)
} finally {
    isScanning = false   // ✅ THẢ LOCK
}
}
////////////////////
async function checkTrades(){

    if(activeTrades.length === 0) return

    for(let i = activeTrades.length - 1; i >= 0; i--){

        let t = activeTrades[i]

        try{
            let data = await getData(t.symbol,"1m",2)
            if(!data) continue

            let price = +data.at(-1)[4]
            // ================= ENTRY 1M CONFIRM =================
if(t.waitingEntry){
     // timeout 1h
    let waitTime = Date.now() - t.time
    
    if(waitTime > 3 * 60 * 60 * 1000){
    console.log(`⛔ Timeout entry ${t.symbol}`)

    await trades.updateOne(
        { symbol: t.symbol, time: t.time },
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
    if(!t.atr || !t.entryZone){
    continue
}
    // ===== LONG =====
    let confirm = false

let atrRatio = t.atr / t.entryZone

atrRatio = Math.max(0.002, Math.min(atrRatio, 0.02)) // 🔥 giảm max

//let entryBuffer = t.atr * (0.3 + atrRatio * 10)
//let maxChase    = t.atr * (2 + atrRatio * 40)
let entryBuffer = t.atr * (0.25 + atrRatio * 8) // 0.3 10
let maxChase = Math.min(t.atr * 3, t.entryZone * 0.015)
let prev = +data.at(-2)[4]

// 🔥 clamp thêm lần cuối
entryBuffer = Math.min(entryBuffer, t.atr * 1.2)
maxChase    = Math.min(maxChase, t.atr * 4)
    
if(Math.abs(price - t.entryZone) > maxChase * 1.5){
    activeTrades.splice(i,1)
    await trades.updateOne(
        { symbol: t.symbol, time: t.time },
        { $set: { result: "CANCEL_CHASE" } }
    )
    continue
}

// ===== MOMENTUM =====
let momentum1m = price - prev
if(t.side === "LONG" && momentum1m < -t.atr * 0.05) continue
if(t.side === "SHORT" && momentum1m >  t.atr * 0.05) continue
//if(t.side === "LONG" && momentum1m <= 0) continue
//if(t.side === "SHORT" && momentum1m >= 0) continue

// ===== ENTRY =====
if(t.side === "LONG"){

    if(t.setup === "BREAKOUT"){
        if(prev <= t.entryZone && price > t.entryZone){
            confirm = true
        }
    }else{
        if(prev < t.entryZone && price > t.entryZone){
            confirm = true
        }
    }
}

if(t.side === "SHORT"){

    if(t.setup === "BREAKOUT"){
        if(prev >= t.entryZone && price < t.entryZone){
            confirm = true
        }
    }else{
        if(prev > t.entryZone && price < t.entryZone){
            confirm = true
        }
    }
}
    // ===== VÀO LỆNH =====
    if(confirm){
    t.entry = price
    t.waitingEntry = false

    let trailingSL = t.side === "LONG"
        ? t.entry - t.atr
        : t.entry + t.atr

    let diff = Math.abs(t.entry - t.sl)
if(diff === 0) continue
let size = t.risk / diff

    let msg = `🔥 BEST SIGNAL

${t.symbol} (${t.setup})
${t.side} | ${t.marketState}

Entry: ${t.entry.toFixed(4)}

TP: ${t.tp.toFixed(4)}

SL: ${t.sl.toFixed(4)}

Trailing SL: ${trailingSL.toFixed(4)}
Size: ${size.toFixed(2)}
Score: ${t.score || 0}
`
    console.log(msg)
    let ok = false
for(let i=0;i<2;i++){
    ok = await sendTelegram(msg)
    if(ok) break
}

   // lastSignalTime[`${t.symbol}-${t.side}`] = Date.now()
}

    // ❌ chưa confirm thì bỏ qua
    continue
}
if(!t.entry) continue

            let win = false
            let done = false

            if(t.side === "LONG"){
                if(price >= t.tp){ win = true; done = true }
                if(price <= t.sl){ win = false; done = true }
                
            }

            if(t.side === "SHORT"){
                if(price <= t.tp){ win = true; done = true }
                if(price >= t.sl){ win = false; done = true }
            }
        

            // timeout 12h
let isTimeout = Date.now() - t.time > 43200000

// ===== TIMEOUT TRƯỚC =====
if(isTimeout){
    
    await trades.updateOne(
    { symbol: t.symbol, time: t.time },
    { $set: { result: "TIMEOUT" } }
)
    console.log(`⏳ Timeout: ${t.symbol}`)

    await sendTelegram2(
`⏳ TIMEOUT ${t.symbol}
${t.side}
⛔ Không chạm TP/SL trong 12h`
    )

    activeTrades.splice(i,1)
    continue
}

// ===== SAU ĐÓ MỚI CHECK TP/SL =====
if(done){
        // 🔥 UPDATE DB
    await trades.updateOne(
        { symbol: t.symbol, time: t.time },
        { $set: { result: win ? "WIN" : "LOSS" } }
    )

    let msg =
`📊 RESULT ${t.symbol}
${t.side}
${win ? "✅ WIN" : "❌ LOSS"}`
    
// await sendTelegram(msg)
    await sendTelegram2(msg)

    activeTrades.splice(i,1)
    continue
}

        }catch(e){
            console.log("❌ checkTrades:", e.message)
        }
    }
} 

async function start(){
    try{

        if(!process.env.MONGO_URI){
            throw new Error("❌ Thiếu MONGO_URI")
        }

        await client.connect()

        try{
    await client.db("admin").command({ ping: 1 })
    console.log("🟢 DB CONNECTED OK")
}catch(e){
    console.log("🔴 DB CONNECT FAIL:", e.message)
}

        db = client.db("trading")
        trades = db.collection("trades")

        console.log("✅ MongoDB connected")

        // 🔥 LOAD LẠI LỆNH
        activeTrades = await trades.find({ result: "PENDING" }).toArray()

// lọc lại tránh rác
        activeTrades = activeTrades.filter(t => t && t.symbol)
        console.log(`♻️ Load lại ${activeTrades.length} lệnh`)

        // ================= LOOP =================
setInterval(()=>scanner(),120000)
setInterval(()=>checkCommand(),10000)
setInterval(()=>checkTrades(),60000)

        scanner()

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

            let ageHours = t.time 
                ? (Date.now() - t.time) / 3600000 
                : 999

            // 🔥 decay 48h
            let weight = Math.exp(-ageHours / 48)

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
