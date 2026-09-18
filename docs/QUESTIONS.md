# Questions people actually ask

Every line is phrased the way someone types it, not the way a tool is named. Try any of them with your own
collection name or address.

**Status key**
- `ANSWERS NOW` - works today.
- `PARTIAL` - part of it answers, the rest is named as a gap.
- `NOT YET` - honest reason given in one clause.

---

## 1. Market research

| Question | How it is answered | Status |
|---|---|---|
| "what's the floor on Claynosaurz" | Collection stats: Magic Eden floor plus OpenSea floor with a key, currencies kept separate | ANSWERS NOW |
| "is this collection dead or just quiet" | Floor and listed count next to recent sales and how many events were scanned to find them | ANSWERS NOW |
| "how much volume did this do in the last 7 days" | Collection sales over a window: count, volume, highest sale | ANSWERS NOW |
| "what's hot on Magic Eden right now" | Trending list with the numbers behind the ranking | ANSWERS NOW |
| "is the floor real or is it one guy" | Floor plus listed count plus last ten sales; a thin book gets called thin | ANSWERS NOW |
| "what are people actually paying, not asking" | Recent sales only counts completed buys, never listings | ANSWERS NOW |
| "did the floor move this week" | Daily series over the window shows the shape; single-point floor is live only | ANSWERS NOW |
| "which marketplace is cheaper for this collection" | Reconciliation block; when the currencies differ it shows both and refuses to rank | PARTIAL (ranks only when currencies match, by design) |
| "how many are listed vs how many exist" | Listed count from the marketplace, existing supply from the chain, both labelled | ANSWERS NOW |
| "what's the biggest sale this collection has ever had" | Window-based highest sale only; all-time needs history older than the marketplace keeps | PARTIAL (window covered, all-time not) |
| "give me the floor for these 8 collections at once" | Batch floor lookup, up to ten in one call, sequenced through one rate gate | ANSWERS NOW |
| "how does this month compare to last month" | Two windows of collection sales, compared side by side | ANSWERS NOW |
| "what's the average sale price right now" | Derived from recent sales in the window, labelled as derived and as a window average | ANSWERS NOW |

---

## 2. Deals and hunting

| Question | How it is answered | Status |
|---|---|---|
| "find me the cheapest one with a hat" | Trait filter plus best deals, ranked against the trait floor | ANSWERS NOW |
| "find #1390" | Name search across the Magic Eden index, then the asset lookup | ANSWERS NOW |
| "what's the cheapest Rex" | Per-trait floor for that trait, plus the listings at it | ANSWERS NOW |
| "is anything listed below floor right now" | Best deals compares listing price against the relevant trait floor, not just the collection floor | ANSWERS NOW |
| "show me every listing under 2 SOL with gold background" | Trait filter plus price bound over the listing set | ANSWERS NOW |
| "what does a low serial usually go for" | Recent sales can be read for comparable serials; there is no automatic serial-tier pricing | PARTIAL (sales shown, comparison is manual) |
| "is this a good buy" | Floor, recent sales, supply and custody facts are given; the recommendation is not | PARTIAL (facts yes, verdict never) |
| "alert me when something drops under 1 SOL" | The data for the check is available; the watching loop is something you build, with a recipe | PARTIAL (data now, scheduling is yours) |
| "which trait is actually rare here" | Per-trait floors show what the market prices as rare; rarity rank itself is not computed | PARTIAL (price signal, not a rarity score) |
| "how much cheaper is OpenSea than Magic Eden for this" | Both floors with currencies; a spread only when comparable | PARTIAL (spread only in matching currency) |
| "anything from this collection sold cheap in the last day" | Recent sales sorted by price over a one-day window | ANSWERS NOW |
| "cheapest one that has never been sold" | Listing price is available, but never-traded is only verifiable per asset for Core assets, one at a time | PARTIAL (per item yes, bulk filter no) |

---

## 3. A specific item

