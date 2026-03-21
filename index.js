// ================= CONFIG =================
const BOT_TOKEN = process.env.BOT_TOKEN
const CHAT_ID = process.env.CHAT_ID

const LIMIT_15M = 300
const LIMIT_1H  = 200

const SCORE_THRESHOLD = 120
const EARLY_THRESHOLD = 80
const SCORE_FALLBACK  = 70

const RISK_PER_TRADE = 0.01
const ACCOUNT_BALANCE = 1000
const MIN_VOL_15M = 100000

const SPREAD = 0.0005
const FEE = 0.0004
const SLIPPAGE = 0.0003

let lastUpdateId = 0
let currentPosition = null

// ================= TELEGRAM =================
async function sendTelegram(msg){
    try{
        let url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`
        await fetch(url,{
            method:"POST",
            headers:{"Content-Type":"application/json"},
            body: JSON.stringify({ chat_id: CHAT_ID, text: msg })
        })
    }catch(e){ console.log("❌ TELE:", e.message) }
}

// ================= DATA (FIX RESTORED) =================
async function getData(symbol, interval, limit){
    const urls = [
        `https://data-api.binance.vision/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`,
        `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`,
        `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`
    ]

    for(let url of urls){
        try{
            let res = await fetch(url)
            if(!res.ok) continue
            let data = await res.json()
            if(Array.isArray(data) && data.length>0) return data
        }catch(e){}
    }
    return null
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
    }catch(e){ console.log("⚠️ CMD:", e.message) }
}

// ================= INDICATORS =================
function ema(arr,p){ let k=2/(p+1), e=arr[0]; for(let i=1;i<arr.length;i++) e=arr[i]*k+e*(1-k); return e }

function rsi(arr,p=14){
    let g=0,l=0
    for(let i=arr.length-p;i<arr.length;i++){
        let d=arr[i]-arr[i-1]
        if(d>=0) g+=d; else l-=d
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

function bollinger(arr,p=20,mult=2){
    let slice = arr.slice(-p)
    let mean = slice.reduce((a,b)=>a+b,0)/p
    let std = Math.sqrt(slice.reduce((a,b)=>a+Math.pow(b-mean,2),0)/p)
    return {upper: mean + mult*std, lower: mean - mult*std, mid: mean}
}

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

// ================= CORE =================
async function coreLogicAdvanced(data15, data1h, symbol){

    let closes = data15.map(x=>+x[4])
    let volumes= data15.map(x=>+x[5])
    let closes1h = data1h.map(x=>+x[4])

    let price = closes.at(-1)
    let volAvg = volumes.slice(-30).reduce((a,b)=>a+b,0)/30
    if(volAvg < MIN_VOL_15M) return null

    let ema20  = ema(closes.slice(-60),20)
    let ema50  = ema(closes.slice(-120),50)
    let ema20_1h = ema(closes1h.slice(-60),20)
    let ema50_1h = ema(closes1h.slice(-120),50)

    let r = rsi(closes.slice(-50))
    let atrVal = atr(data15.slice(-100))

    let trendLong = ema20>ema50 && ema20_1h>ema50_1h
    let trendShort = ema20<ema50 && ema20_1h<ema50_1h

    let bb = bollinger(closes)
    let bbWidth = (bb.upper-bb.lower)/bb.mid
    let adxVal = adx(data15)

    if(bbWidth<0.015 || adxVal<20) return null

    let side=null, score=0

    if(trendLong){ side="LONG"; score+=50 }
    if(trendShort){ side="SHORT"; score+=50 }

    if(side==="LONG" && r>50) score+=20
    if(side==="SHORT" && r<50) score+=20

    if(score < SCORE_FALLBACK) return null

    return {
        side,
        price,
        score,
        tp: side==="LONG" ? price + atrVal*2 : price - atrVal*2,
        sl: side==="LONG" ? price - atrVal : price + atrVal,
        atr: atrVal
    }
}

// ================= SCAN =================
async function scan(symbol){
    let data15 = await getData(symbol,"15m",LIMIT_15M)
    let data1h = await getData(symbol,"1h",LIMIT_1H)
    if(!data15 || !data1h) return null

    let r = await coreLogicAdvanced(data15, data1h, symbol)
    if(!r) return null

    if(currentPosition && currentPosition.symbol === symbol) return null

    return { symbol, ...r }
}

// ================= SCANNER =================
async function scanner(){

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

    if(signals.length===0) return

    signals.sort((a,b)=> b.score - a.score)
    let best = signals[0]

    let risk = ACCOUNT_BALANCE * RISK_PER_TRADE
    let size = risk / Math.abs(best.price - best.sl)

    currentPosition = best

    let msg = `🔥 SIGNAL\n\n${best.symbol}\n${best.side}\nEntry: ${best.price.toFixed(4)}\nTP: ${best.tp.toFixed(4)}\nSL: ${best.sl.toFixed(4)}\nSize: ${size.toFixed(2)}\nScore: ${best.score}`

    await sendTelegram(msg)
}

// ================= LOOP =================
setInterval(()=>scanner(),300000)
setInterval(()=>checkCommand(),10000)

scanner()
