import fetch from "node-fetch"

const BOT_TOKEN = process.env.BOT_TOKEN
const CHAT_ID = process.env.CHAT_ID

let lastUpdateId = 0

// ================= TIMEOUT FETCH =================
async function fetchWithTimeout(url, options={}, ms=5000){
    const controller = new AbortController()
    const timeout = setTimeout(()=>controller.abort(), ms)

    try{
        const res = await fetch(url,{
            ...options,
            signal: controller.signal
        })
        clearTimeout(timeout)
        return res
    }catch{
        return null
    }
}

// ================= TELEGRAM =================
await fetchWithTimeout(
    `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
    {
        method:"POST",
        headers:{"Content-Type":"application/json"},
        body: JSON.stringify({
            chat_id: CHAT_ID,
            text: msg
        })
    },
    5000
)

// ================= COMMAND =================
async function checkCommand(){
    try{
        let res = await fetchWithTimeout(`https://api.telegram.org/bot${BOT_TOKEN}/getUpdates?offset=${lastUpdateId+1}`,5000)
        if(!res) return

        let data = await res.json()
        if(!data.result) return

        for(let update of data.result){

            lastUpdateId = update.update_id

            if(update.message?.text === "/status"){
                await sendTelegram("🤖 Bot vẫn đang chạy OK!")
            }
        }
    }catch{}
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
async function getData(symbol, interval="15m"){

    const urls = [
        `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=200`,
        `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=200`,
        `https://data-api.binance.vision/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=200`
    ]

    for(let url of urls){
        let res = await fetchWithTimeout(url,5000)
        if(!res || !res.ok) continue

        try{
            let data = await res.json()
            if(Array.isArray(data) && data.length>0) return data
        }catch{}
    }

    return null
}

// ================= MAIN =================
async function scanner(){

console.log("🚀 SCAN PRO...")

let coins=[
"BTCUSDT","ETHUSDT","SOLUSDT","BNBUSDT","XRPUSDT",
"ADAUSDT","AVAXUSDT","DOGEUSDT","LINKUSDT","DOTUSDT",
"MATICUSDT","LTCUSDT","TRXUSDT","ATOMUSDT","NEARUSDT",
"INJUSDT","APTUSDT","OPUSDT","ARBUSDT","SUIUSDT",
"SEIUSDT","TIAUSDT","FILUSDT","AAVEUSDT","RNDRUSDT",
"GALAUSDT","DYDXUSDT","ETCUSDT","ICPUSDT","THETAUSDT",
"STXUSDT","IMXUSDT","FLOWUSDT","EGLDUSDT",
"XTZUSDT","KAVAUSDT","CRVUSDT","SANDUSDT","MANAUSDT",
"APEUSDT","LDOUSDT","RUNEUSDT","COMPUSDT","SNXUSDT",
"CHZUSDT","ZILUSDT","1INCHUSDT","BATUSDT","ENSUSDT"
]

// ⚡ chạy song song
let results = await Promise.all(coins.map(async symbol=>{

try{

let data15=await getData(symbol,"15m")
let data1h=await getData(symbol,"1h")
if(!data15 || !data1h) return null

let closes=data15.map(x=>+x[4])
let highs=data15.map(x=>+x[2])
let lows=data15.map(x=>+x[3])
let volumes=data15.map(x=>+x[5])
let closes1h=data1h.map(x=>+x[4])

let price=closes.at(-1)

let ema20=ema(closes.slice(-40),20)
let ema50=ema(closes.slice(-80),50)
let ema200=ema(closes.slice(-120),200)

let ema20_1h=ema(closes1h.slice(-40),20)
let ema50_1h=ema(closes1h.slice(-80),50)

let r=rsi(closes)

let volNow=volumes.at(-1)
let volAvg=volumes.slice(-30).reduce((a,b)=>a+b)/30

let high50=Math.max(...highs.slice(-50))
let low50=Math.min(...lows.slice(-50))

let last4=closes.slice(-4)
let lastVol=volumes.slice(-4)

let atrVal=(high50-low50)/50

let distance=Math.abs(price-ema20)/price
let trendStrength=Math.abs(ema20-ema50)/price
let lastCandleUp=closes.at(-1)>closes.at(-2)

let side=null
let score=0

// TREND
if(ema20>ema50 && ema50>ema200 && ema20_1h>ema50_1h){
    side="LONG"; score+=60
}
if(ema20<ema50 && ema50<ema200 && ema20_1h<ema50_1h){
    side="SHORT"; score+=60
}

// RSI
if(side==="LONG" && r>50 && r<65) score+=20
if(side==="SHORT" && r>35 && r<50) score+=20

// VOLUME
if(lastVol[3]>lastVol[2] && lastVol[2]>lastVol[1]) score+=30
if(volNow>volAvg*2) score+=40

// MOMENTUM
if(side==="LONG" && last4[3]>last4[2] && last4[2]>last4[1]) score+=30
if(side==="SHORT" && last4[3]<last4[2] && last4[2]<last4[1]) score+=30

// BREAKOUT
if(side==="LONG" && price>high50*0.998) score+=40
if(side==="SHORT" && price<low50*1.002) score+=40

// VOLATILITY
if(atrVal/price>0.004) score+=20

// FILTER
if(distance>0.02) return null
if(trendStrength<0.002) return null
if(side==="LONG" && !lastCandleUp) return null
if(side==="SHORT" && lastCandleUp) return null

if(!side || score<130) return null

// TP SL
let tp,sl
if(side==="LONG"){
    sl=price*0.985
    tp=price+(price-sl)*2
}else{
    sl=price*1.015
    tp=price-(sl-price)*2
}

// RANK
let rank = score>=160 ? "S" : "A"
let star = score>=160 ? "⭐⭐⭐" : "⭐⭐"

return {symbol,side,price,tp,sl,score,rank,star}

}catch{
    return null
}

}))

// lọc null
let signals = results.filter(x=>x)

if(signals.length===0){
    console.log("❌ Không có kèo")
    return
}

signals.sort((a,b)=>b.score-a.score)

let msg="🔥 PRO SIGNAL\n"

signals.slice(0,3).forEach(c=>{
msg+=`
${c.symbol} (${c.rank} ${c.star})
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
setInterval(scanner,120000)
setInterval(checkCommand,5000)

scanner()
