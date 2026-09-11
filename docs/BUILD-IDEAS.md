# Things people build with it

Twenty-eight builds, smallest first. Every one of them starts by asking the assistant in one
sentence; the server hands back the data and the recipe, and you write the part that is yours.

Time estimates assume you already write code and have not used these sources before. They are
the time to something that works and survives a restart, not the time to a screenshot.

*(this week)* marks a build that depends on the capabilities landing in the current release.

---

## Under an hour

### 1. Wallet report card (text)
**Who:** anyone who wants a plain summary of an address, theirs or somebody else's.
**Ask:** "Profile this wallet and write it up as a short report."
**Server supplies:** holdings grouped by collection, share of wallet, share of supply, listed and compressed counts, floor ceiling with assumptions, wallet age and transaction count.
**You build:** nothing. This is a conversation, not a program. Save the output if you want a record.
**Time:** 5 minutes.

### 2. "Is this sale real" check for mods
**Who:** Discord and Telegram moderators settling arguments in the channel.
**Ask:** "Someone claims this item sold for X and was never traded before. Check both."
**Server supplies:** claim verification with confirmed, contradicted or unverifiable, the transfer count, the dated history, and recent sales for the collection.
**You build:** a pinned message explaining what the three verdicts mean. That is the whole build.
**Time:** 15 minutes, mostly writing the pinned message.

### 3. Provenance checker you paste into a thread
**Who:** collectors who keep getting into "it never traded" arguments.
**Ask:** "Trace every owner of this mint and give me a one-paragraph version I can paste."
**Server supplies:** the dated ownership chain from the chain, marketplaces named per hop, escrow transfers labelled so a relist does not read as a sale, plus a skipped-event count when history ran deeper than the read.
**You build:** nothing, unless you want a saved template.
**Time:** 10 minutes.

### 4. Rug-check checklist
**Who:** anyone about to buy into a project they do not know.
**Ask:** "Run a pre-buy check on this collection and this specific item."
**Server supplies:** chain supply against the announced number, listed depth versus recent sales, and the custody decode for freeze, transfer, burn, royalty enforcement and metadata mutability.
**You build:** your own pass or fail thresholds. The server gives facts; deciding what disqualifies a project is yours.
**Time:** 30 minutes to write the checklist once, then a minute per use.

### 5. Floor tracker spreadsheet
**Who:** collectors with a watchlist who live in a sheet.
**Ask:** "Give me floors for these ten collections as a table I can paste into a spreadsheet."
**Server supplies:** batch floor lookup for up to ten collections in one call, with currency per venue and a stale flag when a value is cached.
**You build:** the paste, and a habit. If you want it to refresh itself, that is build 13.
**Time:** 20 minutes.

### 6. Personal collection catalogue
**Who:** somebody who minted a lot in 2022 and never wrote any of it down.
**Ask:** "List everything in this wallet with collection, name, listing state and image URL, as a table."
**Server supplies:** holdings as indexed, listing state per item, image URLs, and an explicit note when the page cap was hit so the total is not quietly short.
**You build:** the file format you want to keep it in.
**Time:** 30 minutes.

### 7. Image downloader that respects rights
**Who:** creators who need art for posts and do not want a takedown.
**Ask:** "Give me the image URLs for these items and what the collection says about usage."
**Server supplies:** the image URL and marketplace metadata per asset, plus the royalty and licensing fields where the collection publishes them.
**You build:** the download loop, and the judgment call. The server reports what the metadata says; it does not tell you a licence grants you anything. Check the project's own terms before commercial use.
**Time:** 45 minutes.

---

## An evening

### 8. Discord sales bot
**Who:** a project or a community that wants sales posted with art, price and buyer.
**Ask:** "I want a Discord sales bot for this collection. Endpoints, pace, and where it breaks quietly."
**Server supplies:** the sales feed already rate-gated and cached, plus the sales-bot recipe: verified endpoints, roughly two requests per second so pace at 600ms, a cursor-based skeleton, the running cost, and the pitfalls.
**You build:** the Discord webhook, the cursor store on disk, the embed layout.
**What the recipe saves you:** a misspelled collection symbol returns a normal-looking success response with a zero count, so the bot posts nothing forever and looks healthy. Validate the payload, not the status code. Save the cursor per item rather than per batch so a crash mid-batch does not skip.
**Time:** 3 to 4 hours.

### 9. Telegram floor alert
**Who:** a trader who wants a message when a floor crosses a line.
**Ask:** "Alert me when the floor on these collections crosses my thresholds."
**Server supplies:** floors per collection, with the stale flag and the cached-at time so an alert is never fired off a frozen number presented as live.
**You build:** the Telegram bot token plumbing, the threshold store, and the hysteresis so a floor wobbling on one line does not send forty messages.
**Time:** 2 to 3 hours.

