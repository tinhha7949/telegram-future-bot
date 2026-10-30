"use strict";
async function getTopSymbol({ request, config }) {
  const [exchangeInfo, tickers] = await Promise.all([request("GET", "/fapi/v1/exchangeInfo"), request("GET", "/fapi/v1/ticker/24hr")]);
  const allowed = new Set((exchangeInfo.symbols || []).filter(s => s.status === "TRADING" && s.contractType === "PERPETUAL" && s.quoteAsset === config.QUOTE_ASSET && s.symbol.endsWith(config.QUOTE_ASSET)).map(s => s.symbol));
  const candidates = (tickers || []).filter(t => allowed.has(t.symbol) && Number(t.quoteVolume) >= config.MIN_24H_QUOTE_VOLUME_USDT && Number(t.lastPrice) > 0 && Number(t.highPrice) >= Number(t.lowPrice)).map(t => ({symbol:t.symbol, quoteVolume:Number(t.quoteVolume), rangePct:(Number(t.highPrice)-Number(t.lowPrice))/Number(t.lastPrice)*100})).filter(x => x.rangePct >= config.MIN_24H_RANGE_PCT).sort((a,b) => b.quoteVolume-a.quoteVolume);
  const checked = await Promise.all(candidates.map(async item => { try { const k = await request("GET", "/fapi/v1/klines", {symbol:item.symbol, interval:"5m", limit:2}); const bar = Array.isArray(k) ? k[k.length-2] : null; if (!bar) return null; const qv = Number(bar[7] ?? (Number(bar[4]) * Number(bar[5]))); return qv >= config.MIN_5M_QUOTE_VOLUME_USDT ? {...item, volume5mQuote:qv} : null; } catch { return null; } }));
  return checked.filter(Boolean).sort((a,b) => b.rangePct*Math.log1p(b.quoteVolume)-a.rangePct*Math.log1p(a.quoteVolume)).slice(0,config.MAX_SYMBOLS).map(x => x.symbol);
}
module.exports = { getTopSymbol };
