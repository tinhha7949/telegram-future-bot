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

const SCORE_THRESHOLD = 90 // 110
const EARLY_THRESHOLD = 55  // 60
const RR_THRESHOLD = 1.2 // 1.3 hoặc 1.4 nếu muốn 

const RISK_PER_TRADE = 0.01
const ACCOUNT_BALANCE = 1000
const MIN_VOL_15M = 60000 // 100000 hoặc  nếu rác

const DEBUG_AI = false

let lastUpdateId = 0
let cachedSymbols = null
let lastSymbolsUpdate = 0
let lastSignalTime = {}
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
function ema(arr,p){
    let k=2/(p+1), e=arr[0]
    for(let i=1;i<arr.length;i++) e=arr[i]*k+e*(1-k)
    return e
}

function rsi(arr,p=14){
    let g=0,l=0
    for(let i=arr.length-p;i<arr.length;i++){
        let d=arr[i]-arr[i-1]
        if(d>=0) g+=d
        else l-=d
    }
    let rs=g/(l||1)
    return 100-(100/(1+rs))
}

function atr(data,p=14){
    let trs=[]
    for(let i=1;i<data.length;i++){
        let h=+data[i][2], l=+data[i][3], pc=+data[i-1][4]
        trs.push(Math.max(h-l, Math.abs(h-pc), Math.abs(l-pc)))
    }
    return trs.slice(-p).reduce((a,b)=>a+b,0)/p
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
                .slice(0,40)
                        .map(c => c.symbol)
                }

            }catch(e){
                if(attempt===1) console.log("❌ SYMBOL FAIL:", url)
            }
        }
    }

    return null
}

