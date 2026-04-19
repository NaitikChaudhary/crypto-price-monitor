const fs = require("fs/promises");
const path = require("path");

const CONFIG = {
  lookbackMinutes: 5,
  thresholdPercent: 1,
  tokens: [
    { name: "bitcoin", symbol: "BTCUSDT" },
    { name: "ethereum", symbol: "ETHUSDT" },
    { name: "solana", symbol: "SOLUSDT" },
    { name: "cardano", symbol: "ADAUSDT" },
    { name: "dogecoin", symbol: "DOGEUSDT" },
  ],
  lockFilePath: path.join(__dirname, "locked-prices.json"),
  klineInterval: "1m",
  klineLimit: 10,
  telegramMaxMessageLength: 3900,
  apiBaseUrls: [
    "https://api.binance.com",
    "https://data-api.binance.vision",
    "https://api1.binance.com",
  ],
};

async function fetchJsonWithFallback(pathname) {
  const errors = [];

  for (const baseUrl of CONFIG.apiBaseUrls) {
    const url = `${baseUrl}${pathname}`;

    try {
      const response = await fetch(url);
      if (!response.ok) {
        const details = (await response.text()).slice(0, 200);
        const message = `${baseUrl} returned ${response.status} ${response.statusText}${
          details ? ` - ${details}` : ""
        }`;
        errors.push(message);

        // 451 often means endpoint unavailable in runner region.
        if (response.status === 451) {
          continue;
        }
        continue;
      }

      return await response.json();
    } catch (error) {
      errors.push(`${baseUrl} request failed: ${error.message}`);
    }
  }

  throw new Error(errors.join(" | "));
}

async function fetchCurrentPrices(tokens) {
  const data = await fetchJsonWithFallback("/api/v3/ticker/price");
  if (!Array.isArray(data)) {
    throw new Error("Unexpected Binance ticker response.");
  }

  const bySymbol = new Map(data.map((item) => [item.symbol, item.price]));
  const prices = {};
  for (const token of tokens) {
    const rawPrice = bySymbol.get(token.symbol);
    const value = Number(rawPrice);
    if (Number.isFinite(value)) {
      prices[token.symbol] = value;
    }
  }
  return prices;
}

async function fetchKlinePriceFiveMinutesAgo(symbol, targetTimestampMs) {
  const data = await fetchJsonWithFallback(
    `/api/v3/klines?symbol=${symbol}&interval=${CONFIG.klineInterval}&limit=${CONFIG.klineLimit}`
  );
  if (!Array.isArray(data) || data.length === 0) {
    throw new Error(`No kline data for ${symbol}`);
  }

  const closest = data.reduce((best, kline) => {
    const closeTime = Number(kline[6]);
    const bestDiff = Math.abs(Number(best[6]) - targetTimestampMs);
    const currentDiff = Math.abs(closeTime - targetTimestampMs);
    return currentDiff < bestDiff ? kline : best;
  }, data[0]);

  const closePrice = Number(closest[4]);
  if (!Number.isFinite(closePrice) || closePrice <= 0) {
    throw new Error(`Invalid historical close price for ${symbol}`);
  }

  return closePrice;
}

function roundTo(num, precision = 6) {
  return Number(num.toFixed(precision));
}

function createLogger() {
  const lines = [];

  return {
    info(message) {
      const line = `${new Date().toISOString()} INFO ${message}`;
      lines.push(line);
      console.log(message);
    },
    error(message) {
      const line = `${new Date().toISOString()} ERROR ${message}`;
      lines.push(line);
      console.error(message);
    },
    buildMessage() {
      return lines.join("\n");
    },
  };
}

async function lockSignificantMoves(lockedTokens) {
  const payload = {
    lockedAt: new Date().toISOString(),
    thresholdPercent: CONFIG.thresholdPercent,
    lookbackMinutes: CONFIG.lookbackMinutes,
    tokens: lockedTokens,
  };

  await fs.writeFile(CONFIG.lockFilePath, JSON.stringify(payload, null, 2));
}

async function sendTelegramMessage(message) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!botToken || !chatId) {
    return;
  }

  const text =
    message.length > CONFIG.telegramMaxMessageLength
      ? `${message.slice(0, CONFIG.telegramMaxMessageLength)}\n...truncated`
      : message;

  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
    }),
  });

  if (!response.ok) {
    const details = await response.text();
    throw new Error(`Telegram send failed: ${response.status} ${details}`);
  }
}

async function monitorPrices(logger) {
  const now = Date.now();
  const lookbackMs = CONFIG.lookbackMinutes * 60 * 1000;
  const targetTimestamp = now - lookbackMs;
  const lockedTokens = [];
  const currentPrices = await fetchCurrentPrices(CONFIG.tokens);

  for (const token of CONFIG.tokens) {
    try {
      const currentPrice = currentPrices[token.symbol];
      if (typeof currentPrice !== "number" || currentPrice <= 0) {
        throw new Error("Missing current price.");
      }

      const fiveMinutesAgoPrice = await fetchKlinePriceFiveMinutesAgo(
        token.symbol,
        targetTimestamp
      );
      const percentChange = ((currentPrice - fiveMinutesAgoPrice) / fiveMinutesAgoPrice) * 100;

      const tokenResult = {
        token: token.name,
        symbol: token.symbol,
        currentPrice: roundTo(currentPrice),
        fiveMinutesAgoPrice: roundTo(fiveMinutesAgoPrice),
        percentChange: roundTo(percentChange, 4),
      };

      logger.info(
        `[${token.name}] ${CONFIG.lookbackMinutes}m change: ${tokenResult.percentChange}% (current: ${tokenResult.currentPrice} USDT)`
      );

      if (Math.abs(percentChange) > CONFIG.thresholdPercent) {
        lockedTokens.push(tokenResult);
      }
    } catch (error) {
      logger.error(`[${token.name}] ${error.message}`);
    }
  }

  if (lockedTokens.length > 0) {
    await lockSignificantMoves(lockedTokens);
    logger.info(
      `Locked ${lockedTokens.length} token(s) to ${path.basename(CONFIG.lockFilePath)}`
    );
  } else {
    logger.info(
      `No tokens moved more than ${CONFIG.thresholdPercent}% in the last ${CONFIG.lookbackMinutes} minutes.`
    );
  }
}

async function main() {
  const logger = createLogger();

  try {
    await monitorPrices(logger);
  } catch (error) {
    logger.error(`Unexpected error: ${error.message}`);
    process.exitCode = 1;
  }

  try {
    await sendTelegramMessage(logger.buildMessage());
  } catch (error) {
    console.error(`Failed to send Telegram notification: ${error.message}`);
  }
}

main();
