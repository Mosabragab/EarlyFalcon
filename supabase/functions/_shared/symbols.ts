// ============================================
// TRADING SYMBOLS - 40 TOTAL
// ============================================

export const ORIGINAL_SYMBOLS = [
  'XBTUSD', 'ETHUSD', 'SOLUSD', 'XRPUSD', 'DOGEUSD',
  'LTCUSD', 'SUIUSD', 'LINKUSD', 'BNBUSD', 'ADAUSD',
  'DASHUSD', 'AVAXUSD', 'XLMUSD', 'UNIUSD', 'DOTUSD',
  'MNTUSD', 'ALGOUSD', 'HBARUSD', 'POLUSD', 'TRXUSD'
];

export const NEW_SYMBOLS = [
  'SHIBUSD', 'TONUSD', 'CROUSD', 'ZECUSD', 'AAVEUSD',
  'NEARUSD', 'ETCUSD', 'APTUSD', 'PEPEUSD', 'FILUSD',
  'ICPUSD', 'ARBUSD', 'VETUSD', 'GRTUSD', 'ATOMUSD',
  'INJUSD', 'RENDERUSD', 'SEIUSD', 'OPUSD', 'IMXUSD'
];

export const ALL_SYMBOLS = [...ORIGINAL_SYMBOLS, ...NEW_SYMBOLS];

export const SLIPPAGE_ENTRY = 0.0002; // 0.02% entry slippage
export const SLIPPAGE_EXIT = 0.0002;  // 0.02% exit slippage
export const KRAKEN_COMMISSION = 0.0026; // 0.26% maker/taker fee
