// Lỗi tiềm ẩn có thể commen thử 
// const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args))
// DB 
const { MongoClient } = require("mongodb")

const client = new MongoClient(process.env.MONGO_URI)

let db, trades
// ================= CONFIG =================
const BOT_TOKEN = process.env.BOT_TOKEN
const CHAT_ID = process.env.CHAT_ID

const BOT_TOKEN_2 = process.env.BOT_TOKEN_2
const AI_CHAT_ID = process.env.AI_CHAT_ID

const LIMIT_15M = 200 //300
const LIMIT_1H  = 300 //100

const SCORE_THRESHOLD = 95 // 110
const EARLY_THRESHOLD = 55  // 60
const RR_THRESHOLD = 1.1 // 1.3 hoặc 1.4 nếu muốn 

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

if(volNow < volAvg * 0.5){ // 0.06 0.07
    console.log("❌ vol fail")
    return null
}
    if(volAvg < MIN_VOL_15M){
        console.log("❌ MIN_VOL_15M")
        return null
    }
    // ===== EMA =====
    let ema20 = ema(closes.slice(-60),20)
    let ema50 = ema(closes.slice(-120),50)
    let ema200= ema(closes.slice(-250),200)

    let ema20_1h = ema(closes1h.slice(-60),20)
    let ema50_1h = ema(closes1h.slice(-120),50)
    // ===== DYNAMIC THRESHOLD FINAL =====
let trendHTF = Math.abs(ema20_1h - ema50_1h) / price
let trendLTF = Math.abs(ema20 - ema50) / price

let dynamicThreshold = 100

if(trendHTF > 0.003 && trendLTF > 0.002){
    dynamicThreshold = 90
}
else if(trendHTF > 0.0015){
    dynamicThreshold = 95
}
else{
    dynamicThreshold = 105
}

// sideway yếu → bỏ luôn
if(trendHTF < 0.0012 && trendLTF < 0.001){ // 0.002 0.0018
    console.log("❌ sideway → bỏ")
    return null
}

    let r = rsi(closes.slice(-50))
    let atrVal = atr(data15.slice(-100))
    // mới thêm
    let recentMove = Math.abs(closes.at(-1) - closes.at(-5))
if(recentMove > atrVal * 2.0){ //1.6
    console.log("❌ pump fail")
    return null
}

    let volatility = "LOW"

if(atrVal / price > 0.0045){
    volatility = "HIGH"
}
    // ===== FILTER COIN RÁC (WICK) =====
let lastHigh = highs.at(-1)
let lastLow = lows.at(-1)

let wickSize = lastHigh - lastLow

if(wickSize > atrVal * 2.5){
    console.log("❌ coin rác")
    return null
}
    // ===== MARKET REGIME =====
let emaGap = Math.abs(ema20 - ema50) / price
let atrRatio = atrVal / price

let marketState = "SIDEWAY"

// TREND MẠNH
if(emaGap > 0.004 && atrRatio > 0.0045){
    marketState = "TREND_STRONG"
}
// TREND YẾU
else if(emaGap > 0.0025){
    marketState = "TREND_WEAK"
}
let range = (Math.max(...highs.slice(-30)) - Math.min(...lows.slice(-30))) / price

if(marketState === "SIDEWAY" && range < 0.0025){ //0.003
    console.log("❌ Trend yếu")
    return null
}
// còn lại là SIDEWAY
    // ===== ANTI CHASE + PULLBACK =====
let distEma = Math.abs(price - ema20) / price

// không vào khi vừa pump/dump mạnh
let lastMove = (closes.at(-1) - closes.at(-3)) / closes.at(-3)
if(lastMove > 0.03 || lastMove < -0.03){ // 0.02
    console.log("❌ pump/dump mạnh")
    return null 
}
// chỉ vào khi giá gần EMA (pullback)
let nearEma = distEma < 0.01 // 0.07 // 0.006 // 0.5 nếu đu 
// ===== PULLBACK PHẢI CÓ LỰC =====
if(marketState === "SIDEWAY"){
    if(nearEma && volNow < volAvg * 0.7){ //0.6
        console.log("❌ k có lực")
        return null
    }
}
    // ===== STRUCTURE =====
    // tránh vào giữa trend
    let rangeHigh = Math.max(...highs.slice(-30))
let rangeLow  = Math.min(...lows.slice(-30))

let pos = (price - rangeLow) / (rangeHigh - rangeLow)
// score
let side=null, score=0
    let setupType = null // breakout | pullback
