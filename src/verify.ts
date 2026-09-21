/**
 * Claim verification - "don't trust, verify" as an API.
 *
 * Every other tool here answers "what is true?". This one answers a harder and
 * more useful question: "is what I was told true?"
 *
 * That is the question with actual stakes. A project announces a supply of 250.
 * A seller says a card has never been traded. A Discord post claims a wallet
 * holds the whole set. Collectors act on those statements with real money, and
 * the normal way to check is to trust a marketplace page that is itself just
 * repeating the project's own metadata.
 *
 * Credible neutrality, in Buterin's sense, needs two things this module tries
 * to honour: the mechanism must not encode specific outcomes, and its execution must
 * be publicly verifiable. So verification here never returns a bare verdict. It
 * returns the number it found, where it read it, and how it was derived, so the
 * caller can repeat the check by hand and get the same answer. A verdict you
 * cannot reproduce is just a different party to trust.
 *
 * It is also deliberately willing to answer UNVERIFIABLE. A tool that always
 * produces true or false will produce false confidently, which is worse than
 * admitting the check was not possible.
 */

import * as me from "./sources/magiceden.js";
import * as sol from "./sources/solana.js";
import { clean } from "./lib/untrusted.js";
import { NotFoundError, WrongKindError } from "./lib/errors.js";

export type Verdict = "confirmed" | "contradicted" | "unverifiable";

export interface Evidence {
  /** Where the number came from, specifically enough to re-read it. */
  source: string;
  /** How it was derived, in one sentence a person can follow. */
  method: string;
  observed: string;
}

export interface VerificationResult {
  claim: string;
  subject: string;
  verdict: Verdict;
  /** Plain sentence, safe to repeat to a person verbatim. */
  explanation: string;
  evidence: Evidence[];
  /** How to reproduce this check without trusting this tool. */
  reproduce: string;
  caveats: string[];
  /**
   * One plain line, safe to paste anywhere. A verification that ends an
   * argument in a Discord thread is worth more than a page of JSON, and every
   * pasted receipt names where it came from.
   */
  receipt: string;
}

const near = (a: number, b: number, tolerance = 0) => Math.abs(a - b) <= tolerance;

/**
 * A number this module is willing to compare.
 *
 * JSON parses `1e400` as `Infinity`, and `Infinity <= Infinity` is true - so a
 * claimed floor of `1e400` compared inside a 2% tolerance against ANY observed
 * floor came back "confirmed within 2%". Every comparison here now requires
 * both sides to be finite and above zero, independently of whatever the input
 * schema allowed, because a verifier that trusts its caller's arithmetic is
 * not a verifier.
 */
const comparable = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;

/** The same refusal, worded for a reader, wherever a claimed number is unusable. */
const unusableClaim = (claimed: unknown): string =>
  `The claimed value (${typeof claimed === "number" ? (Number.isNaN(claimed) ? "not a number" : String(claimed)) : String(claimed)}) is not a finite number above zero, so there is nothing to compare against. ` +
  `Very large JSON numbers arrive as infinity and would compare equal to anything; this is refused rather than confirmed.`;

/**
 * Verify a supply claim against the on-chain collection account.
 *
 * Supply is the claim most worth checking, because it is the one that
 * determines scarcity and the one a project controls the presentation of.
 */