| Question | How it is answered | Status |
|---|---|---|
| "what is this" (pastes a mint or a marketplace link) | Identify works out what the string is and what to look up next | ANSWERS NOW |
| "who has owned this card" | Full ownership history for Core assets decoded from RPC, dated, marketplaces named | ANSWERS NOW (Core only) |
| "has this ever been sold" | Claim verification returns confirmed, contradicted or unverifiable with the transfer count | ANSWERS NOW (Core only) |
| "is this legit" | Identify plus collection stats plus the custody decode; the answer describes, it does not certify | ANSWERS NOW |
| "did I overpay" | Recent sales and the floor at the time of asking, against what was paid | ANSWERS NOW |
| "can they take this back from me" | Custody decode: permanent transfer, freeze and burn delegates read from the asset bytes | ANSWERS NOW (Core only) |
| "is the royalty actually enforced or just written down" | Royalty plugin decode: enforced by the program versus advisory metadata | ANSWERS NOW (Core only) |
| "can they change the art after I buy it" | Metadata mutability flag from the asset account | ANSWERS NOW (Core only) |
| "is this a 1 of 1 for real" | Chain supply for the collection plus on-chain edition data where it exists, versus a number typed into the name | ANSWERS NOW |
| "why does the owner show as some random address" | Escrow detection: a listed item is held by the marketplace escrow, and the answer says so | ANSWERS NOW |
| "what traits does this have" | Asset lookup returns marketplace metadata including traits | ANSWERS NOW |
| "is this the pack or the card" | Identify distinguishes pack assets, card assets, collection accounts and non-assets | ANSWERS NOW |
| "who owns it right now" | Authoritative on-chain owner decoded from the asset account, with escrow flagged | ANSWERS NOW (Core authoritative; others via marketplace index) |
| "this is an SPL NFT from 2022, same questions" | Marketplace data yes; decoded provenance and custody are Core only and say so | PARTIAL (gap named, not returned empty) |

---

## 4. A wallet

| Question | How it is answered | Status |
|---|---|---|
| "what's in this wallet" | Wallet holdings as indexed by Magic Eden, with listing state | ANSWERS NOW |
| "profile my wallet" | Items grouped by collection, share of wallet, share of supply, listed and compressed counts, wallet age | ANSWERS NOW |
| "how much is my collection worth" | A floor-times-count ceiling, labelled a ceiling, with unpriced items counted and thin books named | PARTIAL (ceiling, never a valuation) |
| "does this guy flip or hold" | Wallet activity: buys, sells, median hold, realized flips, a behaviour label with its reason | ANSWERS NOW |
| "how much has this wallet made" | Realized flips paired with hold time and profit, plus net SOL flow, with fees and royalties excluded and said so | PARTIAL (realized only, fees excluded) |
| "is this a fresh wallet" | First and last transaction from the chain, transaction count, holdings count | ANSWERS NOW |
| "was this airdropped or did they buy it" | With an OpenSea key, plain transfers show as received without a recorded sale, from a named address | PARTIAL (needs the optional key) |
| "do I have anything listed that I forgot about" | Listed items surfaced first in the wallet profile, with marketplace | ANSWERS NOW |
| "are these two wallets the same person" | Shared counterparties and transfer patterns can be described; identity linkage is not something the chain proves | NOT YET (no address clustering, and on-chain evidence cannot establish identity) |
| "what percent of the supply does this wallet hold" | Holdings count against chain supply, or OpenSea supply with a key | ANSWERS NOW |
| "list everything I bought and sold this year" | Paged wallet activity, dated and priced, with the missing marketplaces named | PARTIAL (Magic Eden by default, OpenSea with a key, not Tensor) |
| "where do they trade, order book or pools" | Marketplace split in the activity breakdown | ANSWERS NOW |
| "this wallet has 400 items, did you see all of them" | The page cap is disclosed in the result rather than the total being quietly short | ANSWERS NOW |
| "what was their best flip" | Flip list sorted by profit, each with hold time | ANSWERS NOW |
| "have they been buying or selling lately" | Net SOL flow over the activity window, direction stated | ANSWERS NOW |
| "who are the biggest buyers of this collection" | Top buyers over a window | ANSWERS NOW |

---

## 5. A project's health

