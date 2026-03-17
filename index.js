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

// ================= DATA =================
async function getData(symbol){
    try{
        // FIX: dùng API này ổn định hơn trên Railway
        let url=`https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=15m&limit=150`

        let res=await fetch(url)
        if(!res.ok){
            console.log("API lỗi:", symbol)
            return null
        }

        let json = await res.json()

        if(!Array.isArray(json) || json.length === 0){
            console.log("Không có data:", symbol)
            return null
        }

        return json

    }catch(e){
        console.log("Fetch lỗi:", symbol)
        return null
    }
}

// ================= MAIN =================
async function scanner(){

console.log("🚀 SCAN...")

let coins=[
"BTCUSDT","ETHUSDT","SOLUSDT","BNBUSDT","XRPUSDT",
"ADAUSDT","AVAXUSDT","DOGEUSDT","LINKUSDT","DOTUSDT"
]

let signals=[]

for(let symbol of coins){

try{

let data=await getData(symbol)

// nếu không có data → bỏ qua nhưng vẫn test tiếp coin khác
if(!data) continue

let closes=data.map(x=>parseFloat(x[4]))
let price=closes.at(-1)

let ema20=ema(closes.slice(-40),20)
let r=rsi(closes)

// ====== LOGIC SIÊU DỄ ======
let side=null

if(r >= 50){
    side="LONG"
}else{
    side="SHORT"
}

if(price > ema20) side="LONG"
if(price < ema20) side="SHORT"

// =================

let tp,sl

if(side==="LONG"){
tp=price*1.01
sl=price*0.995
}else{
tp=price*0.99
sl=price*1.005
}

signals.push({symbol,side,price,tp,sl})

}catch(e){
console.log("Lỗi coin:",symbol)
}

}

// ================= SEND =================

// nếu Binance vẫn lỗi hết → gửi test cứng
if(signals.length===0){

let msg=`⚠️ Binance lỗi → TEST TELE OK

BTCUSDT | LONG
Entry: 100
TP: 110
SL: 95
`

await sendTelegram(msg)
return
}

let msg="🔥 TEST TELE (CÓ KÈO)\n"

signals.slice(0,5).forEach(c=>{
msg+=`
${c.symbol} | ${c.side}
Entry: ${c.price.toFixed(4)}
TP: ${c.tp.toFixed(4)}
SL: ${c.sl.toFixed(4)}
`
})

console.log(msg)
await sendTelegram(msg)

}

// ================= LOOP =================

// test nhanh
setInterval(scanner, 15000)

// check telegram
setInterval(checkCommand, 5000)

// chạy ngay
scanner()
