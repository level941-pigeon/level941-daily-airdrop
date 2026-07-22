// Automated screening for the community drop pipeline.
//
// Three lanes for anything that lands in the drop wallet:
//   fastlane:    majors and pre-approved mints, sweep at next daily run
//   pipeline:    unknown mints -> extension screen -> cooling window ->
//                realizable-value floor -> auto sweep
//   quarantine:  hostile extensions, freeze authority, denied, or worthless
//
// The value check uses a real swap quote for the FULL amount, not a spot
// price. Thin fake liquidity cannot inflate its way past a quote.

import { Connection, PublicKey } from '@solana/web3.js';
import {
  ExtensionType,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getExtensionTypes,
  getMint,
} from '@solana/spl-token';
import { checkTokenContent } from './content-denylist.js';

export const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

export interface MintRecord {
  firstSeen: number; // unix seconds
  screened: boolean;
  screenOk: boolean;
  screenReasons: string[];
  denied: boolean;
  lastValueUsd: number | null;
  sweptDates: string[];
}

export type SweepState = Record<string, MintRecord>;

export type Lane = 'fastlane' | 'sweep' | 'pending' | 'quarantined' | 'denied';

// Pure lane decision. All inputs explicit so this is fully testable.
export function decideLane(opts: {
  denied: boolean;
  fastlane: boolean;
  screenOk: boolean;
  screenReasons: string[];
  firstSeen: number;
  nowSec: number;
  delayHours: number;
  valueUsd: number | null;
  minUsd: number;
}): { lane: Lane; reason: string } {
  if (opts.denied) return { lane: 'denied', reason: 'on the denylist' };
  if (opts.fastlane) return { lane: 'fastlane', reason: 'pre-approved' };
  if (!opts.screenOk) {
    return { lane: 'quarantined', reason: `failed screen: ${opts.screenReasons.join(', ')}` };
  }
  const ageHours = (opts.nowSec - opts.firstSeen) / 3600;
  if (ageHours < opts.delayHours) {
    return {
      lane: 'pending',
      reason: `cooling window, ${Math.ceil(opts.delayHours - ageHours)}h remaining`,
    };
  }
  if (opts.valueUsd === null) {
    return { lane: 'pending', reason: 'no sellable quote yet, retrying next run' };
  }
  if (opts.valueUsd < opts.minUsd) {
    return {
      lane: 'pending',
      reason: `realizable value $${opts.valueUsd.toFixed(2)} below $${opts.minUsd} floor`,
    };
  }
  return { lane: 'sweep', reason: `cleared, worth ~$${opts.valueUsd.toFixed(2)}` };
}

// Hostile or footgun extensions. Unknown extensions also reject: new
// mechanisms get reviewed by a human before they ride the pipeline.
const REJECT_EXTENSIONS = new Set<ExtensionType>([
  ExtensionType.TransferHook,
  ExtensionType.PermanentDelegate,
  ExtensionType.TransferFeeConfig,
  ExtensionType.DefaultAccountState,
  ExtensionType.NonTransferable,
  ExtensionType.ConfidentialTransferMint,
  ExtensionType.PausableConfig,
]);

const ACCEPT_EXTENSIONS = new Set<ExtensionType>([
  ExtensionType.MetadataPointer,
  ExtensionType.TokenMetadata,
  ExtensionType.InterestBearingConfig,
  ExtensionType.MintCloseAuthority,
  ExtensionType.GroupPointer,
  ExtensionType.GroupMemberPointer,
  ExtensionType.TokenGroup,
  ExtensionType.TokenGroupMember,
  ExtensionType.ScaledUiAmountConfig,
]);

export async function screenMint(
  connection: Connection,
  mint: PublicKey,
  programId: PublicKey
): Promise<{ ok: boolean; reasons: string[] }> {
  const reasons: string[] = [];
  try {
    const info = await getMint(connection, mint, 'confirmed', programId);
    if (info.freezeAuthority !== null) {
      reasons.push('freeze authority set');
    }
    if (programId.equals(TOKEN_2022_PROGRAM_ID) && info.tlvData.length > 0) {
      for (const ext of getExtensionTypes(info.tlvData)) {
        if (REJECT_EXTENSIONS.has(ext)) reasons.push(`extension ${ExtensionType[ext] ?? ext}`);
        else if (!ACCEPT_EXTENSIONS.has(ext)) reasons.push(`unknown extension ${ExtensionType[ext] ?? ext}`);
      }
    }
    if (!programId.equals(TOKEN_PROGRAM_ID) && !programId.equals(TOKEN_2022_PROGRAM_ID)) {
      reasons.push('unknown token program');
    }
  } catch (e) {
    reasons.push('mint unreadable');
  }

  const content = await screenTokenContent(connection.rpcEndpoint, mint.toBase58());
  reasons.push(...content.reasons);

  return { ok: reasons.length === 0, reasons };
}

// Name/symbol check via the Helius DAS getAsset call already used elsewhere
// in this codebase for token metadata. A lookup failure is treated as
// "can't confirm clean" -- same fail-closed posture as an unreadable mint,
// not a silent pass. See content-denylist.ts for the matching rules and
// why the two-tier (substring vs exact-word) split exists.
export async function screenTokenContent(rpcEndpoint: string, mint: string): Promise<{ ok: boolean; reasons: string[] }> {
  try {
    const res = await fetch(rpcEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getAsset', params: { id: mint } }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return { ok: false, reasons: ['content screen unreachable'] };
    const json = (await res.json()) as { result?: { content?: { metadata?: { name?: string; symbol?: string } } } };
    const meta = json.result?.content?.metadata;
    return checkTokenContent(meta?.name, meta?.symbol);
  } catch {
    return { ok: false, reasons: ['content screen unreachable'] };
  }
}

// Realizable value of the full amount via a swap quote to USDC.
// Returns null when no route exists or the API is unreachable, which the
// pipeline treats as "wait", never as "go".
export async function quoteValueUsd(
  quoteUrlBase: string,
  mint: string,
  amountRaw: bigint
): Promise<number | null> {
  try {
    const url = `${quoteUrlBase}?inputMint=${mint}&outputMint=${USDC_MINT}&amount=${amountRaw.toString()}&slippageBps=500`;
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) return null;
    const data = (await res.json()) as { outAmount?: string };
    if (!data.outAmount) return null;
    return Number(BigInt(data.outAmount)) / 1e6; // USDC has 6 decimals
  } catch {
    return null;
  }
}
