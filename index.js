// ================= CONFIG =================
const BOT_TOKEN = process.env.BOT_TOKEN
const CHAT_ID = process.env.CHAT_ID

const LIMIT_15M = 300
const LIMIT_1H  = 200

const SCORE_THRESHOLD = 130
const EARLY_THRESHOLD = 90

const RISK_PER_TRADE = 0.01
const ACCOUNT_BALANCE = 1000
const MIN_VOL_15M = 100000

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

    // ===== VOLUME =====
    let volNow = volumes.at(-1)
    let volTrendUp = volumes.slice(-5).every((v,i,a)=> i===0 || v>=a[i-1])

    // ===== FILTER =====
    let trendLong = ema20>ema50 && ema50>ema200 && ema20_1h>ema50_1h
    let trendShort = ema20<ema50 && ema50<ema200 && ema20_1h<ema50_1h

    let trendStrength = Math.abs(ema20-ema50)/price
    if(trendStrength < 0.002) return null

    let candleMove = Math.abs(closes.at(-1)-closes.at(-2))/price
    if(candleMove > 0.03) return null

    let fakePump = volNow > volAvg*2.5 && closes.at(-1) < highs.at(-1)*0.98
    let fakeDump = volNow > volAvg*2.5 && closes.at(-1) > lows.at(-1)*1.02
    if(fakePump || fakeDump) return null

    // ===== SCORE =====
    let side=null, score=0

    if(trendLong){ side="LONG"; score+=50 }
    if(trendShort){ side="SHORT"; score+=50 }

    if(side==="LONG" && bosUp) score+=40
    if(side==="SHORT" && bosDown) score+=40

    if(side==="LONG" && sweepLow) score+=50
    if(side==="SHORT" && sweepHigh) score+=50

    if(volTrendUp) score+=15
    if(volNow > volAvg*1.5) score+=10

    if(side==="LONG" && momentumUp) score+=20
    if(side==="SHORT" && momentumDown) score+=20

    if(side==="LONG" && r>50 && r<65) score+=10
    if(side==="SHORT" && r>35 && r<50) score+=10

    if(atrVal/price > 0.004) score+=10
    if(!side) return null

    // ===== EARLY =====
    let earlySide=null, earlyScore=0

    if(trendLong){
        earlySide="LONG"
        earlyScore=50
        if(r>50) earlyScore+=10
        if(momentumUp) earlyScore+=10
        if(volNow > volAvg*1.2) earlyScore+=10
    }

    if(trendShort){
        earlySide="SHORT"
        earlyScore=50
        if(r<50) earlyScore+=10
        if(momentumDown) earlyScore+=10
        if(volNow > volAvg*1.2) earlyScore+=10
    }

    // ===== STRUCTURE SL/TP =====
    let swingLow = Math.min(...lows.slice(-10))
    let swingHigh = Math.max(...highs.slice(-10))

    let sl = null
    let tp = null
    let rr = 2.2

    if(side === "LONG"){
        sl = swingLow - atrVal * 0.5
        if(sl >= price) sl = price - atrVal * 1.5
        tp = price + (price - sl) * rr
    }else if(side === "SHORT"){
        sl = swingHigh + atrVal * 0.5
        if(sl <= price) sl = price + atrVal * 1.5
        tp = price - (sl - price) * rr
    }

    // ===== VALIDATE MIN/MAX DISTANCE =====
    let minDistance = price * 0.002
    let maxDistance = price * 0.03

    if(Math.abs(price - sl) < minDistance){
        sl = side==="LONG" ? price - atrVal * 1.5 : price + atrVal * 1.5
        tp = side==="LONG" ? price + (price - sl) * rr : price - (sl - price) * rr
    }

    if(Math.abs(price - sl) > maxDistance){
        sl = side==="LONG" ? price - atrVal * 1.5 : price + atrVal * 1.5
        tp = side==="LONG" ? price + (price - sl) * rr : price - (sl - price) * rr
    }

    // ===== ROUND =====
    function round(n){ return Number(n.toFixed(4)) }

    return {
        side,
        score,
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
            if(s.earlyScore >= EARLY_THRESHOLD && s.score < SCORE_THRESHOLD){
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
        candidates.sort((a,b)=> b.score - a.score)

        let best = candidates[0]

        if(!best){
            console.log("❌ No best candidate")
            return
        }

        if(!best.type){
            console.log("❌ Invalid best type")
            return
        }

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

    }catch(e){
    console.log("❌ Scanner error:")
    console.log(e)
}
}
// ================= LOOP =================
setInterval(()=>scanner(),300000)
setInterval(()=>checkCommand(),10000)

scanner()