| Question | How it is answered | Status |
|---|---|---|
| "is this project rugged" | Supply, recent sales activity, listed depth and custody rights are given; the word rugged is not the tool's to apply | PARTIAL (evidence yes, label no) |
| "how many actually exist vs how many they announced" | Chain supply from the collection account against the claim, via claim verification | ANSWERS NOW |
| "are holders concentrated in a few wallets" | `get_collection_holders` reads every asset in the collection from the chain's asset index and ranks holders by count and share, listed or not, with the issuer's own key and marketplace escrows called out as roles so neither is mistaken for a collector | ANSWERS NOW (one collection at a time; no cross-collection ranking) |
| "has anyone traded this in the last month" | Recent sales plus window sales count | ANSWERS NOW |
| "can the team still mint more" | Update authority and collection state from the chain; mint authority behaviour is read from the collection account | PARTIAL (authority visible, future intent is not) |
| "did they burn the supply they said they burned" | Collection account reports minted versus current size, which exposes burns | ANSWERS NOW |
| "is the royalty they advertise real" | Royalty plugin decode, enforced versus advisory | ANSWERS NOW (Core only) |
| "are they listed on both marketplaces" | Collection stats reports presence per marketplace, plus the OpenSea Solana index with a key | ANSWERS NOW |
| "what happened to the floor after the announcement" | Daily series over the window around the date | ANSWERS NOW |
| "how many unique buyers this month" | Top buyers and window sales give the buyer side; unique-buyer count is derived from the same window | ANSWERS NOW |
| "is this collection even real or did someone fake the name" | Identify plus the curated registry plus chain supply; a name alone proves nothing and the answer says so | ANSWERS NOW |

---

## 6. Suspicious activity

| Question | How it is answered | Status |
|---|---|---|
| "did this guy actually pay that" | The specific sale is checked against recent sales and the item's transfer history | ANSWERS NOW (Core assets for the transfer side) |
| "is this wash trading" | Buys and sells between the same addresses can be shown; calling it wash trading is a judgment the tool does not make | PARTIAL (pattern shown, no verdict) |
| "the winner of our raffle looks fake, check them" | Wallet age, transaction count, holdings, and how the qualifying item arrived | ANSWERS NOW (arrival needs the OpenSea key) |
| "someone says this sold for 400 SOL, true" | Claim verification against sales in the window, plus the highest sale figure | ANSWERS NOW (window figure) |
| "this seller says never traded, prove it" | Claim verification returns contradicted with a transfer count, then the dated history | ANSWERS NOW (Core only) |
| "are they selling to themselves" | Buyer and seller addresses are in the sales rows; you can see repeats | PARTIAL (raw pattern, no clustering) |
| "is this a fake collection with a copied name" | Chain address versus registry versus marketplace symbol; matching names with different addresses are named as different things | ANSWERS NOW |
| "did the team dump on holders" | Wallet activity for a named address, with marketplaces covered stated | PARTIAL (needs the address; team wallets are not identified for you) |
| "why does this item keep moving between two wallets" | The provenance timeline shows the hops, dated, with escrow transfers labelled so relists are not mistaken for sales | ANSWERS NOW |
| "is that a real screenshot" (pastes an image) | Images cannot be read; the assistant asks for the item name, mint or address instead | NOT YET (no image reading; ask for the identifier) |
| "this sale shows on OpenSea but not Magic Eden, who is lying" | Both feeds reported separately with marketplace labels; one marketplace has been seen reporting another's fills as its own | ANSWERS NOW |

---

## 7. Mechanics and rights

