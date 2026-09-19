/**
 * The three prompt bodies, as constants, in a module with no side effects.
 *
 * They live apart from the server for one reason: the install bundle has to
 * declare the SAME words. Claude Desktop compares the text a prompt returns
 * against the text the manifest declares and rejects a mismatch as a possible
 * injection, showing the person only "Failed to attach prompt". Retyping them
 * in the bundle script would mean two copies that drift; importing the server
 * itself would start a server inside the build. So both sides import this.
 *
 * Three rules the wording follows, learned from watching this fail in a real
 * client:
 *
 *  1. No interpolation. A prompt whose text changes with an argument cannot
 *     match a fixed declaration, and a fixed declaration is what the client
 *     checks against.
 *  2. No argument dialogs. Each prompt asks for what it needs in the
 *     conversation instead, which works in every client and cannot get out of
 *     step with a manifest.
 *  3. Read the conversation before asking. Without this, attaching a report
 *     right after naming a collection answers with "which collection?", which
 *     is worse than typing the question outright. The prompt earns its place
 *     by fixing the SHAPE of the answer - the ceiling framing, the spam split,
 *     the section saying what could not be seen - not by collecting input.
 *
 * Line breaks are deliberate: a client attaches this as a text file, and one
 * long line shows up in the chip as "1 line", looking like an empty file.
 */
export const PROMPT_TEXTS = {
  getting_started:
    "I just installed collector-mcp and I do not know what to ask yet. Use its own tools, not your memory.\n" +
    "Call get_source_status and tell me which sources are live right now and whether OpenSea is on.\n" +
    "Say in plain language what this server can answer: the history of a single card, who can freeze or burn it, " +
    "what a collection is worth at floor and what actually sold, the cheapest listings and low serial numbers, " +
    "and what any wallet holds and how it trades.\n" +
    "Say clearly what it cannot do: it never moves anything, never signs anything, and only reads public data.\n" +
    "Then give me five questions I can copy, using real collections you can resolve with search_collections.\n" +
    "Keep it short and skip the tool names.",
  collection_report:
    "Build a market report with the collector-mcp tools.\n" +
    "If I have already named a collection in this conversation, use that one and start now. " +
    "Only ask me which collection I mean if I have not named one yet, and do not offer a list of guesses.\n" +
    "Resolve the identifiers first, then supply and floor, then what actually sold recently with the price range and how many changed hands.\n" +
    "Then pick one recently traded item and show its ownership history as a short story.\n" +
    "Close with what a buyer would want to know next. Label anything stale, and never call a floor a valuation.",
  wallet_report:
    "Profile a wallet as a collector with the collector-mcp tools.\n" +
    "If I have already pasted a wallet address in this conversation, use that one and start now. " +
    "Only ask me for an address if I have not given one yet.\n" +
    "Lead with what it collects, how much of the wallet each collection is, how old the wallet is, " +
    "and the floor ceiling, called a ceiling rather than a value.\n" +
    "Then how it trades: buys against sells, net flow, hold times, and the behaviour label with its reason.\n" +
    "Then say what the feeds could not see, including other marketplaces, plain transfers, and anything the index could not name.\n" +
    "Flag airdrop spam separately from real holdings.",
} as const;

/** Name, title and one line of description, in the order a person should meet them. */
export const PROMPT_LIST = [
  ["getting_started", "Start here: what can I ask?", "New to collector-mcp? What it answers, and five questions to try."],
  ["collection_report", "Collection market report", "Supply, floor, what sold, and one item's story, for a collection you name."],
  ["wallet_report", "Wallet report", "What a wallet collects, how it trades, and what it is worth at floor as a ceiling."],
] as const satisfies readonly (readonly [keyof typeof PROMPT_TEXTS, string, string])[];
