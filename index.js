// ================= CONFIG =================
const BOT_TOKEN = process.env.BOT_TOKEN
const CHAT_ID = process.env.CHAT_ID

const LIMIT_15M = 300
const LIMIT_1H  = 200

const SCORE_THRESHOLD = 110 // 140
const EARLY_THRESHOLD = 60 // 80

const RISK_PER_TRADE = 0.01
const ACCOUNT_BALANCE = 1000
const MIN_VOL_15M = 100000

let lastUpdateId = 0
let cachedSymbols = null
let lastSymbolsUpdate = 0
let lastSignalTime = {}

// ================= TELEGRAM =================
async function sendTelegram(msg){
    try{
        let url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`
        await fetch(url,{
            method:"POST",
            headers:{"Content-Type":"application/json"},
            body: JSON.stringify({ chat_id: CHAT_ID, text: msg })
        })
    }catch(e){
        console.log("❌ TELE:", e.message)
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
                        .sort((a,b)=> Number(b.quoteVolume) - Number(a.quoteVolume))
                        .slice(0,25)
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
    if(volAvg < MIN_VOL_15M) return null

    // ===== EMA =====
    let ema20 = ema(closes.slice(-60),20)
    let ema50 = ema(closes.slice(-120),50)
    let ema200= ema(closes.slice(-250),200)

    let ema20_1h = ema(closes1h.slice(-60),20)
    let ema50_1h = ema(closes1h.slice(-120),50)

    let r = rsi(closes.slice(-50))
    let atrVal = atr(data15.slice(-100))
    // ===== ANTI CHASE + PULLBACK =====
let distEma = Math.abs(price - ema20) / price

// không đu giá
if(distEma > 0.007) return null // 0.006

// không vào khi vừa pump/dump mạnh
let lastMove = (closes.at(-1) - closes.at(-3)) / closes.at(-3)
if(lastMove > 0.025 || lastMove < -0.025) return null // 0.02

// chỉ vào khi giá gần EMA (pullback)
let nearEma = distEma < 0.0035 // 0.0025

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
    let volNow = volumes.at(-1)
    let volTrendUp = volumes.slice(-5).every((v,i,a)=> i===0 || v>=a[i-1])

    // ===== FILTER =====
    let trendLong = ema20>ema50 && ema50>ema200 && ema20_1h>ema50_1h
    let trendShort = ema20<ema50 && ema50<ema200 && ema20_1h<ema50_1h

    let trendStrength = Math.abs(ema20-ema50)/price
    if(trendStrength < 0.0018) return null // 0.002

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
    score += 30
    setupType = "BREAKOUT"
}
if(side==="SHORT" && bosDown){
    score += 30
    setupType = "BREAKOUT"
}

// ===== PULLBACK =====
if(side==="LONG" && nearEma){
    score += 20
    if(!setupType) setupType = "PULLBACK"
}
if(side==="SHORT" && nearEma){
    score += 20
    if(!setupType) setupType = "PULLBACK"
}
    if(bosUp || bosDown){
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
    // ===== REQUIRE PULLBACK =====
if(side === "LONG" && !nearEma){
    score -= 25
}
if(side === "SHORT" && !nearEma){
    score -= 25
}
    
    // ===== EARLY =====
    let earlySide=null, earlyScore=0

    if(trendLong && nearEma){
    earlySide="LONG"
    earlyScore=50
    if(r>50 && r<60) earlyScore+=10
    if(momentumUp) earlyScore+=10   // thêm
    if(volNow > volAvg) earlyScore+=5 // thêm    
}

if(trendShort && nearEma){
    earlySide="SHORT"
    earlyScore=50
    if(r<50 && r>40) earlyScore+=10
    if(momentumDown) earlyScore+=10 // thêm
    if(volNow > volAvg) earlyScore+=5 // thêm
}
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

if(side === "LONG" && distToRes < 0.003) return null
if(side === "SHORT" && distToSup < 0.003) return null

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
function pickBestTP(candidates, price, risk, side){

    let valid = []

    for(let c of candidates){

        let rr = side==="LONG"
            ? (c.price - price) / risk
            : (price - c.price) / risk

        let dist = side==="LONG"
            ? (c.price - price)
            : (price - c.price)

        if(rr >= 1.2 && dist >= atrVal * 0.7 && dist <= atrVal * 4.5){ // if(rr >= 1.3 && dist >= atrVal * 0.8 && dist <= atrVal * 5) hoặc 4
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

// ===== LONG =====
if(side === "LONG"){

   if(setupType === "BREAKOUT"){
    sl = swingLow - atrVal * 0.6
}else{
    sl = swingLow - atrVal * 0.8
}

if(sl >= price) sl = price - atrVal * 1.5

    let risk = price - sl

    let candidates = []

    if(resistance > price) candidates.push({price: resistance, type:"res"})
    if(liqHigh && liqHigh > price) candidates.push({price: liqHigh, type:"liq"})

    if(candidates.length === 0){
        candidates.push({price: price + atrVal * 2, type:"atr"})
    }

    tp = pickBestTP(candidates, price, risk, "LONG")

    if(!tp){
        if(resistance > price) tp = resistance
        else if(liqHigh && liqHigh > price) tp = liqHigh
        else tp = price + atrVal * 2
    }

    let dist = tp - price

   if(dist > atrVal * 5){
    if(setupType === "BREAKOUT"){
        tp = price + atrVal * 4.5
    }else{
        tp = price + atrVal * 3
    }
}

    if(dist < atrVal * 0.8) return null

    let last3 = closes.slice(-3)
    let weak = last3[2] < last3[1] && last3[1] < last3[0]

    if(weak && dist > atrVal * 2.5){
        tp = price + atrVal * 1.8
    }
}

// ===== SHORT =====
if(side === "SHORT"){

    if(setupType === "BREAKOUT"){
    sl = swingHigh + atrVal * 0.6
}else{
    sl = swingHigh + atrVal * 0.8
}

if(sl <= price) sl = price + atrVal * 1.5

    let risk = sl - price

    let candidates = []

    if(support < price) candidates.push({price: support, type:"sup"})
    if(liqLow && liqLow < price) candidates.push({price: liqLow, type:"liq"})

    if(candidates.length === 0){
        candidates.push({price: price - atrVal * 2, type:"atr"})
    }

    tp = pickBestTP(candidates, price, risk, "SHORT")

    if(!tp){
        if(support < price) tp = support
        else if(liqLow && liqLow < price) tp = liqLow
        else tp = price - atrVal * 2
    }

    let dist = price - tp

   if(dist > atrVal * 5){
    if(setupType === "BREAKOUT"){
        tp = price - atrVal * 4.5
    }else{
        tp = price - atrVal * 3
    }
}

    if(dist < atrVal * 0.8) return null

    let last3 = closes.slice(-3)
    let weak = last3[2] > last3[1] && last3[1] > last3[0]

    if(weak && dist > atrVal * 2.5){
        tp = price - atrVal * 1.8
    }
}

// ===== VALIDATE SL + RECALC TP =====
let minDistance = price * 0.002
let maxDistance = price * 0.03

if(Math.abs(price - sl) < minDistance || Math.abs(price - sl) > maxDistance){

    sl = side==="LONG"
        ? price - atrVal * 1.5
        : price + atrVal * 1.5

    let risk = Math.abs(price - sl)

    let candidates = []

    if(side==="LONG"){
        if(resistance > price) candidates.push({price: resistance, type:"res"})
        if(liqHigh && liqHigh > price) candidates.push({price: liqHigh, type:"liq"})
    }else{
        if(support < price) candidates.push({price: support, type:"sup"})
        if(liqLow && liqLow < price) candidates.push({price: liqLow, type:"liq"})
    }

    tp = pickBestTP(candidates, price, risk, side)

    if(!tp){
        tp = side==="LONG"
            ? price + atrVal * 2
            : price - atrVal * 2
    }

    let rr = side==="LONG"
        ? (tp - price) / risk
        : (price - tp) / risk

    if(rr < 1.4) return null // 1.5

    let newDist = Math.abs(tp - price)

    if(newDist > atrVal * 4){
        tp = side==="LONG"
            ? price + atrVal * 2.5
            : price - atrVal * 2.5
    }

    if(newDist < atrVal * 0.8){
        return null
    }
}

// ===== ROUND =====
function round(n){ return Number(n.toFixed(4)) }

return {
    side,
    score,
    setup: setupType,
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
            if(s.score >= SCORE_THRESHOLD){
                candidates.push({...s, type:"MAIN"})
            }
        })

        // ===== EARLY =====
        signals.forEach(s=>{
            if(s.earlyScore >= EARLY_THRESHOLD){
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
       let main = candidates.find(c => c.type === "MAIN")
let early = candidates.find(c => c.type === "EARLY")

let best = null

if(main){
    best = main
}else if(early){
    best = early
}
        
        if(!best){
            console.log("❌ No best candidate")
            return
        }

        if(!best.type){
            console.log("❌ Invalid best type")
            return
        }
        // ===== BLOCK DUPLICATE SIGNAL =====
let nowTime = Date.now()

if(lastSignalTime[best.symbol]){
    let diff = nowTime - lastSignalTime[best.symbol]

    if(diff < 2700000){ // 1 tiếng // 3600000
        console.log(`⛔ Skip duplicate: ${best.symbol}`)
        return
    }
}

lastSignalTime[best.symbol] = nowTime

        // ===== RISK =====
        let risk = ACCOUNT_BALANCE * RISK_PER_TRADE

        if(best.type === "EARLY") risk *= 0.5

        let diff = Math.abs(best.price - best.sl)
        if(!best.sl || !best.tp){
    console.log("❌ Missing SL TP")
    return
}

        if(!diff || diff === 0){
            console.log("❌ Invalid SL distance")
            return
        }

        let size = risk / diff

        let trailingSL = best.side === "LONG"
            ? best.price - best.atr
            : best.price + best.atr

        // ===== MESSAGE =====
       let msg = `🔥 BEST SIGNAL

${best.symbol} (${best.type} - ${best.setup})
${best.side}
Entry: ${best.price.toFixed(4)}
TP: ${best.tp.toFixed(4)}
SL: ${best.sl.toFixed(4)}
Trailing SL: ${trailingSL.toFixed(4)}
Size: ${size.toFixed(2)}
Score: ${best.score}
`

        console.log(msg)
        await sendTelegram(msg)

    }catch(e){
    console.log("❌ Scanner error:")
    console.log(e)
}
}
// ================= LOOP =================
setInterval(()=>scanner(),300000)
setInterval(()=>checkCommand(),10000)

scanner()