| Question | How it is answered | Status |
|---|---|---|
| "what does owning this actually mean" | Custody decode translated into plain sentences about freeze, transfer, burn and edit rights | ANSWERS NOW (Core only) |
| "why is the owner a marketplace address" | Glossary plus escrow detection: listing moves the asset into escrow, the seller is the wallet that sent it in | ANSWERS NOW |
| "what is a floor, exactly" | Glossary: a floor is the lowest current ask, not a value and not a sale | ANSWERS NOW |
| "can I sell on Magic Eden something I bought on OpenSea" | Glossary: the asset is the same on chain, marketplaces are storefronts | ANSWERS NOW |
| "what happens to a pack when I open it" | Glossary plus custody decode: some issuers burn the pack, one returns it to a treasury, and supply math differs | ANSWERS NOW |
| "why does a pack have a burn delegate" | The opening program needs to consume it; expected on a pack, a flag on a card meant to be kept | ANSWERS NOW |
| "what is a compressed NFT and do I have any" | Glossary plus the compressed count in the wallet profile | ANSWERS NOW |
| "how do marketplaces actually work on Solana" | Marketplace mechanics explainer covering escrow, order book, pools, fills and fees | ANSWERS NOW |
| "who can freeze my item" | Freeze delegate holder read from the asset bytes | ANSWERS NOW (Core only) |
| "is my serial number on chain or just printed in the name" | Edition data on chain versus a number inside the name string, distinguished in the answer | ANSWERS NOW (Core only) |
| "what is the difference between minted and existing supply" | Collection account exposes both, and burns are the difference | ANSWERS NOW |
| "should I sell" | Not a data question; facts are given, advice is declined | NOT YET (never, by design) |

---

## 8. Building things

| Question | How it is answered | Status |
|---|---|---|
| "I want a Discord sales bot for this collection" | Sales-bot recipe: endpoints, pace, cursor skeleton, cost, silent failure modes | ANSWERS NOW |
| "how do I not get rate limited" | Per-source pacing numbers in every recipe, and the server already gates its own reads | ANSWERS NOW |
| "what will this cost me to run" | Cost note per recipe, priced at steady state rather than one run | ANSWERS NOW |
| "build me a floor dashboard across both marketplaces" | Floor-dashboard recipe plus the live reconciliation rule to copy into the UI | ANSWERS NOW |
| "a page that shows every owner a card has had" | Provenance-lookup recipe plus the live history call | ANSWERS NOW |
| "wallet tracker for my own address" | Wallet-tracker recipe: three states held, listed and sold, plus coverage disclosure | ANSWERS NOW |
| "live pack pull feed" | Pack-watcher recipe: page the collection from the asset index and treat ids you have not stored as the new pulls | PARTIAL (the recipe and the per-card history, not a ready-made feed) |
| "which source should I use for what" | Source catalog with tiers and fallbacks | ANSWERS NOW |
| "what breaks silently in this build" | Every recipe orders its pitfalls by how quietly they fail | ANSWERS NOW |
| "can I call this from my own script instead of a chat" | It is an MCP server; any MCP client or your own agent can call it | ANSWERS NOW |
| "give me a Tensor feed too" | Tensor requires a key, so it is not a source here | NOT YET (Tensor needs a key, and this stays keyless) |
| "can it place the buy for me" | No signing code exists in the repository | NOT YET (never, the ability was not written) |

---

## 9. Posting content

| Question | How it is answered | Status |
|---|---|---|
| "give me a stat for a post about this collection" | Window sales: count, volume, top sale, with the marketplace and timestamp to cite | ANSWERS NOW |
| "write a thread about who has owned this card" | Dated ownership history with marketplaces named, as the thread's spine | ANSWERS NOW (Core only) |
| "what is the top sale today" | Highest sale over a one-day window | ANSWERS NOW |
| "I need the image for this card for my post" | Image URL comes back with the asset; downloading and reuse rights are yours to check | PARTIAL (URL yes, rights not adjudicated) |
| "who bought the most this week" | Top buyers over the window | ANSWERS NOW |
| "is there a number here worth posting" | Window stats plus recent sales; the interesting angle is yours | ANSWERS NOW |
| "someone replied 'source' to my post" | Every answer carries the source, the time and the gaps, so the reply writes itself | ANSWERS NOW |
| "post this to X for me" | No posting capability; the data is handed to whatever you built | NOT YET (read-only, no outbound posting) |
| "compare this week to the week the drop happened" | Two windows of the same collection series | ANSWERS NOW |

---

## 10. Packs and supply

