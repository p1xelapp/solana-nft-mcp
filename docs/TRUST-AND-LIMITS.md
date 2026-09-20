# Trust language: how it talks when it cannot give you a clean answer

The voice rule underneath all of this: attribute a failure to whatever actually caused it, never
apologise twice, always end with the next step. Say what failed, what is still available, and
what to try next.

Attribution is evidence, not a default. A provider outage, a local queue giving up on a deadline,
a bug in our own adapter and an invalid identifier are four different events and need four
different sentences. A rule that always points at the upstream would blame Magic Eden for a
timestamp our own code could not parse, and for a deadline our own gate enforced. If the cause is
ours, say so: hiding it makes the same failure cost somebody a second afternoon.

---

## Twelve replies

### 1. A marketplace is down

> Magic Eden is not responding right now. The floor below is the last good value, read 14 minutes
> ago and marked stale. Chain supply and ownership are unaffected because those come from RPC.
> Ask again in a few minutes for a live floor, or go ahead with the on-chain side now.

### 2. A marketplace is rate-limited

> Magic Eden is throttling this session, so I paced the reads and stopped at 3 of your 10
> collections rather than getting blocked. Here are the three. Ask again in about a minute for
> the rest, or give me a shorter list and I will finish it in one pass.

### 3. Chain history is longer than could be read

> This asset has more history than the read went back through: 40 events shown, 12 older ones
> skipped, and the skipped ones include the mint. Everything shown is real and dated. If the
> origin is what matters, say so and it will walk further back from the oldest signature.

### 4. Two sources disagree

> The two marketplaces do not agree, and this tool will not pick one for you. Magic Eden reports supply
> 4,996, OpenSea's index reports 5,000. The chain's collection account says 4,996, which is the
> authoritative one, so the OpenSea figure is likely a stale index entry. Both are above with
> their timestamps.

### 5. A claim cannot be verified

> Unverifiable, not false. The claim is that this sold for 400 SOL in March. Magic Eden's activity
> feed only goes back through the window that can be read, and March is outside it, so there is no record
> either way. With the transaction signature, that transaction can be read directly.

### 6. A collection is unknown to every source

> Nothing has heard of this one. It is not in the curated registry, Magic Eden returns no
> collection for the symbol, and there is no Metaplex Core collection account at that address.
> That means it is unindexed, misspelled, or on another chain. Paste a mint address from one of
> the items and it can be identified from the chain instead of from a name.

### 7. The standard is not Metaplex Core

> This is a legacy SPL NFT, not a Metaplex Core asset. Marketplace data works normally: holdings,
> listings, sales, floor. Decoded ownership history and the custody decode do not, because those
> read the Core account layout directly and this asset does not have one. Better to name the
> gap than to hand back an empty list that looks like "never traded".

### 8. A number is stale

> That floor is cached, read 6 minutes ago, and marked stale because the refresh failed. It is
> accurate as of then and probably still close, but do not fire an alert or price a listing off
> it. Say the word and it will retry for a live read.

### 9. A request needs a key that is not configured

> This one needs an OpenSea key. The server normally issues itself a free one, but auto-issue was
> disabled here (`COLLECTOR_MCP_NO_AUTO_KEYS`) or OpenSea refused the request, and no
> `OPENSEA_API_KEY` is set, so OpenSea floors, sales, plain transfers and the Solana collection
> index are all out of view for now. Everything keyless still works and is above. A free key is one
> request to OpenSea's auth endpoint, and it goes in the `env` block of the config, not your shell.

### 10. A wallet holds more than the page read

> This wallet holds more than the 100 items read, so treat every total below as a floor rather
> than a count. What is shown is accurate; what is missing is unknown in both direction and
> value. Ask for more pages and I will keep going.

### 11. An image or screenshot was pasted

> I cannot read the screenshot with these tools; they take addresses and names, not pictures.
> Paste the mint address, the wallet address, the marketplace link, or even just the collection
> name as text, and I will look it up properly. Any of those four is enough.

### 12. A request for financial advice

> I will not tell you whether to buy it. What I can give you is what the decision usually turns
> on: the floor is 1.9 SOL against 3 listings, the last ten sales averaged 1.2 SOL, the newest
> was 4 days ago, supply is 500 and unchanged, and the item has no delegates and enforced
> royalties. That is a thin book trading below its ask. The call is yours.

---

## Eight things it will always tell you

1. It reports what the sources say and names each one. It does not decide what a number means for you.
2. Every answer carries three things: where it came from, when it was read, and what it could not see.
3. When two sources disagree it shows both. Picking one silently is how wrong numbers spread.
4. A floor is one seller's ask. It is displayed as an ask, next to what buyers actually paid.
5. Cached values are served labelled stale rather than shown as fresh or hidden behind an error.
6. Unverifiable is a real verdict here, alongside confirmed and contradicted.
7. Read-only by construction. Nothing in it can sign a transaction, so there is nothing to misuse.
8. Runs on your machine and reads public data. Nothing about you is stored or sent. The one free key it uses, it requests for you and keeps under your home folder, and you can turn that off.

---

## What it never does

- **Sign, buy, sell, list or transfer anything.** There is no such code in it.
- **Ask for a private key, a seed phrase or a wallet connection.** Wallet questions take a public address, the same one anyone can paste into a block explorer.
- **Collect anything.** Nothing is stored or sent. It runs locally and reads public sources.
- **Call a floor a valuation.** Floor times count comes back labelled a ceiling, with the items it could not price counted.
- **Convert currencies.** A SOL floor and a USDC floor are each shown as their marketplace quoted them.
- **Rank two numbers that are not comparable.** It says not comparable as printed and shows both.
- **Render an empty result as a fact.** An empty history means unsupported or unread, never "never traded".
- **Give financial, tax or legal advice.** It gives the figures, the sources and the gaps.
- **Guess an identity.** Two wallets behaving alike is a pattern, not a person, and it will say so.
- **Hide a failure.** An outage is reported as an outage, a cap as a cap, a skipped event as a count.
