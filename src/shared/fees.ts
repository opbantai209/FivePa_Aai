// Single source of truth for WorkPerHour order fee math.
// Pure functions only (no server or React imports) so the ledger, the API and any UI can share it.
// All arithmetic is done in integer cents using basis points, so there is no floating-point drift.

export interface FeeConfig {
  /** Platform commission taken from the gig price (freelancer keeps 100 - this). Default 20. */
  commissionPercent: number;
  /** Client service fee charged when gig price is under smallOrderThreshold. Default 1.0 (1%). */
  buyerFeePercent: number;
  /** Flat fee added when the gig price is under the threshold. Default 1.00 ($1). */
  smallOrderFee: number;
  /** Orders with a gig price strictly below this get the buyer service fee (1% + $1). Orders at/above threshold pay $0. Default 200. */
  smallOrderThreshold: number;
}

export const DEFAULT_FEE_CONFIG: FeeConfig = {
  commissionPercent: 20,
  buyerFeePercent: 1.0,
  smallOrderFee: 1.0,
  smallOrderThreshold: 200
};

export interface OrderFeeBreakdown {
  gigPrice: number;          // what the freelancer's gig/extras cost (escrowed amount)
  serviceFee: number;        // client service fee (buyerFeePercent of gigPrice)
  smallOrderFee: number;     // flat fee, 0 when gigPrice >= threshold
  clientTotal: number;       // gigPrice + serviceFee + smallOrderFee: what the client pays
  platformCommission: number;// commissionPercent of gigPrice, taken at escrow release
  freelancerNet: number;     // gigPrice - platformCommission
  freelancerPercent: number; // 100 - commissionPercent
  platformRevenue: number;   // commission + serviceFee + smallOrderFee
  cents: {
    gigPrice: number; serviceFee: number; smallOrderFee: number; clientTotal: number;
    platformCommission: number; freelancerNet: number;
  };
}

/** percent of an integer-cent amount, rounded half-up to a whole cent. */
export function percentOfCents(cents: number, percent: number): number {
  const bps = Math.round(percent * 100); // 5.5% -> 550 basis points
  return Math.floor((cents * bps + 5000) / 10000);
}

export function toCents(amount: number): number {
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0) {
    throw new Error('Amount must be a non-negative number.');
  }
  return Math.round(amount * 100);
}

export function validateFeeConfig(cfg: FeeConfig): void {
  const pct = (v: number) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 100;
  if (!pct(cfg.commissionPercent)) throw new Error('commissionPercent must be between 0 and 100.');
  if (!pct(cfg.buyerFeePercent)) throw new Error('buyerFeePercent must be between 0 and 100.');
  if (typeof cfg.smallOrderFee !== 'number' || !Number.isFinite(cfg.smallOrderFee) || cfg.smallOrderFee < 0) {
    throw new Error('smallOrderFee must be a non-negative number.');
  }
  if (typeof cfg.smallOrderThreshold !== 'number' || !Number.isFinite(cfg.smallOrderThreshold) || cfg.smallOrderThreshold < 0) {
    throw new Error('smallOrderThreshold must be a non-negative number.');
  }
}

/**
 * FivePA Fee rules:
 *  1. Freelancer commission: platform keeps commissionPercent (20%) of the gig price; freelancer gets the rest (80%).
 *  2. Buyer service fee:
 *     - If order amount < smallOrderThreshold ($200): buyer service fee = buyerFeePercent (1%) + smallOrderFee ($1.00).
 *     - If order amount >= smallOrderThreshold ($200): buyer service fee = buyerFeePercent (1%), smallOrderFee = $0.
 */
export function calculateOrderFees(gigPrice: number, cfg: FeeConfig = DEFAULT_FEE_CONFIG): OrderFeeBreakdown {
  validateFeeConfig(cfg);
  const gig = toCents(gigPrice);
  const isSmallOrder = gig > 0 && gig < toCents(cfg.smallOrderThreshold);
  const service = gig > 0 ? percentOfCents(gig, cfg.buyerFeePercent) : 0;
  const small = isSmallOrder ? toCents(cfg.smallOrderFee) : 0;
  const commission = percentOfCents(gig, cfg.commissionPercent);
  const net = gig - commission;
  const total = gig + service + small;
  const d = (c: number) => c / 100;
  return {
    gigPrice: d(gig),
    serviceFee: d(service),
    smallOrderFee: d(small),
    clientTotal: d(total),
    platformCommission: d(commission),
    freelancerNet: d(net),
    freelancerPercent: Math.round((100 - cfg.commissionPercent) * 100) / 100,
    platformRevenue: d(commission + service + small),
    cents: { gigPrice: gig, serviceFee: service, smallOrderFee: small, clientTotal: total, platformCommission: commission, freelancerNet: net }
  };
}

export function fromCents(cents: number): number {
  return cents / 100;
}
