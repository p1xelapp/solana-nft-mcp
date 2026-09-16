/**
 * Offline regressions for the self-issued OpenSea key and the lookalike-name
 * warning.
 *
 * Every block names the wrong BEHAVIOUR it prevents, not the function it
 * calls. Nothing here touches the network: the key tests stub `globalThis.fetch`
 * and restore it, and the name tests run against the pure comparison helper.
 *
 * The home folder is redirected per block, so a run cannot read, write or
 * overwrite the key file of whoever is running the suite.
 */
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";

import { findLookalikes, LOOKALIKE_WARNING } from "../dist/names.js";

let passed = 0;
const ok = (what) => {
  passed++;
  console.log(`  ok  ${what}`);
};

// This suite must never see the real one.
delete process.env.OPENSEA_API_KEY;
delete process.env.COLLECTOR_MCP_NO_AUTO_KEYS;
// The stubbed fetch stands in for the network; offline mode would refuse the
// call before the stub ever ran.
delete process.env.COLLECTOR_MCP_OFFLINE;

const os = await import("../dist/sources/opensea.js");

const realFetch = globalThis.fetch;
const homes = [];

/** Point the module's idea of "home" at a fresh empty directory. */
function freshHome() {
  const dir = fs.mkdtempSync(path.join(tmpdir(), "collector-mcp-key-"));
  homes.push(dir);
  useHome(dir);
  return dir;
}

function useHome(dir) {
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;
}

const keyFileIn = (home) => path.join(home, ".collector-mcp", "opensea-key.json");

/** A stubbed OpenSea key endpoint. Returns the calls it saw. */
function stubIssuer(respond) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), method: init?.method ?? "GET", body: init?.body });
    return respond();
  };
  return calls;
}

const jsonResponse = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const ISO = (ms) => new Date(Date.now() + ms).toISOString();
const DAY = 24 * 60 * 60_000;

// ------------------------------------------------------------------ key 1
// With no key configured, OpenSea used to be simply off. It now asks OpenSea
// for a free one, once, and remembers it in the user's own home folder.
{
  const home = freshHome();
  os.resetKeyCache();
  const calls = stubIssuer(() => jsonResponse({ api_key: "issued-key-1", expires_at: ISO(7 * DAY) }));

  const key = await os.ensureKey();
  assert.strictEqual(key, "issued-key-1", "the freshly issued key is what requests will carry");
  assert.strictEqual(calls.length, 1, "exactly one key request");
  assert.strictEqual(calls[0].method, "POST");
  assert.strictEqual(calls[0].url, "https://api.opensea.io/api/v2/auth/keys");
  assert.strictEqual(calls[0].body, "{}", "OpenSea's key endpoint takes an empty JSON body");

  const stored = JSON.parse(fs.readFileSync(keyFileIn(home), "utf8"));
  assert.strictEqual(stored.key, "issued-key-1");
  assert.strictEqual(stored.source, "opensea-agent-key");
  assert.ok(Date.parse(stored.expiresAt) > Date.now(), "a stored key carries a future expiry");

  const state = os.openSeaState();
  assert.strictEqual(state.enabled, true);
  assert.strictEqual(state.source, "auto");
  assert.ok(state.expiresAt, "the state says when the self-issued key dies");
  assert.ok(!JSON.stringify(state).includes("issued-key-1"), "the key value never appears in anything printable");
  ok("key 1: no configured key issues one free key, stores it, and never prints it");
}

// ------------------------------------------------------------------ key 2
// A key good for another week must be reused. Asking again would spend one of
// the two issues OpenSea allows per day per IP.
{
  const home = homes[homes.length - 1];
  useHome(home);
  os.resetKeyCache(); // as if the server had just restarted
  const calls = stubIssuer(() => {
    throw new Error("a cached key must not trigger a key request");
  });

  const key = await os.ensureKey();
  assert.strictEqual(key, "issued-key-1", "the key comes back off disk after a restart");
  assert.strictEqual(calls.length, 0, "no key request was made");
  ok("key 2: a stored key with time left is reused, not reissued");
}

