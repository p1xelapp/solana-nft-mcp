// Every image in a tree, checked for embedded provenance and editor metadata.
// Shipped artwork should carry pixels and nothing else: a C2PA or JUMBF
// manifest travels with the file, survives most conversions, and says more
// about the machine that made it than anybody downloading a logo needs.
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
    const hit = /c2pa|jumbf|xmpMM:History|photoshop:|gpt-image|OpenAI|Midjourney|firefly|stability\.ai|DALL[ -]?E/i.exec(s);
    if (hit) bad.push(`${p.split(path.sep).join("/")}  [${hit[0]}]`);
  }
};

for (const r of roots) walk(r);
console.log(`images scanned: ${seen}`);
if (bad.length) {
  console.log(`CARRIES EMBEDDED METADATA (${bad.length}):`);
  for (const b of bad) console.log("  " + b);
} else {
  console.log("none carry embedded metadata");
}
