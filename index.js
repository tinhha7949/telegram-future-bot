// ================= CONFIG =================
const BOT_TOKEN = process.env.BOT_TOKEN
const CHAT_ID = process.env.CHAT_ID

const SCORE_THRESHOLD = 80 
const LIMIT_15M = 300
const LIMIT_1H  = 200
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
        console.log("❌ Lỗi gửi Telegram:", e.message)
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

            if(text === "/backtest"){
                await sendTelegram("⏳ Đang backtest BTCUSDT...")
                let result = await backtest("BTCUSDT")
                await sendTelegram(`📊 BACKTEST\n${JSON.stringify(result,null,2)}`)
            }
        }
    }catch(e){
        console.log("⚠️ checkCommand lỗi:", e.message)
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

function atr(data, period=14){
    let trs=[]
    for(let i=1;i<data.length;i++){
        let h=+data[i][2], l=+data[i][3], pc=+data[i-1][4]
        trs.push(Math.max(h-l, Math.abs(h-pc), Math.abs(l-pc)))
    }
    return trs.slice(-period).reduce((a,b)=>a+b)/period
}

// ================= DATA =================
async function getData(symbol, interval, limit){
    const urls = [
        `https://data-api.binance.vision/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`,
        `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`,
        `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`
    ]

    for(let url of urls){
        try{
            let res = await fetch(url,{ headers:{"User-Agent":"Mozilla/5.0"} })
            if(!res.ok) continue
            let data = await res.json()
            if(Array.isArray(data) && data.length > 0){
                return data
            }
        }catch(e){}
    }

    console.log("❌ Binance lỗi:", symbol)
    return null
}

// ================= CORE (NEW) =================
function scanCore(symbol, data15, data1h){

    let closes = data15.map(x=>+x[4])
    let highs  = data15.map(x=>+x[2])
    let lows   = data15.map(x=>+x[3])
    let volumes= data15.map(x=>+x[5])
    let closes1h = data1h.map(x=>+x[4])

    // ===== FIX QUAN TRỌNG: dùng nến đã đóng =====
    let price = closes.at(-2)
    let prevClose = closes.at(-3)

    let volAvg = volumes.slice(-30,-2).reduce((a,b)=>a+b)/30
    if(volAvg < MIN_VOL_15M) return null

    let ema20  = ema(closes.slice(-60,-2),20)
    let ema50  = ema(closes.slice(-120,-2),50)
    let ema200 = ema(closes.slice(-250,-2),200)

    let ema20_1h = ema(closes1h.slice(-60,-2),20)
    let ema50_1h = ema(closes1h.slice(-120,-2),50)

    let r = rsi(closes.slice(-50,-2))
    let atrVal = atr(data15.slice(-100,-2))

    let highs50 = highs.slice(-50,-2)
    let lows50  = lows.slice(-50,-2)

    let high50 = Math.max(...highs50)
    let low50  = Math.min(...lows50)

    let prevHigh = Math.max(...highs.slice(-25,-5))
    let prevLow  = Math.min(...lows.slice(-25,-5))

    let bosUp   = price > prevHigh
    let bosDown = price < prevLow

    let prevHigh50 = Math.max(...highs.slice(-51,-2))
    let prevLow50  = Math.min(...lows.slice(-51,-2))

    let sweepHigh = highs.at(-3) > prevHigh50 && closes.at(-3) < prevHigh50
    let sweepLow  = lows.at(-3) < prevLow50 && closes.at(-3) > prevLow50

    let last4 = closes.slice(-6,-2)
    let momentumUp = last4.every((v,i,a)=> i===0 || v>=a[i-1])
    let momentumDown = last4.every((v,i,a)=> i===0 || v<=a[i-1])

    let pullbackLong  = Math.abs(price-ema20)/price < 0.01
    let pullbackShort = pullbackLong

    let range = (high50 - low50)/price
    if(range < 0.008) return null

    let side=null, score=0

    // ===== TREND =====
    if(ema20>ema50 && ema50>ema200 && ema20_1h>ema50_1h){
        side="LONG"; score+=40
    }
    if(ema20<ema50 && ema50<ema200 && ema20_1h<ema50_1h){
        side="SHORT"; score+=40
    }

    // ===== STRUCTURE =====
    if(side==="LONG"){
        if(sweepLow) score+=40
        else if(bosUp) score+=25
    }

    if(side==="SHORT"){
        if(sweepHigh) score+=40
        else if(bosDown) score+=25
    }

    // ===== RSI =====
    if(side==="LONG" && r>48 && r<70) score+=10
    if(side==="SHORT" && r>30 && r<52) score+=10

    // ===== MOMENTUM =====
    if(side==="LONG" && momentumUp) score+=10
    if(side==="SHORT" && momentumDown) score+=10

    // ===== PULLBACK =====
    if(pullbackLong) score+=15

    // ===== VOLUME =====
    let volNow = volumes.at(-2)
    if(volNow > volAvg*1.5) score+=10

    // ===== FINAL FILTER =====
    if(score < 80) return null

    let sl,tp

    if(side==="LONG"){
        sl = price - atrVal*1
        tp = price + atrVal*1.8
    }else{
        sl = price + atrVal*1
        tp = price - atrVal*1.8
    }

    return { symbol, side, price, tp, sl, score }
}

// ================= SCAN (GIỮ NGUYÊN) =================
async function scan(symbol){
    let data15 = await getData(symbol,"15m",LIMIT_15M)
    let data1h = await getData(symbol,"1h",LIMIT_1H)
    if(!data15 || !data1h) return null
    return scanCore(symbol, data15, data1h)
}

// ================= BACKTEST (NEW) =================
async function backtest(symbol){

    let data15 = await getData(symbol,"15m",2000)
    let data1h = await getData(symbol,"1h",600)

    if(!data15 || !data1h){
        return { error:"no data" }
    }

    let win=0, loss=0, trades=0
    let balance = ACCOUNT_BALANCE
    let equity = []

    for(let i=300;i<data15.length-60;i++){

        let slice15 = data15.slice(0,i)

        // 👉 FIX CHUẨN: lấy 1h thật
        let idx1h = Math.floor(i/4)
        let slice1h = data1h.slice(0, idx1h)

        // 👉 tránh thiếu data
        if(slice1h.length < 120) continue

        let signal = scanCore(symbol, slice15, slice1h)
        if(!signal) continue

        let { side, tp, sl, price } = signal

        let result=null
        let maxHold = 50

        for(let j=i+1;j<Math.min(i+maxHold,data15.length);j++){
            let h=+data15[j][2]
            let l=+data15[j][3]

            if(side==="LONG"){
                if(l<=sl){ result="SL"; break }
                if(h>=tp){ result="TP"; break }
            }else{
                if(h>=sl){ result="SL"; break }
                if(l<=tp){ result="TP"; break }
            }
        }

        if(!result) result="TIMEOUT"

        let risk = balance * RISK_PER_TRADE
        let rr = Math.abs(tp-price) / Math.abs(price-sl)

        if(result==="TP"){
            balance += risk * rr
            win++
        }else{
            balance -= risk
            loss++
        }

        trades++
        equity.push(balance)
    }

    let total = win+loss
    let winrate = total ? (win/total*100).toFixed(2) : 0

    // ===== drawdown =====
    let peak = equity[0] || balance
    let maxDD = 0

    for(let e of equity){
        if(e > peak) peak = e
        let dd = (peak - e) / peak
        if(dd > maxDD) maxDD = dd
    }

    return {
        trades,
        win,
        loss,
        winrate,
        finalBalance: balance.toFixed(2),
        pnlPercent: (((balance-ACCOUNT_BALANCE)/ACCOUNT_BALANCE)*100).toFixed(2)+"%",
        maxDrawdown: (maxDD*100).toFixed(2)+"%"
    }
}

// ================= SCANNER =================
async function scanner(){
    console.log("🚀 SCAN PRO...")

    let symbols = ["BTCUSDT","ETHUSDT","BNBUSDT","ADAUSDT","XRPUSDT",
  "SOLUSDT","DOTUSDT","MATICUSDT","LTCUSDT","AVAXUSDT",
  "LINKUSDT","TRXUSDT","ATOMUSDT","XLMUSDT","ALGOUSDT",
  "VETUSDT","FTMUSDT","NEARUSDT","EOSUSDT","FILUSDT",
  "CHZUSDT","KSMUSDT","SANDUSDT","GRTUSDT","AAVEUSDT",
  "MKRUSDT","COMPUSDT","SNXUSDT","CRVUSDT","1INCHUSDT",
  "ZRXUSDT","BATUSDT","ENJUSDT","LRCUSDT","OPUSDT",
  "STXUSDT","MINAUSDT","COTIUSDT","IMXUSDT","RUNEUSDT",
  "KLAYUSDT","TFUELUSDT","ONTUSDT","QTUMUSDT","NEOUSDT"]

    let results = await Promise.allSettled(symbols.map(symbol => scan(symbol)))
    let signals = results
        .filter(r => r.status==="fulfilled" && r.value)
        .map(r => r.value)

    if(signals.length===0){
        console.log("❌ Không có kèo")
        return
    }

    signals = signals.sort((a,b)=>b.score-a.score)

    let msg="🔥 PRO SIGNAL\n"
    signals.slice(0,3).forEach(c=>{
        msg+=`\n${c.symbol} ${c.side}\nEntry:${c.price.toFixed(4)}\nTP:${c.tp.toFixed(4)}\nSL:${c.sl.toFixed(4)}\nScore:${c.score}\n`
    })

    console.log(msg)
    await sendTelegram(msg)
}

// ================= LOOP =================
setInterval(() => scanner(), 300000)
setInterval(() => checkCommand(), 10000)

// ================= RUN =================
async function main(){
    await scanner()
}
main()
