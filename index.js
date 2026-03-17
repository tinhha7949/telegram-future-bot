const TelegramBot = require("node-telegram-bot-api")

const TOKEN = process.env.BOT_TOKEN

if(!TOKEN){
console.log("BOT_TOKEN missing")
process.exit(1)
}

const bot = new TelegramBot(TOKEN,{polling:true})

console.log("BOT STARTED")

function sleep(ms){
return new Promise(r=>setTimeout(r,ms))
}

async function getKline(symbol){

try{

let res = await fetch(`https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=15m&limit=120`)

let data = await res.json()

// nếu API lỗi thì bỏ qua
if(!Array.isArray(data)){
console.log(symbol,"API ERROR")
return null
}

return data

}catch(e){

console.log(symbol,"FETCH FAIL")

return null
}

}

function ema(data,period){

let k = 2/(period+1)

let ema = data[0]

for(let i=1;i<data.length;i++){
ema = data[i]*k + ema*(1-k)
}

return ema
}

function rsi(data){

let gain=0
let loss=0

for(let i=data.length-14;i<data.length;i++){

let diff = data[i]-data[i-1]

if(diff>0) gain+=diff
else loss-=diff

}

let rs = gain/(loss||1)

return 100-(100/(1+rs))

}

async function scan(){

console.log("SCANNING MARKET")

let coins=[

"BTCUSDT","ETHUSDT","SOLUSDT","BNBUSDT","XRPUSDT",
"ADAUSDT","AVAXUSDT","DOGEUSDT","LINKUSDT","DOTUSDT",
"MATICUSDT","LTCUSDT","TRXUSDT","ATOMUSDT","NEARUSDT",
"APTUSDT","OPUSDT","ARBUSDT","SUIUSDT","SEIUSDT"

]

let signals=[]

for(let coin of coins){

await sleep(300)

let data = await getKline(coin)

if(!data) continue

let close = data.map(x=>parseFloat(x[4]))

let price = close[close.length-1]

let ema20 = ema(close.slice(-40),20)
let ema50 = ema(close.slice(-80),50)

let r = rsi(close)

let score=0
let side=null

if(ema20>ema50){
side="LONG"
score+=50
}

if(ema20<ema50){
side="SHORT"
score+=50
}

if(side==="LONG" && r>55) score+=30
if(side==="SHORT" && r<45) score+=30

if(score>=80){

signals.push({
coin,
side,
price,
score
})

}

}

signals.sort((a,b)=>b.score-a.score)

return signals[0]

}

bot.onText(/\/start/,async msg=>{

let id = msg.chat.id

bot.sendMessage(id,"🚀 Bot đang scan market...")

let signal = await scan()

if(!signal){

bot.sendMessage(id,"❌ Chưa có kèo mạnh")

return

}

let tp,sl

if(signal.side==="LONG"){

tp = signal.price*1.03
sl = signal.price*0.985

}else{

tp = signal.price*0.97
sl = signal.price*1.015

}

let text = `
🔥 FUTURE SIGNAL

Coin: ${signal.coin}
Side: ${signal.side}

Entry: ${signal.price}

TP: ${tp.toFixed(4)}
SL: ${sl.toFixed(4)}

Score: ${signal.score}
`

bot.sendMessage(id,text)

})
