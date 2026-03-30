// ================= CONFIG =================
const BOT_TOKEN = process.env.BOT_TOKEN
const CHAT_ID = process.env.CHAT_ID

const BOT_TOKEN_2 = process.env.BOT_TOKEN_2
const AI_CHAT_ID = process.env.AI_CHAT_ID

const LIMIT_15M = 300
const LIMIT_1H  = 200

const SCORE_THRESHOLD = 95 // 110
const EARLY_THRESHOLD = 55  // 60
const RR_THRESHOLD = 1.1 // 1.3 hoặc 1.4 nếu muốn 

const RISK_PER_TRADE = 0.01
const ACCOUNT_BALANCE = 1000
const MIN_VOL_15M = 50000 // 100000 hoặc  nếu rác

let lastUpdateId = 0
let cachedSymbols = null
let lastSymbolsUpdate = 0
let lastSignalTime = {}

let setup = "BREAKOUT"
let marketState = "TREND"
// ================= AI MEMORY =================
function getWinRate(win, loss){
    win = win || 0
    loss = loss || 0

    let total = win + loss
    if(total === 0) return 0.5

    return win / total
}

// ===== ACTIVE TRADES =====
let activeTrades = []

// AI
let aiMemory = {
    setups: {},
    markets: {}
}

let lastMessageId = null

// ===== TELEGRAM AI STORAGE =====
async function saveMemory(){

    try{

        let data = JSON.stringify(aiMemory)

        // lần đầu → gửi
        if(!lastMessageId){

            let res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN_2}/sendMessage`,{
                method:"POST",
                headers:{ "Content-Type":"application/json" },
                body: JSON.stringify({
                    chat_id: AI_CHAT_ID,
                    text: "AI_MEMORY:" + data.slice(0, 3000) // chống quá dài
                })
            })

            let json = await res.json()

            if(!json.ok){
                console.log("❌ SEND FAIL:", json)
                return
            }

            lastMessageId = json.result.message_id
            console.log("✅ AI saved (new message)")
        }

        // các lần sau → edit
        else{

            let res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN_2}/editMessageText`,{
                method:"POST",
                headers:{ "Content-Type":"application/json" },
                body: JSON.stringify({
                    chat_id: AI_CHAT_ID,
                    message_id: lastMessageId,
                    text: "AI_MEMORY:" + data.slice(0, 3000)
                })
            })

            let json = await res.json()

            if(!json.ok){
                console.log("❌ EDIT FAIL:", json)

                // fallback: gửi mới nếu edit lỗi
                lastMessageId = null
            }else{
                console.log("✅ AI updated")
            }
        }

    }catch(e){
        console.log("❌ SAVE AI ERROR:", e.message)
    }
}


