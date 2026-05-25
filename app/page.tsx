"use client";

import { useCallback, useEffect, useState } from "react";

const BINANCE_SPOT_TICKER_URL =
  "https://api.binance.com/api/v3/ticker/24hr?symbol=BTCUSDT";
const BINANCE_SPOT_KLINES_URL =
  "https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1d&limit=90";
const REFRESH_INTERVAL = 5 * 60 * 1000;

const INDICATOR_TOOLTIPS = {
  ema9:
    "9周期指数均线，比普通均线更敏感，适合观察短线合约动能。价格在 EMA9 上方通常代表短线偏强，下方代表短线偏弱。",
  ma20:
    "20日均线，代表短期平均价格。价格在 MA20 上方通常偏强，下方通常偏弱。",
  ma50:
    "50日均线，代表中期趋势。价格在 MA50 上方通常说明中期趋势较强。",
  rsi14:
    "相对强弱指数，用来判断短线是否超买或超卖。RSI > 70 通常偏热，RSI < 30 通常偏冷。",
  macd:
    "趋势动能指标，用来观察多空动能变化。金叉通常偏多，死叉通常偏空。",
  bollingerBands:
    "布林带，用来观察价格是否接近波动区间上沿或下沿。靠近上轨代表偏热，靠近下轨代表偏冷。",
  atr14:
    "平均真实波幅，用来衡量当前波动率。ATR 越高，代表行情波动越大，合约止损不宜设太近。",
  volumeTrend:
    "成交量趋势，用来判断上涨或下跌是否有量能配合。放量更容易确认趋势，缩量则信号较弱。",
} as const;

type BitcoinMarketData = {
  usd: number;
  usd_market_cap?: number;
  usd_24h_vol: number;
  usd_24h_change: number;
};

type BinanceTickerResponse = {
  price?: string;
  lastPrice?: string;
  priceChangePercent?: string;
  quoteVolume?: string;
  volume?: string;
};

type MarketMetric = {
  label: string;
  value: string;
  tone?: "positive" | "negative";
};

type BitcoinMarketSnapshot = BitcoinMarketData & {
  updatedAt: Date;
};

type ChartPoint = [number, number];

type BinanceKline = [
  number | string,
  string,
  string,
  string,
  string,
  string,
  number,
  string,
  ...unknown[],
];

type BitcoinMarketChartSnapshot = {
  data: {
    prices: ChartPoint[];
    total_volumes: ChartPoint[];
  };
  updatedAt: Date;
};

type SignalStatus =
  | "Bullish"
  | "Bearish"
  | "Neutral"
  | "Overbought"
  | "Oversold"
  | "Normal"
  | "Low"
  | "Medium"
  | "High";

type IndicatorMetric = {
  label: string;
  value: string;
  status: SignalStatus;
  tooltip: string;
  detail?: string;
};

type TechnicalSignals = {
  price: number;
  ema9: number;
  ma20: number;
  ma50: number;
  rsi14: number;
  macd: {
    line: number;
    signal: number;
    histogram: number;
  };
  bollingerBands: {
    upper: number;
    middle: number;
    lower: number;
  };
  atr14: number;
  atrPercent: number;
  volumeTrendPercent: number;
  futuresRisk: "Low" | "Medium" | "High";
  technicalRead: string;
};

type SupportResistanceZone = {
  label: string;
  range: [number, number];
  distancePercent: number;
  explanation: string;
};

type SupportResistanceSignals = {
  pressureZones: SupportResistanceZone[];
  supportZones: SupportResistanceZone[];
  oneLineRead: string;
};

type ChartSeries = {
  label: string;
  color: string;
  values: Array<number | null>;
};

function formatCurrency(value: number, options?: Intl.NumberFormatOptions) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
    ...options,
  }).format(value);
}

function formatCompactCurrency(value: number) {
  return formatCurrency(value, {
    notation: "compact",
    maximumFractionDigits: 2,
  });
}

function formatPercent(value: number) {
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
}

function formatDistancePercent(value: number) {
  return `${value.toFixed(2)}%`;
}

function formatNumber(value: number, maximumFractionDigits = 2) {
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits,
  }).format(value);
}

