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