async function loadMemory(){

    try{

        let res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN_2}/getUpdates`)
        let data = await res.json()

        if(!data.ok){
            console.log("❌ LOAD FAIL:", data)
            return
        }

        let messages = data.result.reverse()

        for(let msg of messages){

            let text = msg.message?.text || ""

            if(text.startsWith("AI_MEMORY:")){

                try{
                    aiMemory = JSON.parse(text.replace("AI_MEMORY:", ""))
                    lastMessageId = msg.message.message_id

                    console.log("✅ Loaded AI từ Telegram phụ")
                    return
                }catch(e){
                    console.log("❌ parse AI lỗi")
                }
            }
        }

        console.log("⚠️ chưa có AI memory")

    }catch(e){
        console.log("❌ LOAD AI ERROR:", e.message)
    }
}

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
// Telegram phụ để lưu AI memory
async function sendTelegram2(msg){
    try{
        let url = `https://api.telegram.org/bot${BOT_TOKEN_2}/sendMessage`
        await fetch(url,{
            method:"POST",
            headers:{"Content-Type":"application/json"},
            body: JSON.stringify({ chat_id: AI_CHAT_ID, text: msg })
        })
    }catch(e){
        console.log("❌ TELE 2:", e.message)
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
                .slice(0,60)
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
    let range = (Math.max(...highs.slice(-30)) - Math.min(...lows.slice(-30))) / price

if(range < 0.003){ // 0.4 
    return null
}

    let volAvg = volumes.slice(-30).reduce((a,b)=>a+b,0)/30
    let volNow = volumes.at(-1)

if(volNow < volAvg * 0.6){ //0.007
    return null
}
    if(volAvg < MIN_VOL_15M) return null

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
if(trendHTF < 0.0015 && trendLTF < 0.0012){ // 0.0025 0.002
    return null
}

    let r = rsi(closes.slice(-50))
    let atrVal = atr(data15.slice(-100))
    // ===== FILTER COIN RÁC (WICK) =====
let lastHigh = highs.at(-1)
let lastLow = lows.at(-1)

let wickSize = lastHigh - lastLow

if(wickSize > atrVal * 2.5){
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
// còn lại là SIDEWAY
    // ===== ANTI CHASE + PULLBACK =====
let distEma = Math.abs(price - ema20) / price

// không vào khi vừa pump/dump mạnh
let lastMove = (closes.at(-1) - closes.at(-3)) / closes.at(-3)
if(lastMove > 0.025 || lastMove < -0.025) return null // 0.02

// chỉ vào khi giá gần EMA (pullback)
let nearEma = distEma < 0.006 // 0.0025 // 0.0035 // 0.5 nếu đu 
// ===== PULLBACK PHẢI CÓ LỰC =====
if(nearEma && volNow < volAvg * 0.6){ // nâng 0.8 nếu sideway
    return null
}
    // ===== STRUCTURE =====
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
    // ===== CONTINUATION STRUCTURE =====
    let higherLow = lows.at(-2) > lows.at(-5)
    let lowerHigh = highs.at(-2) < highs.at(-5)

    // ===== VOLUME =====
    let volTrendUp = volumes.slice(-5).every((v,i,a)=> i===0 || v>=a[i-1])

    // ===== FILTER =====
    let trendLong = ema20>ema50 && ema50>ema200 && ema20_1h>ema50_1h
    let trendShort = ema20<ema50 && ema50<ema200 && ema20_1h<ema50_1h

    let trendStrength = Math.abs(ema20-ema50)/price
    if(trendStrength < 0.002) return null // 0.0022
    
    // ===== FILTER SIDEWAY =====
if(marketState === "SIDEWAY"){
    if(!sweepHigh && !sweepLow){
        return null
    }
}

    let candleMove = Math.abs(closes.at(-1)-closes.at(-2))/price
    if(candleMove > 0.03) return null

    let fakePump = volNow > volAvg*2.5 && closes.at(-1) < highs.at(-1)*0.98
    let fakeDump = volNow > volAvg*2.5 && closes.at(-1) > lows.at(-1)*1.02
    if(fakePump || fakeDump) return null

    // ===== SCORE =====
    let side=null, score=0
    let setupType = null // breakout | pullback

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
    if(!side) return null
    // ===== AI SCORE =====
let s = aiMemory.setups[setupType] || { win:0, loss:0 }
let wr = getWinRate(s.win, s.loss)

if(wr > 0.6) score += 10
if(wr < 0.4) score -= 10

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

if(side === "LONG" && distToRes < 0.0035) return null // 0.0045 nếu mua đỉnh bán đáy
if(side === "SHORT" && distToSup < 0.0035) return null

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

        let rr = side==="LONG"
            ? (c.price - price) / risk
            : (price - c.price) / risk

        let dist = side==="LONG"
            ? (c.price - price)
            : (price - c.price)

       // ===== AI TP ADJUST =====
let s = aiMemory.setups[setupType] || { win:0, loss:0 }
let wr = getWinRate(s.win, s.loss)

// win thấp → ép TP gần
let rrMin = RR_THRESHOLD

if(wr > 0.6) rrMin = RR_THRESHOLD * 0.9
if(wr < 0.4) rrMin = RR_THRESHOLD * 1.1

if(rr >= rrMin && dist >= atrVal * 0.7 && dist <= atrVal * 3.5){
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

// ===== INIT =====
let sl = null
let tp = null
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

    if(dist < atrVal * 0.8) return null

    let last3 = closes.slice(-3)
    let weak = last3[2] < last3[1] && last3[1] < last3[0]

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

    if(dist < atrVal * 0.8) return null

    let last3 = closes.slice(-3)
    let weak = last3[2] > last3[1] && last3[1] > last3[0]

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

    let rr = side==="LONG"
        ? (tp - price) / risk
        : (price - tp) / risk

   // if(rr < RR_THRESHOLD) return null // 1.5

    let newDist = Math.abs(tp - price)

    if(newDist > atrVal * 4){
        tp = side==="LONG"
            ? price + atrVal * 2.5 * tpMult
            : price - atrVal * 2.5 * tpMult
    }

    if(newDist < atrVal * 0.8){
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

if(rangeCandle === 0 || body / rangeCandle < 0.3){ // nếu muốn chắc hơn rõ nâng 0.4 
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
if(distance > atrVal * 1.7){ // nếu quá ít lệnh fix 1.7 nếu rác 1.5
    score -= 25
}

// ===== 2. CHẶN HOÀN TOÀN (quá xa) =====
if(distance > atrVal * 3){ // cũ 3.5
    return null
}

// ===== 3. NẾN ĐẢO CHIỀU MẠNH =====
if(side === "LONG" && lastClose < lastOpen && lastBody > atrVal * 0.8){
    return null
}

if(side === "SHORT" && lastClose > lastOpen && lastBody > atrVal * 0.8){
    return null
}
    
return {
    side,
    score,
    dynamicThreshold,
    setup: setupType,
    marketState,
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
            return
        }

        let candidates = []

        // ===== MAIN =====
        signals.forEach(s=>{
            if(s.score >= s.dynamicThreshold){
                candidates.push({...s, type:"MAIN"})
            }
        })

        // ===== EARLY =====
        signals.forEach(s=>{
            if(s.earlyScore >= EARLY_THRESHOLD && s.earlySide){
    candidates.push({
        ...s,
        side: s.earlySide,
        score: s.earlyScore,
        type:"EARLY"
    })
}
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
    return b.score - a.score
})

let main = candidates.find(c => c.type === "MAIN")

let best = main || candidates[0]
// ===== AI FILTER =====
let s = aiMemory.setups[best.setup] || { win:0, loss:0 }
let wr = getWinRate(s.win, s.loss)
// đủ data mới chặn
let total = s.win + s.loss

if(total > 20 && wr < 0.4){
    console.log("❌ AI chặn kèo xấu:", best.symbol)
    return
}
        
        if(!best){
            console.log("❌ No best candidate")
            return
        }
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
        return
    }
}
    // nếu là breakout thì yêu cầu momentum rõ
    if(best.setup === "BREAKOUT" && best.type !== "EARLY"){
    if(!best.momentumUp && !best.momentumDown){
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

let signalKey = `${best.symbol}_${best.type}_${best.setup}_${best.side}`

if(lastSignalTime[signalKey]){
    let diff = Date.now() - lastSignalTime[signalKey]

    if(diff < 3600000){
        console.log(`⛔ Skip duplicate: ${signalKey}`)
        return
    }
}


        // ===== RISK =====
        let risk = ACCOUNT_BALANCE * RISK_PER_TRADE

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
// ===== AI RR ADJUST =====
let s2 = aiMemory.setups[best.setup] || { win:0, loss:0 }
let wr2 = getWinRate(s2.win, s2.loss)
let total2 = s2.win + s2.loss

// win cao → TP xa hơn
if(wr2 > 0.6){
    best.tp = best.side === "LONG"
        ? best.tp + best.atr * 0.5
        : best.tp - best.atr * 0.5
}

// win thấp → TP gần lại
if(wr2 < 0.4){
    best.tp = best.side === "LONG"
        ? best.price + (best.tp - best.price) * 0.7
        : best.price - (best.price - best.tp) * 0.7
}

// ===== TÍNH RR =====
let rr = best.side === "LONG"
    ? (best.tp - best.price) / (best.price - best.sl)
    : (best.price - best.tp) / (best.sl - best.price)

// if(rr < RR_THRESHOLD){
    // console.log("❌ RR thấp")
  //   return
// }
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
        // send tele
        let ok = await sendTelegram(msg)

if(ok !== false){
    lastSignalTime[signalKey] = Date.now()
}
        // ===== SAVE TRADE =====
activeTrades.push({
    symbol: best.symbol,
    side: best.side,
    entry: best.price,
    tp: best.tp,
    sl: best.sl,
    setup: best.setup,
    marketState: best.marketState,
    time: Date.now()
})

    }catch(e){
    console.log("❌ Scanner error:")
    console.log(e)
}
}
// HỌC AI
async function updateAI(result, setup, market){

    // ===== SETUP =====
    if(!aiMemory.setups[setup]){
        aiMemory.setups[setup] = { win: 0, loss: 0 }
    }

    if(result === "WIN") aiMemory.setups[setup].win++
    else aiMemory.setups[setup].loss++

    let s = aiMemory.setups[setup]
    let total = s.win + s.loss

    s.winrate = total ? s.win / total : 0.5
    s.confidence = Math.min(total / 20, 1)

    // ===== MARKET =====
    if(!aiMemory.markets[market]){
        aiMemory.markets[market] = { win: 0, loss: 0 }
    }

    if(result === "WIN") aiMemory.markets[market].win++
    else aiMemory.markets[market].loss++

    let m = aiMemory.markets[market]
    let mTotal = m.win + m.loss

    m.winrate = mTotal ? m.win / mTotal : 0.5

    console.log("🧠 AI:", aiMemory)

    await saveMemory()
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

    console.log(`⏳ Timeout: ${t.symbol}`)

    // await updateAI(win ? "WIN" : "LOSS", t.setup, t.marketState)

    await sendTelegram(
`⏳ TIMEOUT ${t.symbol}
${t.side}
⛔ Không chạm TP/SL trong 6h`
    )

    activeTrades.splice(i,1)
    continue
}

// ===== SAU ĐÓ MỚI CHECK TP/SL =====
if(done){

    await updateAI(win ? "WIN" : "LOSS", t.setup, t.marketState)

    let msg =
`📊 RESULT ${t.symbol}
${t.side}
${win ? "✅ WIN" : "❌ LOSS"}`
    
//await sendTelegram(msg)
    await sendTelegram2(msg)

    activeTrades.splice(i,1)
    continue
}

        }catch(e){
            console.log("❌ checkTrades:", e.message)
        }
    }
} 
/// AI DECAY
async function decayAI(){

    for(let s in aiMemory.setups){
        aiMemory.setups[s].win *= 0.98
        aiMemory.setups[s].loss *= 0.98
    }

    for(let m in aiMemory.markets){
        aiMemory.markets[m].win *= 0.98
        aiMemory.markets[m].loss *= 0.98
    }
    await saveMemory()
}
// ================= LOOP =================
setInterval(()=>scanner(),300000)
setInterval(()=>checkCommand(),10000)
setInterval(()=>checkTrades(),60000)
setInterval(()=>decayAI(),3600000)

async function start(){
    await loadMemory()
    scanner()
}

start()
