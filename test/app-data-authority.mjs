import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const folder = new URL("./fixtures/item-reads-2026-11-19/", import.meta.url);
const dist = process.argv[2] ?? path.join(import.meta.dirname, "../dist");
const { decodeCoreAccountPlugins, deriveTrust } = await import(pathToFileURL(path.resolve(dist, "lib/coreplugins.js")).href);
function decode(name) {
  const account = JSON.parse(fs.readFileSync(new URL(name + ".json", folder))).result.value;
  return decodeCoreAccountPlugins(account.data[0]);
}
const trust = deriveTrust(decode("app"), decode("appParent"));
const oracle = deriveTrust(decode("asset"), decode("collection"));
assert.equal(oracle.incomplete, true, "the unread oracle still leaves a gap");
assert.equal(trust.incomplete, false, trust.warnings.join(" "));
assert.match(trust.assurances.join(" "), /AppData/);
assert.doesNotMatch(trust.warnings.join(" "), /veto|gate transfers/i);
console.log("PASS the AppData writer can change its data without gaining custody powers");
