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
      method: "Same account, currentSize field - how many still exist after burns.",
      observed: `currentSize = ${acct.currentSize}`,
    },
  ];

  const burned = acct.numMinted - acct.currentSize;
  const caveats: string[] = [];
  if (burned > 0) {
    caveats.push(
      `${burned} item(s) have been burned or closed, so "minted" and "how many exist" are different numbers here. A claim is ambiguous unless it says which one it means.`,
    );
  }
  caveats.push(
    "This counts what the collection account records. It does not prove the issuer will not mint more later unless the authority is renounced.",
  );

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
    claim: "never traded since mint",
    subject: mint,
    reproduce:
      `Call getSignaturesForAddress on ${mint}, fetch each transaction, and count the ones whose logs ` +
      `contain a Core Transfer instruction. Anything beyond the original mint is a change of hands.`,
  };

  // Fresh walk, and decode every transaction (depth 25 is the tool's ceiling;
  // anything beyond that shows up as skipped and blocks a "confirmed").
  const prov = await sol.getProvenance(mint, 25, { fresh: true }).catch(() => null);
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
  ];

  const caveats = [
    "This checks whether the asset ever CHANGED HANDS on chain. A transfer is not necessarily a sale (listing moves an item to escrow), and a sale is always a transfer - so 'no transfers' rules out a sale, while 'transfers' does not prove one.",
  ];
  if (prov.skippedTransactions > 0) {
    caveats.push(
      `${prov.skippedTransactions} older transaction(s) were beyond the decode depth and were not examined.`,
    );
  }

  if (transfers.length === 0) {
    // "Never" needs the whole history, readable. Anything skipped or unread
    // makes this unverifiable, not confirmed.
    if (!prov.historyComplete || prov.skippedTransactions > 0) {
      return {
        ...base,
        verdict: "unverifiable",
        explanation: `No transfer appears in the ${prov.events.length} transaction(s) read, but the history was not read in full, so "never" cannot be confirmed.`,
        evidence,
        caveats,
      };
    }
    return {
      ...base,
      verdict: "confirmed",
      explanation: `Confirmed: no transfer instructions appear anywhere in this asset's on-chain history. It has never changed hands since mint.`,
      evidence,
      caveats,
    };
  }

  return {
    ...base,
    verdict: "contradicted",
    explanation:
      `Contradicted: the asset has ${transfers.length} transfer(s) on chain. ` +
      `Use get_asset_provenance for the dated trail of who held it.`,
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

  const acct = await sol.getCoreAccount(mint, { fresh: true }).catch(() => null);
  if (!acct || acct.kind !== "asset") {
    return {
      ...base,
      verdict: "unverifiable",
      explanation: `${mint} does not decode as a Metaplex Core asset, so its owner field cannot be read here.`,
      evidence: [],
      caveats: ["Legacy SPL and compressed NFTs store ownership elsewhere and are not decoded by this server."],
    };
  }

  const evidence: Evidence[] = [
    {
      source: `Solana account ${mint}`,
      method: "Metaplex Core asset account, owner field decoded from bytes 1-33.",
      observed: `owner = ${acct.owner}`,
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

  const stats = await me.collectionStats(symbol, { fresh: true }).catch(() => null);
  if (!stats || stats.floorPriceSol === null) {
    return {
      ...base,
      verdict: "unverifiable",
      explanation: `No live floor was returned for "${symbol}", so the claim cannot be checked.`,
      evidence: [],
      caveats: ["A collection with no listings has no floor at all."],
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
  const evidence: Evidence[] = [
    {
      source: `Magic Eden collection stats for ${symbol}`,
      method: "Live floorPrice in lamports, divided by 1e9.",
      observed: `${observed} SOL, ${stats.listedCount ?? "?"} listed`,
    },
  ];
  const caveats = [
    "A floor is the lowest current ask on ONE venue and moves constantly - this was true at the moment of the call and may not be a minute later.",
    "Other marketplaces quote their own floors, sometimes in another currency. Use get_collection_stats for the cross-venue view.",
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

function withReceipt(r: Omit<VerificationResult, "receipt">): VerificationResult {
  const observed = r.evidence.map((e) => e.observed).join(", ");
  return {
    ...r,
    receipt:
      `${MARK[r.verdict]}: "${r.claim}" for ${short(r.subject)}` +
      (observed ? ` - chain shows ${observed}` : "") +
      ` · checked on-chain via collector-mcp, reproducible with no key · github.com/p1xelapp/collector-mcp`,
  };
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