### 10. Pack-pull ticker
**Who:** card communities watching a live rip.
**Ask:** "Show me pulls as they happen, with player, set, serial and owner."
**Server supplies:** the live pull feed, cached and gated, labelled best effort because the upstream is flaky by nature.
**You build:** the display, and a reconciliation pass on boot. The recipe is blunt about this one: a feed built purely by accumulating events loses everything that happened while you were down, and looks complete afterwards.
**What it saves you:** a tracker sized to the count announced at the time silently evicted 8,409 real pulls when the set grew past the cap. Size storage to the maximum the set can ever reach, and alert before you get near it.
**Time:** 4 hours.

### 11. Deal finder
**Who:** buyers hunting mispriced listings.
**Ask:** "Find me listings priced below the floor for their own trait."
**Server supplies:** best deals ranked against per-trait floors rather than the collection floor, plus trait filters.
**You build:** your own notion of a deal, and the loop that re-runs it. A listing below the collection floor is usually just the worst item in the collection; below its own trait floor is the interesting case.
**Time:** 3 hours.

### 12. Trait floor board
**Who:** collectors specialising in one trait, and projects who want to show their community how traits price.
**Ask:** "Give me the floor for every trait in this collection as a board."
**Server supplies:** per-trait floors, current listings with traits.
**You build:** the layout and the refresh policy. Refresh on view, not on a timer, or you burn quota around the clock for nobody.
**Time:** 4 hours.

### 13. Floor dashboard across two marketplaces
**Who:** a project dev whose community asked for one.
**Ask:** "Floor dashboard for our collection across Magic Eden and OpenSea. How do I not make a fool of myself?"
**Server supplies:** floors per venue with currencies, the reconciliation block that says whether the two are comparable, and a spread only when they are.
**You build:** the page. Copy the reconciliation rule verbatim: Collector Crypt has been 0.053 SOL on one venue and 9 USDC on the other, and merging those gives a 170x gap that does not exist.
**What the recipe saves you:** a blank panel when a source is down reads as an empty market, so serve the last good value with its age visible. And label a sale by the program that executed the transaction, because one venue has been observed reporting another venue's fills as its own.
**Time:** an evening for one collection, a weekend for a real watchlist.

### 14. X poster with image
**Who:** a project or a creator who wants sales or milestones posted automatically.
**Ask:** "Give me each new sale with price, buyer and the item image."
**Server supplies:** the sale rows and the image URL per asset.
**You build:** the posting integration, the image fetch, the rate discipline on the posting side, and a kill switch. Check the platform's automation rules before you turn it on; that is a policy question, not a data one.
**Time:** 4 to 5 hours.

### 15. Portfolio page
**Who:** a collector who wants a private page showing what they hold.
**Ask:** "Everything this wallet holds, grouped, with a floor-based ceiling and the assumptions."
**Server supplies:** the grouped holdings, share of supply, the ceiling with unpriced items counted and thin books named.
**You build:** the page. Print the word ceiling on it. Multiplying item count by floor treats a one-of-one and the worst item in the set as equal, and the floor is one optimistic ask.
**Time:** 4 hours.

### 16. Weekly market digest
**Who:** anyone who posts a Monday recap, for a community or for themselves.
**Ask:** "For these collections, give me last week's sale count, volume, top sale and daily series."
**Server supplies:** window sales per collection with the daily series, top buyers, and each figure's venue and coverage.
**You build:** the template and the schedule. Give the scheduled job an owner, a cost, and a date it turns off.
**Time:** 4 hours, then it runs itself.

### 17. Holder concentration dashboard
**Who:** a project team or an analyst asking who really holds this.
**Ask:** "For these wallets, what share of the supply does each hold?"
**Server supplies:** share of supply per wallet against chain supply, holdings counts, wallet age.
**You build:** the wallet list. There is no automatic top-holders sweep, so you supply the addresses from a snapshot or from sales history, and the server does the share arithmetic with the supply source named.
**Time:** 4 to 6 hours including getting the address list.

### 18. Wallet tracker for one address
**Who:** somebody watching a wallet that seems to know things.
**Ask:** "Track what this wallet buys and sells and tell me when it moves."
**Server supplies:** activity with buys, sells, net flow, venue split, flips with hold time and profit, and the behaviour label with its reason.
**You build:** the polling loop and the notification. Track three states, not two: held, listed and sold are different, and a listed item has left the wallet on chain without being sold.
**Time:** 4 hours.