| Question | How it is answered | Status |
|---|---|---|
| "what is being pulled right now" | No keyless feed sorts a Solana collection by mint time, so the answer says so and points at the pack-watcher recipe | NOT YET (the public asset index cannot sort by creation) |
| "did anyone pull a one of one today" | Serial and population come from the card itself, so a named card answers; a whole-day sweep does not | PARTIAL (per card, not per day) |
| "how many packs are left" | Pack asset supply from the collection account where packs are Core assets | PARTIAL (supply yes; issuer-held inventory is not visible) |
| "what are the odds on this pack" | Odds are an operator claim the chain cannot verify, and the answer says so | NOT YET (odds are unverifiable on chain) |
| "does opening a pack destroy it" | Depends on the issuer; the custody decode shows burn versus return-to-treasury behaviour | ANSWERS NOW |
| "how many of this card exist" | Chain supply for the card's collection, plus the population printed on the card where present | ANSWERS NOW |
| "trace these auction packs to their winners" | Transfer decoding walks each pack to its final owner | ANSWERS NOW (Core only) |
| "is the announced print run accurate" | Claim verification against the collection account | ANSWERS NOW |
| "show me every card in this set" | The asset index pages a Metaplex Core collection in full | ANSWERS NOW (by collection address) |
| "how many were burned" | Minted minus current size from the collection account | ANSWERS NOW |

---

## 11. Cross-project comparisons

| Question | How it is answered | Status |
|---|---|---|
| "which of these three collections is doing better" | Window sales for each, compared on count and volume with marketplaces named | ANSWERS NOW |
| "compare floors across my watchlist" | Batch floor lookup, up to ten collections in one call | ANSWERS NOW |
| "is Candy MLB or Candy DC moving more volume" | Window volume per collection, with the coverage of each feed stated | ANSWERS NOW |
| "serial #69 across every Solana project" | Would need a full chain index of every collection, which nobody offers keyless | NOT YET (no keyless whole-chain index exists) |
| "which Solana collections does OpenSea actually index" | The OpenSea Solana collection index, with each on-chain address | ANSWERS NOW (needs the optional key) |
| "same collection, both marketplaces, which has more depth" | Listed counts per marketplace, with the currency caveat when floors differ in unit | ANSWERS NOW |
| "rank these by holder concentration" | Share of supply per wallet you name; there is no automatic ranking across collections | PARTIAL (manual, wallet by wallet) |
| "which of my collections has the deepest book" | Listed count and recent sales per collection | ANSWERS NOW |
| "compare this Solana collection to an Ethereum one" | Solana only; keyless indexed NFT data on other chains is gone | NOT YET (no keyless multi-chain source survives) |
| "which project's royalties are actually enforced" | Royalty plugin decode per collection's assets, one at a time | PARTIAL (per asset, not a sweep) |

---

## 12. Charts and breakdowns

| Question | How it is answered | Status |
|---|---|---|
| "make me a chart of sales this month" | Daily series with count and volume per day | ANSWERS NOW |
| "break my wallet down by collection" | Wallet profile grouping with share of wallet per collection | ANSWERS NOW |
| "show me price distribution of current listings" | Listings with prices and traits, ready to bucket | ANSWERS NOW |
| "floor per trait, as a table" | Per-trait floors | ANSWERS NOW |
| "buyers ranked by spend" | Top buyers over the window | ANSWERS NOW |
| "volume by day for the last 30 days" | Daily series over a 30-day window, subject to what the marketplace retains | PARTIAL (window limited by marketplace retention) |
| "hold time distribution for this wallet" | Every flip carries hold time; the distribution is yours to bucket | ANSWERS NOW |
| "marketplace split for this wallet as a pie" | Order book versus pool split already comes back as numbers | ANSWERS NOW |
| "sales per hour during the drop" | The window series is daily, not hourly | NOT YET (series granularity is daily) |
| "a two-year price history" | Older than the marketplace's retained feed would need chain reads, which are decoded for Core assets only | PARTIAL (recent window yes, long history no) |
| "chart the supply burning down over time" | Current minted and existing counts are point-in-time, not a historical series | NOT YET (no historical supply snapshots are stored) |

---

**Total: 141 questions.**