// ❌ tránh giữa range
if(pos > 0.4 && pos < 0.6){
    console.log("❌ giữa trend")
    return null
}
    let prevHigh = Math.max(...highs.slice(-25,-5))
    let prevLow  = Math.min(...lows.slice(-25,-5))

    let bosUp = price > prevHigh
    let bosDown = price < prevLow
    // bắt sớm trend xóa đi nếu kh ổn
    let recentBreakUp = closes.at(-1) > prevHigh
let recentBreakDown = closes.at(-1) < prevLow

if(recentBreakUp){
    score += 25
}

if(recentBreakDown){
    score += 25
}

    let prevHigh50 = Math.max(...highs.slice(-51,-1))
    let prevLow50  = Math.min(...lows.slice(-51,-1))

    let sweepHigh = highs.at(-2) > prevHigh50 && closes.at(-2) < prevHigh50
    let sweepLow  = lows.at(-2) < prevLow50 && closes.at(-2) > prevLow50

    // ===== MOMENTUM =====
    let last4 = closes.slice(-4)
    let momentumUp = last4[3]>last4[2] && last4[2]>last4[1]
    let momentumDown = last4[3]<last4[2] && last4[2]<last4[1]
    // ===== CONTINUATION STRUCTURE =====
    let higherLow = lows.at(-2) > lows.at(-5)
    let lowerHigh = highs.at(-2) < highs.at(-5)

    // ===== VOLUME =====
    let volTrendUp = volumes.slice(-5).every((v,i,a)=> i===0 || v>=a[i-1])

    // ===== FILTER =====
    let trendLong = ema20>ema50 && ema50>ema200 && ema20_1h>ema50_1h
    let trendShort = ema20<ema50 && ema50<ema200 && ema20_1h<ema50_1h

    let trendStrength = Math.abs(ema20-ema50)/price
    if(marketState === "TREND_STRONG" && trendStrength < 0.002){
        console.log("❌ trendStrength fail")
    return null
}

if(marketState !== "TREND_STRONG" && trendStrength < 0.0015){
    console.log("❌ trendStrength fail 2")
    return null
}
    
    // ===== FILTER SIDEWAY =====
if(marketState === "SIDEWAY"){

    if(sweepHigh){
        side = "SHORT"
        score += 60
    }

    if(sweepLow){
        side = "LONG"
        score += 60
    }
    if(!side) return null
    // ❌ cấm breakout trong sideway
    if(bosUp || bosDown){
        return null
    }
}

    let candleMove = Math.abs(closes.at(-1)-closes.at(-2))/price
    if(candleMove > 0.05){ // 0.3 gốc // 0.4
        console.log("❌ candleMove fail")
        return null 
    }
    let fakePump = volNow > volAvg*2.5 && closes.at(-1) < highs.at(-1)*0.98
    let fakeDump = volNow > volAvg*2.5 && closes.at(-1) > lows.at(-1)*1.02
    if(fakePump || fakeDump){
        console.log("❌ fake")
        return null
    }
    // ===== SCORE =====
    if(trendLong){ side="LONG"; score+=50 }
    if(trendShort){ side="SHORT"; score+=50 }

    // ===== BREAKOUT =====
if(side==="LONG" && bosUp){
    score += marketState === "TREND_STRONG" ? 40 : 20
    setupType = "BREAKOUT"
}

if(side==="SHORT" && bosDown){
    score += marketState === "TREND_STRONG" ? 40 : 20
    setupType = "BREAKOUT"
}

// ===== PULLBACK =====
 if(side==="LONG" && nearEma){
    score += marketState === "TREND_WEAK" ? 30 : 15
    if(!setupType) setupType = "PULLBACK"
}

if(side==="SHORT" && nearEma){
    score += marketState === "TREND_WEAK" ? 30 : 15
    if(!setupType) setupType = "PULLBACK"
}
    if(!setupType && (bosUp || bosDown)){
    setupType = "BREAKOUT"
}

    if(side==="LONG" && sweepLow) score+=35 // 50
    if(side==="SHORT" && sweepHigh) score+=35 // 50

    if(volTrendUp) score+=20 // 15 ở dưới là 10 
    if(volNow > volAvg*1.5) score+=15 

    if(side==="LONG" && momentumUp) score+=25   // 20
    if(side==="SHORT" && momentumDown) score+=25    // 20

    if(side==="LONG" && higherLow) score+=15
    if(side==="SHORT" && lowerHigh) score+=15
   
    if(side==="LONG" && r>50 && r<65) score+=10
    if(side==="SHORT" && r>35 && r<50) score+=10

    if(atrVal/price > 0.004) score+=10
    if(!side){
        console.log("❌ !side")
        return null
    }
    // ===== REQUIRE PULLBACK =====