async function verifySupply(collectionAddress: string, claimed: number): Promise<Omit<VerificationResult, "receipt">> {
  const base = {
    claim: `supply is ${claimed}`,
    subject: collectionAddress,
    reproduce:
      `Call getAccountInfo on ${collectionAddress} against any Solana RPC, base64-decode the data, and ` +
      `read the two little-endian uint32s that follow the name and URI strings: numMinted then currentSize. ` +
      `No API key and no indexer is involved, so any node gives the same answer.`,
  };

  // getCoreAccount throws for accounts that are not Core (a wallet, an SPL
  // mint). That is an unverifiable claim, not an error - catch it here so the
  // tool can say so instead of failing.
  if (!comparable(claimed)) {
    return {
      ...base,
      verdict: "unverifiable",
      explanation: unusableClaim(claimed),
      evidence: [],
      caveats: ["Pass a finite supply count above zero."],
    };
  }

  const acct = await sol.getCoreAccount(collectionAddress, { fresh: true }).catch(() => null);
  if (!acct || acct.kind !== "collection") {
    return {
      ...base,
      verdict: "unverifiable",
      explanation:
        `${collectionAddress} does not decode as a Metaplex Core collection account, so there is no ` +
        `on-chain supply figure to check the claim against. This is not evidence the claim is false.`,
      evidence: [],
      caveats: [
        "Legacy SPL and compressed collections store supply differently and are not decoded here.",
      ],
    };
  }

  const evidence: Evidence[] = [
    {
      source: `Solana account ${collectionAddress}`,
      method: "Metaplex Core collection account decoded from raw bytes; numMinted field.",
      observed: `numMinted = ${acct.numMinted}`,
    },
    {
      source: `Solana account ${collectionAddress}`,
      method: "Same account, currentSize field - how many members it counts now. Burns, closures and moves to another collection lower it; a move in raises it.",
      observed: `currentSize = ${acct.currentSize}`,
    },
  ];

  const delta = acct.numMinted - acct.currentSize;
  const caveats: string[] = [];
  if (delta !== 0) {
    caveats.push(
      `numMinted and currentSize differ by ${delta}, so "minted" and "how many are in it now" are different numbers here. The counters do not say why: burns and closures lower currentSize, and so does an asset moved out to another collection, while one moved in raises it. A claim is ambiguous unless it says which number it means, and a burn count needs decoded history.`,
    );
  }
  caveats.push(
    "This counts what the collection account records. It does not prove the issuer will not mint more later unless the authority is renounced.",
  );

  // The OBSERVED side has to be a real number too: a decode that produced NaN
  // or infinity must not be compared, it must be reported as unreadable.
  if (!Number.isFinite(acct.numMinted) || !Number.isFinite(acct.currentSize)) {
    return {
      ...base,
      verdict: "unverifiable",
      explanation: `The collection account at ${collectionAddress} did not decode into usable mint counts, so there is no on-chain figure to check the claim against.`,
      evidence,
      caveats,
    };
  }

  if (near(acct.numMinted, claimed) || near(acct.currentSize, claimed)) {
    const which = near(acct.numMinted, claimed) ? "minted" : "currently existing";
    return {
      ...base,
      verdict: "confirmed",
      explanation: `Confirmed against the chain: ${claimed} matches the ${which} count on the collection account.`,
      evidence,
      caveats,
    };
  }

  return {
    ...base,
    verdict: "contradicted",
    explanation:
      `The chain does not support this claim. It records ${acct.numMinted} minted and ${acct.currentSize} ` +
      `currently existing, neither of which is ${claimed}.`,
    evidence,
    caveats,
  };
}

