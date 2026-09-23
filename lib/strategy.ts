/**
 * The two tokens the strategy is about. Everything else moving through the
 * wallet is "other activity". Override with STRATEGY_MINTS=<mintA>,<mintB>.
 */
const DEFAULT_MINT_A = "taoC6xyv2v8tDLcev4uaGUgV4vdQsWJrGft2kcBRrBY"; // TAO
const DEFAULT_MINT_B = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"; // USDC

export function getStrategyMints(): { mintA: string; mintB: string } {
  const raw = process.env.STRATEGY_MINTS?.split(",").map((s) => s.trim()).filter(Boolean);
  if (raw && raw.length === 2) return { mintA: raw[0], mintB: raw[1] };
  return { mintA: DEFAULT_MINT_A, mintB: DEFAULT_MINT_B };
}