if(side === "LONG" && !nearEma){
    score -= 10
}
if(side === "SHORT" && !nearEma){
    score -= 10
}
    
    // ===== EARLY =====
    let earlySide=null, earlyScore=0

    if(trendLong && nearEma){
    earlySide="LONG"
    earlyScore=50
    if(r>50 && r<60) earlyScore+=10
    if(momentumUp) earlyScore+=5  // thêm
    if(volNow > volAvg) earlyScore+=5 // thêm    
}

if(trendShort && nearEma){
    earlySide="SHORT"
    earlyScore=50
    if(r<50 && r>40) earlyScore+=10
    if(momentumDown) earlyScore+=5 // thêm
    if(volNow > volAvg) earlyScore+=5 // thêm
}

// ===== MARKET STATE =====
let isTrending = trendStrength > 0.003 // 0.004 

// ===== SWING =====
let swingLow = Math.min(...lows.slice(-20))
let swingHigh = Math.max(...highs.slice(-20))

// ===== STRUCTURE =====
let resistance = Math.max(...highs.slice(-30))
let support = Math.min(...lows.slice(-30))
// ===== AVOID BAD ZONE =====
let distToRes = (resistance - price) / price
let distToSup = (price - support) / price

if(side === "LONG" && distToRes < 0.0025){ // 0.0045 nếu mua đỉnh bán đáy
     console.log("❌ đỉnh")
    return null
}
if(side === "SHORT" && distToSup < 0.0025){
    console.log("❌ đáy")
    return null
}
// ===== LIQUIDITY =====
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

// ===== PICK TP =====
function pickBestTP(candidates, price, risk, side, setupType, atrVal){

    let valid = []

    for(let c of candidates){

        let rrCalc = side==="LONG"
            ? (c.price - price) / risk
            : (price - c.price) / risk

        let dist = side==="LONG"
            ? (c.price - price)
            : (price - c.price)

        // 🔥 FIX
        if(side === "LONG" && c.price <= price) continue
        if(side === "SHORT" && c.price >= price) continue

        if(dist < risk * 1.1) continue
        if(dist > risk * 4) continue

        let rr = rrCalc

        if(rr > 3) rr = 3

        if(rr >= RR_THRESHOLD && dist >= atrVal * 1.0 && dist <= atrVal * 3.5){
            valid.push({...c, rr, dist})
        }
    }

    if(valid.length === 0){
        console.log("❌ valid.length fail")
        return null
    }
    valid.sort((a,b)=>{

        let setupBoost = 0
        if(setupType === "BREAKOUT") setupBoost = 0.2
        if(setupType === "retest") setupBoost = 0.1

        let scoreA = a.rr - (a.dist / (atrVal * 3)) + setupBoost
        let scoreB = b.rr - (b.dist / (atrVal * 3)) + setupBoost

        return scoreB - scoreA
    })

    if(DEBUG_AI){
        console.log("🎯 TP PICK:", valid.slice(0,3))
    }

    return valid[0].price
}

// ===== INIT =====
let sl = null
let tp = null
// ===== AI TP/SL =====
let rrAI = await getBestTPSL(setupType, marketState, side)

let rrBase = RR_THRESHOLD
let rr = RR_THRESHOLD // 🔥 THÊM    

if(rrAI && rrAI.rr && rrAI.rr > 0){
    rr = Math.max(rrAI.rr, RR_THRESHOLD)
}
    // TP SL THEO 
    let tpMult = 1
let slMult = 1

if(marketState === "TREND_STRONG"){
    tpMult = 1.3
    slMult = 1.2
}

if(marketState === "TREND_WEAK"){
    tpMult = 1
    slMult = 1
}

if(marketState === "SIDEWAY"){
    tpMult = 0.7
    slMult = 0.8
}

