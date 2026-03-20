// ================= CONFIG =================
const BOT_TOKEN = process.env.BOT_TOKEN
const CHAT_ID = process.env.CHAT_ID

const LIMIT_15M = 300
const LIMIT_1H  = 200

const SCORE_THRESHOLD = 100       // tín hiệu mạnh
const EARLY_THRESHOLD = 50       // early entry
const SCORE_FALLBACK  = 10      // fallback trung bình

const RISK_PER_TRADE = 0.01
const ACCOUNT_BALANCE = 1000
const MIN_VOL_15M = 100000

const SPREAD = 0.0005   // giả lập spread 0.05%
const FEE = 0.0004      // giả lập phí 0.04%
const SLIPPAGE = 0.0003 // giả lập slippage 0.03%

let lastUpdateId = 0

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

            if(text === "/backtest"){
                await sendTelegram("⏳ Backtest BTCUSDT...")
                let r = await backtest(["BTCUSDT"])
                await sendTelegram(`📊 RESULT\n${JSON.stringify(r,null,2)}`)
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

// ===== BOLLINGER BANDS =====
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
// Lấy kline data (15m, 1h, ...) với fallback giống style cũ
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

// Lấy order book depth (Future) theo style cũ với fallback
async function getOrderBook(symbol, limit=50){
    const urls = [
        `https://api.binance.com/api/v3/depth?symbol=${symbol}&limit=${limit}`,
        `https://fapi.binance.com/fapi/v1/depth?symbol=${symbol}&limit=${limit}`
    ]
    for(let url of urls){
        try{
            let res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } })
            if(!res.ok) continue
            let data = await res.json()
            if(data?.bids && data?.asks) return data
        }catch(e){}
    }
    return null
}

// Lấy Open Interest (Future) theo style cũ
async function getOpenInterest(symbol){
    const urls = [
        `https://fapi.binance.com/fapi/v1/openInterest?symbol=${symbol}`,
        `https://fapi.binance.com/fapi/v2/openInterest?symbol=${symbol}` // fallback
    ]
    for(let url of urls){
        try{
            let res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } })
            if(!res.ok) continue
            let data = await res.json()
            if(data?.openInterest) return +data.openInterest
        }catch(e){}
    }
    return 0
}

// Tính volume profile cơ bản
function volumeProfile(data, bins=20){
    let closes = data.map(x=>+x[4])
    let minP = Math.min(...closes)
    let maxP = Math.max(...closes)
    let binSize = (maxP - minP)/bins
    let vp = new Array(bins).fill(0)
    for(let i=0;i<data.length;i++){
        let idx = Math.min(Math.floor((+data[i][4]-minP)/binSize), bins-1)
        vp[idx] += +data[i][5] // cộng volume
    }
    let maxVol = Math.max(...vp)
    let highVolBins = vp.map((v,i)=>v>=maxVol*0.7 ? i : -1).filter(i=>i>=0)
    return {vp, highVolBins, binSize, minP, maxP}
}