### 19. Sale verifier bot for a server
**Who:** mods who want the check as a slash command instead of a ping to the one person who knows.
**Ask:** "Wrap the claim check and the history trace behind one command."
**Server supplies:** claim verification with its receipt, and the dated transfer history.
**You build:** the command, and the output format. Show the verdict, the number seen, and the re-check line. Do not collapse unverifiable into false.
**Time:** 4 hours.

---

## A weekend

### 20. Collection sales chart page
**Who:** a project wanting a public volume chart, or a creator wanting one for posts.
**Ask:** "Daily sales count and volume for this collection over the last 30 days."
**Server supplies:** the daily series, count, volume and top sale for the window.
**You build:** the chart, and honesty about the window. Series granularity is daily and the window is limited by what the venue retains, so label both on the axis rather than implying an unbroken history.
**Time:** a weekend for something you would publish.

### 21. Multi-collection watchlist service
**Who:** a trader running a personal service on a small box.
**Ask:** "Floors, window volume and new listings for these collections on a schedule."
**Server supplies:** batch floors, window sales, listings.
**You build:** the scheduler, the store, and a budget stop. Price the steady state: a two-minute cron rewriting a table 720 times a day cost 180 dollars in a month on a project nobody was using.
**Time:** a weekend.

### 22. Provenance widget for a project site
**Who:** a project that wants holders to see an item's history on the item page.
**Ask:** "Give me the ownership history for this mint in a shape I can render."
**Server supplies:** events oldest first with timestamps, transaction signatures, marketplace labels, escrow detection, and a skipped count.
**You build:** the embed. Render the skipped count rather than dropping old events quietly, and explain escrow instead of printing a marketplace address as the owner.
**Time:** a weekend including the design.

### 23. Pre-purchase report generator
**Who:** somebody who buys expensive items and wants a repeatable check.
**Ask:** "Full pre-purchase report on this item and this seller."
**Server supplies:** identify, ownership history, never-traded verification with a receipt, custody decode, collection supply, and the seller wallet's behaviour profile.
**You build:** the report template and the storage, so you have a dated record of what was true when you bought.
**Time:** a weekend for something you would hand to someone else.

### 24. Name and serial search tool
**Who:** collectors chasing a specific number or player across a collection.
**Ask:** "Find item #1390, and every listing with this player's name."
**Server supplies:** name search across the Magic Eden index, trait filters, listings with prices.
**You build:** the saved-search list and the alerting. The index is one venue's, so say so in the interface.
**Time:** a weekend.

### 25. Source catalog page for your own team
**Who:** a team that keeps rediscovering which API to use for what.
**Ask:** "Which source answers which question, what is the fallback, and what does each one cost?"
**Server supplies:** the source catalog with tiers and fallbacks, plus the per-recipe pacing and cost notes.
**You build:** an internal page, and the discipline to update it when a source changes.
**Time:** half a day.

### 26. Tax-shaped trading record
**Who:** somebody who traded a lot and needs a record.
**Ask:** "Every buy and sell for this address this year, dated and priced, as a table."
**Server supplies:** paged activity, dated and priced, flips paired with hold times, and an explicit list of what is missing.
**You build:** the export and the reconciliation against your own records. Read the gaps out loud: venues not in the feed, fees and royalties excluded, anything older than the window. It is a record with named gaps, not a tax document, and it is not advice.
**Time:** a weekend.

### 27. Agent that answers collection questions in a channel
**Who:** a community that wants the lookup without installing anything themselves.
**Ask:** "Put these tools behind a bot that answers questions in our server."
**Server supplies:** typed structured results on every call, asset names defanged before a model sees them, read-only hints on every tool, frozen tool names so your prompts do not break.
**You build:** the agent loop and the guardrails. Keep the defanging on: minting is permissionless, so a name can be a fake message boundary followed by instructions aimed at your model.
**Time:** a weekend.

### 28. Cross-venue reconciliation job
**Who:** a project or analyst who wants to know when two sources disagree, on purpose.
**Ask:** "Compare supply, floor and listed counts per venue and flag every disagreement."
**Server supplies:** chain supply, per-venue floors and counts, and the comparability verdict.
**You build:** the job, the history table, and the alert. Disagreement is the product here, so store both numbers rather than picking one, and read the provider's usage graph 24 and 48 hours after you switch it on.
**Time:** a weekend, and it will teach you more about this market than any dashboard.

---

## Two rules that apply to every build on this page

**Never render a blank as a fact.** An empty history is usually an unsupported asset type, a blank
panel is usually a source outage, and a zero count is often a misspelled symbol. Show the last
good value with its age, or say which failure happened.

**Give every scheduled job an owner, a cost and an off date.** Reads here are free. Storage,
hosting and your own database writes are not, and a job nobody remembers is the one that bills.
