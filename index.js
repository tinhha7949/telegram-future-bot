// ================= CONFIG =================
const BOT_TOKEN = process.env.BOT_TOKEN
const CHAT_ID = process.env.CHAT_ID

const LIMIT_15M = 300
const LIMIT_1H  = 200

const SCORE_THRESHOLD = 120
const EARLY_THRESHOLD = 70
const SCORE_FALLBACK  = 85

const RISK_PER_TRADE = 0.01
const ACCOUNT_BALANCE = 1000
const MIN_VOL_15M = 100000

const SPREAD = 0.0005
const FEE = 0.0004
const SLIPPAGE = 0.0003

let lastUpdateId = 0
let cachedSymbols = null
let lastSymbolsUpdate = 0
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

            let text = u.message.text

            if(text === "/status"){
                await sendTelegram("🤖 BOT SMART nâng cấp đang chạy OK")
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

// ===== BOLLINGER =====
function bollinger(arr,p=20,mult=2){
    let slice = arr.slice(-p)
    let mean = slice.reduce((a,b)=>a+b,0)/p
    let std = Math.sqrt(slice.reduce((a,b)=>a+Math.pow(b-mean,2),0)/p)
    return {upper: mean + mult*std, lower: mean - mult*std, mid: mean}
}

// ===== ADX =====
function adx(data,p=14){
    let trs=[], DMplus=[], DMminus=[]
    for(let i=1;i<data.length;i++){
        let h=+data[i][2], l=+data[i][3], ph=+data[i-1][2], pl=+data[i-1][3]
        let tr = Math.max(h-l, Math.abs(h-+data[i-1][4]), Math.abs(l-+data[i-1][4]))
        trs.push(tr)
        let up = h-ph
        let down = pl-l
        DMplus.push(up>down&&up>0?up:0)
        DMminus.push(down>up&&down>0?down:0)
    }
    let smTr = trs.slice(-p).reduce((a,b)=>a+b,0)
    let smPlus = DMplus.slice(-p).reduce((a,b)=>a+b,0)
    let smMinus= DMminus.slice(-p).reduce((a,b)=>a+b,0)
    let diPlus = 100*smPlus/smTr
    let diMinus=100*smMinus/smTr
    return Math.abs(diPlus-diMinus)/(diPlus+diMinus)*100
}

// ================= DATA =================
async function getData(symbol, interval, limit){
    const urls = [
        `https://data-api.binance.vision/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`,
        `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`,
        `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`
    ]

    for(let url of urls){
        try{
            let res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } })
            if(!res.ok) continue
            let data = await res.json()
            if(Array.isArray(data) && data.length>0) return data
        }catch(e){}
    }
    return null
}
// ================= AUTO COIN FILTER =================
async function getTopSymbols(){

    let urls = [
        "https://api.binance.com/api/v3/ticker/24hr",
        "https://data-api.binance.vision/api/v3/ticker/24hr"
    ]

    for(let url of urls){
    try{
       
        let res = await fetch(url)

        if(!res.ok){
            continue
        }

        let data = await res.json()

        if(Array.isArray(data) && data.length > 0){


            let filtered = data
                .filter(c => 
                    c.symbol.endsWith("USDT") &&
                    !c.symbol.includes("UP") &&
                    !c.symbol.includes("DOWN") &&
                    !c.symbol.includes("BUSD")
                )
                .sort((a,b)=> b.quoteVolume - a.quoteVolume)
                .slice(0, 25)

            return filtered.map(c => c.symbol)
        }else{
            console.log("⚠️ Empty or invalid data:", url)
        }

    }catch(e){
        console.log("❌ ERROR:", url, e.message)
    }
}

    console.log("❌ AUTO FILTER FAIL")
    return null
}
// ================= CORE =================
async function coreLogicAdvanced(data15, data1h, symbol, isBacktest=false){

    let closes = data15.map(x=>+x[4])
    let highs  = data15.map(x=>+x[2])
    let lows   = data15.map(x=>+x[3])
    let volumes= data15.map(x=>+x[5])
    let closes1h = data1h.map(x=>+x[4])
    let price = closes.at(-1)
    let volAvg = volumes.slice(-30).reduce((a,b)=>a+b,0)/30 || 1
    if(!isBacktest && volAvg < MIN_VOL_15M) return null

    let ema20  = ema(closes.slice(-60),20)
    let ema50  = ema(closes.slice(-120),50)
    let ema200 = closes.length>=200 ? ema(closes.slice(-250),200) : ema50
    let ema20_1h = ema(closes1h.slice(-60),20)
    let ema50_1h = ema(closes1h.slice(-120),50)

    let r = rsi(closes.slice(-50))
    let atrVal = atr(data15.slice(-100))
    let last4 = closes.slice(-4)
    let momentumUp = last4.length === 4 && last4[3]>last4[2] && last4[2]>last4[1]
    let momentumDown = last4.length === 4 && last4[3]<last4[2] && last4[2]<last4[1]
    let volNow = volumes.at(-1)
    let volSpike = volNow > volAvg*1.5

    let trendLong = ema20>ema50 && ema50>ema200 && ema20_1h>ema50_1h
    let trendShort = ema20<ema50 && ema50<ema200 && ema20_1h<ema50_1h

    let prevHigh = Math.max(...highs.slice(-25,-5))
    let prevLow  = Math.min(...lows.slice(-25,-5))
    let bosUp   = price > prevHigh
    let bosDown = price < prevLow
    // ===== NEW FILTER =====
let distanceFromEMA = Math.abs(price - ema20)/price
let candleBody = Math.abs(closes.at(-1) - closes.at(-2))
let candleRange = highs.at(-1) - lows.at(-1)
let volStrong = volNow > volAvg * 1.8
// ===== PULLBACK ENTRY =====
let pullbackShort = (
    price > ema20 &&
    r > 45 && r < 60
)

let pullbackLong = (
    price < ema20 &&
    r < 55 && r > 40
)
// ===== BOS CONFIRM =====
let bosConfirmUp = closes.at(-1) > prevHigh && closes.at(-2) > prevHigh
let bosConfirmDown = closes.at(-1) < prevLow && closes.at(-2) < prevLow

// ===== HTF TREND STRENGTH =====
let trendStrongHTF = Math.abs(ema20_1h - ema50_1h)/price > 0.002

    let bb = bollinger(closes,20,2)
    let bbWidth = (bb.upper-bb.lower)/bb.mid
    let adxVal = adx(data15,14)
    if(!isBacktest && bbWidth<0.02) return null
    if(!isBacktest && adxVal<25) return null
    // ❌ tránh đuổi giá
    if(!isBacktest && side==="SHORT" && price < ema20) return null
    if(!isBacktest && side==="LONG" && price > ema20) return null
    if(!isBacktest && volNow < volAvg * 1.1) return null
    if(!isBacktest && distanceFromEMA > 0.025) return null
    if(!isBacktest && candleRange > 0 && candleBody / candleRange < 0.4) return null
    if(!isBacktest && !trendStrongHTF) return null

    let side=null, score=0, type="MAIN"
    if(trendLong){ side="LONG"; score+=50 }
    if(trendShort){ side="SHORT"; score+=50 }
    if(side==="LONG" && bosConfirmUp && pullbackLong) score+=40
    if(side==="SHORT" && bosConfirmDown && pullbackShort) score+=40
    if(side==="LONG" && r>55 && r<65) score+=12
    if(side==="SHORT" && r>35 && r<45) score+=12
    if(volSpike) score+=12
    if(volStrong) score+=18
    if(side==="LONG" && momentumUp) score+=20
    if(side==="SHORT" && momentumDown) score+=20
    if(side==="LONG" && closes.at(-1) > closes.at(-2)) score+=5
    if(side==="SHORT" && closes.at(-1) < closes.at(-2)) score+=5



    let earlySide=null, earlyScore=0
    if(trendLong){
        earlySide="LONG"; earlyScore=50
        if(r>50) earlyScore+=10
        if(volNow > volAvg*1.1) earlyScore+=10
        if(momentumUp) earlyScore+=12
    }
    if(trendShort){
        earlySide="SHORT"; earlyScore=50
        if(r<50) earlyScore+=10
        if(volNow > volAvg*1.1) earlyScore+=10
        if(momentumDown) earlyScore+=12
    }

    let range = (Math.max(...highs.slice(-50)) - Math.min(...lows.slice(-50))) / price
    let candleMove = Math.abs(closes.at(-1)-closes.at(-2))/price
    let trendStrength = Math.abs(ema20-ema50)/price
    if(!isBacktest && range < 0.012) return null
    if(!isBacktest && candleMove > 0.4) return null
    if(!isBacktest && trendStrength < 0.0025) return null

    return {
    side,
    price,
    score,
    earlyScore,
    earlySide,
    type,
    tp: (() => {
    let slPrice = side==="LONG"
        ? Math.min(...lows.slice(-10))
        : Math.max(...highs.slice(-10))

    let rr = 2

    return side==="LONG"
        ? price + (price - slPrice)*rr
        : price - (slPrice - price)*rr
})(),
    sl: side==="LONG"
    ? Math.min(...lows.slice(-10))
    : Math.max(...highs.slice(-10)),
    vol: volNow,
    atr: atrVal,

    // ===== ADD =====
    adx: adxVal,
    bbWidth: bbWidth
}
}

