/**
 * CryptoSlam public web API - the live "pack rip" feed for licensed
 * collectibles (Panini America NBA/NFL/Soccer/Baseball cards and more).
 *
 * This is the API CryptoSlam's own site runs on: public, keyless, but FLAKY
 * (intermittent 500/504). Every call here is retried, cached, and served
 * stale-on-error, and results are labeled best-effort. Poll sizes stay small
 * (<=20) because large pages time out upstream.
 */

import { cached, fetchJson } from "../lib/http.js";

const BASE = "https://web-api.cryptoslam.io/v1";
const HEADERS = {
  "Content-Type": "application/json",
  "User-Agent": "collector-mcp/1.0 (+https://github.com/p1xelapp/collector-mcp)",
  Origin: "https://www.cryptoslam.io",
  Referer: "https://www.cryptoslam.io/",
};

interface CsMint {
  tokenId?: string;
  timeStamp?: string;
  owner?: { address?: string };
  attributes?: Record<string, unknown>;
}

/**
 * Last N mints for a contract. For licensed card platforms each mint is a
 * card being pulled from a pack - a live rip feed.
 */
export async function recentMints(contract: string, limit: number) {
  const n = Math.min(Math.max(limit, 1), 20);
  const { data, stale, cachedAt } = await cached(`cs:mints:${contract}:${n}`, 60_000, () =>
    fetchJson<CsMint[]>(
      "CryptoSlam",
      `${BASE}/mints/${encodeURIComponent(contract)}/${n}/last`,
      { headers: HEADERS },
      { retries: 3, timeoutMs: 20_000 },
    ),
  );
  if (!Array.isArray(data)) throw new Error("CryptoSlam returned an unexpected mints shape");
  const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
  return {
    contract,
    pulls: data.map((m) => {
      const a = m.attributes ?? {};
      return {
        tokenId: m.tokenId ?? null,
        time: m.timeStamp ?? null,
        card: str(a["Name"]),
        set: str(a["CardSet"]),
        serial: str(a["Mint"]),
        population: str(a["Population"]),
        team: str(a["Team"]),
        sport: str(a["SportName"]),
        image: str(a["Image"]),
        owner: m.owner?.address ?? null,
      };
    }),
    stale,
    cachedAt,
    source: "cryptoslam",
    note: "CryptoSlam's public API is best-effort; stale=true means this is the last good snapshot.",
  };
}
