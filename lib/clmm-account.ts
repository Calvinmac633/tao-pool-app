import { PublicKey } from "@solana/web3.js";

/**
 * Fields decoded from a Raydium CLMM PersonalPositionState account.
 *
 * Layout (little-endian), from the Raydium CLMM program:
 *   0   8 bytes  anchor discriminator
 *   8   1        bump
 *   9   32       nft_mint
 *   41  32       pool_id
 *   73  4        tick_lower_index (i32)
 *   77  4        tick_upper_index (i32)
 *   81  16       liquidity (u128)
 *   ... fee growth, fees owed, reward infos, padding (not needed here)
 */
export type PersonalPosition = {
  nftMint: PublicKey;
  poolId: PublicKey;
  tickLower: number;
  tickUpper: number;
  liquidity: bigint;
};

const MIN_LENGTH = 97;

export function decodePersonalPosition(data: Buffer): PersonalPosition {
  if (data.length < MIN_LENGTH) {
    throw new Error(`Position account too short: ${data.length} bytes`);
  }
  return {
    nftMint: new PublicKey(data.subarray(9, 41)),
    poolId: new PublicKey(data.subarray(41, 73)),
    tickLower: data.readInt32LE(73),
    tickUpper: data.readInt32LE(77),
    liquidity: readU128LE(data, 81),
  };
}

function readU128LE(buf: Buffer, offset: number): bigint {
  const lo = buf.readBigUInt64LE(offset);
  const hi = buf.readBigUInt64LE(offset + 8);
  return (hi << 64n) | lo;
}