function formatUpdatedTime(date?: Date | string | number) {
  const safeDate = date ? new Date(date) : new Date();

  return safeDate.toLocaleTimeString("en-US", {
    timeZone: "Asia/Singapore",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function formatUpdatedMeta(date?: Date | string | number) {
  const time = formatUpdatedTime(date);

  return `Updated: ${time} GMT+8 · Refresh: 5 min`;
}

function parseBinanceNumber(value: string | undefined) {
  if (!value) {
    return null;
  }

  const parsedValue = Number(value);

  return Number.isFinite(parsedValue) ? parsedValue : null;
}

function getBinanceTickerPrice(data: BinanceTickerResponse) {
  return parseBinanceNumber(data.price) ?? parseBinanceNumber(data.lastPrice);
}

async function getBitcoinMarketData(signal?: AbortSignal) {
  const response = await fetch(BINANCE_SPOT_TICKER_URL, { signal });

  if (!response.ok) {
    throw new Error("Binance Spot did not return a successful response.");
  }

  const data = (await response.json()) as BinanceTickerResponse;
  const price = getBinanceTickerPrice(data);

  if (price === null) {
    throw new Error("Binance Spot returned an unexpected response shape.");
  }

  return {
    usd: price,
    usd_24h_change: parseBinanceNumber(data.priceChangePercent) ?? 0,
    usd_24h_vol:
      parseBinanceNumber(data.quoteVolume) ??
      parseBinanceNumber(data.volume) ??
      0,
    updatedAt: new Date(),
  };
}

function isBinanceKlineSeries(data: unknown): data is BinanceKline[] {
  return (
    Array.isArray(data) &&
    data.every(
      (kline) =>
        Array.isArray(kline) &&
        kline.length >= 8 &&
        (typeof kline[0] === "number" || typeof kline[0] === "string") &&
        typeof kline[4] === "string" &&
        typeof kline[5] === "string" &&
        parseBinanceNumber(kline[4]) !== null &&
        parseBinanceNumber(kline[5]) !== null,
    )
  );
}

async function getBitcoinMarketChartData(
  signal?: AbortSignal,
): Promise<BitcoinMarketChartSnapshot> {
  const response = await fetch(BINANCE_SPOT_KLINES_URL, { signal });

  if (!response.ok) {
    throw new Error("Binance Spot kline data did not return successfully.");
  }

  const data = (await response.json()) as unknown;

  if (!isBinanceKlineSeries(data) || data.length < 60) {
    throw new Error("Binance Spot kline data is incomplete.");
  }

  const prices: ChartPoint[] = data.map(
    (kline) =>
      [Number(kline[0]), parseBinanceNumber(kline[4]) ?? 0] as ChartPoint,
  );
  const totalVolumes: ChartPoint[] = data.map(
    (kline) =>
      [Number(kline[0]), parseBinanceNumber(kline[5]) ?? 0] as ChartPoint,
  );

  return {
    data: {
      prices,
      total_volumes: totalVolumes,
    },
    updatedAt: new Date(),
  };
}

function average(values: number[]) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function simpleMovingAverage(values: number[], period: number) {
  return average(values.slice(-period));
}

function exponentialMovingAverage(values: number[], period: number) {
  const multiplier = 2 / (period + 1);
  let ema = simpleMovingAverage(values.slice(0, period), period);

  for (const value of values.slice(period)) {
    ema = (value - ema) * multiplier + ema;
  }

  return ema;
}

function relativeStrengthIndex(values: number[], period: number) {
  const changes = values.slice(1).map((value, index) => value - values[index]);
  const recentChanges = changes.slice(-period);
  const gains = recentChanges.map((change) => Math.max(change, 0));
  const losses = recentChanges.map((change) => Math.max(-change, 0));
  const averageGain = average(gains);
  const averageLoss = average(losses);

  if (averageLoss === 0) {
    return 100;
  }

  return 100 - 100 / (1 + averageGain / averageLoss);
}

function macd(values: number[]) {
  const macdValues = values.slice(25).map((_, index) => {
    const priceWindow = values.slice(0, index + 26);
    return (
      exponentialMovingAverage(priceWindow, 12) -
      exponentialMovingAverage(priceWindow, 26)
    );
  });
  const line = macdValues.at(-1) ?? 0;
  const signal = exponentialMovingAverage(macdValues, 9);

  return {
    line,
    signal,
    histogram: line - signal,
  };
}

function standardDeviation(values: number[]) {
  const mean = average(values);
  const variance =
    values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;

  return Math.sqrt(variance);
}

function bollingerBands(values: number[], period: number) {
  const recentPrices = values.slice(-period);
  const middle = average(recentPrices);
  const deviation = standardDeviation(recentPrices);

  return {
    upper: middle + deviation * 2,
    middle,
    lower: middle - deviation * 2,
  };
}

function averageTrueRangeProxy(values: number[], period: number) {
  const ranges = values
    .slice(1)
    .map((value, index) => Math.abs(value - values[index]));

  return average(ranges.slice(-period));
}

function getTrendStatus(price: number, baseline: number): "Bullish" | "Bearish" {
  return price >= baseline ? "Bullish" : "Bearish";
}

function getRsiStatus(rsi: number): "Overbought" | "Oversold" | "Normal" {
  if (rsi > 70) {
    return "Overbought";
  }

  if (rsi < 30) {
    return "Oversold";
  }

  return "Normal";
}

function getMacdStatus(signal: TechnicalSignals["macd"]) {
  if (Math.abs(signal.histogram) < 1) {
    return "Neutral";
  }

  return signal.histogram > 0 ? "Bullish" : "Bearish";
}

function getBollingerStatus(
  price: number,
  bands: TechnicalSignals["bollingerBands"],
) {
  const bandWidth = bands.upper - bands.lower;
  const position = bandWidth === 0 ? 0.5 : (price - bands.lower) / bandWidth;

  if (position > 0.8) {
    return "Overbought";
  }

  if (position < 0.2) {
    return "Oversold";
  }

  return "Normal";
}

function getVolatilityStatus(atrPercent: number): "Low" | "Medium" | "High" {
  if (atrPercent < 1.5) {
    return "Low";
  }

  if (atrPercent < 3.5) {
    return "Medium";
  }

  return "High";
}

function getVolumeStatus(volumeTrendPercent: number) {
  if (volumeTrendPercent > 8) {
    return "Bullish";
  }

  if (volumeTrendPercent < -8) {
    return "Bearish";
  }

  return "Neutral";
}

function getFuturesRisk(
  rsi: number,
  atrPercent: number,
  volumeTrendPercent: number,
): "Low" | "Medium" | "High" {
  const overheated = rsi > 72 || rsi < 28;
  const volatile = atrPercent >= 3.5;
  const fadingVolume = volumeTrendPercent < -12;

  if ((overheated && volatile) || (volatile && fadingVolume)) {
    return "High";
  }

  if (overheated || atrPercent >= 1.5 || fadingVolume) {
    return "Medium";
  }

  return "Low";
}

function buildTechnicalRead(signals: TechnicalSignals) {
  const trend =
    signals.price > signals.ema9 &&
    signals.price > signals.ma20 &&
    signals.price > signals.ma50
      ? "多头结构占优"
      : signals.price < signals.ema9 && signals.price < signals.ma20
        ? "短线结构偏弱"
        : "趋势信号分化";
  const momentum =
    signals.macd.histogram > 0 ? "MACD 动能偏多" : "MACD 动能偏空";
  const rsi =
    signals.rsi14 > 70
      ? "RSI 偏热，追多风险上升"
      : signals.rsi14 < 30
        ? "RSI 偏冷，空头拥挤风险上升"
        : "RSI 处于正常区间";
  const volatility =
    signals.futuresRisk === "High"
      ? "合约波动风险较高，仓位和止损需要更保守。"
      : signals.futuresRisk === "Medium"
        ? "合约风险中等，适合等待更清晰的量价确认。"
        : "合约风险相对较低，但仍需控制杠杆。";

  return `${trend}，${momentum}，${rsi}。${volatility}`;
}

function calculateTechnicalSignals(
  chartData: BitcoinMarketChartSnapshot["data"],
): TechnicalSignals {
  const prices = chartData.prices.map((point) => point[1]);
  const volumes = chartData.total_volumes.map((point) => point[1]);
  const price = prices.at(-1) ?? 0;
  const ema9 = exponentialMovingAverage(prices, 9);
  const ma20 = simpleMovingAverage(prices, 20);
  const ma50 = simpleMovingAverage(prices, 50);
  const rsi14 = relativeStrengthIndex(prices, 14);
  const macdSignal = macd(prices);
  const bands = bollingerBands(prices, 20);
  const atr14 = averageTrueRangeProxy(prices, 14);
  const atrPercent = (atr14 / price) * 100;
  const recentVolume = average(volumes.slice(-7));
  const previousVolume = average(volumes.slice(-14, -7));
  const volumeTrendPercent =
    previousVolume === 0
      ? 0
      : ((recentVolume - previousVolume) / previousVolume) * 100;
  const futuresRisk = getFuturesRisk(rsi14, atrPercent, volumeTrendPercent);
  const signals = {
    price,
    ema9,
    ma20,
    ma50,
    rsi14,
    macd: macdSignal,
    bollingerBands: bands,
    atr14,
    atrPercent,
    volumeTrendPercent,
    futuresRisk,
    technicalRead: "",
  };

  return {
    ...signals,
    technicalRead: buildTechnicalRead(signals),
  };
}

function roundToPriceStep(value: number, step: number) {
  return Math.round(value / step) * step;
}

function getRoundPriceStep(price: number) {
  if (price >= 100000) {
    return 5000;
  }

  if (price >= 50000) {
    return 2500;
  }

  return 1000;
}

function getSwingLevels(prices: number[], direction: "high" | "low") {
  return prices
    .slice(2, -2)
    .map((price, index) => {
      const realIndex = index + 2;
      const window = prices.slice(realIndex - 2, realIndex + 3);
      const isSwing =
        direction === "high"
          ? price === Math.max(...window)
          : price === Math.min(...window);

      return isSwing ? price : null;
    })
    .filter((price): price is number => price !== null);
}

function getDedupedLevels(levels: number[], price: number) {
  const minGap = price * 0.008;
  const sortedLevels = [...levels].sort((first, second) => first - second);

  return sortedLevels.reduce<number[]>((dedupedLevels, level) => {
    const isNearExistingLevel = dedupedLevels.some(
      (existingLevel) => Math.abs(existingLevel - level) < minGap,
    );

    return isNearExistingLevel ? dedupedLevels : [...dedupedLevels, level];
  }, []);
}

function getFallbackLevels(
  price: number,
  direction: "pressure" | "support",
  count: number,
) {
  const step = getRoundPriceStep(price);

  return Array.from({ length: count }, (_, index) => {
    const multiplier = index + 1;

    return direction === "pressure"
      ? roundToPriceStep(price + step * multiplier, step)
      : roundToPriceStep(price - step * multiplier, step);
  });
}

function buildZone(
  label: string,
  level: number,
  price: number,
  atr14: number,
  explanation: string,
  direction: "pressure" | "support",
): SupportResistanceZone {
  const halfWidth = Math.max(price * 0.003, atr14 * 0.25);
  const range: [number, number] = [level - halfWidth, level + halfWidth];
  const distance =
    direction === "pressure" ? range[0] - price : price - range[1];

  return {
    label,
    range,
    distancePercent: Math.max(0, (distance / price) * 100),
    explanation,
  };
}

function buildSupportResistanceSignals(
  chartData: BitcoinMarketChartSnapshot["data"],
  signals: TechnicalSignals,
): SupportResistanceSignals {
  const price = signals.price;
  const prices = chartData.prices.map((point) => point[1]).slice(-90);
  const roundStep = getRoundPriceStep(price);
  const roundBase = roundToPriceStep(price, roundStep);
  const swingHighs = getSwingLevels(prices, "high").filter(
    (level) => level > price,
  );
  const swingLows = getSwingLevels(prices, "low").filter(
    (level) => level < price,
  );
  const movingLevels = [signals.ema9, signals.ma20, signals.ma50];
  const pressureCandidates = getDedupedLevels(
    [
      ...swingHighs,
      signals.bollingerBands.upper,
      ...movingLevels.filter((level) => level > price),
      roundBase + roundStep,
      roundBase + roundStep * 2,
      roundBase + roundStep * 3,
    ].filter((level) => level > price),
    price,
  )
    .sort((first, second) => first - second)
    .slice(0, 3);
  const supportCandidates = getDedupedLevels(
    [
      ...swingLows,
      signals.bollingerBands.lower,
      ...movingLevels.filter((level) => level < price),
      roundBase - roundStep,
      roundBase - roundStep * 2,
      roundBase - roundStep * 3,
    ].filter((level) => level < price),
    price,
  )
    .sort((first, second) => second - first)
    .slice(0, 3);
  const pressureLevels = [
    ...pressureCandidates,
    ...getFallbackLevels(price, "pressure", 3),
  ].slice(0, 3);
  const supportLevels = [
    ...supportCandidates,
    ...getFallbackLevels(price, "support", 3),
  ].slice(0, 3);
  const pressureZones = [
    buildZone(
      "近压力区",
      pressureLevels[0],
      price,
      signals.atr14,
      "靠近当前价格的上方卖压区，短线多单需要观察突破是否放量。",
      "pressure",
    ),
    buildZone(
      "中压力区",
      pressureLevels[1],
      price,
      signals.atr14,
      "由近期摆动高点、均线或整数位形成，适合观察反弹是否受阻。",
      "pressure",
    ),
    buildZone(
      "远压力区",
      pressureLevels[2],
      price,
      signals.atr14,
      "距离较远的上方目标区，突破前不宜过早按强趋势外推。",
      "pressure",
    ),
  ];
  const supportZones = [
    buildZone(
      "近支撑区",
      supportLevels[0],
      price,
      signals.atr14,
      "靠近当前价格的下方承接区，短线回踩时优先观察是否止跌。",
      "support",
    ),
    buildZone(
      "中支撑区",
      supportLevels[1],
      price,
      signals.atr14,
      "由近期摆动低点、均线或整数位形成，跌破后空头动能可能增强。",
      "support",
    ),
    buildZone(
      "远支撑区",
      supportLevels[2],
      price,
      signals.atr14,
      "距离较远的防守区，通常用于极端波动下的合约风险参考。",
      "support",
    ),
  ];
  const nearestPressure = pressureZones[0].distancePercent;
  const nearestSupport = supportZones[0].distancePercent;
  let oneLineRead: string;

  if (nearestPressure < 1 && nearestSupport > 2) {
    oneLineRead = "一句话判断：价格更接近上方压力，短线追多需要等待放量突破。";
  } else if (nearestSupport < 1 && nearestPressure > 2) {
    oneLineRead = "一句话判断：价格更接近下方支撑，短线空单需要防止快速反抽。";
  } else if (signals.price > signals.ma20 && signals.macd.histogram > 0) {
    oneLineRead = "一句话判断：结构偏多，但仍要关注近压力区的突破质量。";
  } else if (signals.price < signals.ma20 && signals.macd.histogram < 0) {
    oneLineRead = "一句话判断：结构偏弱，反弹到压力区更容易遇到抛压。";
  } else {
    oneLineRead = "一句话判断：当前处于区间博弈，支撑和压力都需要等待确认。";
  }

  return {
    pressureZones,
    supportZones,
    oneLineRead,
  };
}

function movingAverageSeries(values: number[], period: number) {
  return values.map((_, index) => {
    if (index < period - 1) {
      return null;
    }

    return simpleMovingAverage(values.slice(index - period + 1, index + 1), period);
  });
}

function exponentialMovingAverageSeries(values: number[], period: number) {
  const series: Array<number | null> = Array(period - 1).fill(null);
  let ema = simpleMovingAverage(values.slice(0, period), period);
  const multiplier = 2 / (period + 1);

  series.push(ema);

  for (const value of values.slice(period)) {
    ema = (value - ema) * multiplier + ema;
    series.push(ema);
  }

  return series;
}

function getChartX(index: number, total: number, width: number, padding: number) {
  if (total <= 1) {
    return padding;
  }

  return padding + (index / (total - 1)) * (width - padding * 2);
}

function getChartY(value: number, min: number, max: number, height: number, padding: number) {
  if (max === min) {
    return height / 2;
  }

  return height - padding - ((value - min) / (max - min)) * (height - padding * 2);
}

function chartSeriesToPoints(
  values: Array<number | null>,
  min: number,
  max: number,
  width: number,
  height: number,
  padding: number,
) {
  return values
    .map((value, index) => {
      if (value === null) {
        return null;
      }

      return `${getChartX(index, values.length, width, padding).toFixed(2)},${getChartY(
        value,
        min,
        max,
        height,
        padding,
      ).toFixed(2)}`;
    })
    .filter((point): point is string => point !== null)
    .join(" ");
}

function MetricCard({ label, value, tone }: MarketMetric) {
  const toneClass =
    tone === "positive"
      ? "text-emerald-300"
      : tone === "negative"
        ? "text-rose-300"
        : "text-zinc-50";

  return (
    <div className="rounded-lg border border-white/10 bg-white/[0.04] p-4 shadow-[0_1px_0_rgba(255,255,255,0.04)_inset]">
      <p className="text-sm text-zinc-400">{label}</p>
      <p className={`mt-3 text-2xl font-semibold tracking-tight ${toneClass}`}>
        {value}
      </p>
    </div>
  );
}

function MarketSkeleton() {
  return (
    <section className="w-full max-w-5xl rounded-lg border border-white/10 bg-zinc-950 p-6 shadow-2xl shadow-black/30 sm:p-8">
      <div className="flex flex-col gap-6">
        <div className="space-y-3">
          <div className="h-4 w-28 animate-pulse rounded bg-white/10" />
          <div className="h-10 w-64 animate-pulse rounded bg-white/10" />
          <div className="h-4 w-48 animate-pulse rounded bg-white/10" />
        </div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {[0, 1, 2, 3].map((item) => (
            <div
              className="h-28 animate-pulse rounded-lg border border-white/10 bg-white/[0.04]"
              key={item}
            />
          ))}
        </div>
      </div>
    </section>
  );
}

function MarketError({ message }: { message?: string }) {
  return (
    <section className="w-full max-w-5xl rounded-lg border border-rose-400/25 bg-rose-950/30 p-6 text-rose-100 shadow-2xl shadow-black/30 sm:p-8">
      <p className="text-sm font-medium uppercase tracking-[0.2em] text-rose-300">
        Market data unavailable
      </p>
      <h1 className="mt-4 text-3xl font-semibold tracking-tight sm:text-4xl">
        BTC market snapshot could not load.
      </h1>
      <p className="mt-3 max-w-2xl text-sm leading-6 text-rose-100/75">
        Binance Spot may be temporarily unavailable or rate limited. Refresh the
        page to request the latest BTC market data again.
      </p>
      {message ? (
        <p className="mt-4 rounded-lg border border-rose-300/20 bg-rose-300/10 p-3 text-sm text-rose-100">
          {message}
        </p>
      ) : null}
    </section>
  );
}

function getStatusClass(status: SignalStatus) {
  if (status === "Bullish" || status === "Low" || status === "Oversold") {
    return "border-emerald-300/20 bg-emerald-300/10 text-emerald-200";
  }

  if (status === "Bearish" || status === "High" || status === "Overbought") {
    return "border-rose-300/20 bg-rose-300/10 text-rose-200";
  }

  if (status === "Medium") {
    return "border-amber-300/20 bg-amber-300/10 text-amber-200";
  }

  return "border-zinc-300/15 bg-zinc-300/10 text-zinc-200";
}

function StatusPill({ status }: { status: SignalStatus }) {
  return (
    <span
      className={`rounded-lg border px-3 py-1 text-xs font-medium ${getStatusClass(
        status,
      )}`}
    >
      {status}
    </span>
  );
}

function IndicatorCard({
  label,
  value,
  status,
  tooltip,
  detail,
}: IndicatorMetric) {
  return (
    <div className="rounded-lg border border-white/10 bg-white/[0.04] p-4 shadow-[0_1px_0_rgba(255,255,255,0.04)_inset]">
      <div className="flex items-start justify-between gap-3">
        <p className="flex items-center text-sm text-zinc-400">
          {label}
          <span
            className="ml-2 inline-flex h-5 w-5 items-center justify-center rounded-full border border-cyan-300/30 bg-cyan-300/10 text-xs font-semibold text-cyan-200"
            title={tooltip}
          >
            ?
          </span>
        </p>
        <StatusPill status={status} />
      </div>
      <p className="mt-4 text-2xl font-semibold tracking-tight text-zinc-50">
        {value}
      </p>
      {detail ? <p className="mt-2 text-xs text-zinc-500">{detail}</p> : null}
    </div>
  );
}

function TechnicalSkeleton() {
  return (
    <section className="w-full max-w-5xl rounded-lg border border-white/10 bg-zinc-950 p-6 shadow-2xl shadow-black/30 sm:p-8">
      <div className="space-y-6">
        <div className="space-y-3">
          <div className="h-4 w-44 animate-pulse rounded bg-white/10" />
          <div className="h-8 w-80 max-w-full animate-pulse rounded bg-white/10" />
        </div>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {[0, 1, 2, 3, 4, 5, 6, 7].map((item) => (
            <div
              className="h-36 animate-pulse rounded-lg border border-white/10 bg-white/[0.04]"
              key={item}
            />
          ))}
        </div>
        <div className="h-24 animate-pulse rounded-lg border border-white/10 bg-white/[0.04]" />
      </div>
    </section>
  );
}

function TechnicalError({ message }: { message?: string }) {
  return (
    <section className="w-full max-w-5xl rounded-lg border border-rose-400/25 bg-rose-950/30 p-6 text-rose-100 shadow-2xl shadow-black/30 sm:p-8">
      <p className="text-sm font-medium uppercase tracking-[0.2em] text-rose-300">
        Technical data unavailable
      </p>
      <h2 className="mt-4 text-3xl font-semibold tracking-tight sm:text-4xl">
        BTC futures signals could not load.
      </h2>
      <p className="mt-3 max-w-2xl text-sm leading-6 text-rose-100/75">
        Binance Spot kline data may be temporarily unavailable or rate limited.
        Refresh the page after a moment to rebuild the technical panel.
      </p>
      {message ? (
        <p className="mt-4 rounded-lg border border-rose-300/20 bg-rose-300/10 p-3 text-sm text-rose-100">
          {message}
        </p>
      ) : null}
    </section>
  );
}

function TrendChartSkeleton() {
  return (
    <section className="w-full max-w-5xl rounded-lg border border-white/10 bg-zinc-950 p-6 shadow-2xl shadow-black/30 sm:p-8">
      <div className="space-y-6">
        <div className="space-y-3">
          <div className="h-4 w-32 animate-pulse rounded bg-white/10" />
          <div className="h-9 w-64 animate-pulse rounded bg-white/10" />
          <div className="h-4 w-80 max-w-full animate-pulse rounded bg-white/10" />
        </div>
        <div className="h-80 animate-pulse rounded-lg border border-white/10 bg-white/[0.04]" />
      </div>
    </section>
  );
}

function TrendChartError({ message }: { message?: string }) {
  return (
    <section className="w-full max-w-5xl rounded-lg border border-rose-400/25 bg-rose-950/30 p-6 text-rose-100 shadow-2xl shadow-black/30 sm:p-8">
      <p className="text-sm font-medium uppercase tracking-[0.2em] text-rose-300">
        Trend chart unavailable
      </p>
      <h2 className="mt-4 text-3xl font-semibold tracking-tight sm:text-4xl">
        BTC trend chart could not load.
      </h2>
      <p className="mt-3 max-w-2xl text-sm leading-6 text-rose-100/75">
        Binance Spot kline data may be temporarily unavailable or rate limited.
        Refresh the page after a moment to rebuild the chart.
      </p>
      {message ? (
        <p className="mt-4 rounded-lg border border-rose-300/20 bg-rose-300/10 p-3 text-sm text-rose-100">
          {message}
        </p>
      ) : null}
    </section>
  );
}

function TrendLegend({ series }: { series: ChartSeries[] }) {
  return (
    <div className="flex flex-wrap gap-3 text-xs text-zinc-400">
      {series.map((item) => (
        <div className="flex items-center gap-2" key={item.label}>
          <span
            className="h-2 w-5 rounded-full"
            style={{ backgroundColor: item.color }}
          />
          {item.label}
        </div>
      ))}
      <div className="flex items-center gap-2">
        <span className="h-2 w-5 rounded-full bg-rose-300" />
        Resistance
      </div>
      <div className="flex items-center gap-2">
        <span className="h-2 w-5 rounded-full bg-emerald-300" />
        Support
      </div>
    </div>
  );
}

function BitcoinTrendChartModule({
  chartSnapshot,
  signals,
  supportResistanceSignals,
}: {
  chartSnapshot: BitcoinMarketChartSnapshot;
  signals: TechnicalSignals;
  supportResistanceSignals: SupportResistanceSignals;
}) {
  const prices = chartSnapshot.data.prices.map((point) => point[1]).slice(-90);
  const pricePoints = chartSnapshot.data.prices.slice(-90);
  const width = 920;
  const height = 400;
  const padding = 42;
  const rightPadding = 76;
  const bottomPadding = 58;
  const resistanceZones = supportResistanceSignals.pressureZones.map(
    (zone, index) => ({
      zone,
      className: ["resistance-near", "resistance-mid", "resistance-far"][index],
      label: ["近压力", "中压力", "远压力"][index],
    }),
  );
  const supportZones = supportResistanceSignals.supportZones.map(
    (zone, index) => ({
      zone,
      className: ["support-near", "support-mid", "support-far"][index],
      label: ["近支撑", "中支撑", "远支撑"][index],
    }),
  );
  const nearestResistance = resistanceZones[0].zone;
  const nearestSupport = supportZones[0].zone;
  const series: ChartSeries[] = [
    {
      label: "BTC Price",
      color: "#facc15",
      values: prices,
    },
    {
      label: "EMA9",
      color: "#22d3ee",
      values: exponentialMovingAverageSeries(prices, 9),
    },
    {
      label: "MA20",
      color: "#a78bfa",
      values: movingAverageSeries(prices, 20),
    },
    {
      label: "MA50",
      color: "#fb7185",
      values: movingAverageSeries(prices, 50),
    },
  ];
  const chartValues = [
    ...series.flatMap((item) =>
      item.values.filter((value): value is number => value !== null),
    ),
    nearestResistance.range[0],
    nearestResistance.range[1],
    nearestSupport.range[0],
    nearestSupport.range[1],
    ...resistanceZones.flatMap((item) => item.zone.range),
    ...supportZones.flatMap((item) => item.zone.range),
    signals.price,
  ];
  const rawMin = Math.min(...chartValues);
  const rawMax = Math.max(...chartValues);
  const valuePadding = Math.max((rawMax - rawMin) * 0.08, signals.price * 0.01);
  const min = rawMin - valuePadding;
  const max = rawMax + valuePadding;
  const plotWidth = width - padding - rightPadding;
  const plotHeight = height - padding - bottomPadding;
  const getTrendX = (index: number) =>
    prices.length <= 1 ? padding : padding + (index / (prices.length - 1)) * plotWidth;
  const getTrendY = (value: number) =>
    max === min ? padding + plotHeight / 2 : padding + ((max - value) / (max - min)) * plotHeight;
  const trendSeriesToPoints = (values: Array<number | null>) =>
    values
      .map((value, index) => {
        if (value === null) {
          return null;
        }

        return `${getTrendX(index).toFixed(2)},${getTrendY(value).toFixed(2)}`;
      })
      .filter((point): point is string => point !== null)
      .join(" ");
  const currentX = getTrendX(prices.length - 1);
  const currentY = getTrendY(signals.price);
  const dateFormatter = new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "2-digit",
    timeZone: "Asia/Singapore",
  });
  const xAxisTicks = [0, 1, 2, 3, 4].map((tick) => {
    const index = Math.round((tick / 4) * (pricePoints.length - 1));
    const timestamp = pricePoints[index]?.[0];

    return {
      index,
      label: tick === 4 || index === pricePoints.length - 1
        ? "Today"
        : dateFormatter.format(new Date(timestamp)),
      x: getTrendX(index),
    };
  });
  const yAxisTicks = [0, 1, 2, 3, 4].map((tick) => {
    const value = max - (tick / 4) * (max - min);

    return {
      label: `$${Math.round(value / 1000)}K`,
      value,
      y: getTrendY(value),
    };
  });

  return (
    <section className="w-full max-w-5xl rounded-lg border border-white/10 bg-zinc-950 p-6 shadow-2xl shadow-black/30 sm:p-8">
      <div className="flex flex-col gap-6">
        <div className="flex flex-col justify-between gap-5 lg:flex-row lg:items-end">
          <div>
            <p className="text-sm font-medium uppercase tracking-[0.2em] text-cyan-300">
              BTC Trend Chart
            </p>
            <h2 className="mt-4 text-3xl font-semibold tracking-tight text-zinc-50 sm:text-5xl">
              90-Day Price Structure
            </h2>
            <p className="mt-3 text-sm text-zinc-400">
              Price, EMA9, MA20, MA50, and nearest deterministic S/R zones.
            </p>
            <p className="mt-2 text-sm text-zinc-500">
              Data source: Binance Spot BTCUSDT
            </p>
            <p className="mt-3 text-xs font-medium tracking-[0.16em] text-zinc-500">
              {formatUpdatedMeta(chartSnapshot.updatedAt)}
            </p>
          </div>
          <div className="rounded-lg border border-amber-300/20 bg-amber-300/10 px-4 py-3 text-sm font-medium text-amber-200">
            Current: {formatCurrency(signals.price, { maximumFractionDigits: 2 })}
          </div>
        </div>
        <div className="trend-chart rounded-lg border border-white/10 bg-black/30 p-4">
          <style>
            {`
              .trend-chart-input {
                position: absolute;
                opacity: 0;
                pointer-events: none;
              }

              .trend-chart-control {
                border: 1px solid rgba(255, 255, 255, 0.1);
                background: rgba(255, 255, 255, 0.04);
                color: rgb(161, 161, 170);
                cursor: pointer;
              }

              .trend-chart-toggle {
                border: 1px solid rgba(255, 255, 255, 0.1);
                background: rgba(255, 255, 255, 0.04);
                color: rgb(161, 161, 170);
                cursor: pointer;
              }

              #trend-support-near:checked ~ .trend-controls label[for="trend-support-near"],
              #trend-support-mid:checked ~ .trend-controls label[for="trend-support-mid"],
              #trend-support-far:checked ~ .trend-controls label[for="trend-support-far"] {
                border-color: rgba(52, 211, 153, 0.35);
                background: rgba(52, 211, 153, 0.12);
                color: rgb(167, 243, 208);
              }

              #trend-resistance-near:checked ~ .trend-controls label[for="trend-resistance-near"],
              #trend-resistance-mid:checked ~ .trend-controls label[for="trend-resistance-mid"],
              #trend-resistance-far:checked ~ .trend-controls label[for="trend-resistance-far"] {
                border-color: rgba(251, 113, 133, 0.35);
                background: rgba(251, 113, 133, 0.12);
                color: rgb(254, 205, 211);
              }

              #trend-show-support:checked ~ .trend-controls label[for="trend-show-support"] {
                border-color: rgba(52, 211, 153, 0.35);
                background: rgba(52, 211, 153, 0.12);
                color: rgb(167, 243, 208);
              }

              #trend-show-resistance:checked ~ .trend-controls label[for="trend-show-resistance"] {
                border-color: rgba(251, 113, 133, 0.35);
                background: rgba(251, 113, 133, 0.12);
                color: rgb(254, 205, 211);
              }

              .trend-chart-frame .support-zone,
              .trend-chart-frame .resistance-zone {
                display: none;
              }

              #trend-show-support:checked ~ #trend-support-near:checked ~ .trend-chart-frame .support-near,
              #trend-show-support:checked ~ #trend-support-mid:checked ~ .trend-chart-frame .support-mid,
              #trend-show-support:checked ~ #trend-support-far:checked ~ .trend-chart-frame .support-far,
              #trend-show-resistance:checked ~ #trend-resistance-near:checked ~ .trend-chart-frame .resistance-near,
              #trend-show-resistance:checked ~ #trend-resistance-mid:checked ~ .trend-chart-frame .resistance-mid,
              #trend-show-resistance:checked ~ #trend-resistance-far:checked ~ .trend-chart-frame .resistance-far {
                display: block;
              }
            `}
          </style>
          <input
            className="trend-chart-input"
            defaultChecked
            id="trend-show-support"
            type="checkbox"
          />
          <input
            className="trend-chart-input"
            defaultChecked
            id="trend-support-near"
            name="trend-support-level"
            type="radio"
          />
          <input
            className="trend-chart-input"
            id="trend-support-mid"
            name="trend-support-level"
            type="radio"
          />
          <input
            className="trend-chart-input"
            id="trend-support-far"
            name="trend-support-level"
            type="radio"
          />
          <input
            className="trend-chart-input"
            defaultChecked
            id="trend-show-resistance"
            type="checkbox"
          />
          <input
            className="trend-chart-input"
            defaultChecked
            id="trend-resistance-near"
            name="trend-resistance-level"
            type="radio"
          />
          <input
            className="trend-chart-input"
            id="trend-resistance-mid"
            name="trend-resistance-level"
            type="radio"
          />
          <input
            className="trend-chart-input"
            id="trend-resistance-far"
            name="trend-resistance-level"
            type="radio"
          />
          <div className="trend-controls mb-4 grid gap-4 lg:grid-cols-2">
            <div className="rounded-lg border border-white/10 bg-white/[0.03] p-3">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <p className="text-xs font-medium uppercase tracking-[0.18em] text-emerald-200">
                  Support level
                </p>
                <label
                  className="trend-chart-toggle rounded-lg px-3 py-1 text-xs font-medium"
                  htmlFor="trend-show-support"
                >
                  Show Support
                </label>
              </div>
              <div className="flex flex-wrap gap-2">
                {[
                  ["trend-support-near", "Near Support", "近支撑"],
                  ["trend-support-mid", "Mid Support", "中支撑"],
                  ["trend-support-far", "Far Support", "远支撑"],
                ].map(([id, englishLabel, chineseLabel]) => (
                  <label
                    className="trend-chart-control rounded-lg px-3 py-2 text-xs font-medium"
                    htmlFor={id}
                    key={id}
                  >
                    {englishLabel}
                    <span className="ml-2 text-[11px]">{chineseLabel}</span>
                  </label>
                ))}
              </div>
            </div>
            <div className="rounded-lg border border-white/10 bg-white/[0.03] p-3">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <p className="text-xs font-medium uppercase tracking-[0.18em] text-rose-200">
                  Resistance level
                </p>
                <label
                  className="trend-chart-toggle rounded-lg px-3 py-1 text-xs font-medium"
                  htmlFor="trend-show-resistance"
                >
                  Show Resistance
                </label>
              </div>
              <div className="flex flex-wrap gap-2">
                {[
                  ["trend-resistance-near", "Near Resistance", "近压力"],
                  ["trend-resistance-mid", "Mid Resistance", "中压力"],
                  ["trend-resistance-far", "Far Resistance", "远压力"],
                ].map(([id, englishLabel, chineseLabel]) => (
                  <label
                    className="trend-chart-control rounded-lg px-3 py-2 text-xs font-medium"
                    htmlFor={id}
                    key={id}
                  >
                    {englishLabel}
                    <span className="ml-2 text-[11px]">{chineseLabel}</span>
                  </label>
                ))}
              </div>
            </div>
          </div>
          <TrendLegend series={series} />
          <svg
            aria-label="90-day BTC trend chart"
            className="trend-chart-frame mt-4 h-auto w-full overflow-visible"
            role="img"
            viewBox={`0 0 ${width} ${height}`}
          >
            {xAxisTicks.map((tick) => (
              <g key={tick.index}>
                <line
                  stroke="rgba(255,255,255,0.05)"
                  strokeWidth="1"
                  x1={tick.x}
                  x2={tick.x}
                  y1={padding}
                  y2={height - bottomPadding}
                />
                <text
                  fill="rgba(212,212,216,0.68)"
                  fontSize="12"
                  textAnchor={tick.index === 0 ? "start" : "middle"}
                  x={tick.x}
                  y={height - 22}
                >
                  {tick.label}
                </text>
              </g>
            ))}
            {yAxisTicks.map((tick, index) => (
              <g key={index}>
                <line
                  stroke="rgba(255,255,255,0.07)"
                  strokeWidth="1"
                  x1={padding}
                  x2={width - rightPadding}
                  y1={tick.y}
                  y2={tick.y}
                />
                <text
                  fill="rgba(212,212,216,0.72)"
                  fontSize="12"
                  x={width - rightPadding + 12}
                  y={tick.y + 4}
                >
                  {tick.label}
                </text>
              </g>
            ))}
            <line
              stroke="rgba(255,255,255,0.18)"
              strokeWidth="1"
              x1={padding}
              x2={width - rightPadding}
              y1={height - bottomPadding}
              y2={height - bottomPadding}
            />
            <line
              stroke="rgba(255,255,255,0.18)"
              strokeWidth="1"
              x1={width - rightPadding}
              x2={width - rightPadding}
              y1={padding}
              y2={height - bottomPadding}
            />
            {resistanceZones.map(({ zone, className, label }) => {
              const zoneTop = getTrendY(zone.range[1]);
              const zoneBottom = getTrendY(zone.range[0]);
              const zoneY = getTrendY(average(zone.range));

              return (
                <g
                  className={`resistance-zone ${className}`}
                  key={zone.label}
                >
                  <rect
                    fill="rgba(251,113,133,0.08)"
                    height={Math.max(3, Math.abs(zoneBottom - zoneTop))}
                    rx="4"
                    width={plotWidth}
                    x={padding}
                    y={Math.min(zoneTop, zoneBottom)}
                  />
                  <line
                    stroke="rgba(251,113,133,0.75)"
                    strokeDasharray="6 6"
                    strokeWidth="1.2"
                    x1={padding}
                    x2={width - rightPadding}
                    y1={zoneY}
                    y2={zoneY}
                  />
                  <text
                    fill="#fda4af"
                    fontSize="12"
                    x={padding + 8}
                    y={zoneY - 8}
                  >
                    {label} {formatCurrency(average(zone.range))}
                  </text>
                </g>
              );
            })}
            {supportZones.map(({ zone, className, label }) => {
              const zoneTop = getTrendY(zone.range[1]);
              const zoneBottom = getTrendY(zone.range[0]);
              const zoneY = getTrendY(average(zone.range));

              return (
                <g className={`support-zone ${className}`} key={zone.label}>
                  <rect
                    fill="rgba(52,211,153,0.08)"
                    height={Math.max(3, Math.abs(zoneBottom - zoneTop))}
                    rx="4"
                    width={plotWidth}
                    x={padding}
                    y={Math.min(zoneTop, zoneBottom)}
                  />
                  <line
                    stroke="rgba(52,211,153,0.75)"
                    strokeDasharray="6 6"
                    strokeWidth="1.2"
                    x1={padding}
                    x2={width - rightPadding}
                    y1={zoneY}
                    y2={zoneY}
                  />
                  <text
                    fill="#86efac"
                    fontSize="12"
                    x={padding + 8}
                    y={zoneY - 8}
                  >
                    {label} {formatCurrency(average(zone.range))}
                  </text>
                </g>
              );
            })}
            {series.map((item) => (
              <polyline
                fill="none"
                key={item.label}
                opacity={item.label === "BTC Price" ? 1 : 0.58}
                points={trendSeriesToPoints(item.values)}
                stroke={item.color}
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={item.label === "BTC Price" ? 2.2 : 1.1}
              />
            ))}
            <line
              stroke="rgba(250,204,21,0.55)"
              strokeDasharray="4 5"
              strokeWidth="1.2"
              x1={padding}
              x2={width - rightPadding}
              y1={currentY}
              y2={currentY}
            />
            <circle cx={currentX} cy={currentY} fill="#facc15" r="4" />
            <circle
              cx={currentX}
              cy={currentY}
              fill="transparent"
              r="8"
              stroke="rgba(250,204,21,0.35)"
              strokeWidth="1.5"
            />
            <text
              fill="#fde68a"
              fontSize="12"
              textAnchor="end"
              x={width - padding}
              y={currentY - 10}
            >
              Current {formatCurrency(signals.price)}
            </text>
          </svg>
        </div>
      </div>
    </section>
  );
}

function ZoneCard({ zone }: { zone: SupportResistanceZone }) {
  return (
    <div className="rounded-lg border border-white/10 bg-white/[0.04] p-4 shadow-[0_1px_0_rgba(255,255,255,0.04)_inset]">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="text-sm font-medium text-zinc-200">{zone.label}</p>
          <p className="mt-2 text-xl font-semibold tracking-tight text-zinc-50">
            {formatCurrency(zone.range[0])} - {formatCurrency(zone.range[1])}
          </p>
        </div>
        <span className="rounded-lg border border-cyan-300/20 bg-cyan-300/10 px-3 py-1 text-xs font-medium text-cyan-200">
          距离 {formatDistancePercent(zone.distancePercent)}
        </span>
      </div>
      <p className="mt-3 text-sm leading-6 text-zinc-400">
        {zone.explanation}
      </p>
    </div>
  );
}

function SupportResistanceSection({
  signals,
  updatedAt,
}: {
  signals: SupportResistanceSignals;
  updatedAt: Date;
}) {
  return (
    <div className="rounded-lg border border-white/10 bg-white/[0.03] p-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-sm font-medium uppercase tracking-[0.2em] text-amber-200">
            Support & Resistance
          </p>
          <h3 className="mt-3 text-2xl font-semibold tracking-tight text-zinc-50">
            合约支撑与压力区
          </h3>
        </div>
        <p className="max-w-md text-sm leading-6 text-zinc-400">
          基于 90 日价格、摆动高低点、布林带、均线和整数关口生成。
        </p>
      </div>
      <p className="mt-3 text-xs font-medium tracking-[0.16em] text-zinc-500">
        {formatUpdatedMeta(updatedAt)}
      </p>
      <div className="mt-6 grid gap-4 lg:grid-cols-2">
        <div>
          <p className="mb-3 text-sm font-semibold text-rose-200">
            上方压力区:
          </p>
          <div className="space-y-3">
            {signals.pressureZones.map((zone) => (
              <ZoneCard key={zone.label} zone={zone} />
            ))}
          </div>
        </div>
        <div>
          <p className="mb-3 text-sm font-semibold text-emerald-200">
            下方支撑区:
          </p>
          <div className="space-y-3">
            {signals.supportZones.map((zone) => (
              <ZoneCard key={zone.label} zone={zone} />
            ))}
          </div>
        </div>
      </div>
      <div className="mt-5 rounded-lg border border-cyan-300/15 bg-cyan-300/[0.06] p-4">
        <p className="text-sm leading-6 text-zinc-100">{signals.oneLineRead}</p>
      </div>
      <div className="mt-5 flex flex-col gap-3 sm:flex-row sm:items-center">
        <button
          className="rounded-lg border border-white/10 bg-white/[0.04] px-4 py-3 text-sm font-medium text-zinc-500"
          disabled
          type="button"
        >
          Generate AI Summary
        </button>
        <p className="text-sm text-zinc-500">
          AI summary is manual only to reduce token usage.
        </p>
      </div>
    </div>
  );
}

function BitcoinTechnicalModule({
  chartUpdatedAt,
  signals,
  supportResistanceSignals,
}: {
  chartUpdatedAt: Date;
  signals: TechnicalSignals;
  supportResistanceSignals: SupportResistanceSignals;
}) {
  const indicatorMetrics: IndicatorMetric[] = [
    {
      label: "EMA9",
      value: formatCurrency(signals.ema9, { maximumFractionDigits: 2 }),
      status: getTrendStatus(signals.price, signals.ema9),
      tooltip: INDICATOR_TOOLTIPS.ema9,
    },
    {
      label: "MA20",
      value: formatCurrency(signals.ma20, { maximumFractionDigits: 2 }),
      status: getTrendStatus(signals.price, signals.ma20),
      tooltip: INDICATOR_TOOLTIPS.ma20,
    },
    {
      label: "MA50",
      value: formatCurrency(signals.ma50, { maximumFractionDigits: 2 }),
      status: getTrendStatus(signals.price, signals.ma50),
      tooltip: INDICATOR_TOOLTIPS.ma50,
    },
    {
      label: "RSI14",
      value: formatNumber(signals.rsi14),
      status: getRsiStatus(signals.rsi14),
      tooltip: INDICATOR_TOOLTIPS.rsi14,
    },
    {
      label: "MACD",
      value: formatNumber(signals.macd.histogram),
      status: getMacdStatus(signals.macd),
      tooltip: INDICATOR_TOOLTIPS.macd,
      detail: `Line ${formatNumber(signals.macd.line)} / Signal ${formatNumber(
        signals.macd.signal,
      )}`,
    },
    {
      label: "Bollinger Bands",
      value: `${formatCompactCurrency(
        signals.bollingerBands.lower,
      )} - ${formatCompactCurrency(
        signals.bollingerBands.upper,
      )}`,
      status: getBollingerStatus(signals.price, signals.bollingerBands),
      tooltip: INDICATOR_TOOLTIPS.bollingerBands,
      detail: `Mid ${formatCurrency(signals.bollingerBands.middle)}`,
    },
    {
      label: "ATR14",
      value: formatCurrency(signals.atr14, { maximumFractionDigits: 2 }),
      status: getVolatilityStatus(signals.atrPercent),
      tooltip: INDICATOR_TOOLTIPS.atr14,
      detail: `Volatility: ${getVolatilityStatus(signals.atrPercent)} (${formatPercent(
        signals.atrPercent,
      )})`,
    },
    {
      label: "Volume Trend",
      value: formatPercent(signals.volumeTrendPercent),
      status: getVolumeStatus(signals.volumeTrendPercent),
      tooltip: INDICATOR_TOOLTIPS.volumeTrend,
      detail: "7D average volume vs prior 7D",
    },
  ];

  return (
    <section className="w-full max-w-5xl rounded-lg border border-white/10 bg-zinc-950 p-6 shadow-2xl shadow-black/30 sm:p-8">
      <div className="flex flex-col gap-8">
        <div className="flex flex-col justify-between gap-5 lg:flex-row lg:items-end">
          <div>
            <p className="text-sm font-medium uppercase tracking-[0.2em] text-cyan-300">
              Futures Technical Signals
            </p>
            <h2 className="mt-4 text-3xl font-semibold tracking-tight text-zinc-50 sm:text-5xl">
              BTC Contract Bias
            </h2>
            <p className="mt-3 text-sm text-zinc-400">
              Daily Binance Spot kline data, refreshed every 5 minutes.
            </p>
            <p className="mt-2 text-sm text-zinc-500">
              Data source: Binance Spot BTCUSDT
            </p>
            <p className="mt-3 text-xs font-medium tracking-[0.16em] text-zinc-500">
              {formatUpdatedMeta(chartUpdatedAt)}
            </p>
          </div>
          <div
            className={`rounded-lg border px-4 py-3 text-sm font-medium ${getStatusClass(
              signals.futuresRisk,
            )}`}
          >
            Futures Risk: {signals.futuresRisk}
          </div>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {indicatorMetrics.map((metric) => (
            <IndicatorCard key={metric.label} {...metric} />
          ))}
        </div>
        <div className="rounded-lg border border-cyan-300/15 bg-cyan-300/[0.06] p-5">
          <p className="text-sm font-medium uppercase tracking-[0.2em] text-cyan-200">
            Technical Read
          </p>
          <p className="mt-3 text-base leading-7 text-zinc-100">
            {signals.technicalRead}
          </p>
        </div>
        <SupportResistanceSection
          signals={supportResistanceSignals}
          updatedAt={chartUpdatedAt}
        />
      </div>
    </section>
  );
}

function BitcoinMarketModule({ data }: { data: BitcoinMarketSnapshot }) {
  const changeTone = data.usd_24h_change >= 0 ? "positive" : "negative";
  const metrics: MarketMetric[] = [
    {
      label: "24h Change",
      value: formatPercent(data.usd_24h_change),
      tone: changeTone,
    },
    {
      label: "Market Cap",
      value:
        typeof data.usd_market_cap === "number"
          ? formatCompactCurrency(data.usd_market_cap)
          : "N/A",
    },
    {
      label: "24h Volume",
      value: formatCompactCurrency(data.usd_24h_vol),
    },
    {
      label: "Last Updated",
      value: formatUpdatedMeta(data.updatedAt),
    },
  ];

  return (
    <section className="w-full max-w-5xl rounded-lg border border-white/10 bg-zinc-950 p-6 shadow-2xl shadow-black/30 sm:p-8">
      <div className="flex flex-col gap-8">
        <div className="flex flex-col justify-between gap-5 lg:flex-row lg:items-end">
          <div>
            <p className="text-sm font-medium uppercase tracking-[0.2em] text-amber-300">
              Bitcoin Market
            </p>
            <h1 className="mt-4 text-4xl font-semibold tracking-tight text-zinc-50 sm:text-6xl">
              {formatCurrency(data.usd, { maximumFractionDigits: 2 })}
            </h1>
            <p className="mt-3 text-sm text-zinc-400">
              Live BTCUSDT spot price from Binance 24h ticker.
            </p>
            <p className="mt-2 text-sm text-zinc-500">
              Data source: Binance Spot BTCUSDT
            </p>
            <p className="mt-3 text-xs font-medium tracking-[0.16em] text-zinc-500">
              {formatUpdatedMeta(data.updatedAt)}
            </p>
          </div>
          <div
            className={`rounded-lg border px-4 py-3 text-sm font-medium ${
              changeTone === "positive"
                ? "border-emerald-300/20 bg-emerald-300/10 text-emerald-200"
                : "border-rose-300/20 bg-rose-300/10 text-rose-200"
            }`}
          >
            {formatPercent(data.usd_24h_change)} over 24h
          </div>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {metrics.map((metric) => (
            <MetricCard key={metric.label} {...metric} />
          ))}
        </div>
      </div>
    </section>
  );
}

export default function Home() {
  const [marketData, setMarketData] = useState<BitcoinMarketSnapshot | null>(
    null,
  );
  const [chartSnapshot, setChartSnapshot] =
    useState<BitcoinMarketChartSnapshot | null>(null);
  const [signals, setSignals] = useState<TechnicalSignals | null>(null);
  const [supportResistanceSignals, setSupportResistanceSignals] =
    useState<SupportResistanceSignals | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const refreshBinanceData = useCallback(async (signal?: AbortSignal) => {
    try {
      setErrorMessage(null);

      const [nextMarketData, nextChartSnapshot] = await Promise.all([
        getBitcoinMarketData(signal),
        getBitcoinMarketChartData(signal),
      ]);
      const nextSignals = calculateTechnicalSignals(nextChartSnapshot.data);
      const nextSupportResistanceSignals = buildSupportResistanceSignals(
        nextChartSnapshot.data,
        nextSignals,
      );

      setMarketData(nextMarketData);
      setChartSnapshot(nextChartSnapshot);
      setSignals(nextSignals);
      setSupportResistanceSignals(nextSupportResistanceSignals);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        return;
      }

      setMarketData(null);
      setChartSnapshot(null);
      setSignals(null);
      setSupportResistanceSignals(null);
      setErrorMessage(
        error instanceof Error ? error.message : "Binance data fetch failed.",
      );
    } finally {
      if (!signal?.aborted) {
        setIsLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();

    refreshBinanceData(controller.signal);
    const intervalId = window.setInterval(() => {
      refreshBinanceData();
    }, REFRESH_INTERVAL);

    return () => {
      controller.abort();
      window.clearInterval(intervalId);
    };
  }, [refreshBinanceData]);

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6 bg-black px-5 py-10 font-sans text-zinc-50 sm:px-8">
      {isLoading ? <MarketSkeleton /> : null}
      {!isLoading && errorMessage ? <MarketError message={errorMessage} /> : null}
      {!isLoading && marketData ? <BitcoinMarketModule data={marketData} /> : null}
      {isLoading ? <TrendChartSkeleton /> : null}
      {!isLoading && errorMessage ? (
        <TrendChartError message={errorMessage} />
      ) : null}
      {!isLoading &&
      chartSnapshot &&
      signals &&
      supportResistanceSignals ? (
        <BitcoinTrendChartModule
          chartSnapshot={chartSnapshot}
          signals={signals}
          supportResistanceSignals={supportResistanceSignals}
        />
      ) : null}
      {isLoading ? <TechnicalSkeleton /> : null}
      {!isLoading && errorMessage ? (
        <TechnicalError message={errorMessage} />
      ) : null}
      {!isLoading &&
      chartSnapshot &&
      signals &&
      supportResistanceSignals ? (
        <BitcoinTechnicalModule
          chartUpdatedAt={chartSnapshot.updatedAt}
          signals={signals}
          supportResistanceSignals={supportResistanceSignals}
        />
      ) : null}
    </main>
  );
}