/** Verify that an asset has, or has not, changed hands since it was minted. */
async function verifyUntraded(mint: string): Promise<Omit<VerificationResult, "receipt">> {
  const base = {
    claim: "never changed hands since mint",
    subject: mint,
    reproduce:
      `Call getSignaturesForAddress on ${mint}, fetch each transaction, and count the ones whose logs ` +
      `contain a Core Transfer instruction. Anything beyond the original mint is a change of hands.`,
  };

  // Fresh walk, and decode every transaction (depth 25 is the tool's ceiling;
  // anything beyond that shows up as skipped and blocks a "confirmed").
  let prov: Awaited<ReturnType<typeof sol.getProvenance>> | null = null;
  let provError: string | undefined;
  let provMissing = false;
  try {
    prov = await sol.getProvenance(mint, 25, { fresh: true });
  } catch (e) {
    // "Not a Core asset" and "no such account" are answers about the subject;
    // anything else is the chain not being readable. The class says which.
    provMissing = e instanceof NotFoundError || e instanceof WrongKindError;
    provError = clean(e instanceof Error ? e.message : String(e)).slice(0, 200);
  }
  if (!prov && provError && !provMissing) {
    return {
      ...base,
      verdict: "unverifiable",
      explanation: `The chain could not be read for ${mint} just now (${provError}), so its history cannot be checked.`,
      evidence: [],
      caveats: ["This is a source failure, not a statement about the asset. Retry shortly."],
    };
  }
  if (!prov) {
    return {
      ...base,
      verdict: "unverifiable",
      explanation: `${mint} could not be read as a Metaplex Core asset, so its transfer history cannot be decoded here.`,
      evidence: [],
      caveats: ["Legacy SPL and compressed NFTs are not decoded by this server."],
    };
  }

  const transfers = prov.events.filter((e) => e.event === "transferred");
  const evidence: Evidence[] = [
    {
      source: `Solana transaction history for ${mint}`,
      method: "Core TransferV1 instructions decoded from each signature touching the asset.",
      observed: `${transfers.length} transfer(s) across ${prov.totalSignatures} total signatures (${prov.unreadableTransactions} unreadable, ${prov.skippedTransactions} not decoded)`,
    },
    {
      source: `Solana RPC endpoint ${prov.endpointPinned}`,
      method: "Every read in this walk - the account, the signature pages and each transaction - came from this one endpoint, so the answer describes a state that node actually held rather than a snapshot stitched from two.",
      observed: `endpointPinned = ${prov.endpointPinned}`,
    },
    {
      source: `Solana RPC endpoint ${prov.endpointPinned}`,
      method:
        prov.slotFloorHonoured
          ? "The account read's own context slot was used as a minContextSlot floor on the signature pages and every transaction, so no read in this walk could come from a slot older than the account it describes."
          : "The endpoint would not take a minContextSlot floor, so the single pinned endpoint is what keeps this walk internally consistent.",
      observed: `contextSlot = ${prov.contextSlot ?? "not reported by the endpoint"}, slotFloorHonoured = ${prov.slotFloorHonoured}`,
    },
  ];

  const caveats = [
    "This checks whether the asset ever CHANGED HANDS on chain. A transfer is not necessarily a sale (listing moves an item to escrow), and a sale is always a transfer - so 'no transfers' rules out a sale, while 'transfers' does not prove one.",
  ];
  if (prov.skippedTransactions > 0) {
    caveats.push(
      `${prov.skippedTransactions} older transaction(s) were beyond the decode depth and were not examined.`,
    );
  }

  if (prov.transfersWithoutLogEvidence > 0) {
    caveats.push(
      `${prov.transfersWithoutLogEvidence} transaction(s) carried a Core TransferV1 for this asset that the transaction logs did not mention. The instruction list is the record and was used; the logs could not corroborate it.`,
    );
  }

  if (transfers.length === 0) {
    // "Never" needs the whole history, readable. Anything skipped or unread
    // makes this unverifiable, not confirmed.
    if (!prov.historyComplete || prov.skippedTransactions > 0) {
      const why =
        prov.unreadableTransactions > 0
          ? `${prov.unreadableTransactions} transaction(s) touching this asset could not be classified - a Core instruction with no decodable data and no corroborating log is a hole in the evidence, not an absence of events`
          : "the history was not read in full";
      return {
        ...base,
        verdict: "unverifiable",
        explanation: `No transfer appears in the ${prov.events.length} transaction(s) read, but ${why}, so "never" cannot be confirmed.`,
        evidence,
        caveats,
      };
    }
    // A complete walk still has to have SEEN the beginning. Reaching the end
    // of the signature list proves the endpoint had nothing older to give,
    // not that the oldest thing it gave was the mint: a pruned node hands
    // back a short, complete-looking list that starts mid-history.
    if (!prov.mintObserved) {
      return {
        ...base,
        verdict: "unverifiable",
        explanation:
          `No transfer appears in the ${prov.events.length} transaction(s) read and the signature list was walked to its end, ` +
          `but no mint instruction was decoded at the start of it, so the beginning of this asset's history was not recognised and "never" cannot be confirmed.`,
        evidence,
        caveats: [...caveats, "The endpoint may hold less history than the asset has (a pruned node). Try again against an archival endpoint via SOLANA_RPC_URL."],
      };
    }
    return {
      ...base,
      verdict: "confirmed",
      explanation: `Confirmed: no transfer instructions appear anywhere in this asset's on-chain history. It has never changed hands since mint, so it cannot have been sold.`,
      evidence,
      caveats,
    };
  }

  return {
    ...base,
    verdict: "contradicted",
    explanation:
      `Contradicted: the asset has changed hands ${transfers.length} time(s) on chain` +
      (transfers.some((t) => t.marketplace) ? ` (${transfers.filter((t) => t.marketplace).length} through a marketplace program - listings and sales both move it)` : "") +
      `. Whether any of those was a sale needs marketplace sale records: get_recent_sales. Use get_asset_provenance for the dated trail.`,
    evidence,
    caveats,
  };
}