// ================= CORE =================
async function coreLogic(data15, data1h){

    let closes = data15.map(x=>+x[4])
    let highs  = data15.map(x=>+x[2])
    let lows   = data15.map(x=>+x[3])
    let volumes= data15.map(x=>+x[5])
    let closes1h = data1h.map(x=>+x[4])

    let price = closes.at(-1)
    
    let volAvg = volumes.slice(-30).reduce((a,b)=>a+b,0)/30
    let volNow = volumes.at(-1)

    if(volNow < volAvg * 0.4) return null
    if(volAvg < MIN_VOL_15M) return null
    
    // ===== EMA =====
    let ema20 = ema(closes.slice(-60),20)
    let ema50 = ema(closes.slice(-120),50)
    let ema200= ema(closes.slice(-250),200)

    let ema20_1h = ema(closes1h.slice(-60),20)
    let ema50_1h = ema(closes1h.slice(-120),50)

    // ===== TREND =====
    let trendHTF = Math.abs(ema20_1h - ema50_1h) / price
    let trendLTF = Math.abs(ema20 - ema50) / price

    //if(trendHTF < 0.0012 && trendLTF < 0.001) return null

    let dynamicThreshold = 100
    if(trendHTF > 0.003 && trendLTF > 0.002) dynamicThreshold = 90 //90
    else if(trendHTF > 0.0015) dynamicThreshold = 95 // 95
    else dynamicThreshold = 105 // 105

    let r = rsi(closes.slice(-50))
    let atrVal = atr(data15.slice(-100))

    let volatility = "LOW"
    if(atrVal / price > 0.0045) volatility = "HIGH"

    // ===== ANTI CHASE (GIỮ 1) =====
   // let lastMove = (closes.at(-1) - closes.at(-3)) / closes.at(-3)
   // if(Math.abs(lastMove) > 0.03) return null

    // ===== WICK =====
    if((highs.at(-1) - lows.at(-1)) > atrVal * 3.0) return null

    // ===== MARKET =====
    let emaGap = Math.abs(ema20 - ema50) / price
    let atrRatio = atrVal / price

    let marketState = "SIDEWAY"
    if(emaGap > 0.004 && atrRatio > 0.0045) marketState = "TREND_STRONG"
    else if(emaGap > 0.0025) marketState = "TREND_WEAK"

    let range = (Math.max(...highs.slice(-30)) - Math.min(...lows.slice(-30))) / price
    if(marketState === "SIDEWAY" && range < 0.002) return null

    // ===== EMA DIST =====
    let distEma = Math.abs(price - ema20) / price
    let nearEma = distEma < 0.0065

    if(marketState === "SIDEWAY"){
        if(nearEma && volNow < volAvg * 0.5) return null
    }

    // ===== STRUCTURE =====
    let rangeHigh = Math.max(...highs.slice(-30))
    let rangeLow  = Math.min(...lows.slice(-30))
    if(rangeHigh === rangeLow) return null

    let pos = (price - rangeLow) / (rangeHigh - rangeLow)
    if(marketState === "SIDEWAY"){
    if(pos > 0.3 && pos < 0.7) return null
}
    let side=null, score=0
    let setupType = null

    let prevHigh = Math.max(...highs.slice(-25,-5))
    let prevLow  = Math.min(...lows.slice(-25,-5))

    let bosUp = price > prevHigh
    let bosDown = price < prevLow

    let prevHigh50 = Math.max(...highs.slice(-51,-1))
    let prevLow50  = Math.min(...lows.slice(-51,-1))

    let sweepHigh = highs.at(-2) > prevHigh50 && closes.at(-2) < prevHigh50
    let sweepLow  = lows.at(-2) < prevLow50 && closes.at(-2) > prevLow50

    // ===== MOMENTUM =====
    let last4 = closes.slice(-4)
    let momentumUp = last4[3]>last4[2] && last4[2]>last4[1]
    let momentumDown = last4[3]<last4[2] && last4[2]<last4[1]

    let higherLow = lows.at(-2) > lows.at(-5)
    let lowerHigh = highs.at(-2) < highs.at(-5)

    let volTrendUp = volumes.slice(-5).every((v,i,a)=> i===0 || v>=a[i-1])

    // ===== TREND FILTER =====
    let trendLong = ema20>ema50 && ema50>ema200 && ema20_1h>ema50_1h
    let trendShort = ema20<ema50 && ema50<ema200 && ema20_1h<ema50_1h

    let trendStrength = Math.abs(ema20-ema50)/price
    if(marketState !== "SIDEWAY" && trendStrength < 0.002){
    return null
}

    // ===== SIDEWAY =====
    if(marketState === "SIDEWAY"){
        if(sweepHigh){ side="SHORT"; score+=60 }
        if(sweepLow){ side="LONG"; score+=60 }
        if(!side) return null
        if(bosUp || bosDown) return null
    }
    // Fake breakout
    let fakePump = volNow > volAvg*2.5 && closes.at(-1) < highs.at(-1)*0.98
let fakeDump = volNow > volAvg*2.5 && closes.at(-1) > lows.at(-1)*1.02

if(fakePump || fakeDump) return null

    // ===== SCORE =====
    if(!side){
    if(trendLong){ side="LONG"; score+=50 }
    else if(trendShort){ side="SHORT"; score+=50 }
}

    // ===== SETUP =====
    if(side==="LONG" && bosUp){
        score += 40
        setupType = "BREAKOUT"
    }

    if(side==="SHORT" && bosDown){
        score += 40
        setupType = "BREAKOUT"
    }

    if(side==="LONG" && nearEma){
        score += 20
        if(!setupType) setupType = "PULLBACK"
    }

    if(side==="SHORT" && nearEma){
        score += 20
        if(!setupType) setupType = "PULLBACK"
    }

    if(side==="LONG" && sweepLow) score+=35
    if(side==="SHORT" && sweepHigh) score+=35

    if(volTrendUp) score+=20
    if(volNow > volAvg*1.5) score+=15 

    if(side==="LONG" && momentumUp) score+=10
    if(side==="SHORT" && momentumDown) score+=10

    if(side==="LONG" && higherLow) score+=15
    if(side==="SHORT" && lowerHigh) score+=15
   
    if(side==="LONG" && r>50 && r<65) score+=10
    if(side==="SHORT" && r>35 && r<50) score+=10

    if(!side) return null
    
// kháng cự hỗ trợ gần quá thì tránh vào (giữ nguyên)
     let resistance = Math.max(...highs.slice(-30))
let support = Math.min(...lows.slice(-30))
let distToRes = (resistance - price) / price
let distToSup = (price - support) / price

if(side === "LONG" && distToRes < 0.002) return null
if(side === "SHORT" && distToSup < 0.002) return null

    // ===== ANTI FOMO (GỌN - KHÔNG TRÙNG) =====
    let distance = Math.abs(price - ema20)

    if(marketState !== "TREND_STRONG" && distance > atrVal * 4){
        return null
    }

    // ===== SL TP (GIỮ NGUYÊN) =====
    let swingLow = Math.min(...lows.slice(-20))
    let swingHigh = Math.max(...highs.slice(-20))

    let sl = side==="LONG"
        ? swingLow - atrVal
        : swingHigh + atrVal

    let risk = Math.abs(price - sl)

let tp

if(side === "LONG"){
    tp = Math.min(
        price + risk * RR_THRESHOLD,
        resistance
    )
}else{
    tp = Math.max(
        price - risk * RR_THRESHOLD,
        support
    )
}
// kiểm tra khoảng cách giữa tp và price
if(Math.abs(tp - price) / price < 0.0015){
    return null
}
        // candle có thân lớn so với toàn cây không (giữ nguyên)
        let open = +data15.at(-1)[1]
let close = +data15.at(-1)[4]

let body = Math.abs(close - open)
let rangeCandle = highs.at(-1) - lows.at(-1)

if(rangeCandle === 0 || body / rangeCandle < 0.2){
    return null
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
    let aiMain = (dbMain.winrate - 0.5) * 200 * weightMain

    if(dbMain.total < 15) aiMain *= 0.5

    let finalMain = s.score + aiMain

    if(finalMain >= s.dynamicThreshold){
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

// let main = candidates.find(c => c.type === "MAIN")

let best = candidates[0]

// ===== CHECK DB AI =====
let dbAI = await getDBStats(
    best.setup,
    best.marketState,
    best.side,
    best.volatility
)
// ===== AI MARKET ADAPTIVE =====
if(dbAI.total > 20){

    if(best.marketState === "SIDEWAY"){
        if(dbAI.winrate < 0.48){
            best.finalScore -= 15
        }
    }

    if(best.marketState === "TREND_STRONG"){
        if(dbAI.winrate > 0.55){
            best.finalScore += 10
        }
    }

}
// ===== CHECK BEST CANDIDATE =====
       // ❌ check trước
if(!best || !best.type){
    console.log("❌ Invalid best")
    return
}

// ===== EARLY =====
//if(best.type === "EARLY"){

   // let rr = Math.abs(best.tp - best.price) / Math.abs(best.price - best.sl)

    //if(best.score < EARLY_THRESHOLD){
       // console.log("❌ Early score thấp")
        //return
    //}

    //if(rr < 1.1){
        //return
   // }
//}

// ===== MAIN =====
if(best.type !== "EARLY"){

    let rr = Math.abs(best.tp - best.price) / Math.abs(best.price - best.sl)

    //if(rr < RR_THRESHOLD){
        //console.log("❌ RR MAIN fail")
        //return
    //}
}
    // nếu là breakout thì yêu cầu momentum rõ
    if(best.setup === "BREAKOUT" && best.type !== "EARLY"){
    if(!best.momentumUp && !best.momentumDown){
         console.log("❌ momentum kh rõ")
        return
    }
}

    let weakMomentum =
    Math.abs(best.price - best.sl)/best.price < 0.0015 &&
    !best.momentumUp && !best.momentumDown
    
    if(best.setup === "PULLBACK" && weakMomentum && best.type !== "EARLY"){
    return
}
        // ===== BLOCK DUPLICATE SIGNAL =====
let nowTime = Date.now()

let symbolKey = `${best.symbol}-${best.side}`

if(lastSignalTime[symbolKey]){
    let diff = Date.now() - lastSignalTime[symbolKey]

    if(diff < 3600000){
        console.log(`⛔ Skip trùng coin: ${symbolKey}`)
        return
    }
}


        // ===== RISK =====
        let multiplier = 1

if(dbAI.total > 20){

    let edge = dbAI.winrate - 0.5

    multiplier = 1 + edge * 2   // scale mềm

    // clamp lại
    if(multiplier > 1.5) multiplier = 1.5
    if(multiplier < 0.5) multiplier = 0.5
}
let risk = ACCOUNT_BALANCE * RISK_PER_TRADE * multiplier

        if(best.type === "EARLY") risk *= 0.5
// ===== CHECK SL TP TRƯỚC =====
if(!best.sl || !best.tp){
    console.log("❌ Missing SL TP")
    return
}

// ===== TÍNH DIFF SAU =====
let diff = Math.abs(best.price - best.sl)

if(!diff || diff === 0){
    console.log("❌ Invalid SL distance")
    return
}

        let size = risk / diff
       
        let trailingSL = best.side === "LONG"
            ? best.price - best.atr
            : best.price + best.atr
            
// ===== TÍNH RR =====
let rr = best.side === "LONG"
    ? (best.tp - best.price) / (best.price - best.sl)
    : (best.price - best.tp) / (best.sl - best.price)

// ===== AI RR ADAPTIVE =====
if(dbAI.total > 20){

    if(dbAI.winrate > 0.6){
        rr *= 0.9   // dễ vào hơn (TP gần hơn)
    }

    if(dbAI.winrate < 0.45){
        rr *= 1.1   // khó hơn (đòi RR cao hơn)
    }
}
        // === RR ====
let rrThreshold = RR_THRESHOLD

if(dbAI.total > 20){

    if(dbAI.winrate > 0.6){
        rrThreshold = 1.1   // dễ hơn
    }

    if(dbAI.winrate < 0.45){
        rrThreshold = 1.35  // khó hơn
    }
}

// check
if(rr < rrThreshold){
     console.log("❌ rr <rrThreshold")
    return
}
// ===== AI BLOCK =====
let threshold = 0.48

if(best.marketState === "TREND_STRONG"){
    threshold = 0.44
}

if(best.marketState === "SIDEWAY"){
    threshold = 0.52
}

let aiScoreAdjust = 0

if(dbAI.total > 10){

    let edge = dbAI.winrate - 0.5  // lợi thế

    // scale nhẹ để không phá logic gốc
    aiScoreAdjust = edge * 100   // ~ -10 → +10

    // confidence theo sample
    let confidence = Math.min(dbAI.total / 50, 1)

    aiScoreAdjust *= confidence
}

// áp vào score
best.finalScore = (best.finalScore || best.score) + aiScoreAdjust
        // ===== MESSAGE =====
       let msg = `🔥 BEST SIGNAL

${best.symbol} (${best.type} - ${best.setup})
${best.side} | ${best.marketState}
Entry Zone: ${best.price.toFixed(4)}
TP: ${best.tp.toFixed(4)}
SL: ${best.sl.toFixed(4)}
Trailing SL: ${trailingSL.toFixed(4)}
Size: ${size.toFixed(2)}
Score: ${t.score || 0}
`

       //onsole.log(msg)
       //et ok = await sendTelegram(msg)

//(ok !== false){
   //astSignalTime[symbolKey] = Date.now()
//}
        // ===== SAVE TRADE =====
let trade = {
    symbol: best.symbol,
    side: best.side,

    // ❌ chưa vào lệnh
    entry: null,

    // ✅ giá chờ
    entryZone: best.price,

    tp: best.tp,
    sl: best.sl,
    score: best.score,
    waitingEntry: true,   // 🔥 CHỜ 1M CONFIRM

    setup: best.setup,
    marketState: best.marketState,
    volatility: best.volatility,
    atr: best.atr,

    time: Date.now(),
    result: "PENDING"
}

activeTrades.push(trade)
if(activeTrades.length > 50){
    activeTrades.shift()
}

// 🔥 THÊM DÒNG NÀY (lưu DB)
await trades.insertOne(trade)

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

    let closes = data.map(x => +x[4])
    let last = closes.at(-1)
    let prev = closes.at(-2)

    let confirm = false

    // ===== LONG =====
    if(t.side === "LONG"){
    if(last >= t.entryZone){
        confirm = true
    }
}

if(t.side === "SHORT"){
    if(last <= t.entryZone){
        confirm = true
    }
}

    // ===== VÀO LỆNH =====
    if(confirm){
    t.entry = price
    t.waitingEntry = false

    let trailingSL = t.side === "LONG"
        ? t.entry - t.atr
        : t.entry + t.atr

    let size = (ACCOUNT_BALANCE * RISK_PER_TRADE) / Math.abs(t.entry - t.sl)

    let msg = `🔥 BEST SIGNAL

${t.symbol} (${t.setup})
${t.side} | ${t.marketState}

Entry: ${t.entry.toFixed(4)}

TP: ${t.tp.toFixed(4)}

SL: ${t.sl.toFixed(4)}

Trailing SL: ${trailingSL.toFixed(4)}
Size: ${size.toFixed(2)}
Score: ${best.score}
`

    await sendTelegram(msg)

    lastSignalTime[`${t.symbol}-${t.side}`] = Date.now()
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
        

            // timeout 6h
let isTimeout = Date.now() - t.time > 21600000

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
⛔ Không chạm TP/SL trong 6h`
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
        console.log(`♻️ Load lại ${activeTrades.length} lệnh`)

        // ================= LOOP =================
setInterval(()=>scanner(),300000)
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
        // 🔥 CHECK DB (giảm spam)
        if(Math.random() < 0.1){
            await client.db("admin").command({ ping: 1 })
            console.log("🟢 DB OK")
        }

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