// ------------------------------------------------------------------ key 3
// A key expiring tonight is worse than useless mid-conversation: it is renewed
// a day early rather than at the moment it dies.
{
  const home = freshHome();
  fs.mkdirSync(path.dirname(keyFileIn(home)), { recursive: true });
  fs.writeFileSync(
    keyFileIn(home),
    JSON.stringify({ key: "almost-dead", issuedAt: ISO(-6 * DAY), expiresAt: ISO(12 * 60 * 60_000), source: "opensea-agent-key" }),
  );
  os.resetKeyCache();
  const calls = stubIssuer(() => jsonResponse({ key: "issued-key-2", expires_at: ISO(7 * DAY) }));

  const key = await os.ensureKey();
  assert.strictEqual(key, "issued-key-2", "a key inside the refresh window is replaced before it expires");
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(JSON.parse(fs.readFileSync(keyFileIn(home), "utf8")).key, "issued-key-2", "the replacement is what gets stored");
  ok("key 3: a key within a day of expiry is refreshed, not used until it dies");
}

// ------------------------------------------------------------------ key 4
// OpenSea caps key creation at about two a day per IP. Hitting that cap must
// leave OpenSea off in the state it was always allowed to be off in - named,
// with the reason - and must never surface as a broken server.
{
  freshHome();
  os.resetKeyCache();
  const calls = stubIssuer(() => jsonResponse({ errors: ["Key creation rate limit exceeded..."] }, 429));

  const key = await os.ensureKey();
  assert.strictEqual(key, null, "no key, and no exception escaping");
  assert.strictEqual(calls.length, 1, "a daily quota is never retried - retrying spends it faster");
  const state = os.openSeaState();
  assert.strictEqual(state.enabled, false);
  assert.strictEqual(state.source, "none");
  // The cap by name, and the wait as a real time rather than a figure of
  // speech: the refusal is now remembered for a cooldown, and the note says
  // when the next attempt may go out.
  assert.ok(
    state.note.includes("OpenSea's key limit") && /not asked again before \d{4}-\d{2}-\d{2}T/.test(state.note),
    `the note must name the cap and the wait, got: ${state.note}`,
  );
  assert.strictEqual(os.openSeaEnabled(), false, "every OpenSea-backed field stays absent, as it always could be");
  ok("key 4: OpenSea's 429 key cap turns OpenSea off with a reason, never into an error");
}

// ------------------------------------------------------------------ key 5
// A read-only or unwritable home folder must cost the user nothing but a fresh
// key next restart.
{
  const parent = fs.mkdtempSync(path.join(tmpdir(), "collector-mcp-ro-"));
  homes.push(parent);
  const notADirectory = path.join(parent, "blocker");
  fs.writeFileSync(notADirectory, "this is a file, so nothing can be created under it");
  useHome(path.join(notADirectory, "nested"));
  os.resetKeyCache();
  const calls = stubIssuer(() => jsonResponse({ api_key: "unstored-key", expires_at: ISO(7 * DAY) }));

  const key = await os.ensureKey();
  assert.strictEqual(key, "unstored-key", "the key still works for this process");
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(os.openSeaState().enabled, true, "an unwritable cache is not a disabled OpenSea");
  ok("key 5: an unwritable home folder loses the cache, not the key and not the answer");
}

