# Nine-AI 4h Quant Engine

One decision authority (AI-9) over 4-hour closed candles, default WAIT, no martingale, durable risk/drawdown/memory circuits, 60/40 TP1/TP2, realized outcome calibration and automatic 14-day shadow champion evaluation.

Start with [VPS installation, config and safety limitations](docs/NINE_AI_VPS_DEPLOY.md), edit [CONFIG.yaml](CONFIG.yaml), put exchange/database secrets in an untracked `.env`, and run `npm run install:service` on a systemd host. `npm test` checks all nested modules.

**Tests are not a profit guarantee or proof of exchange-live safety.** Never treat a failed API request or uncertain position as permission to enter a trade.
