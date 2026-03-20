// ================= CONFIG =================
const BOT_TOKEN = process.env.BOT_TOKEN
const CHAT_ID = process.env.CHAT_ID

const LIMIT_15M = 300
const LIMIT_1H  = 200

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

// ================= CORE =================
function scanCore(symbol, data15, data1h){

    if(data15.length < 150 || data1h.length < 30) return null

    let closes = data15.map(x=>+x[4])
    let volumes= data15.map(x=>+x[5])
    let closes1h = data1h.map(x=>+x[4])

    let price = closes.at(-2)

    let ema20  = ema(closes.slice(-50,-2),20)
    let ema50  = ema(closes.slice(-100,-2),50)

    let ema20_1h = ema(closes1h.slice(-50),20)
    let ema50_1h = ema(closes1h.slice(-100),50)

    let r = rsi(closes.slice(-30,-2))
    let atrVal = atr(data15.slice(-50,-2))

    let volAvg = volumes.slice(-30,-2).reduce((a,b)=>a+b)/28
    let volNow = volumes.at(-2)

    let side=null, score=0

    if(ema20 > ema50 && ema20_1h > ema50_1h){
        side="LONG"; score+=50
    }

    if(ema20 < ema50 && ema20_1h < ema50_1h){
        side="SHORT"; score+=50
    }

    if(side==="LONG" && r>50) score+=10
    if(side==="SHORT" && r<50) score+=10

    if(volNow > volAvg*1.1) score+=10

    if(!side || score < 60) return null

    let sl,tp

    if(side==="LONG"){
        sl = price - atrVal
        tp = price + atrVal*2
    }else{
        sl = price + atrVal
        tp = price - atrVal*2
    }

    return { symbol, side, price, tp, sl, score }
}

// ================= SCAN =================
async function scan(symbol){
    let data15 = await getData(symbol,"15m",LIMIT_15M)
    let data1h = await getData(symbol,"1h",LIMIT_1H)
    if(!data15 || !data1h) return null
    return scanCore(symbol, data15, data1h)
}

// ================= BACKTEST =================
async function backtest(symbol){
    let data15 = await getData(symbol,"15m",1500)
    let data1h = await getData(symbol,"1h",500)

    if(!data15 || !data1h) return { error:"no data" }

    let win=0, loss=0, total=0

    for(let i=150;i<data15.length-50;i++){

        let slice15 = data15.slice(0,i)
        let idx1h = Math.floor(i/4)
        let slice1h = data1h.slice(Math.max(0, idx1h-120), idx1h)

        if(slice1h.length < 30) continue

        let signal = scanCore(symbol, slice15, slice1h)
        if(!signal) continue

        let { side, tp, sl } = signal
        let result=null

        for(let j=i+1;j<i+40;j++){
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

        if(result==="TP") win++
        else loss++

        total++
    }

    let winrate = total ? (win/total*100).toFixed(2) : 0

    return { total, win, loss, winrate }
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
setInterval(() => checkCommand(), 5000)

// ================= RUN =================
async function main(){
    await scanner()
}
main()