/** Verify a wallet currently holds a specific asset. */
async function verifyOwnership(mint: string, wallet: string): Promise<Omit<VerificationResult, "receipt">> {
  const base = {
    claim: `${wallet} owns ${mint}`,
    subject: mint,
    reproduce:
      `Call getAccountInfo on ${mint}, base64-decode, and read bytes 1-33 as a base58 public key. ` +
      `For a Metaplex Core asset that field IS the owner - there is no separate token account to consult.`,
  };

  let acct: Awaited<ReturnType<typeof sol.getCoreAccount>> = null;
  let readError: string | undefined;
  let endpointPinned = "no endpoint was contacted for this read";
  try {
    // Pinned even though this is a single read: the result records WHICH node
    // said it, so a reader who disagrees knows whom they are disagreeing with,
    // and a mid-read failure restarts cleanly instead of silently rotating.
    const walk = await sol.pinnedWalk((pin) => sol.getCoreAccount(mint, { fresh: true, pin }));
    acct = walk.value;
    endpointPinned = walk.endpointPinned;
  } catch (e) {
    readError = e instanceof Error ? e.message : String(e);
  }
  if (!acct || acct.kind !== "asset") {
    return {
      ...base,
      verdict: "unverifiable",
      explanation: readError
        ? `The chain could not be read for ${mint} just now (${readError}), so ownership cannot be checked.`
        : `${mint} does not decode as a Metaplex Core asset, so its owner field cannot be read here.`,
      evidence: [],
      caveats: readError
        ? ["This is a source failure, not a statement about the asset. Retry shortly."]
        : ["Legacy SPL and compressed NFTs store ownership elsewhere and are not decoded by this server."],
    };
  }

  const evidence: Evidence[] = [
    {
      source: `Solana account ${mint}`,
      method: "Metaplex Core asset account, owner field decoded from bytes 1-33.",
      observed: `owner = ${acct.owner}`,
    },
    {
      source: `Solana RPC endpoint ${endpointPinned}`,
      method: "The endpoint this read was pinned to, so the answer names the node whose state it describes.",
      observed: `endpointPinned = ${endpointPinned}`,
    },
  ];

  const caveats = [
    "If the item is listed for sale, the on-chain owner is the marketplace escrow rather than the seller - so a 'no' here can still mean the person controls the asset.",
    "A permanent delegate, where one is configured, can move the asset without the owner's signature. Ownership on chain is not always unconditional control.",
  ];

  if (acct.owner === wallet) {
    return {
      ...base,
      verdict: "confirmed",
      explanation: `Confirmed: the asset account names ${wallet} as its owner right now.`,
      evidence,
      caveats,
    };
  }

  return {
    ...base,
    verdict: "contradicted",
    explanation: `Contradicted: the asset is currently owned by ${acct.owner}, not ${wallet}.`,
    evidence,
    caveats,
  };
}

/** Verify a floor-price claim against the live marketplace. */
async function verifyFloor(symbol: string, claimed: number): Promise<Omit<VerificationResult, "receipt">> {
  const base = {
    claim: `floor is ${claimed} SOL`,
    subject: symbol,
    reproduce: `GET https://api-mainnet.magiceden.dev/v2/collections/${symbol}/stats and divide floorPrice by 1e9 to get SOL. No key required.`,
  };

  if (!comparable(claimed)) {
    return {
      ...base,
      verdict: "unverifiable",
      explanation: unusableClaim(claimed),
      evidence: [],
      caveats: ["Pass a finite price above zero, in SOL."],
    };
  }

  let stats: Awaited<ReturnType<typeof me.collectionStats>> | null = null;
  let statsError: string | undefined;
  let statsMissing = false;
  try {
    stats = await me.collectionStats(symbol, { fresh: true });
  } catch (e) {
    // Classified on the error CLASS, never on the upstream's words: a 5xx
    // whose body happened to contain "has no collection" was being reported
    // as an absence, which is a claim about the market built from a failure.
    statsMissing = e instanceof NotFoundError;
    statsError = clean(e instanceof Error ? e.message : String(e)).slice(0, 200);
  }
  if (!stats || stats.floorPriceSol === null) {
    const outage = Boolean(statsError) && !statsMissing;
    return {
      ...base,
      verdict: "unverifiable",
      explanation: outage
        ? `Magic Eden could not be read just now (${statsError}), so the claim cannot be checked.`
        : `No live floor was returned for "${symbol}", so the claim cannot be checked.`,
      evidence: [],
      caveats: outage
        ? ["This is a source failure, not a statement about the collection. Retry shortly."]
        : ["A collection with no listings has no floor at all; an unknown symbol has none either."],
    };
  }

  if (stats.stale) {
    return {
      ...base,
      verdict: "unverifiable",
      explanation: `Magic Eden did not answer just now; the only floor available is a cached value from ${stats.cachedAt}, which cannot confirm a live claim.`,
      evidence: [],
      caveats: ["Retry in a minute. A stale floor is presented as stale everywhere in this server, and never as confirmation."],
    };
  }
  const observed = stats.floorPriceSol;
  if (!comparable(observed)) {
    return {
      ...base,
      verdict: "unverifiable",
      explanation: `Magic Eden returned a floor for "${symbol}" that is not a finite number above zero, so it cannot be compared with the claim.`,
      evidence: [],
      caveats: ["That is a marketplace shape problem, not a statement about the collection. Retry shortly."],
    };
  }
  const evidence: Evidence[] = [
    {
      source: `Magic Eden collection stats for ${symbol}`,
      method: "Live floorPrice in lamports, divided by 1e9.",
      observed: `${observed} SOL, ${stats.listedCount ?? "?"} listed`,
    },
  ];
  const caveats = [
    "A floor is the lowest current ask on ONE marketplace and moves constantly - this was true at the moment of the call and may not be a minute later.",
    "Other marketplaces quote their own floors, sometimes in another currency. Use get_collection_stats for the cross-marketplace view.",
  ];

  // 2% tolerance: a floor moves while the claim is being made, and calling that
  // a lie would make the tool useless.
  if (near(observed, claimed, claimed * 0.02)) {
    return {
      ...base,
      verdict: "confirmed",
      explanation: `Confirmed within 2%: the live floor is ${observed} SOL against a claimed ${claimed} SOL.`,
      evidence,
      caveats,
    };
  }

  const dir = observed > claimed ? "higher" : "lower";
  return {
    ...base,
    verdict: "contradicted",
    explanation: `Contradicted: the live floor is ${observed} SOL, ${dir} than the claimed ${claimed} SOL by more than 2%.`,
    evidence,
    caveats,
  };
}

