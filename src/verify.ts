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
import { checkedFloor } from "./lib/custody.js";
import { NotFoundError, WrongKindError, BadInputError, TypedError } from "./lib/errors.js";
import { getProvenanceWithSales, isSignature, readSale, type ChainSale } from "./lib/chain-sales.js";
import { currencyByMint } from "./lib/reconcile.js";
import { plainReason } from "./lib/http.js";

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
   * The code behind a read that failed (an RPC or HTTP code, or "timeout"),
   * for whoever debugs it. The explanation says the same thing in words.
   */
  code?: string;
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

/**
 * "Never sold" for an item whose history the chain reader cannot decode.
 *
 * A legacy or programmable NFT has no Core account, so the claim used to come
 * back unverifiable even while the marketplace showed the item selling twice
 * that hour. One recorded fill, with its transaction, is enough to contradict
 * "never"; no fill confirms nothing, because a venue's silence is not a
 * history.
 */
async function untradedFromMarketplace(
  mint: string,
  base: { claim: string; subject: string; reproduce: string },
): Promise<Omit<VerificationResult, "receipt">> {
  const reproduce = `GET https://api-mainnet.magiceden.dev/v2/tokens/${mint}/activities and look for rows of type buyNow; open each signature in an explorer to check the transfer and the payment. No key required.`;
  let read: Awaited<ReturnType<typeof me.tokenSales>>;
  try {
    read = await me.tokenSales(mint);
  } catch (e) {
    const why = plainReason(e);
    return {
      ...base,
      reproduce,
      verdict: "unverifiable",
      explanation: `${mint} is not a Metaplex Core asset, so its history is not decoded from the chain here, and Magic Eden's activity for it could not be read just now (${why.sentence}).`,
      evidence: [],
      caveats: ["This is a source failure, not a statement about the item. get_recent_sales on its collection shows the fills the marketplaces recorded."],
      ...(why.code ? { code: why.code } : {}),
    };
  }
  const latest = read.sales[0];
  if (latest) {
    // A Tensor fill Magic Eden relays is still a sale, but its figure is
    // Tensor's quote, not what was paid, so it is named as that.
    const quote = "tensorQuoteSol" in latest ? latest.tensorQuoteSol : undefined;
    const money =
      quote !== undefined
        ? `, a Tensor fill Magic Eden relays, at Tensor's quote of ${quote} SOL as Magic Eden passed it on, which is not what anyone paid`
        : ` for ${latest.price} ${latest.currency ?? "in a currency that is not established"}`;
    return {
      ...base,
      reproduce,
      verdict: "contradicted",
      explanation:
        `Contradicted: Magic Eden recorded ${read.sales.length} sale(s) of this item, the latest at ${latest.time}${money} ` +
        `(transaction ${latest.signature}).`,
      evidence: [
        {
          source: `Magic Eden token activity for ${mint}`,
          method: "Sale rows in the marketplace's activity feed for this mint, each carrying a transaction signature, a price above zero and a block time.",
          observed: `${read.sales.length} sale(s) in ${read.eventsRead} event(s) read at ${read.readAt}, latest ${latest.signature}`,
        },
      ],
      caveats: [
        "This item is not a Metaplex Core asset, so the answer rests on the marketplace's record rather than on decoded chain history. The transaction can be opened in any explorer to check it.",
      ],
    };
  }
  return {
    ...base,
    reproduce,
    verdict: "unverifiable",
    explanation:
      `${mint} is not a Metaplex Core asset, so its history is not decoded from the chain here, and Magic Eden's activity for it shows no recorded sale ` +
      `in the ${read.eventsRead} event(s) read${read.reachedEnd ? ", which is all it returned" : ` (the newest ${read.pagesRead} page(s) only, so older sales can sit beyond them)`}. One marketplace with no record of a sale is not proof the item never sold.`,
    evidence: [
      {
        source: `Magic Eden token activity for ${mint}`,
        method: "Sale rows in the marketplace's activity feed for this mint.",
        observed: `0 sales in ${read.eventsRead} event(s) read at ${read.readAt}`,
      },
    ],
    caveats: ["get_recent_sales on the item's collection shows the fills the marketplaces recorded, and get_asset names the collection."],
  };
}