// ================= SCAN =================
async function scan(symbol){
    let data15 = await getData(symbol,"15m",LIMIT_15M)
    let data1h = await getData(symbol,"1h",LIMIT_1H)
    if(!data15 || !data1h) return null
    let r = await coreLogicAdvanced(data15, data1h, symbol)
    if(!r) return null
    return { symbol, ...r }
}

// ================= SCANNER =================
async function scanner(){

    console.log("🚀 SMART SCAN nâng cấp...")

   let now = Date.now()

if(!cachedSymbols || now - lastSymbolsUpdate > 900000){
    console.log("🔄 Updating symbols...")
    let newSymbols = await getTopSymbols()

    if(newSymbols && newSymbols.length > 0){
        cachedSymbols = newSymbols
        lastSymbolsUpdate = now
    }
}

let symbols = cachedSymbols || []
if(symbols && symbols.length > 0){
    console.log(`✅ Using ${symbols.length} symbols`)
}
    
if(!symbols || symbols.length === 0){
    console.log("⚠️ fallback to default list")

    symbols = [
        "BTCUSDT","ETHUSDT","BNBUSDT","SOLUSDT","XRPUSDT","ADAUSDT",
        "AVAXUSDT","LINKUSDT","DOTUSDT","MATICUSDT",
        "ATOMUSDT","NEARUSDT","FILUSDT","LTCUSDT",
        "AAVEUSDT","MKRUSDT","OPUSDT","IMXUSDT","RUNEUSDT"
    ]
}
    let results = await Promise.allSettled(symbols.map(scan))
    let signals = results.filter(r=>r.status==="fulfilled" && r.value).map(r=>r.value)
    if(signals.length===0){ console.log("❌ No signal"); return }

    let candidates = []

// ===== MAIN =====
signals.forEach(s => {
    if(s.score >= SCORE_THRESHOLD){
        candidates.push({
            ...s,
            type: "MAIN"
        })
    }
})

// ===== EARLY =====
signals.forEach(s => {
    if(s.earlyScore >= EARLY_THRESHOLD && s.score < SCORE_THRESHOLD){
        candidates.push({
            ...s,
            side: s.earlySide,
            score: s.earlyScore,
            type: "EARLY"
        })
    }
})

// ===== FALLBACK =====
signals.forEach(s => {
    if(
        s.score >= SCORE_FALLBACK &&
        s.score < SCORE_THRESHOLD &&
        (
            s.adx >= 35 ||
            s.bbWidth > 0.03
        )
    ){
        candidates.push({
            ...s,
            type: "FALLBACK"
        })
    }
})
if(candidates.length === 0) return

// ===== SORT =====
candidates.sort((a,b)=> b.score - a.score || b.vol - a.vol)

let best = candidates[0]

// ===== FIX EARLY ĐÈ FALLBACK =====
if(best.type === "EARLY" && best.score < 85){
    let betterFallback = candidates.find(c => 
        c.type === "FALLBACK" && c.score > best.score + 5
    )
    if(betterFallback) best = betterFallback
}

if(!best) return

    let risk = ACCOUNT_BALANCE * RISK_PER_TRADE
    if(best.type==="EARLY") risk *= 0.5
    if(best.type==="FALLBACK") risk *= 0.3
    let size = risk / Math.abs(best.price - best.sl)

    let trailingSL = best.side==="LONG" ? best.price - best.atr : best.price + best.atr

    let msg = `🔥 BEST SIGNAL

${best.symbol} (${best.type})
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
}

// ================= LOOP =================
setInterval(()=>scanner(),300000)
setInterval(()=>checkCommand(),10000)

// ================= RUN =================
scanner()
