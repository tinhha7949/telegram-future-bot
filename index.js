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

// ================= DATA (ĐÃ FIX) =================
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

console.log("🚀 SCAN...")

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

let signals=[]

for(let symbol of coins){

try{

let data=await getData(symbol)
if(!data) continue

let closes=data.map(x=>parseFloat(x[4]))
let highs=data.map(x=>parseFloat(x[2]))
let lows=data.map(x=>parseFloat(x[3]))
let volumes=data.map(x=>parseFloat(x[5]))

let price=closes.at(-1)

let ema20=ema(closes.slice(-40),20)
let ema50=ema(closes.slice(-80),50)

let r=rsi(closes)

let volNow=volumes.at(-1)
let volAvg=volumes.slice(-30).reduce((a,b)=>a+b)/30

let high20=Math.max(...highs.slice(-20))
let low20=Math.min(...lows.slice(-20))

let side=null

// ====== LOGIC GỐC ======

// ====== LOGIC TEST (NỚI NHẸ) ======

// LONG dễ hơn
if(
price > ema20 &&
r > 52
){
side="LONG"
}

// SHORT dễ hơn
if(ema20>ema50 && ema50>ema200){
side="LONG"
score+=60
}

if(ema20<ema50 && ema50<ema200){
side="SHORT"
score+=60
}

// RSI MOMENTUM

if(side==="LONG" && r>50 && r<65) score+=20
if(side==="SHORT" && r>35 && r<50) score+=20

// VOLUME BUILDUP (trước khi nổ)

if(
lastVol[3]>lastVol[2] &&
lastVol[2]>lastVol[1]
){
score+=30
}

// VOLUME SPIKE

if(volNow>volAvg*2) score+=40

// MOMENTUM

if(side==="LONG" &&
last4[3]>last4[2] &&
last4[2]>last4[1]) score+=30

if(side==="SHORT" &&
last4[3]<last4[2] &&
last4[2]<last4[1]) score+=30

// BREAKOUT

if(side==="LONG" && price>high50*0.998) score+=40
if(side==="SHORT" && price<low50*1.002) score+=40

// VOLATILITY FILTER

if(atrVal/price>0.004) score+=20

if(side && score>=130){

let tp,sl

if(side==="LONG"){
tp=price*1.05
sl=price*0.985
}else{
tp=price*0.95
sl=price*1.015
}

signals.push({
symbol,
side,
price,
tp,
sl,
score
})

}
}

// ================= SEND =================

if(signals.length===0){
console.log("❌ Không có kèo")
return
}

let msg="🔥 KÈO XỊN\n"

signals.slice(0,3).forEach(c=>{
msg+=`
${c.symbol}
${c.side}
Entry: ${c.price.toFixed(4)}
TP: ${c.tp.toFixed(4)}
SL: ${c.sl.toFixed(4)}
`
})

console.log(msg)
await sendTelegram(msg)

}

// ================= LOOP =================

setInterval(scanner, 120000)
setInterval(checkCommand, 5000)

scanner()