// ================= CORE LOGIC nâng cấp =================
async function coreLogicAdvanced(data15, data1h, symbol, isBacktest=false){

    let closes = data15.map(x=>+x[4])
    let highs  = data15.map(x=>+x[2])
    let lows   = data15.map(x=>+x[3])
    let volumes= data15.map(x=>+x[5])
    let closes1h = data1h.map(x=>+x[4])
    let price = closes.at(-1)
    let volAvg = volumes.slice(-30).reduce((a,b)=>a+b,0)/30
    if(!isBacktest && volAvg < MIN_VOL_15M) return null

    let ema20  = ema(closes.slice(-60),20)
    let ema50  = ema(closes.slice(-120),50)
    let ema200 = closes.length>=200 ? ema(closes.slice(-250),200) : ema50
    let ema20_1h = ema(closes1h.slice(-60),20)
    let ema50_1h = ema(closes1h.slice(-120),50)

    let r = rsi(closes.slice(-50))
    let atrVal = atr(data15.slice(-100))
    let last4 = closes.slice(-4)
    let momentumUp = last4[3]>last4[2] && last4[2]>last4[1]
    let momentumDown = last4[3]<last4[2] && last4[2]<last4[1]
    let volNow = volumes.at(-1)
    let volSpike = volNow > volAvg*1.3

    let trendLong = ema20>ema50 && ema50>ema200 && ema20_1h>ema50_1h
    let trendShort = ema20<ema50 && ema50<ema200 && ema20_1h<ema50_1h

    let prevHigh = Math.max(...highs.slice(-25,-5))
    let prevLow  = Math.min(...lows.slice(-25,-5))
    let bosUp   = price > prevHigh
    let bosDown = price < prevLow

    // ===== FILTER SIDEWAY / FAKE BREAKOUT nâng cao =====
    let bb = bollinger(closes,20,2)
    let bbWidth = (bb.upper-bb.lower)/bb.mid
    let adxVal = adx(data15,14)
    if(!isBacktest && bbWidth<0.015) return null
    if(!isBacktest && adxVal<20) return null

    // Volume profile
    let vp = volumeProfile(data15)
    let priceBin = Math.floor((price - vp.minP)/vp.binSize)
    if(!isBacktest && !vp.highVolBins.includes(priceBin)) return null

    // Order book depth
    let ob = await getOrderBook(symbol)
    if(ob){
        let bidVol = ob.bids.reduce((a,b)=>a+parseFloat(b[1]),0)
        let askVol = ob.asks.reduce((a,b)=>a+parseFloat(b[1]),0)
        let obRatio = bidVol/(askVol||1)
        if(!isBacktest && obRatio<0.8 && trendLong) return null
        if(!isBacktest && obRatio>1.2 && trendShort) return null
    }

    // Open Interest (future)
    let oi = await getOpenInterest(symbol)
    if(!isBacktest && oi<volAvg*10) return null

    // ===== MAIN logic giữ nguyên =====
    let side=null, score=0, type="MAIN"
    if(trendLong){ side="LONG"; score+=50 }
    if(trendShort){ side="SHORT"; score+=50 }
    if(side==="LONG" && bosUp) score+=40
    if(side==="SHORT" && bosDown) score+=40
    if(side==="LONG" && r>50 && r<65) score+=10
    if(side==="SHORT" && r>35 && r<50) score+=10
    if(volSpike) score+=10
    if(side==="LONG" && momentumUp) score+=20
    if(side==="SHORT" && momentumDown) score+=20

    // EARLY logic giữ nguyên
    let earlySide=null, earlyScore=0
    if(trendLong){
        earlySide="LONG"; earlyScore=50
        if(r>50) earlyScore+=10
        if(volNow > volAvg*1.1) earlyScore+=10
        if(momentumUp) earlyScore+=10
    }
    if(trendShort){
        earlySide="SHORT"; earlyScore=50
        if(r<50) earlyScore+=10
        if(volNow > volAvg*1.1) earlyScore+=10
        if(momentumDown) earlyScore+=10
    }

    // RANGE, candleMove, trendStrength filter
    let range = (Math.max(...highs.slice(-50)) - Math.min(...lows.slice(-50))) / price
    let candleMove = Math.abs(closes.at(-1)-closes.at(-2))/price
    let trendStrength = Math.abs(ema20-ema50)/price
    if(!isBacktest && range < 0.01) return null
    if(!isBacktest && candleMove > 0.035) return null
    if(!isBacktest && trendStrength < 0.002) return null

    return {
        side,
        price,
        score,
        earlyScore,
        earlySide,
        type,
        tp: side==="LONG" ? price + atrVal*2.5 : price - atrVal*2.5,
        sl: side==="LONG" ? price - atrVal*1.2 : price + atrVal*1.2,
        vol: volNow,
        atr: atrVal,
        vp,
        ob,
        oi
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

    let symbols=["BTCUSDT","ETHUSDT","BNBUSDT","ADAUSDT","XRPUSDT",
        "SOLUSDT","DOTUSDT","MATICUSDT","LTCUSDT","AVAXUSDT",
        "LINKUSDT","TRXUSDT","ATOMUSDT","XLMUSDT","ALGOUSDT",
        "VETUSDT","FTMUSDT","NEARUSDT","EOSUSDT","FILUSDT",
        "CHZUSDT","KSMUSDT","SANDUSDT","GRTUSDT","AAVEUSDT",
        "MKRUSDT","COMPUSDT","SNXUSDT","CRVUSDT","1INCHUSDT",
        "ZRXUSDT","BATUSDT","ENJUSDT","LRCUSDT","OPUSDT",
        "STXUSDT","MINAUSDT","COTIUSDT","IMXUSDT","RUNEUSDT",
        "KLAYUSDT","TFUELUSDT","ONTUSDT","QTUMUSDT","NEOUSDT"]

    let results = await Promise.allSettled(symbols.map(scan))
    let signals = results.filter(r=>r.status==="fulfilled" && r.value).map(r=>r.value)
    if(signals.length===0){ console.log("❌ No signal"); return }

    // ===== SMART SELECT: MAIN -> EARLY -> FALLBACK =====
    let main = signals.filter(s => s.score >= SCORE_THRESHOLD)
    let best = null

    if(main.length>0){
        main.sort((a,b)=> b.score - a.score || b.vol - a.vol)
        best = main[0]
        best.type="MAIN"
    }else{
        let early = signals.filter(s => s.earlyScore >= EARLY_THRESHOLD)
        if(early.length>0){
            early.sort((a,b)=> b.earlyScore - a.earlyScore || b.vol - a.vol)
            best = early[0]
            best.side = best.earlySide
            best.score = best.earlyScore
            best.type="EARLY"
        }else{
            let fallback = signals.filter(s=>s.score>=SCORE_FALLBACK)
            if(fallback.length>0){
                fallback.sort((a,b)=> b.score - a.score || b.vol - a.vol)
                best = fallback[0]
                best.type="FALLBACK"
            }
        }
    }

    if(!best) return

    // ===== SIZE RISK nâng cao + Trailing =====
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

// ================= BACKTEST nâng cao =================
async function backtest(symbols){

    let results = []

    for(let symbol of symbols){
        let data15 = await getData(symbol,"15m",1500)
        let data1h = await getData(symbol,"1h",500)
        if(!data15 || !data1h) { results.push({symbol,error:"no data"}); continue }

        let balance = ACCOUNT_BALANCE
        let win=0, loss=0, total=0

        for(let i=250;i<data15.length-50;i++){
            let slice15 = data15.slice(0,i)
            let idx1h = Math.floor(i/4)
            let slice1h = data1h.slice(Math.max(0, idx1h-150), idx1h)

            let r = await coreLogicAdvanced(slice15, slice1h, symbol, true)
            if(!r) continue

            let side = null
            if(r.score >= SCORE_THRESHOLD) side = r.side
            else if(r.earlyScore >= EARLY_THRESHOLD) side = r.earlySide
            else if(r.score >= SCORE_FALLBACK) side = r.side
            else continue

            let tp = r.tp*(1-SPREAD-FEE-SLIPPAGE)
            let sl = r.sl*(1+SPREAD+FEE+SLIPPAGE)
            if(side==="SHORT"){ [tp,sl] = [sl,tp] }

            if(!tp || !sl || isNaN(tp) || isNaN(sl)) continue

            let result=null
            for(let j=i+1;j<i+40;j++){
                let h=+data15[j][2], l=+data15[j][3]
                if(side==="LONG"){
                    if(l<=sl){ result="SL"; break }
                    if(h>=tp){ result="TP"; break }
                }else{
                    if(h>=sl){ result="SL"; break }
                    if(l<=tp){ result="TP"; break }
                }
            }

            if(!result) continue
            if(result==="TP") { win++; balance*=1+(tp-r.price)/r.price } 
            else { loss++; balance*=1-(r.price-sl)/r.price }

            total++
        }

        let winrate = total ? (win/total*100).toFixed(2) : 0
        results.push({symbol,total,win,loss,winrate,finalBalance:balance.toFixed(2)})
    }

    return results
}

// ================= LOOP =================
setInterval(()=>scanner(),300000)  // 5 phút
setInterval(()=>checkCommand(),10000) // check telegram command

// ================= RUN =================
scanner()
