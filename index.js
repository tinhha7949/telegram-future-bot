const TelegramBot = require("node-telegram-bot-api")

const token = process.env.BOT_TOKEN
const bot = new TelegramBot(token,{polling:true})

let chatIdGlobal=null

bot.onText(/\/start/,async(msg)=>{

chatIdGlobal=msg.chat.id

bot.sendMessage(chatIdGlobal,"🚀 Bot bắt đầu auto scan future...")

startAutoScan()

})

async function startAutoScan(){

while(true){

let result=await futureScanner50()

if(result && chatIdGlobal){
bot.sendMessage(chatIdGlobal,result)
}

await new Promise(r=>setTimeout(r,300000)) // 5 phút

}

}

async function futureScanner50(){

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

async function getKlines(symbol,interval,limit){

try{

let url=`https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`

let res=await fetch(url)

if(!res.ok) return null

return await res.json()

}catch(e){
return null
}

}

let btc=await getKlines("BTCUSDT","30m",200)

let btcTrend="SIDE"

if(btc){

let btcClose=btc.map(x=>parseFloat(x[4]))

let btcEma50=ema(btcClose.slice(-100),50)
let btcEma200=ema(btcClose.slice(-200),200)

if(btcEma50>btcEma200) btcTrend="LONG"
if(btcEma50<btcEma200) btcTrend="SHORT"

}

let signals=[]

for(let symbol of coins){

let data=await getKlines(symbol,"30m",120)

if(!data) continue

let closes=data.map(x=>parseFloat(x[4]))
let volumes=data.map(x=>parseFloat(x[5]))

let price=closes[closes.length-1]

let ema20=ema(closes.slice(-40),20)
let ema50=ema(closes.slice(-80),50)

let r=rsi(closes)

let volNow=volumes[volumes.length-1]
let volAvg=volumes.slice(-40).reduce((a,b)=>a+b)/40

let side=null
let score=0

if(ema20>ema50 && btcTrend==="LONG"){
side="LONG"
score+=50
}

if(ema20<ema50 && btcTrend==="SHORT"){
side="SHORT"
score+=50
}

if(r>45 && r<60) score+=20

if(volNow>volAvg*2) score+=40

if(side && score>=90){

let tp,sl

if(side==="LONG"){
tp=price*1.04
sl=price*0.99
}else{
tp=price*0.96
sl=price*1.01
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

signals.sort((a,b)=>b.score-a.score)

if(signals.length===0) return null

let text="🔥 FUTURE SIGNAL\n\n"

signals.slice(0,2).forEach(c=>{

text+=`${c.symbol}
${c.side}
Entry ${c.price.toFixed(4)}
TP ${c.tp.toFixed(4)}
SL ${c.sl.toFixed(4)}

`

})

return text

}

console.log("🤖 Bot đang chạy...")
