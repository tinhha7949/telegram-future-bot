async function scanner(){

console.log("🚀 ULTIMATE FUTURE SCANNER\n")

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
let ema200=ema(closes.slice(-150),200)

let r=rsi(closes)
let atrVal=atr(highs,lows,closes)

let volNow=volumes.at(-1)
let volAvg=volumes.slice(-50).reduce((a,b)=>a+b)/50

let high50=Math.max(...highs.slice(-50))
let low50=Math.min(...lows.slice(-50))

let last4=closes.slice(-4)
let lastVol=volumes.slice(-4)

let side=null
let score=0

// TREND
if(ema20>ema50 && ema50>ema200){
side="LONG"; score+=60
}
if(ema20<ema50 && ema50<ema200){
side="SHORT"; score+=60
}

// RSI
if(side==="LONG" && r>50 && r<70) score+=20
if(side==="SHORT" && r>30 && r<50) score+=20

// VOLUME BUILDUP
if(lastVol[3]>lastVol[2] && lastVol[2]>lastVol[1]){
score+=25
}

// VOLUME SPIKE
if(volNow>volAvg*1.8) score+=35

// MOMENTUM
if(side==="LONG" && last4[3]>last4[2] && last4[2]>last4[1]){
score+=25
}
if(side==="SHORT" && last4[3]<last4[2] && last4[2]<last4[1]){
score+=25
}

// BREAKOUT
if(side==="LONG" && price>high50*0.999){
score+=30
}
if(side==="SHORT" && price<low50*1.001){
score+=30
}

// VOLATILITY
if(atrVal/price>0.003){
score+=15
}

// 👉 LOG GIỐNG CONSOLE
console.log(symbol, "| side:", side, "| score:", score)

// 👉 LẤY NHIỀU KÈO HƠN
if(side && score>=100){

let tp,sl

if(side==="LONG"){
tp=price*1.04
sl=price*0.99
}else{
tp=price*0.96
sl=price*1.01
}

signals.push({symbol,side,price,tp,sl,score})
}

}

// SORT
signals.sort((a,b)=>b.score-a.score)

// 👉 FORMAT GIỐNG CONSOLE
if(signals.length===0){

console.log("❌ Không có kèo mạnh")

await sendTelegram("❌ Không có kèo (market yếu)")
return
}

console.log("\n🔥 BEST SETUPS\n")

let msg="🔥 BEST SETUPS\n"

signals.slice(0,5).forEach(c=>{

let line=`
${c.symbol}
${c.side}
Entry ${c.price.toFixed(4)}
TP ${c.tp.toFixed(4)}
SL ${c.sl.toFixed(4)}
Score ${c.score}
`

console.log(line)

msg+=line+"\n"
})

await sendTelegram(msg)

}
