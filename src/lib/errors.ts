/**
 * Typed failures, so the layer that words an error for a person classifies on
 * a TYPE rather than on the text of a message.
 *
 * The trap this closes: the public error layer decided "this identifier does
 * not exist" by matching /not found|does not exist/ against an error message.
 * Upstream bodies reach that layer, and an upstream that answers a real
 * collection with the words "not found" in its body could make this server
 * assert a thing does not exist - a claim about the world, decided by somebody
 * else's text. Every place that knows what a failure MEANS now says so by
 * throwing one of these, and the wording layer reads `kind`.
 */

/** The failure kinds the public error layer can word specifically. */
export type FailureKind = "not-found" | "wrong-kind" | "escrow" | "unsupported" | "bad-input";

/** Base class carrying the kind, so one `instanceof` covers every typed failure. */
export class TypedError extends Error {
  constructor(
    msg: string,
    public readonly kind: FailureKind,
  ) {
    super(msg);
    this.name = new.target.name;
  }
}

/** The sources looked and nothing matched. Only thrown where an ABSENCE was actually established. */
export class NotFoundError extends TypedError {
  constructor(msg: string) {
    super(msg, "not-found");
  }
}

/** The identifier is real but is a different kind of thing than the tool takes (a collection passed to an item tool). */
export class WrongKindError extends TypedError {
  constructor(msg: string) {
    super(msg, "wrong-kind");
  }
}

/** The address is a marketplace escrow or a program account, not a person's wallet. */
export class EscrowError extends TypedError {
  constructor(msg: string) {
    super(msg, "escrow");
  }
}

/** A capability this read needs is not being served (the public asset index withdrawing DAS methods). */
export class DasUnsupported extends TypedError {
  constructor(msg: string) {
    super(msg, "unsupported");
  }
}

/** What the caller passed cannot be used, decided by us rather than by an upstream body. */
export class BadInputError extends TypedError {
  constructor(msg: string) {
    super(msg, "bad-input");
  }
}

/**
 * When several readers were asked and every one failed, the failure to report
 * is the one that carries a kind. A wrapper Error built from the messages
 * loses the kind, so the wording layer can only say "try again" about an
 * address that is, and will stay, a marketplace escrow.
 */
export function firstTypedFailure(settled: PromiseSettledResult<unknown>[]): TypedError | null {
  for (const r of settled) {
    if (r.status === "rejected" && r.reason instanceof TypedError) return r.reason;
  }
  return null;
}
