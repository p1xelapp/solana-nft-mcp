# How it was built, and why

### The problem came from a job, not a whiteboard

I built and run CandyScan, a tracker used by Candy Digital MLB collectors, backed by an
895,000-row asset database that gets reconciled against chain state and marketplace feeds every
day. Alongside it I run a fleet of sales bots watching VeVe, Candy Digital, Panini, sports card
and TCG drops from an always-on machine, and SolGrails, a Solana marketplace with real money
moving through it. The three failures below are the ones those systems kept hitting, which is
why this server reads the way it does.

**Failure one: empty history.** Candy Digital mints Metaplex Core assets. Core stores ownership
inside the asset account rather than in a token account, and the consequence is that mainstream
enhanced-transaction APIs parse a Core transfer as an unknown type with an empty token-transfer
list. A tool built on those APIs reports zero provenance while the history sits on chain the whole
time. That is how a card that has changed hands four times gets sold as "never traded, straight
from the pack", with a screenshot from a reputable tool agreeing.

**Failure two: counts that disagree.** Reconciling a marketplace's numbers against the chain
daily, for a year, produces one lesson faster than any other: a count belongs to a state, not to a
place. A listed item has left the wallet on chain and has not been sold. An opened pack is burned
by most issuers and returned to a treasury by one. Where an asset sits is a guess about what it
is. Tools that count by place produce totals that are confidently wrong and internally consistent.

**Failure three: floors that lie.** Collector Crypt has been quoted at 0.053 SOL on Magic Eden and
9 USDC on OpenSea. Put them in the same column and you have a 170x gap that does not exist.
Multiply a floor by an item count and you have a number people will call their portfolio value,
built from one seller's ask on a book three listings deep.

### The design choices

**Chain first.** Supply
comes from the collection account. Current owner comes from a hand-decoded asset account, not from
an indexer's opinion. Ownership history comes from walking the transfer instructions in each
transaction. There is no indexer in the path and no key required to do it.

**Venue labelled, always.** Marketplace data is that marketplace's index, and it is returned
saying so. Each number carries its venue, its currency, and its read time. When two venues
disagree, both are returned. One marketplace has been observed reporting another venue's fills as
its own, so events are labelled by the program that executed the transaction rather than by who
reported it.

**Evidence-shaped output.** Every result is typed rather than prose a model has to scrape numbers
out of. Partial results report what they skipped: how many older events were not read, how many
activity events were scanned to find the sales, whether a wallet page hit its cap. Claim checks
return three verdicts, because a tool with only true and false will eventually return false for
something it simply could not see.

**No sign-up, read-only, local.** Every default source is public: Magic Eden's v2 endpoints,
plain Solana RPC and its asset index. OpenSea is the one source that wants a key, and the
server asks OpenSea for a free one itself rather than asking you. Requests are paced per source and cached, because being a polite
client is the only thing that keeps a keyless server viable. There is no signing code in the
repository, so the ability to move anything was never written rather than merely disabled. It runs
on the user's own machine, keeps nothing, and asks for no account.

**Refuse to guess.** The stats block will not rank a SOL floor against a USDC floor. No currency
conversion happens, on purpose, because it would mean depending on a second price
feed I cannot check. A floor-times-count figure is returned as a ceiling with its assumptions attached. An
empty history is reported as unsupported or unread, never as untraded.

### What was tested

Every tool and prompt is exercised offline against captured feeds, including the wallet logic and the prompt-injection defence, and again live against the real endpoints with a real provenance trace, a real wallet and hostile inputs. The design was put through repeated hostile review rounds, and CI runs the offline suite plus a full-history secrets scan on every push. A weekly live check re-reads the real sources, and the hardest piece - extracting the new owner from a Core transfer whose account layout varies between two shapes - was verified against a live 36-pack auction, where all 36 packs traced to their winners with none left untraced.

### Why that is worth trusting

Not because it is always right. Sources lag, venues go down, public RPC throttles. It is worth
trusting because it reports those conditions instead of smoothing them over. Cached values come
back labelled stale rather than erroring mid-conversation. Caps are disclosed. Disagreements are
shown rather than resolved by a coin flip. Every claim check hands back a line telling you how to
reproduce it without trusting this server at all.

Each of those lessons came off a live system with people watching. They are in the code and in
the build recipes so the next person does not have to learn them the same way.
