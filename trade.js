const ccxt = require('ccxt');
const axios = require('axios');
const { EMA, RSI } = require('technicalindicators');

const binance = new ccxt.binance({
  apiKey: process.env.BINANCE_API-KEY,
  secret: process.env.BINANCE_SECRET,
  enableRateLimit: true,
});

const symbols = ['BTC/USDT', 'ETH/USDT', 'BNB/USDT'];
const INTERVAL = '15m';
const CANDLE_LIMIT = 100;
let position = null;

async function getCandleData(symbol) {
  const binanceSymbol = symbol.replace('/', '');
  const url = `https://api.binance.com/api/v3/klines?symbol=${binanceSymbol}&interval=${INTERVAL}&limit=${CANDLE_LIMIT}`;
  const res = await axios.get(url);
  return res.data.map(c => ({
    open: parseFloat(c[1]),
    high: parseFloat(c[2]),
    low: parseFloat(c[3]),
    close: parseFloat(c[4]),
    volume: parseFloat(c[5]),
  }));
}

async function checkGoldenCross(symbol) {
  try {
    const candles = await getCandleData(symbol);
    const closes = candles.map(c => c.close);
    const volumes = candles.map(c => c.volume);

    const ema5 = EMA.calculate({ period: 5, values: closes });
    const ema20 = EMA.calculate({ period: 20, values: closes });

    const prevEMA5 = ema5[ema5.length - 2];
    const prevEMA20 = ema20[ema20.length - 2];
    const curEMA5 = ema5[ema5.length - 1];
    const curEMA20 = ema20[ema20.length - 1];

    const isGoldenCross = prevEMA5 < prevEMA20 && curEMA5 > curEMA20;
    if (!isGoldenCross) return null;

    const currentClose = closes[closes.length - 1];
    if (currentClose < curEMA5) return null;

    const avgVol = volumes.slice(-11, -1).reduce((a, b) => a + b, 0) / 10;
    const curVol = volumes[volumes.length - 1];
    if (curVol < avgVol * 1.1) return null;

    return { symbol, trendStrength: curEMA5 - curEMA20 };
  } catch (err) {
    console.error(`골든크로스 체크 실패 ${symbol}: ${err.message}`);
    return null;
  }
}

async function selectBestSymbol() {
  const candidates = [];
  for (const sym of symbols) {
    const res = await checkGoldenCross(sym);
    if (res) candidates.push(res);
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.trendStrength - a.trendStrength);
  return candidates[0].symbol;
}

async function executeBuy(symbol) {
  if (position) return;

  const balance = await binance.fetchBalance();
  const usdt = balance.total['USDT'];
  if (usdt < 10) return;

  const ticker = await binance.fetchTicker(symbol);
  const price = ticker.ask;
  const amount = (usdt * 0.95) / price;

  await binance.createMarketBuyOrder(symbol, binance.amountToPrecision(symbol, amount));
  position = {
    symbol,
    entryPrice: price,
    highestPrice: price,
    amount,
    status: 'OPEN',
  };
  console.log(`✅ 매수: ${symbol} @ ${price}`);
}

async function checkSellConditions() {
  if (!position) return;

  const ticker = await binance.fetchTicker(position.symbol);
  const curPrice = ticker.bid;
  const pnl = ((curPrice - position.entryPrice) / position.entryPrice) * 100;

  if (curPrice > position.highestPrice) {
    position.highestPrice = curPrice;
  }

  const drawdown = ((position.highestPrice - curPrice) / position.highestPrice) * 100;

  if (drawdown >= 0.5 || pnl <= -1) {
    await binance.createMarketSellOrder(position.symbol, binance.amountToPrecision(position.symbol, position.amount));
    console.log(`💰 매도 완료 (${drawdown >= 0.5 ? '익절' : '손절'}): ${position.symbol} @ ${curPrice}`);
    position = null;
    return;
  }

  const candles = await getCandleData(position.symbol);
  const closes = candles.map(c => c.close);
  const ema5 = EMA.calculate({ period: 5, values: closes });
  const ema20 = EMA.calculate({ period: 20, values: closes });
  const curEMA5 = ema5[ema5.length - 1];
  const curEMA20 = ema20[ema20.length - 1];
  if (curEMA5 < curEMA20) {
    await binance.createMarketSellOrder(position.symbol, binance.amountToPrecision(position.symbol, position.amount));
    console.log(`❌ 골든크로스 무효, 강제 매도: ${position.symbol} @ ${curPrice}`);
    position = null;
  }
}

async function mainLoop() {
  try {
    if (!position) {
      const sym = await selectBestSymbol();
      if (sym) await executeBuy(sym);
      else console.log('골든크로스 종목 없음');
    } else {
      await checkSellConditions();
    }
  } catch (err) {
    console.error(`루프 에러: ${err.message}`);
  }
}

console.log('▶ 골든크로스 자동매매 시작');
mainLoop();
setInterval(mainLoop, 60 * 1000);