/** A complete transfer-free history rules out an on-chain resale; transfers alone cannot prove one. */
async function verifyUntraded(mint: string): Promise<Omit<VerificationResult, "receipt">> {
  const base = {
    claim: "never sold on chain since mint",
    subject: mint,
    reproduce:
      `Call getSignaturesForAddress on ${mint}, fetch each transaction, and decode Core transfers for this asset. ` +
      `A transfer alone does not prove a sale: wallet migrations, gifts and escrow moves need separate sale evidence.`,
  };

  // Fresh walk, and decode every transaction (depth 25 is the tool's ceiling;
  // anything beyond that shows up as skipped and blocks a "confirmed").
  let prov: Awaited<ReturnType<typeof sol.getProvenance>> | null = null;
  let provError: { sentence: string; code: string | null } | undefined;
  let provOutdated: { headline: string; next: string } | undefined;
  let provMissing = false;
  let isCollection = false;
  try {
    // Every marketplace transaction in the walk goes through the sale
    // decoder, so a sale the chain proves is named as one. Without it, an
    // item whose one transfer was a 0.3 SOL OpenSea sale (which a sale claim
    // on the same transaction confirms) came back unverifiable.
    prov = await getProvenanceWithSales(mint, 25, { fresh: true });
  } catch (e) {
    // "Not a Core asset" and "no such account" are answers about the subject;
    // anything else is the chain not being readable. The class says which.
    provMissing = e instanceof NotFoundError || e instanceof WrongKindError;
    provError = plainReason(e);
    // A transaction format newer than this server reads: a retry gets the
    // same refusal, so the answer says to update, as the sale check does.
    provOutdated = e instanceof TypedError && e.kind === "unsupported" ? e.wording : undefined;
    // The provenance reader's own sentence for a collection account.
    isCollection = e instanceof WrongKindError && /Core COLLECTION/.test(e.message);
  }
  if (!prov && provOutdated) {
    return {
      ...base,
      verdict: "unverifiable",
      explanation: `${provOutdated.headline} The history of ${mint} cannot be checked here.`,
      evidence: [],
      caveats: [`This is not a statement about the asset. ${provOutdated.next}`],
    };
  }
  if (!prov && provError && !provMissing) {
    return {
      ...base,
      verdict: "unverifiable",
      explanation: `The chain could not be read for ${mint} just now (${provError.sentence}), so its history cannot be checked.`,
      evidence: [],
      caveats: ["This is a source failure, not a statement about the asset. Retry shortly."],
      ...(provError.code ? { code: provError.code } : {}),
    };
  }
  if (!prov && isCollection) {
    return {
      ...base,
      verdict: "unverifiable",
      explanation: `${mint} is a collection address, not a single item, so whether it was ever sold is not a question it can answer. Pass one item's mint; identify lists recently active members of a collection.`,
      evidence: [],
      caveats: [],
    };
  }
  if (!prov) return untradedFromMarketplace(mint, base);

  const transfers = prov.events.filter((e) => e.event === "transferred");
  const evidence: Evidence[] = [
    {
      source: `Solana transaction history for ${mint}`,
      method: "Core TransferV1 instructions decoded from each signature touching the asset.",
      observed: `${transfers.length} transfer(s) across ${prov.totalSignatures} total signatures (${prov.unreadableTransactions} unreadable, ${prov.skippedTransactions} not decoded)`,
    },
    // Plain words: this text is pasted into receipts, where field names such
    // as endpointPinned or slotFloorHonoured mean nothing to a reader.
    {
      source: `Solana RPC endpoint ${prov.endpointPinned}`,
      method: "Every read in this walk - the account, the signature pages and each transaction - came from this one endpoint, so the answer describes a state that node actually held rather than a snapshot stitched from two.",
      observed: `every read from one endpoint, ${prov.endpointPinned}`,
    },
    {
      source: `Solana RPC endpoint ${prov.endpointPinned}`,
      method:
        prov.slotFloorHonoured
          ? "The account read's own context slot was used as a minContextSlot floor on the signature pages and every transaction, so no read in this walk could come from a slot older than the account it describes."
          : "The endpoint would not take a minContextSlot floor, so the single pinned endpoint is what keeps this walk internally consistent.",
      observed:
        prov.slotFloorHonoured && prov.contextSlot !== null
          ? `every read at slot ${prov.contextSlot} or later`
          : "the endpoint would not hold the reads to one slot, so the single endpoint kept them consistent",
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

  // A sale the decoder proved from a transaction's own instructions and
  // payments answers "never sold", whatever else the history holds. A
  // self-fill is no sale between two parties, and a layout not yet checked
  // against a real transaction carries no verdict.
  const proven = transfers.filter((t) => t.sale && !t.sale.selfFill && (t.sale.layout === "published" || t.sale.layout === "observed"));
  if (proven.length > 0) {
    const last = proven[proven.length - 1]!;
    const s = last.sale!;
    const money = s.price !== null && s.price !== undefined ? ` for ${s.price} ${s.currency ?? "units of another token"}` : "";
    const at = last.time ? ` at ${last.time}` : "";
    evidence.unshift({
      source: `Solana transaction ${last.signature}`,
      method: "The item's Metaplex Core transfer inside the marketplace's sale instruction, with the payment to the seller beside it, decoded from the transaction itself.",
      observed: `${s.venue} sale${at}${money}, seller ${s.seller}, buyer ${s.buyer}`,
    });
    return {
      ...base,
      verdict: "contradicted",
      explanation: `Contradicted: the chain shows ${proven.length} sale(s) of this item. The latest is ${/^[AEIOU]/.test(s.venue ?? "") ? "an" : "a"} ${s.venue} sale${at}${money} (transaction ${last.signature}), from ${s.seller} to ${s.buyer}, decoded from its own instructions and payments.`,
      evidence,
      caveats: [...caveats, "verify_claim with claim sale on that transaction shows its figures in full."],
    };
  }

  return {
    ...base,
    verdict: "unverifiable",
    explanation:
      `The asset has changed hands ${transfers.length} time(s) on chain` +
      (transfers.some((t) => t.marketplace) ? ` (${transfers.filter((t) => t.marketplace).length} through a marketplace program - listings and sales both move it)` : "") +
      `. These transfers do not settle whether it was ever sold. A wallet migration, gift or escrow move is not sale evidence. Check get_recent_sales for recorded fills and get_asset_provenance for the dated trail.`,
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
  let readError: { sentence: string; code: string | null } | undefined;
  let endpointPinned = "no endpoint was contacted for this read";
  try {
    // Pinned even though this is a single read: the result records WHICH node
    // said it, so a reader who disagrees knows whom they are disagreeing with,
    // and a mid-read failure restarts cleanly instead of silently rotating.
    const walk = await sol.pinnedWalk((pin) => sol.getCoreAccount(mint, { fresh: true, pin }));
    acct = walk.value;
    endpointPinned = walk.endpointPinned;
  } catch (e) {
    readError = plainReason(e);
  }
  if (!acct || acct.kind !== "asset") {
    return {
      ...base,
      verdict: "unverifiable",
      explanation: readError
        ? `The chain could not be read for ${mint} just now (${readError.sentence}), so ownership cannot be checked.`
        : `${mint} does not decode as a Metaplex Core asset, so its owner field cannot be read here.`,
      evidence: [],
      caveats: readError
        ? ["This is a source failure, not a statement about the asset. Retry shortly."]
        : ["Legacy SPL and compressed NFTs store ownership elsewhere and are not decoded by this server."],
      ...(readError?.code ? { code: readError.code } : {}),
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
      observed: `read from ${endpointPinned}`,
    },
  ];

  // The escrow sentence only where it applies: printed under every
  // contradiction, it offered "maybe it is in escrow" about an item a person's
  // wallet plainly holds.
  const caveats = [
    ...(sol.knownVenueAccount(acct.owner)
      ? ["The owner on chain is a marketplace escrow, which is where a listed item sits rather than with its seller - so a 'no' here can still mean the person controls the asset."]
      : []),
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

  // A listed item's owner is the marketplace's account, not the seller, and
  // the seller is not written anywhere this server can read. Saying
  // CONTRADICTED to the person who listed it is a confident wrong answer; the
  // honest one is that the chain cannot settle it from here.
  const venue =
    acct.owner === sol.MAGIC_EDEN_ESCROW
      ? "Magic Eden's escrow account, where a Magic Eden listing keeps the item"
      : (await sol.accountNature(acct.owner).catch(() => null))?.ownerProgram === sol.OPENSEA_SOLANA_PROGRAM
        ? `an OpenSea listing account (${acct.owner}), owned by OpenSea's Solana protocol program, where an OpenSea listing keeps the item`
        : null;
  if (venue) {
    return {
      ...base,
      verdict: "unverifiable",
      explanation:
        `The item is listed for sale. Its owner on chain is ${venue}, not a person's wallet. ` +
        `The seller of that listing cannot be read from the chain here, so whether ${wallet} is that seller, and so still owns the item, cannot be checked.`,
      evidence,
      caveats: [
        "get_asset_provenance on this item shows the wallet that moved it into the listing account; that wallet is the seller unless it has been sold since.",
        caveats[1]!,
      ],
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
  let statsError: { sentence: string; code: string | null } | undefined;
  let statsMissing = false;
  try {
    stats = await me.collectionStats(symbol, { fresh: true });
  } catch (e) {
    // Classified on the error CLASS, never on the upstream's words: a 5xx
    // whose body happened to contain "has no collection" was being reported
    // as an absence, which is a claim about the market built from a failure.
    statsMissing = e instanceof NotFoundError;
    statsError = plainReason(e);
  }
  if (!stats || stats.floorPriceSol === null) {
    const outage = Boolean(statsError) && !statsMissing;
    return {
      ...base,
      verdict: "unverifiable",
      explanation: outage
        ? `Magic Eden could not be read just now (${statsError!.sentence}), so the claim cannot be checked.`
        : `No live floor was returned for "${symbol}", so the claim cannot be checked.`,
      evidence: [],
      caveats: outage
        ? ["This is a source failure, not a statement about the collection. Retry shortly."]
        : ["A collection with no listings has no floor at all; an unknown symbol has none either."],
      ...(outage && statsError?.code ? { code: statsError.code } : {}),
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
      observed: `${observed} SOL reported, ${stats.listedCount ?? "?"} listed`,
    },
  ];
  const caveats = [
    "A floor is the lowest current ask on ONE marketplace and moves constantly - this was true at the moment of the call and may not be a minute later.",
    "Other marketplaces quote their own floors, sometimes in another currency. Use get_collection_stats for the cross-marketplace view.",
  ];

  // The venue's floor is the cheapest ask in its index, and its index keeps
  // listings after the item has moved. A receipt saying CONFIRMED on such a
  // listing was pasted as proof of a price nobody could pay, so the claim is
  // judged against the cheapest listing the chain shows can be bought.
  const check = await checkedFloor(symbol, observed, { fresh: true });
  const reproduceChecked =
    `${base.reproduce} Then GET /v2/collections/${symbol}/listings?sort=listPrice&sort_direction=asc&limit=100 and read each listed item's Metaplex Core account ` +
    `(getMultipleAccounts, bytes 1-33 are the owner): a listing counts only when that owner is the seller or Magic Eden's escrow ${sol.MAGIC_EDEN_ESCROW}.`;
  // Anything short of a checked floor, including pool and non-Core custody
  // that is deliberately left unread, gives no verdict either way.
  const reproduce = check.status === "not-core" ? base.reproduce : reproduceChecked;
  if (!check.checked || check.status === "none-backed") {
    return {
      ...base,
      reproduce,
      verdict: "unverifiable",
      explanation:
        check.status === "none-backed"
          ? `Magic Eden reports a floor of ${observed} SOL, but none of the ${check.listingsChecked} cheapest listing(s) read can be bought: in every one the chain shows the seller no longer holds the item. No ask that can be paid was found among them to check the claim against.`
          : check.status === "not-core"
            ? `Magic Eden reports a floor of ${observed} SOL. This collection is not Metaplex Core, so whether the seller behind that listing still holds the item is not checked here, and a receipt is only given on a checked listing. get_floor_prices shows Magic Eden's figure with that label.`
            : `Magic Eden reports a floor of ${observed} SOL, but the listing behind it could not be checked against the chain, and its floor can be a listing whose item has moved. ${check.sentence} This neither confirms nor contradicts a price someone can pay.`,
      evidence,
      caveats: [...caveats, ...(check.staleExamples.length ? [`Stale listings seen: ${check.staleExamples.map((s) => `${s.priceSol} SOL (${s.why})`).join("; ")}.`] : [])],
    };
  }
  const floor = check.floorSol;
  if (!comparable(floor)) {
    return { ...base, reproduce, verdict: "unverifiable", explanation: `No usable floor was found for "${symbol}" after checking its listings. ${check.sentence}`, evidence, caveats };
  }
  evidence.push({
    source: `Magic Eden collection listings for ${symbol}, each checked against its Solana account`,
    method: "The cheapest 100 listings, cheapest first; a listing counts only when the item's Core account names the seller or Magic Eden's escrow as its owner.",
    observed: `cheapest ask that can be bought ${floor} SOL${check.staleBelowFloor ? ` (${check.staleBelowFloor} cheaper stale listing(s) skipped)` : ""}`,
  });
  if (check.staleBelowFloor > 0) caveats.push(`${check.staleBelowFloor} cheaper listing(s) on Magic Eden were left out: the chain shows the seller no longer holds the item, so nobody can buy at those prices.`);

  // 2% tolerance: a floor moves while the claim is being made, and calling that
  // a lie would make the tool useless.
  if (near(floor, claimed, claimed * 0.02)) {
    return {
      ...base,
      reproduce,
      verdict: "confirmed",
      explanation: `Confirmed within 2%: the cheapest live ask that can be bought is ${floor} SOL against a claimed ${claimed} SOL.`,
      evidence,
      caveats,
    };
  }

  const dir = floor > claimed ? "higher" : "lower";
  const staleMatch = check.staleBelowFloor > 0 && near(observed, claimed, claimed * 0.02);
  return {
    ...base,
    reproduce,
    verdict: "contradicted",
    explanation:
      `Contradicted: the cheapest live ask that can be bought is ${floor} SOL, ${dir} than the claimed ${claimed} SOL by more than 2%.` +
      (staleMatch ? ` The claimed figure matches Magic Eden's reported floor of ${observed} SOL, which is a listing whose seller no longer holds the item.` : ""),
    evidence,
    caveats,
  };
}

/**
 * A claimed currency, by code or by mint address. Null when it names nothing
 * this module can compare, which the caller hears as bad input.
 */
function claimedCurrency(raw: string | undefined): { code: string | null; mint: string | null; label: string } | null {
  if (raw === undefined) return { code: "SOL", mint: null, label: "SOL" };
  const t = raw.trim();
  const code = t.toUpperCase();
  if (["SOL", "USDC", "USDT", "PYUSD"].includes(code)) return { code, mint: null, label: code };
  if (sol.isBase58Address(t)) {
    // The one table the marketplace rows and the decoder use too.
    const named = currencyByMint(t);
    return { code: named, mint: t, label: named ?? `the token ${t}` };
  }
  return null;
}

/**
 * The most a coarsely written price may sit from a figure, as a share of it.
 * "1" for 0.99456 is the same price rounded; "1" for 0.6 rounds the same way
 * and is a different price.
 */
const PRICE_ROUNDING_CAP = 0.05;
/**
 * A hair over half a unit. A figure exactly halfway (0.265 written as 0.27)
 * is a rounding of the claim, and floating point puts it a few units in the
 * last place past the half.
 */
const HALF_UNIT = 0.5 * (1 + 1e-9);

/** Decimal places a claimed number was written with: 0.27 has two, 1 has none, 1e-7 has seven. */
function writtenDecimals(n: number): number {
  const m = /^\d+(?:\.(\d+))?(?:e([+-]?\d+))?$/i.exec(String(n));
  if (!m) return 0;
  return Math.max(0, (m[1]?.length ?? 0) - (m[2] ? Number(m[2]) : 0));
}

/**
 * How far a figure may sit from a claim and still be the figure the person
 * meant: half a unit of the last place they wrote, so 0.27 is 0.267 rounded
 * and 0.034193384, written to nine places, is not 0.03432567. A flat share of
 * the figure on top of that confirmed fully written prices that are a
 * rounding of no figure at all (383 of 507 confirmations in one sweep of the
 * real sales, up to 4.8% away).
 */
const roomFor = (claimed: number, figure: number, slack: number): number =>
  Math.min(HALF_UNIT * 10 ** -writtenDecimals(claimed), figure * PRICE_ROUNDING_CAP) + slack;

/**
 * A sale, checked against the transaction it names.
 *
 * The feeds quote one fill differently: Magic Eden reported 0.0039 SOL and
 * OpenSea 0.004368 SOL for the same transaction, because one quotes what the
 * seller listed at and the other what the buyer paid. A seller quotes what
 * reached their wallet, after the network fee they paid, and an accepted
 * offer is quoted at its order price, between what the seller kept and what
 * the buyer paid in all. All of these are true, so the chain gives each one
 * it can read, and a claim is confirmed when it matches any of them at the
 * precision it was written, saying which. It is contradicted only when the
 * transaction was read and shows something else: not a sale of this item,
 * another currency, or a price outside every figure. A claim between the
 * smallest and the largest figure that matches none is unverifiable, because
 * a price quoted after some fees but not others reads like that. A
 * transaction that could not be read, that moved several items, whose buyer
 * and seller are one wallet, or whose figures carry returned rent too large
 * to rule a claim in or out, is unverifiable for a price: the same currency,
 * multi-item and self-fill rules the marketplace sale rows follow.
 */
async function verifySale(signature: string, item: string, claimed: number | undefined, currencyArg: string | undefined): Promise<Omit<VerificationResult, "receipt">> {
  const wanted = claimedCurrency(currencyArg);
  if (!wanted) throw new BadInputError("currency must be SOL, USDC, USDT, PYUSD or a token's mint address");
  const base = {
    claim: `${item} was sold in this transaction${claimed !== undefined ? ` for ${claimed} ${wanted.label}` : ""}`,
    subject: signature,
    reproduce:
      `Call getTransaction on ${signature} with encoding jsonParsed and maxSupportedTransactionVersion 1 against any Solana RPC. ` +
      `Find the Metaplex Core TransferV1 (program ${sol.CORE_PROGRAM}, first data byte 14) whose first account is ${item}: its fifth account is the new owner. ` +
      `The marketplace instruction that called it names the venue, and the System Program or token transfers inside that instruction are the payments, each with its recipient. No key is needed.`,
  };
  if (claimed !== undefined && !comparable(claimed)) {
    return { ...base, verdict: "unverifiable", explanation: unusableClaim(claimed), evidence: [], caveats: ["Pass a finite price above zero."] };
  }
  let read: Awaited<ReturnType<typeof readSale>>;
  try {
    read = await readSale(signature, item);
  } catch (e) {
    // A transaction format newer than this server reads is the server being
    // out of date, not the chain being busy: the shared reader says so, and
    // a retry would not help.
    const outdated = e instanceof TypedError && e.kind === "unsupported" ? e.wording : undefined;
    const why = plainReason(e);
    return {
      ...base,
      verdict: "unverifiable",
      explanation: outdated
        ? `${outdated.headline} The sale cannot be checked here.`
        : `The chain could not be read for this transaction just now (${why.sentence}), so the sale cannot be checked.`,
      evidence: [],
      caveats: [outdated ? `This is not a statement about the sale. ${outdated.next}` : "This is a source failure, not a statement about the sale. Retry shortly."],
      ...(why.code ? { code: why.code } : {}),
    };
  }
  const evidence: Evidence[] = [];
  const where = `Solana transaction ${signature}`;
  const at = read.time ? `, block time ${read.time}` : "";
  if (read.status === "cannot-tell") {
    return {
      ...base,
      verdict: "unverifiable",
      explanation: `${read.reason} The claim is neither confirmed nor contradicted.`,
      evidence: [{ source: where, method: "Read with getTransaction and decoded for this item's Metaplex Core transfer.", observed: `could not decide${at}` }],
      caveats: read.notes,
    };
  }
  if (read.status === "not-a-sale") {
    evidence.push({ source: where, method: "Read with getTransaction and decoded for this item's Metaplex Core transfer and the program that made it.", observed: `not a sale (${read.kind ?? "other"})${read.venue ? `, ${read.venue}${read.instruction ? ` ${read.instruction}` : ""}` : ""}${at}` });
    return {
      ...base,
      verdict: "contradicted",
      explanation: `Contradicted: the chain shows this transaction is not a sale of ${item}. ${read.reason}`,
      evidence,
      caveats: ["A transaction signature names one transaction. If the sale happened, it is in another one; get_asset_provenance lists the item's transactions."],
    };
  }

  // A sale. What it was, then the money.
  const sale: ChainSale = read;
  const aVenue = `${/^[AEIOU]/.test(sale.venue ?? "") ? "an" : "a"} ${sale.venue}`;
  const AVenue = aVenue[0]!.toUpperCase() + aVenue.slice(1);
  evidence.push({
    source: where,
    method: `The item's Metaplex Core transfer, made inside ${sale.venue} ${sale.instruction}; buyer and seller from that instruction's accounts (${sale.layout === "published" ? "the venue's published layout" : sale.layout === "observed" ? "a layout read from real transactions" : sale.layout === "published-unchecked" ? "the venue's published layout, not yet checked against a real transaction of this kind" : "a layout inferred from a sibling program"}).`,
    observed: `${sale.venue} sale${at}, seller ${sale.seller}, buyer ${sale.buyer}${sale.collection ? `, collection ${sale.collection}` : ""}`,
  });
  const caveats = [
    "Marketplaces quote one fill differently. Magic Eden and Tensor quote a listing's price, which is what the seller receives, with royalties and fees added for the buyer; OpenSea quotes the buyer's total, from which the seller's share is net; an accepted offer is quoted at its order price, from which the seller pays the fee. The chain gives each figure it can read, and a claim matching any of them at the precision it was written is confirmed.",
    ...sale.notes,
  ];
  if (read.endpoint) evidence.push({ source: `Solana RPC endpoint ${read.endpoint}`, method: "The endpoint that served the transaction. A confirmed transaction is the same on every node.", observed: `read at ${read.readAt}` });
  const cur = sale.currency;
  if (cur) {
    const money = [
      sale.price !== null && sale.price !== undefined ? `everything paid for the item ${sale.price}` : null,
      sale.orderPrice !== undefined ? `order price ${sale.orderPrice}` : null,
      sale.sellerReceived !== null && sale.sellerReceived !== undefined ? `seller received ${sale.sellerReceived}` : null,
      sale.sellerAfterFee !== undefined ? `seller kept ${sale.sellerAfterFee} after the network fee` : null,
      sale.buyerPaid !== null && sale.buyerPaid !== undefined ? `buyer paid ${sale.buyerPaid}` : null,
    ].filter(Boolean);
    evidence.push({
      source: where,
      method:
        sale.priceBasis === "venue-transfers"
          ? "The transfers inside the venue's instruction, each with its recipient: the seller's share, then royalty and fee legs."
          : sale.priceBasis === "balance-changes"
            ? "Balance changes, because the venue moved the money without a transfer instruction to read."
            : sale.priceBasis === "buyer-balance"
              ? "The buyer's balance change, because the seller's proceeds were not visible."
              : "No per-item amount could be stated.",
      observed: `${money.length ? money.join(", ") : "no per-item price"} (${cur.label})`,
    });
  }
  if (sale.selfFill) caveats.unshift("The buyer and the seller are the same wallet. A self-fill happened on chain, but it is not evidence of a market price.");

  // Before the currency: which payment was the seller's rests on the slots,
  // so a currency read through an unchecked layout is no ground for a
  // contradiction either.
  if (sale.layout !== "published" && sale.layout !== "observed") {
    return {
      ...base,
      verdict: "unverifiable",
      explanation:
        sale.layout === "inferred"
          ? `The chain shows ${aVenue} ${sale.instruction} that moved this item, but the buyer and seller slots for that instruction are inferred and no real transaction of its kind has been checked, so no verdict is given on it.`
          : `The chain shows ${aVenue} ${sale.instruction} that moved this item, but the buyer and seller slots for that instruction come from the venue's published code and no real transaction of its kind has been checked against them, so no verdict is given on it.`,
      evidence,
      caveats,
    };
  }
  // The currency, by mint address. Anything else is never SOL.
  if (cur && (claimed !== undefined || currencyArg !== undefined)) {
    const same = wanted.mint ? cur.mint === wanted.mint || (wanted.code === "SOL" && cur.code === "SOL") : wanted.code !== null && cur.code === wanted.code;
    if (!same) {
      return {
        ...base,
        verdict: "contradicted",
        explanation: `Contradicted: ${aVenue} sale of this item did happen here, but it was paid in ${cur.label}, not ${wanted.label}.${cur.paidInOtherToken ? " An amount in another token is never a SOL figure." : ""}`,
        evidence,
        caveats,
      };
    }
  }
  // The marketplace rows' rule: a self-fill is a sale, and its amount is no
  // evidence of what anyone paid, so it is in no money figure. A claimed price
  // is therefore neither confirmed nor contradicted by one, and neither is a
  // claim that the item "was sold": one wallet on both sides sold it to nobody.
  if (sale.selfFill) {
    return {
      ...base,
      verdict: "unverifiable",
      explanation:
        `${AVenue} fill of this item did happen in this transaction, but the buyer and the seller are the same wallet (a self-fill): no money changed hands between two parties, ` +
        (claimed === undefined ? "so it is not a sale from one owner to another and the claim is neither confirmed nor contradicted by it." : `so its amount is not a price anyone paid and a ${claimed} ${wanted.label} claim is neither confirmed nor contradicted by it.`),
      evidence,
      caveats,
    };
  }
  if (claimed === undefined) {
    return { ...base, verdict: "confirmed", explanation: `Confirmed against the chain: ${sale.reason}`, evidence, caveats };
  }
  if (sale.price === null || sale.price === undefined) {
    return {
      ...base,
      verdict: "unverifiable",
      explanation: `${AVenue} sale of this item did happen in this transaction, but its price cannot be proven: ${(sale.noPriceReason ?? "no per-item amount could be stated").replace(/\.$/, "").replace(/^[A-Z](?=[a-z])/, (c) => c.toLowerCase())}.`,
      evidence,
      caveats,
    };
  }
  const slack = sale.priceExact ? 0 : sale.priceSlack ?? 0;
  if (slack > sale.price * 0.05) {
    return {
      ...base,
      verdict: "unverifiable",
      explanation: `${AVenue} sale of this item did happen here, but its figures come from balance changes that can include up to ${slack} ${cur?.label ?? ""} of returned rent, too much to rule a ${claimed} claim in or out.`,
      evidence,
      caveats,
    };
  }
  const unit = cur?.label ?? "";
  const figures = [
    { what: "the order price written in the marketplace instruction", value: sale.orderPrice },
    { what: "what the seller received", value: sale.sellerReceived },
    { what: "what the seller kept after the network fee it paid", value: sale.sellerAfterFee },
    { what: "what the buyer paid", value: sale.buyerPaid },
    { what: "everything paid for the item (the buyer's total)", value: sale.price },
  ].filter((f): f is { what: string; value: number } => comparable(f.value));
  // A figure the claim matches as written comes first; rounding at the
  // claim's precision is used only when none does, so "1 SOL" on an order of
  // exactly 1 is named as that, not also as the 0.98 the seller kept.
  const close = figures.filter((f) => near(f.value, claimed, slack));
  const hits = close.length > 0 ? close : figures.filter((f) => near(f.value, claimed, roomFor(claimed, f.value, slack)));
  if (hits.length > 0) {
    // Figures that are the same amount are named together, so a reader sees
    // that 2 SOL is both the order price and what the seller received.
    const byValue = new Map<number, string[]>();
    for (const h of hits) byValue.set(h.value, [...(byValue.get(h.value) ?? []), h.what]);
    const named = [...byValue.entries()].map(([value, whats]) => `${whats.join(" and ")}, ${value} ${unit}`).join("; and ");
    const rounded = hits.every((h) => h.value !== claimed) ? ` (${claimed} is that figure at the precision it was written)` : "";
    return {
      ...base,
      verdict: "confirmed",
      explanation: `Confirmed against the chain: ${aVenue} sale of this item, and ${claimed} ${wanted.label} matches ${named}${rounded}.`,
      evidence,
      caveats,
    };
  }
  const listed = `${figures.map((f) => `${f.what} ${f.value}`).join(", ")} ${unit}`;
  const lo = figures.reduce<{ what: string; value: number } | null>((a, f) => (a === null || f.value < a.value ? f : a), null);
  const hi = figures.reduce<{ what: string; value: number } | null>((a, f) => (a === null || f.value > a.value ? f : a), null);
  if (lo && hi && claimed > lo.value && claimed < hi.value) {
    return {
      ...base,
      verdict: "unverifiable",
      explanation:
        `${AVenue} sale of this item did happen here, and ${claimed} ${wanted.label} lies between ${lo.what} (${lo.value}) and ${hi.what} (${hi.value}) without matching any figure the chain shows (${listed}). ` +
        `A price quoted after some fees but not others reads like this, so the claim is neither confirmed nor contradicted.`,
      evidence,
      caveats,
    };
  }
  return {
    ...base,
    verdict: "contradicted",
    explanation: `Contradicted: ${aVenue} sale of this item did happen here, but the chain shows ${listed}, and ${claimed} matches none of them.`,
    evidence,
    caveats,
  };
}

export type ClaimType = "supply" | "never-traded" | "ownership" | "floor" | "sale";

const MARK: Record<Verdict, string> = { confirmed: "CONFIRMED", contradicted: "CONTRADICTED", unverifiable: "UNVERIFIABLE" };
const short = (s: string) => (s.length > 12 ? s.slice(0, 4) + "…" + s.slice(-4) : s);

export function buildReceipt(r: Omit<VerificationResult, "receipt">, at = new Date()): string {
  const observed = r.evidence.map((e) => e.observed).join(", ");
  const onChain = r.evidence.length > 0 && r.evidence.every((e) => /Solana|Core|account|transaction/i.test(e.source));
  const venue = (src: string) => src.split(/ (collection|stats|account|for) /)[0] ?? src;
  const srcLabel = r.evidence.length === 0 ? "" : onChain ? "chain shows" : `${[...new Set(r.evidence.map((e) => venue(e.source)))].join(" + ")} shows`;
  // A receipt with nothing read still says when the check was tried: an
  // UNVERIFIABLE pasted without a time cannot be told from one made last week.
  const how =
    r.evidence.length === 0
      ? ` · attempted via solana-nft-mcp at ${at.toISOString()}`
      : onChain
        ? ` · checked on-chain via solana-nft-mcp at ${at.toISOString()}, reproducible with no key`
        : ` · marketplace read via solana-nft-mcp at ${at.toISOString()}, reproducible with no key`;
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
  item?: string;
  currency?: string;
}): Promise<VerificationResult> {
  const { claim, subject, value, wallet, item, currency } = args;
  return withReceipt(await route({ claim, subject, value, wallet, item, currency }));
}

async function route(args: {
  claim: ClaimType;
  subject: string;
  value?: number;
  wallet?: string;
  item?: string;
  currency?: string;
}): Promise<Omit<VerificationResult, "receipt">> {
  const { claim, subject, value, wallet, item, currency } = args;
  switch (claim) {
    case "sale":
      if (!isSignature(subject)) throw new BadInputError("sale claims take the transaction signature as `subject` (base58 that decodes to 64 bytes, usually 87 or 88 characters)");
      if (!item) throw new BadInputError("sale claims need `item` - the address of the item said to be sold");
      return verifySale(subject, item, value, currency);
    case "supply":
      if (value === undefined) throw new BadInputError("supply claims need `value` - the number being claimed");
      return verifySupply(subject, value);
    case "never-traded":
      return verifyUntraded(subject);
    case "ownership":
      if (!wallet) throw new BadInputError("ownership claims need `wallet` - the address said to own it");
      return verifyOwnership(subject, wallet);
    case "floor":
      if (value === undefined) throw new BadInputError("floor claims need `value` - the price being claimed, in SOL");
      return verifyFloor(subject, value);
  }
}
