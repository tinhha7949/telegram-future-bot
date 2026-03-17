const TelegramBot = require("node-telegram-bot-api")
const fetch = require("node-fetch")

const bot = new TelegramBot(process.env.BOT_TOKEN,{polling:true})

console.log("BOT STARTED")

bot.onText(/\/scan/, async (msg)=>{

const chatId = msg.chat.id

bot.sendMessage(chatId,"🚀 Scanning futures market...")

let coins=[
"BTCUSDT","ETHUSDT","SOLUSDT","BNBUSDT","XRPUSDT",
"ADAUSDT","AVAXUSDT","DOGEUSDT","LINKUSDT","DOTUSDT",
"MATICUSDT","LTCUSDT","TRXUSDT","ATOMUSDT","NEARUSDT",
"INJUSDT","APTUSDT","OPUSDT","ARBUSDT","SUIUSDT",
"SEIUSDT","TIAUSDT","FILUSDT","AAVEUSDT","RNDRUSDT",
"GALAUSDT","DYDXUSDT","ETCUSDT","ICPUSDT","THETAUSDT",
"STXUSDT","IMXUSDT","FLOWUSDT","EGLDUSDT","XTZUSDT",
"KAVAUSDT","CRVUSDT","SANDUSDT","MANAUSDT","APEUSDT",
"LDOUSDT","RUNEUSDT","COMPUSDT","SNXUSDT","CHZUSDT",
"ZILUSDT","1INCHUSDT","BATUSUSDT","ENSUSDT"
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

async function getData(symbol){

let url=`https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=15m&limit=200`

try{

let res=await fetch(url)
let data=await res.json()

return data

}catch{
return null
}

}

let signals=[]

for(let symbol of coins){

let data=await getData(symbol)

if(!data) continue

let closes=data.map(x=>parseFloat(x[4]))
let highs=data.map(x=>parseFloat(x[2]))
let lows=data.map(x=>parseFloat(x[3]))
let volumes=data.map(x=>parseFloat(x[5]))

let price=closes[closes.length-1]

let ema20=ema(closes.slice(-40),20)
let ema50=ema(closes.slice(-80),50)
let ema200=ema(closes.slice(-150),200)

let r=rsi(closes)

let high50=Math.max(...highs.slice(-50))
let low50=Math.min(...lows.slice(-50))

let side=null
let score=0

if(ema20>ema50 && ema50>ema200){
side="LONG"
score+=60
}

if(ema20<ema50 && ema50<ema200){
side="SHORT"
score+=60
}

if(side==="LONG" && r>50 && r<65) score+=20
if(side==="SHORT" && r>35 && r<50) score+=20

if(side==="LONG" && price>high50*0.998) score+=40
if(side==="SHORT" && price<low50*1.002) score+=40

if(side && score>=100){

let tp,sl

if(side==="LONG"){
tp=price*1.05
sl=price*0.985
}else{
tp=price*0.95
sl=price*1.015
}

signals.push({symbol,side,price,tp,sl,score})

}

}

signals.sort((a,b)=>b.score-a.score)

if(signals.length===0){

bot.sendMessage(chatId,"❌ Không có kèo mạnh")

return

}

let text="🔥 BEST FUTURE SETUPS\n"

signals.slice(0,3).forEach(c=>{

text+=`

${c.symbol}
${c.side}
Entry ${c.price.toFixed(4)}
TP ${c.tp.toFixed(4)}
SL ${c.sl.toFixed(4)}
Score ${c.score}

`

})

bot.sendMessage(chatId,text)

})
