"use strict";

async function getTopSymbol({ request, config }) {
  const [exchangeInfo, tickers] = await Promise.all([
    request("GET", "/fapi/v1/exchangeInfo"),
    request("GET", "/fapi/v1/ticker/24hr")
  ]);
  const allowed = new Set((exchangeInfo.symbols || [])
    .filter(s => s.status === "TRADING" &&
      s.contractType === "PERPETUAL" &&
      s.quoteAsset === config.QUOTE_ASSET &&
      s.symbol.endsWith(config.QUOTE_ASSET))
    .map(s => s.symbol));

  return (tickers || [])
    .filter(t => allowed.has(t.symbol) &&
      Number(t.quoteVolume) >= config.MIN_24H_QUOTE_VOLUME_USDT &&
      Number(t.lastPrice) > 0 &&
      Number(t.highPrice) >= Number(t.lowPrice))
    .map(t => ({
      symbol: t.symbol,
      quoteVolume: Number(t.quoteVolume),
      rangePct: (Number(t.highPrice) - Number(t.lowPrice)) / Number(t.lastPrice) * 100
    }))
    .filter(t => Number.isFinite(t.rangePct) && t.rangePct >= config.MIN_24H_RANGE_PCT)
    .sort((a, b) => (b.rangePct * Math.log1p(b.quoteVolume)) - (a.rangePct * Math.log1p(a.quoteVolume)))
    .slice(0, config.MAX_SYMBOLS)
    .map(t => t.symbol);
}

module.exports = { getTopSymbol };
