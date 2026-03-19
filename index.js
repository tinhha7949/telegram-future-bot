import fetch from "node-fetch"

const BOT_TOKEN = process.env.BOT_TOKEN
const CHAT_ID = process.env.CHAT_ID

let lastUpdateId = 0

// ================= TELEGRAM =================
async function sendTelegram(msg){
    try{
        let url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`

        await fetch(url,{
            method:"POST",
            headers:{"Content-Type":"application/json"},
            body: JSON.stringify({
                chat_id: CHAT_ID,
                text: msg
            })
        })
    }catch(e){
        console.log("❌ Lỗi gửi Telegram")
    }
}

// ================= COMMAND =================
async function checkCommand(){
    try{
        let url = `https://api.telegram.org/bot${BOT_TOKEN}/getUpdates?offset=${lastUpdateId+1}`
        let res = await fetch(url)
        let data = await res.json()

        if(!data.result) return

        for(let update of data.result){

            lastUpdateId = update.update_id

            if(!update.message || !update.message.text) continue

            let text = update.message.text

            if(text === "/status"){
                await sendTelegram("🤖 Bot vẫn đang chạy OK!")
            }
        }

    }catch(e){
        console.log("⚠️ checkCommand lỗi nhẹ")
    }
}

// ================= INDICATORS =================
function ema(arr,p){
    let k=2/(p+1)
    let e=arr[0]
    for(let i=1;i<arr.length;i++){
        e=arr[i]*k+e*(1-k)
    }
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

// ================= DATA =================
async function getData(symbol){

    const urls = [
        `https://data-api.binance.vision/api/v3/klines?symbol=${symbol}&interval=15m&limit=150`,
        `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=15m&limit=150`,
        `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=15m&limit=150`
    ]

    for(let url of urls){
        try{
            let res = await fetch(url,{
                headers:{
                    "User-Agent":"Mozilla/5.0"
                }
            })

            if(!res.ok) continue

            let data = await res.json()

            if(Array.isArray(data) && data.length > 0){
                return data
            }

        }catch(e){
            continue
        }
    }

    console.log("❌ Binance lỗi:", symbol)
    return null
}

// ================= MAIN =================
async function scanner(){

console.log("🚀 SCAN PRO...")

let symbols = [
  "BTCUSDT","ETHUSDT","SOLUSDT","BNBUSDT","ADAUSDT",
  "XRPUSDT","DOGEUSDT","DOTUSDT","MATICUSDT","LTCUSDT",
  "AVAXUSDT","LINKUSDT","TRXUSDT","ATOMUSDT","XLMUSDT",
  "ALGOUSDT","VETUSDT","FTMUSDT","NEARUSDT","EOSUSDT",
  "FILUSDT","CHZUSDT","KSMUSDT","SANDUSDT","GRTUSDT",
  "AAVEUSDT","MKRUSDT","COMPUSDT","SNXUSDT","CRVUSDT",
  "1INCHUSDT","ZRXUSDT","BATUSDT","ENJUSDT","LRCUSDT",
  "STXUSDT","MINAUSDT","COTIUSDT","IMXUSDT","RUNEUSDT",
  "KLAYUSDT","TFUELUSDT","ONTUSDT","QTUMUSDT","NEOUSDT",
  "HNTUSDT","RVNUSDT","ANKRUSDT","XEMUSDT","HBARUSDT"
]

let SCORE_THRESHOLD = 150
let signals = []

// ================= SCAN SONG SONG =================
let results = await Promise.allSettled(
  symbols.map(symbol => scan(symbol))
)

results.forEach((r, i) => {
  if (r.status === "fulfilled" && r.value) signals.push(r.value)
  else if (r.status === "rejected") console.error("Scan failed:", symbols[i], r.reason)
})

// ================= LỌC & SORT =================
signals = signals.filter(s => s.score >= SCORE_THRESHOLD)  // chỉ kèo đẹp
signals.sort((a,b) => b.score - a.score)                  // kèo mạnh nhất lên đầu

console.table(signals)

// ================= CONFIG =================
const LIMIT_15M = 300
const LIMIT_1H  = 200
const RISK_PER_TRADE = 0.01
const ACCOUNT_BALANCE = 1000
const MIN_VOL_15M = 100000  // volume tối thiểu 15m (tùy coin)

async function scan(symbol){
    // ===== LOAD DATA =====
    let data15 = await getData(symbol,"15m",LIMIT_15M)
    let data1h = await getData(symbol,"1h",LIMIT_1H)

    if(!data15 || !data1h) return null
    if(data15.length < 250 || data1h.length < 120) return null

    // ===== PARSE =====
    let closes = data15.map(x=>+x[4])
    let highs  = data15.map(x=>+x[2])
    let lows   = data15.map(x=>+x[3])
    let volumes= data15.map(x=>+x[5])
    let closes1h = data1h.map(x=>+x[4])

    let price = closes.at(-1)

    // ===== FILTER LIQUIDITY / VOLUME =====
    let volAvg = volumes.slice(-30).reduce((a,b)=>a+b)/30
    if(volAvg < MIN_VOL_15M) return null  // loại coin low liquidity

    // ================= INDICATORS =================
    let ema20  = ema(closes.slice(-60),20)
    let ema50  = ema(closes.slice(-120),50)
    let ema200 = ema(closes.slice(-250),200)

    let ema20_1h = ema(closes1h.slice(-60),20)
    let ema50_1h = ema(closes1h.slice(-120),50)

    let r = rsi(closes.slice(-50))
    let atrVal = atr(data15.slice(-100))

    // ================= PRE-CALC =================
    let highs50 = highs.slice(-50)
    let lows50  = lows.slice(-50)
    let vol5    = volumes.slice(-5)
    let last4   = closes.slice(-4)

    let high50 = Math.max(...highs50)
    let low50  = Math.min(...lows50)

    let volTrendUp = vol5.every((v,i,a)=> i===0 || v>=a[i-1])

    let momentumUp = last4[3]>last4[2] && last4[2]>last4[1] && last4[1]>last4[0]
    let momentumDown = last4[3]<last4[2] && last4[2]<last4[1] && last4[1]<last4[0]

    let prevHigh = Math.max(...highs.slice(-25,-5))
    let prevLow  = Math.min(...lows.slice(-25,-5))

    let bosUp   = price > prevHigh
    let bosDown = price < prevLow

    let prevHigh50 = Math.max(...highs.slice(-51,-1))
    let prevLow50  = Math.min(...lows.slice(-51,-1))

    let sweepHigh = highs.at(-2) > prevHigh50 && closes.at(-2) < prevHigh50
    let sweepLow  = lows.at(-2) < prevLow50 && closes.at(-2) > prevLow50

    let pullbackLong  = price < ema20*1.01 && price > ema20*0.995
    let pullbackShort = price > ema20*0.99 && price < ema20*1.005

    // ================= MARKET REGIME =================
    let range = (high50 - low50) / price
    if(range < 0.01) return null

    // ================= FILTER =================
    let distance = Math.abs(price-ema20)/price
    let trendStrength = Math.abs(ema20-ema50)/price
    let lastCandleUp = closes.at(-1) > closes.at(-2)
    let volNow = volumes.at(-1)
    let fakePump = volNow > volAvg*2.5 && closes.at(-1) < highs.at(-1)*0.98
    let fakeDump = volNow > volAvg*2.5 && closes.at(-1) > lows.at(-1)*1.02
    let candleMove = Math.abs(closes.at(-1)-closes.at(-2))/price

    // ================= LOGIC =================
    let side = null
    let score = 0

    // TREND
    if(ema20>ema50 && ema50>ema200 && ema20_1h>ema50_1h){
        side="LONG"; score+=50
    }
    if(ema20<ema50 && ema50<ema200 && ema20_1h<ema50_1h){
        side="SHORT"; score+=50
    }

    // BOS
    if(side==="LONG" && bosUp) score+=40
    if(side==="SHORT" && bosDown) score+=40

    // SWEEP
    if(side==="LONG" && sweepLow) score+=50
    if(side==="SHORT" && sweepHigh) score+=50

    // RSI
    if(side==="LONG" && r>50 && r<65) score+=10
    if(side==="SHORT" && r>35 && r<50) score+=10

    // VOLUME
    if(volTrendUp) score+=15
    if(volNow > volAvg*1.8) score+=10

    // MOMENTUM
    if(side==="LONG" && momentumUp) score+=20
    if(side==="SHORT" && momentumDown) score+=20

    // PULLBACK
    if(side==="LONG" && pullbackLong) score+=30
    if(side==="SHORT" && pullbackShort) score+=30

    // VOLATILITY
    if(atrVal/price > 0.004) score+=10

    // ================= FILTER FINAL =================
    if(distance > (atrVal/price)*2) side=null
    if(trendStrength < 0.002) side=null
    if(fakePump || fakeDump) side=null
    if(candleMove > 0.035) side=null
    if(side==="LONG" && !lastCandleUp) side=null
    if(side==="SHORT" && lastCandleUp) side=null

    // ================= FINAL =================
    if(!side || score < 165) return null

    let sl, tp
    if(side==="LONG"){
        sl = price - atrVal*1.3
        tp = price + atrVal*3
    }else{
        sl = price + atrVal*1.3
        tp = price - atrVal*3
    }

    // ===== POSITION SIZE =====
    let risk = ACCOUNT_BALANCE * RISK_PER_TRADE
    let lossPerUnit = Math.abs(price - sl)
    let size = risk / lossPerUnit

    // ===== TRAILING =====
    let beTrigger = atrVal * 1.2
    let trailTrigger = atrVal * 2

    let rank = score>=180 ? "S+" : score>=165 ? "S" : "A"

    return {
        symbol,
        side,
        price,
        tp,
        sl,
        size,
        score,
        rank,
        beTrigger,
        trailTrigger
    }
}

// ================= ATR =================
function atr(data, period=14){
    let trs=[]
    for(let i=1;i<data.length;i++){
        let h=+data[i][2], l=+data[i][3], pc=+data[i-1][4]
        trs.push(Math.max(h-l, Math.abs(h-pc), Math.abs(l-pc)))
    }
    return trs.slice(-period).reduce((a,b)=>a+b)/period
}

let results = await Promise.allSettled(coins.map(symbol => scan(symbol)))
let signals = results
    .filter(r => r.status === 'fulfilled' && r.value)
    .map(r => r.value)

// ================= SEND =================

if(signals.length===0){
console.log("❌ Không có kèo")
return
}

signals.sort((a,b)=>b.score-a.score)

let msg="🔥 PRO SIGNAL\n"

signals.slice(0,3).forEach(c=>{
msg+=`
${c.symbol} (${c.rank})
${c.side}
Entry: ${c.price.toFixed(4)}
TP: ${c.tp.toFixed(4)}
SL: ${c.sl.toFixed(4)}
Score: ${c.score}
`
})

console.log(msg)
await sendTelegram(msg)

}

// ================= LOOP =================

setInterval(scanner, 300000)
setInterval(checkCommand, 10000)

scanner()
