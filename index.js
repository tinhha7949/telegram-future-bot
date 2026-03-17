import fetch from "node-fetch"

const BOT_TOKEN = process.env.BOT_TOKEN
const CHAT_ID = process.env.CHAT_ID

let lastUpdateId = 0

// ================= TELEGRAM =================
async function sendTelegram(msg){
    let url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`

    await fetch(url,{
        method:"POST",
        headers:{"Content-Type":"application/json"},
        body: JSON.stringify({
            chat_id: CHAT_ID,
            text: msg
        })
    })
}

// ================= COMMAND =================
async function checkCommand(){
    try{
        let url = `https://api.telegram.org/bot${BOT_TOKEN}/getUpdates?offset=${lastUpdateId+1}`
        let res = await fetch(url)

        if(!res.ok){
            console.log("❌ Telegram API lỗi")
            return
        }

        let data = await res.json()

        if(!data.result || data.result.length === 0) return

        for(let update of data.result){

            lastUpdateId = update.update_id

            if(!update.message || !update.message.text) continue

            let text = update.message.text

            if(text === "/status"){
                await sendTelegram("🤖 Bot vẫn đang chạy OK!")
            }
        }

    }catch(e){
        console.log("⚠️ Lỗi nhẹ khi check command")
    }
}

    }catch(e){
        console.log("Command error")
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
    try{
        let url=`https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=15m&limit=150`
        let res=await fetch(url)
        if(!res.ok) return null
        return await res.json()
    }catch{
        return null
    }
}

// ================= MAIN =================
async function scanner(){

console.log("🚀 RUNNING SCANNER...\n")

let coins=[
"BTCUSDT","ETHUSDT","SOLUSDT","BNBUSDT","XRPUSDT",
"ADAUSDT","AVAXUSDT","DOGEUSDT","LINKUSDT","DOTUSDT",
"MATICUSDT","LTCUSDT","TRXUSDT","ATOMUSDT","NEARUSDT",
"INJUSDT","APTUSDT","OPUSDT","ARBUSDT","SUIUSDT",
"SEIUSDT","TIAUSDT","FILUSDT","AAVEUSDT","RNDRUSDT",
"GALAUSDT","DYDXUSDT","ETCUSDT","ICPUSDT","THETAUSDT",
"KASUSDT","STXUSDT","IMXUSDT","FLOWUSDT","EGLDUSDT",
"XTZUSDT","KAVAUSDT","CRVUSDT","SANDUSDT","MANAUSDT",
"APEUSDT","LDOUSDT","RUNEUSDT","COMPUSDT","SNXUSDT",
"CHZUSDT","ZILUSDT","1INCHUSDT","BATUSDT","ENSUSDT"
]

let signals=[]

for(let symbol of coins){

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

// ===== WINRATE CAO =====
let trendStrong = Math.abs(ema20 - ema50) / price > 0.002

// LONG chuẩn
if(
trendStrong &&
price > ema20 &&
ema20 > ema50 &&
r > 55 && r < 70 &&
volNow > volAvg * 1.5 &&
price > high20 * 1.002
){
side="LONG"
}

// SHORT chuẩn
if(
trendStrong &&
price < ema20 &&
ema20 < ema50 &&
r < 45 && r > 30 &&
volNow > volAvg * 1.5 &&
price < low20 * 0.998
){
side="SHORT"
}

console.log(symbol, "|", side)

// ===== PUSH + STRENGTH =====
if(side){

let tp,sl

if(side==="LONG"){
tp=price*1.03
sl=price*0.99
}else{
tp=price*0.97
sl=price*1.01
}

// 🔥 strength xịn
let strength = 0

strength += (Math.abs(ema20 - ema50) / price) * 1000

if(side==="LONG"){
    strength += (70 - r)
}else{
    strength += (r - 30)
}

strength += (volNow / volAvg) * 15

if(side==="LONG"){
    strength += (price / high20) * 80
}else{
    strength += (low20 / price) * 80
}

signals.push({symbol,side,price,tp,sl,strength})
}

}

// ===== FILTER =====
if(signals.length===0){
console.log("❌ Không có kèo")
return
}

signals = signals.filter(c => c.strength > 120)

if(signals.length===0){
console.log("❌ Không có kèo mạnh")
return
}

signals.sort((a,b)=>b.strength-a.strength)

// ===== TELE =====
let best = signals[0]

let msg=`
🔥 BEST KÈO

${best.symbol} | ${best.side}
Entry: ${best.price.toFixed(4)}
TP: ${best.tp.toFixed(4)}
SL: ${best.sl.toFixed(4)}
Power: ${best.strength.toFixed(1)}
`

console.log(msg)

await sendTelegram(msg)

}

// ================= LOOP =================
setInterval(scanner, 60000)
setInterval(checkCommand, 3000)

scanner()