// ------------------------------------------------------------------ key 6
// The opt-out has to mean no request at all, not a request whose result is
// discarded.
{
  freshHome();
  process.env.COLLECTOR_MCP_NO_AUTO_KEYS = "1";
  os.resetKeyCache();
  const calls = stubIssuer(() => {
    throw new Error("COLLECTOR_MCP_NO_AUTO_KEYS=1 must prevent the request itself");
  });

  const key = await os.ensureKey();
  assert.strictEqual(key, null);
  assert.strictEqual(calls.length, 0, "nothing was contacted");
  const state = os.openSeaState();
  assert.strictEqual(state.enabled, false);
  assert.ok(state.note.includes("COLLECTOR_MCP_NO_AUTO_KEYS=1"), `the note must name the opt-out, got: ${state.note}`);
  delete process.env.COLLECTOR_MCP_NO_AUTO_KEYS;
  ok("key 6: COLLECTOR_MCP_NO_AUTO_KEYS=1 stops the request, not just the storage");
}

// ------------------------------------------------------------------ key 7
// A configured key is the user's explicit choice and outranks everything the
// server could arrange for itself.
{
  freshHome();
  process.env.OPENSEA_API_KEY = "user-supplied";
  os.resetKeyCache();
  const calls = stubIssuer(() => {
    throw new Error("a configured key must never trigger a key request");
  });

  assert.strictEqual(await os.ensureKey(), "user-supplied");
  assert.strictEqual(calls.length, 0);
  assert.strictEqual(os.openSeaState().source, "env");
  delete process.env.OPENSEA_API_KEY;
  ok("key 7: OPENSEA_API_KEY overrides the self-issued key and suppresses the request");
}

globalThis.fetch = realFetch;
for (const dir of homes) fs.rmSync(dir, { recursive: true, force: true });

// ------------------------------------------------------------- lookalike 1
// A directory row for the real collection and one for an imitation used to be
// returned as two ordinary results, ranked by score, with nothing saying the
// names were the same name.
{
  const snapshot = [
    { symbol: "mad_lads", name: "Mad Lads", badged: true },
    { symbol: "mad_lads_official", name: "Mad Lads Official", badged: false },
    { symbol: "claynosaurz", name: "Claynosaurz", badged: true },
  ];
  const hits = findLookalikes(snapshot);
  assert.deepStrictEqual(
    hits.map((h) => h.symbol).sort(),
    ["mad_lads", "mad_lads_official"],
    "both sides of the imitation are named, and the unrelated collection is not",
  );
  assert.strictEqual(hits.find((h) => h.symbol === "mad_lads").badged, true, "the badge travels with the entry, so the real one can be preferred");
  ok("lookalike 1: 'Mad Lads' and 'Mad Lads Official' are flagged as the same name");
}

// ------------------------------------------------------------- lookalike 2
// One letter is all an imitation needs, and trailing digits and punctuation
// are not a different name to a reader.
{
  const oneEdit = findLookalikes([
    { symbol: "degods", name: "DeGods", badged: true },
    { symbol: "degodz", name: "DeGodz", badged: false },
  ]);
  assert.strictEqual(oneEdit.length, 2, "a single-edit name is a lookalike");

  const punctuated = findLookalikes([
    { symbol: "okay_bears", name: "Okay Bears", badged: true },
    { symbol: "okaybears2", name: "Okay-Bears 2", badged: false },
  ]);
  assert.strictEqual(punctuated.length, 2, "case, punctuation and trailing digits are not a different name");

  const unrelated = findLookalikes([
    { symbol: "mad_lads", name: "Mad Lads", badged: true },
    { symbol: "claynosaurz", name: "Claynosaurz", badged: true },
  ]);
  assert.deepStrictEqual(unrelated, [], "collections with genuinely different names raise nothing");
  ok("lookalike 2: one edit, punctuation and trailing digits collide; unrelated names do not");
}

// ------------------------------------------------------------- lookalike 3
// The warning is what a person reads, so its wording is part of the contract.
{
  assert.ok(LOOKALIKE_WARNING.includes("fakes imitate popular names"));
  assert.ok(LOOKALIKE_WARNING.includes("Prefer the badged one"));
  assert.ok(LOOKALIKE_WARNING.includes("official channel"));
  ok("lookalike 3: the warning tells the reader what to do, not just that something is odd");
}

console.log(`\nautokey: ${passed} checks passed`);