// ===== LONG =====
if(side === "LONG"){

   if(setupType === "BREAKOUT"){
    sl = swingLow - atrVal * 0.6 * slMult
}else{
   sl = swingLow - atrVal * 0.8 * slMult
}

if(sl >= price) sl = price - atrVal * 1.5

    let risk = price - sl

    let candidates = []

    if(resistance > price) candidates.push({price: resistance, type:"res"})
    if(liqHigh && liqHigh > price) candidates.push({price: liqHigh, type:"liq"})

    if(candidates.length === 0){
        candidates.push({price: price + atrVal * 2, type:"atr"})
    }

    tp = pickBestTP(candidates, price, risk, "LONG", setupType, atrVal)

    if(!tp){
        if(resistance > price) tp = resistance
        else if(liqHigh && liqHigh > price) tp = liqHigh
        else tp = price + atrVal * 2 * tpMult
    }

    let dist = tp - price

   if(dist > atrVal * 5){
    if(setupType === "BREAKOUT"){
        tp = price + atrVal * 4.5 * tpMult
    }else{
        tp = price + atrVal * 3 * tpMult
    }
}

    if(dist < atrVal * 0.8){
        console.log("❌ dist atrVal LONG")
        return null
    }
    let last3 = closes.slice(-3)
    let weak = last3[2] < last3[1] && last3[1] < last3[0]

       // ===== APPLY AI RR FINAL =====
if(sl && price){

    let riskAI = Math.abs(price - sl)

    if(riskAI > 0){

        let rrTP = side === "LONG"
            ? price + riskAI * rr
            : price - riskAI * rr

        let distAI = Math.abs(rrTP - price)
        let distTP = Math.abs(tp - price)

        // ✅ ƯU TIÊN TP XA HƠN (RR tốt hơn)
        if(distAI > distTP){
            tp = rrTP
        }
    }
}
if(weak && dist > atrVal * 2.5){
       tp = price + atrVal * 1.8 * tpMult
    }
}

// ===== SHORT =====
if(side === "SHORT"){

    if(setupType === "BREAKOUT"){
    sl = swingHigh + atrVal * 0.6 * slMult
}else{
    sl = swingHigh + atrVal * 0.8 * slMult
}

if(sl <= price) sl = price + atrVal * 1.5

    let risk = sl - price

    let candidates = []

    if(support < price) candidates.push({price: support, type:"sup"})
    if(liqLow && liqLow < price) candidates.push({price: liqLow, type:"liq"})

    if(candidates.length === 0){
        candidates.push({price: price - atrVal * 2, type:"atr"})
    }

    tp = pickBestTP(candidates, price, risk, "SHORT", setupType, atrVal)

    if(!tp){
        if(support < price) tp = support
        else if(liqLow && liqLow < price) tp = liqLow
        else tp = price - atrVal * 2 * tpMult
    }

    let dist = price - tp

   if(dist > atrVal * 5){
    if(setupType === "BREAKOUT"){
        tp = price - atrVal * 4.5 * tpMult
    }else{
        tp = price - atrVal * 3 * tpMult
    }
}

    if(dist < atrVal * 0.8){
        console.log("❌ dist atrVal SHORT")
        return null
    }
    let last3 = closes.slice(-3)
    let weak = last3[2] > last3[1] && last3[1] > last3[0]
// ===== APPLY AI RR FINAL =====
if(sl && price){

    let riskAI = Math.abs(price - sl)

    if(riskAI > 0){

        let rrTP = price - riskAI * rr

        let distAI = Math.abs(rrTP - price)
        let distTP = Math.abs(tp - price)

        if(distAI > distTP){
            tp = rrTP
        }
    }
}
if(weak && dist > atrVal * 2.5){
        tp = price - atrVal * 1.8 * tpMult
    }
}
// ===== VALIDATE SL + RECALC TP =====
let minDistance = price * 0.002
let maxDistance = price * 0.03

if(Math.abs(price - sl) < minDistance || Math.abs(price - sl) > maxDistance){

    sl = side==="LONG"
        ? price - atrVal * 1.5 * slMult
        : price + atrVal * 1.5 * slMult

    let risk = Math.abs(price - sl)

    let candidates = []

    if(side==="LONG"){
        if(resistance > price) candidates.push({price: resistance, type:"res"})
        if(liqHigh && liqHigh > price) candidates.push({price: liqHigh, type:"liq"})
    }else{
        if(support < price) candidates.push({price: support, type:"sup"})
        if(liqLow && liqLow < price) candidates.push({price: liqLow, type:"liq"})
    }

   tp = pickBestTP(candidates, price, risk, side, setupType, atrVal)

    if(!tp){
        tp = side==="LONG"
            ? price + atrVal * 2 * tpMult
            : price - atrVal * 2 * tpMult
    }

    let rrCalc = side==="LONG"
        ? (tp - price) / risk
        : (price - tp) / risk

    if(rr < RR_THRESHOLD){
        console.log("❌ VALIDATE")
        return null // 1.5
    }
    let newDist = Math.abs(tp - price)

    if(newDist > atrVal * 4){
        tp = side==="LONG"
            ? price + atrVal * 2.5 * tpMult
            : price - atrVal * 2.5 * tpMult
    }

    if(newDist < atrVal * 0.8){
        console.log("❌ RECALC TP")
        return null
    }
}

