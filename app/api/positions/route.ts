import { PublicKey } from "@solana/web3.js";
import { fetchWalletPositions } from "@/lib/raydium";
import type { PositionsResponse } from "@/lib/types";

export async function GET(request: Request): Promise<Response> {
  // Validate the wallet address.
  const raw = new URL(request.url).searchParams.get("wallet")?.trim() ?? "";
  let wallet: PublicKey;
  try {
    wallet = new PublicKey(raw);
  } catch {
    return Response.json({ error: "That doesn't look like a valid Solana address." }, { status: 400 });
  }

  try {
    // Positions whose Raydium request failed are skipped rather than failing
    // the whole response; the raw API payload is not sent to the browser.
    const { positions: fetched } = await fetchWalletPositions(wallet);
    const positions = fetched.map((f) => f.position);
    const totalUsdValue = positions.reduce((sum, p) => sum + p.usdValue, 0);
    const body: PositionsResponse = { positions, totalUsdValue };
    return Response.json(body);
  } catch (err) {
    console.error("Failed to load positions:", err);
    return Response.json({ error: "Couldn't reach the network. Try again." }, { status: 502 });
  }
}