export type ClaimType = "supply" | "never-traded" | "ownership" | "floor";

const MARK: Record<Verdict, string> = { confirmed: "CONFIRMED", contradicted: "CONTRADICTED", unverifiable: "UNVERIFIABLE" };
const short = (s: string) => (s.length > 12 ? s.slice(0, 4) + "…" + s.slice(-4) : s);

export function buildReceipt(r: Omit<VerificationResult, "receipt">, at = new Date()): string {
  const observed = r.evidence.map((e) => e.observed).join(", ");
  const onChain = r.evidence.length > 0 && r.evidence.every((e) => /Solana|Core|account|transaction/i.test(e.source));
  const venue = (src: string) => src.split(/ (collection|stats|account|for) /)[0] ?? src;
  const srcLabel = r.evidence.length === 0 ? "" : onChain ? "chain shows" : `${[...new Set(r.evidence.map((e) => venue(e.source)))].join(" + ")} shows`;
  const how = r.evidence.length === 0 ? "" : onChain ? " · checked on-chain via solana-nft-mcp, reproducible with no key" : ` · marketplace read via solana-nft-mcp at ${at.toISOString().slice(0, 16)}Z, reproducible with no key`;
  return (
    `${MARK[r.verdict]}: "${r.claim}" for ${short(r.subject)}` +
    (observed ? ` - ${srcLabel} ${observed}` : "") +
    `${how} · github.com/p1xelapp/solana-nft-mcp`
  );
}

function withReceipt(r: Omit<VerificationResult, "receipt">): VerificationResult {
  return { ...r, receipt: buildReceipt(r) };
}

export async function verifyClaim(args: {
  claim: ClaimType;
  subject: string;
  value?: number;
  wallet?: string;
}): Promise<VerificationResult> {
  const { claim, subject, value, wallet } = args;
  return withReceipt(await route({ claim, subject, value, wallet }));
}

async function route(args: {
  claim: ClaimType;
  subject: string;
  value?: number;
  wallet?: string;
}): Promise<Omit<VerificationResult, "receipt">> {
  const { claim, subject, value, wallet } = args;
  switch (claim) {
    case "supply":
      if (value === undefined) throw new Error("supply claims need `value` - the number being claimed");
      return verifySupply(subject, value);
    case "never-traded":
      return verifyUntraded(subject);
    case "ownership":
      if (!wallet) throw new Error("ownership claims need `wallet` - the address said to own it");
      return verifyOwnership(subject, wallet);
    case "floor":
      if (value === undefined) throw new Error("floor claims need `value` - the price being claimed, in SOL");
      return verifyFloor(subject, value);
  }
}
