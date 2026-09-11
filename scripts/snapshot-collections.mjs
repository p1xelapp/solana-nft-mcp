// Refresh the bundled Magic Eden collection directory snapshot.
//
// The live directory is 61 pages and takes about 40 seconds to walk, which
// is too slow to sit in front of a person's first question. A snapshot makes
// name search instant; the live walk still runs in the background after the
// first miss so anything newer than the snapshot is found on the next ask.
// Run before a release: `npm run snapshot`. The date in the file is what the
// tool reports as the snapshot's age.
import { gzipSync } from "node:zlib";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const me = await import(new URL("../dist/sources/magiceden.js", import.meta.url).href);

const started = Date.now();
const read = await me.collectionsIndex(80);
const collections = read.collections
  .filter((c) => typeof c.symbol === "string" && c.symbol.length > 0)
  .map((c) => ({ s: c.symbol, n: typeof c.name === "string" ? c.name.slice(0, 120) : "", b: c.isBadged === true ? 1 : 0 }));

// Complete means the CATALOGUE was covered, not that our page budget survived.
// Magic Eden answers 400 past offset 30,000, so a walk that ends there is a
// prefix: recording complete:true for it is how "no such collection" gets said
// about a collection that exists.
const out = {
  source: "Magic Eden v2 collection directory",
  takenAt: new Date().toISOString(),
  count: collections.length,
  complete: !read.partial && !read.atVenuePagingLimit,
  atVenuePagingLimit: read.atVenuePagingLimit,
  collections,
};
const dir = path.join(root, "data");
fs.mkdirSync(dir, { recursive: true });
const file = path.join(dir, "me-collections.json.gz");
fs.writeFileSync(file, gzipSync(Buffer.from(JSON.stringify(out)), { level: 9 }));
console.log(
  `wrote ${path.relative(root, file)}: ${collections.length} collections, ${read.pagesRead} pages, ` +
    `${Math.round((Date.now() - started) / 1000)}s, ${fs.statSync(file).size} bytes, complete=${out.complete}` +
    `, atVenuePagingLimit=${out.atVenuePagingLimit}`,
);
