// Every image in a tree, checked for the metadata a generator leaves behind.
import fs from "node:fs";
import path from "node:path";

const roots = process.argv.slice(2);
const bad = [];
let seen = 0;

const walk = (d) => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === ".git" || e.name === ".stage") continue;
    const p = path.join(d, e.name);
    if (e.isDirectory()) {
      walk(p);
      continue;
    }
    if (!/\.(png|jpg|jpeg|webp|gif|svg|avif)$/i.test(e.name)) continue;
    seen++;
    const s = fs.readFileSync(p).toString("latin1");
    const hit = /c2pa|jumbf|gpt-image|OpenAI|Midjourney|firefly|stability\.ai|DALL[ -]?E/i.exec(s);
    if (hit) bad.push(`${p.split(path.sep).join("/")}  [${hit[0]}]`);
  }
};

for (const r of roots) walk(r);
console.log(`images scanned: ${seen}`);
if (bad.length) {
  console.log(`CARRIES GENERATOR METADATA (${bad.length}):`);
  for (const b of bad) console.log("  " + b);
} else {
  console.log("none carry generator metadata");
}
