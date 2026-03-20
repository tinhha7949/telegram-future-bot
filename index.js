// ================= CONFIG =================
const BOT_TOKEN = process.env.BOT_TOKEN
const CHAT_ID = process.env.CHAT_ID

const LIMIT_15M = 300
const LIMIT_1H  = 200

const SCORE_THRESHOLD = 150
const RISK_PER_TRADE = 0.01
const ACCOUNT_BALANCE = 1000
const MIN_VOL_15M = 100000

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
        console.log("❌ Telegram:", e.message)
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

            if(u.message.text === "/status"){
                await sendTelegram("🤖 BOT 3 đang chạy OK")
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

function atr(data, p=14){
    let trs=[]
    for(let i=1;i<data.length;i++){
        let h=+data[i][2], l=+data[i][3], pc=+data[i-1][4]
        trs.push(Math.max(h-l, Math.abs(h-pc), Math.abs(l-pc)))
    }
    return trs.slice(-p).reduce((a,b)=>a+b,0)/p
}

// ================= DATA =================
async function getData(symbol, interval, limit){
    const urls=[
        `https://data-api.binance.vision/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`,
        `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`,
        `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`
    ]

    for(let url of urls){
        try{
            let res=await fetch(url,{headers:{"User-Agent":"Mozilla/5.0"}})
            if(!res.ok) continue
            let data=await res.json()
            if(Array.isArray(data)&&data.length>0) return data
        }catch(e){}
    }

    console.log("❌ DATA:", symbol)
    return null
}

// ================= CORE BOT 3 =================
async function scan(symbol){

    let data15 = await getData(symbol,"15m",LIMIT_15M)
    let data1h = await getData(symbol,"1h",LIMIT_1H)
    if(!data15 || !data1h) return null
    if(data15.length<250 || data1h.length<120) return null

    let closes = data15.map(x=>+x[4])
    let highs  = data15.map(x=>+x[2])
    let lows   = data15.map(x=>+x[3])
    let volumes= data15.map(x=>+x[5])
    let closes1h = data1h.map(x=>+x[4])

    let price = closes.at(-1)

    let volAvg = volumes.slice(-30).reduce((a,b)=>a+b,0)/30
    if(volAvg < MIN_VOL_15M) return null

    // ===== INDICATOR =====
    let ema20  = ema(closes.slice(-60),20)
    let ema50  = ema(closes.slice(-120),50)
    let ema200 = ema(closes.slice(-250),200)

    let ema20_1h = ema(closes1h.slice(-60),20)
    let ema50_1h = ema(closes1h.slice(-120),50)

    let r = rsi(closes.slice(-50))
    let atrVal = atr(data15.slice(-100))

    let last4 = closes.slice(-4)
    let momentumUp = last4[3]>last4[2] && last4[2]>last4[1]
    let momentumDown = last4[3]<last4[2] && last4[2]<last4[1]

    let volNow = volumes.at(-1)
    let volSpike = volNow > volAvg*1.3

    // ===== TREND =====
    let trendLong = ema20>ema50 && ema50>ema200 && ema20_1h>ema50_1h
    let trendShort = ema20<ema50 && ema50<ema200 && ema20_1h<ema50_1h

    // ===== BOS =====
    let prevHigh = Math.max(...highs.slice(-25,-5))
    let prevLow  = Math.min(...lows.slice(-25,-5))
    let bosUp   = price > prevHigh
    let bosDown = price < prevLow

    // ===== MAIN =====
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

    // ===== EARLY =====
    let earlySide=null, earlyScore=0

    if(trendLong){
        earlySide="LONG"
        earlyScore=50
        if(momentumUp) earlyScore+=20
        if(r>50) earlyScore+=10
        if(volSpike) earlyScore+=10
    }

    if(trendShort){
        earlySide="SHORT"
        earlyScore=50
        if(momentumDown) earlyScore+=20
        if(r<50) earlyScore+=10
        if(volSpike) earlyScore+=10
    }

    // ===== SELECT =====
    if(score >= SCORE_THRESHOLD){
        type="MAIN"
    }else if(earlyScore >= 70){
        side=earlySide
        score=earlyScore
        type="EARLY"
    }else return null

    if(!side) return null

    // ===== SL TP =====
    let sl,tp
    if(side==="LONG"){
        sl = price - atrVal*1.2
        tp = price + atrVal*2.5
    }else{
        sl = price + atrVal*1.2
        tp = price - atrVal*2.5
    }

    // ===== SIZE =====
    let risk = ACCOUNT_BALANCE * RISK_PER_TRADE
    if(type==="EARLY") risk *= 0.5

    let lossPerUnit = Math.abs(price-sl)
    let size = risk / lossPerUnit

    let rank = type==="MAIN" ? "S" : "B"

    return { symbol, side, price, tp, sl, size, score, rank, type }
}

// ================= SCANNER =================
async function scanner(){
    console.log("🚀 BOT 3 SCAN...")

    let symbols = ["BTCUSDT","ETHUSDT","BNBUSDT","SOLUSDT","XRPUSDT","ADAUSDT"]

    let results = await Promise.allSettled(symbols.map(scan))

    let signals = results
        .filter(r=>r.status==="fulfilled" && r.value)
        .map(r=>r.value)

    if(signals.length===0){
        console.log("❌ No signal")
        return
    }

    signals.sort((a,b)=>b.score-a.score)

    let msg="🔥 BOT 3 SIGNAL\n"

    signals.slice(0,3).forEach(c=>{
        msg+=`
${c.symbol} (${c.rank}-${c.type})
${c.side}
Entry: ${c.price.toFixed(4)}
TP: ${c.tp.toFixed(4)}
SL: ${c.sl.toFixed(4)}
Size: ${c.size.toFixed(2)}
Score: ${c.score}
`
    })

    console.log(msg)
    await sendTelegram(msg)
}

// ================= LOOP =================
setInterval(()=>scanner(),300000)   // 5 phút
setInterval(()=>checkCommand(),10000)

// ================= RUN =================
async function main(){
    await scanner()
}
main()