// ===== ROUND =====
function round(n){ return Number(n.toFixed(4)) }
    // ==== CANDLE STRENGTH FILTER ====
    let open = +data15.at(-1)[1]
let close = +data15.at(-1)[4]

let body = Math.abs(close - open)
let rangeCandle = highs.at(-1) - lows.at(-1)

if(rangeCandle === 0 || body / rangeCandle < 0.2){ // nếu muốn chắc hơn rõ nâng 0.4 
    console.log("❌ rangeCandle fail")
    return null
}
// ===== ANTI FOMO (FIX CHUẨN) tránh đu đỉnh đu đáy =====

// dùng dữ liệu có sẵn
let lastOpen = +data15.at(-1)[1]
let lastClose = +data15.at(-1)[4]

let lastBody = Math.abs(lastClose - lastOpen)

// khoảng cách tới EMA
let distance = Math.abs(price - ema20)

// ===== 1. TRỪ ĐIỂM (xa EMA) =====
if(distance > atrVal * 2.0){ // nếu quá ít lệnh fix 1.7 nếu rác 1.5
    score -= 25
}

// ===== 2. CHẶN HOÀN TOÀN (quá xa) =====
if(marketState !== "TREND_STRONG"){
    if(distance > atrVal * 3){
        console.log("❌ quá xa")
        return null
    }
}
// ===== 3. NẾN ĐẢO CHIỀU MẠNH =====
if(side === "LONG" && lastClose < lastOpen && lastBody > atrVal * 0.8){
    console.log("❌ nến đảo mạnh")
    return null
}

if(side === "SHORT" && lastClose > lastOpen && lastBody > atrVal * 0.8){
     console.log("❌ nến đảo mạnh")
    return null
}
    // ===== FIX NULL SETUP =====
if(!setupType){
    setupType = nearEma ? "PULLBACK" : "BREAKOUT"
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
    earlySide,
    earlyScore,
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

// ================= SCANNER =================
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

    // ===== EARLY =====
    if(s.earlyScore >= EARLY_THRESHOLD && s.earlySide){

        let keyEarly = `${s.setup}-${s.marketState}-${s.earlySide}-${s.volatility}`

        if(!dbCache[keyEarly]){
            dbCache[keyEarly] = await getDBStats(
                s.setup,
                s.marketState,
                s.earlySide,
                s.volatility
            )
        }

        let dbEarly = dbCache[keyEarly]

        let weightEarly = Math.min(dbEarly.total / 50, 1)
        let aiEarly = (dbEarly.winrate - 0.5) * 200 * weightEarly

        if(dbEarly.total < 15) aiEarly *= 0.5

        let finalEarly = s.earlyScore + aiEarly * 0.7

        candidates.push({
            ...s,
            side: s.earlySide,
            score: s.earlyScore,
            finalScore: finalEarly,
            type: "EARLY"
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

let main = candidates.find(c => c.type === "MAIN")

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
if(best.type === "EARLY"){

    let rr = Math.abs(best.tp - best.price) / Math.abs(best.price - best.sl)

    if(best.score < EARLY_THRESHOLD){
        console.log("❌ Early score thấp")
        return
    }

    if(rr < 1.1){
        return
    }
}

// ===== MAIN =====
if(best.type !== "EARLY"){

    let rr = Math.abs(best.tp - best.price) / Math.abs(best.price - best.sl)

    if(rr < RR_THRESHOLD){
        console.log("❌ RR MAIN fail")
        return
    }
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

let symbolKey = best.symbol

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

if(dbAI.total > 20){

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
Entry: ${best.price.toFixed(4)}
TP: ${best.tp.toFixed(4)}
SL: ${best.sl.toFixed(4)}
Trailing SL: ${trailingSL.toFixed(4)}
Size: ${size.toFixed(2)}
Score: ${best.score}
`

        console.log(msg)
        let ok = await sendTelegram(msg)

if(ok !== false){
    lastSignalTime[symbolKey] = Date.now()
}
        // ===== SAVE TRADE =====
let trade = {
    symbol: best.symbol,
    side: best.side,
    entry: best.price,
    tp: best.tp,
    sl: best.sl,
    setup: best.setup,
    marketState: best.marketState,
    volatility: best.volatility,
    atr: best.atr,
    time: Date.now(),
    result: "PENDING"
}

activeTrades.push(trade)

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
