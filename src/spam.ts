/**
 * Airdrop spam in a wallet, labelled rather than hidden.
 *
 * The problem this solves, measured on a real wallet: the chain reported 1,171
 * items and 1,166 of them were unsolicited compressed drops - "Redeem NFT
 * Voucher", "104 SOL For You ETHCrate.com", "WEN Vоucher" with a Cyrillic o in
 * place of the Latin one. The five things the person actually collects were
 * buried. Any honest summary has to separate the two, and until now that
 * separation only happened when a model happened to notice.
 *
 * Two rules govern this file:
 *
 * 1. Nothing is ever removed. Every item is returned; some carry a label and
 *    the reasons for it. A filter that drops rows silently is how a real
 *    holding disappears from a wallet report.
 * 2. Every signal is named in the output. "Likely spam" with no reason is an
 *    opinion; "the name contains a web address and a token amount" is evidence
 *    the reader can overrule.
 *
 * These are heuristics about names, not a blocklist, so they cost nothing and
 * cannot go stale. They are deliberately conservative: a real collection with
 * a website in its name is mislabelled far less often than a scam drop goes
 * uncaught, and the label always travels with its reasons.
 */

export interface SpamVerdict {
  likelySpam: boolean;
  /** Named signals, in the order they were tested. Empty when nothing fired. */
  signals: string[];
}

export interface SpamCandidate {
  name?: string | null;
  compressed?: boolean | null;
  collection?: string | null;
  collectionVerified?: boolean | null;
}

/** A web address in an item's name: the click the drop exists to buy. */
const WEB_ADDRESS = /\b(?:https?:\/\/|www\.)|\b[a-z0-9-]{3,}\.(?:com|net|org|io|xyz|app|fun|site|link|live|gift|cash|club|vip|top|pro|shop)\b/i;

/** Claim bait: the words a drop uses to move somebody to a website. */
const REWARD_BAIT =
  /\b(?:voucher|vouchers|claim|claimable|airdrop|reward|rewards|giveaway|winner|prize|bonus|free\s+mint|redeem|eligible|congratulations|you\s+won|gift)\b/i;

/** A token amount in a name, with or without a currency mark: "104 SOL For You", "$1700". */
const MONEY = /(?:[$€£]\s?\d|\b\d[\d,.]*\s*(?:sol|usdc|usdt|eth|btc|k|m)\b)/i;

/**
 * Latin letters mixed with lookalikes from another script - the Cyrillic о in
 * "Vоucher". A name written entirely in another script is a name; a name that
 * is ASCII except for two substituted letters is a disguise.
 */
function hasHomoglyphs(name: string): boolean {
  const latin = /[a-z]/i.test(name);
  if (!latin) return false;
  // Cyrillic and Greek blocks only: these are the ones whose letters are drawn
  // like Latin ones. Emoji, punctuation and CJK are not disguises.
  return /[Ѐ-ӿͰ-Ͽ]/.test(name);
}

/**
 * Judge one item. `compressed` matters because minting a compressed asset into
 * a stranger's wallet costs a fraction of a cent, which is what makes mass
 * drops worth sending at all - but on its own it proves nothing, so it only
 * ever appears alongside a naming signal.
 */
export function classifyAirdrop(item: SpamCandidate): SpamVerdict {
  const name = typeof item.name === "string" ? item.name : "";
  const signals: string[] = [];
  if (WEB_ADDRESS.test(name)) signals.push("the name contains a web address");
  if (REWARD_BAIT.test(name)) signals.push("the name offers a reward to claim");
  if (MONEY.test(name)) signals.push("the name puts a token amount in front of the reader");
  if (hasHomoglyphs(name)) signals.push("the name mixes Latin letters with lookalikes from another alphabet");
  // A naming signal is what makes it spam. The cheap-to-mint standard and the
  // missing collection are corroboration, added only when something already
  // fired, so an unverified cNFT is never called spam for that alone.
  const decided = signals.length > 0;
  if (decided && item.compressed === true) signals.push("it is a compressed asset, which costs a fraction of a cent to mint into any wallet");
  if (decided && item.collectionVerified !== true) signals.push("it belongs to no verified collection");
  return { likelySpam: decided, signals };
}

export interface SpamSummary {
  /** How many of the items examined carry the label. */
  likelySpam: number;
  /** How many items were examined. Never the wallet's total unless the walk finished. */
  examined: number;
  /** Items left after the labelled ones, for a reader who wants the short version. */
  rest: number;
  rule: string;
  note: string;
}

/** Count the labels across a page of items, and say what the count does and does not mean. */
export function summariseAirdrops(verdicts: SpamVerdict[]): SpamSummary {
  const likelySpam = verdicts.filter((v) => v.likelySpam).length;
  return {
    likelySpam,
    examined: verdicts.length,
    rest: verdicts.length - likelySpam,
    rule: "An item is labelled when its NAME sells something: a web address, a reward to claim, a token amount, or Latin letters mixed with lookalikes from another alphabet.",
    note:
      "Labelled, never removed - every item is still in the list with its reasons. This is a judgement about names, so check any item before acting on the label, " +
      "and read the remainder as what is left after the labels rather than as a verified list of real holdings.",
  };
}
