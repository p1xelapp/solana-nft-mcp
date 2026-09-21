/**
 * Extracts a zip archive with nothing but Node's own zlib.
 *
 * The bundle verifier used PowerShell's Expand-Archive, which made the check
 * Windows-only: a person building the bundle on macOS or Linux could not
 * verify what they built. A .mcpb is an ordinary zip, and the format is small
 * enough to read here: the central directory at the end names every entry
 * and its local header offset; each entry is stored or deflated.
 *
 * Bounded on purpose. Entry names cannot escape the destination, entry
 * count and total uncompressed size are capped, and anything else (zip64,
 * encryption, unknown methods) is refused by name rather than guessed at.
 */
import { inflateRawSync } from "node:zlib";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import path from "node:path";

const MAX_ENTRIES = 50_000;
const MAX_TOTAL_BYTES = 512 * 1024 * 1024;

export function unzipSync(archivePath, destination) {
  const buf = readFileSync(archivePath);
  // End of central directory: the last 22 bytes plus up to 64 KB of comment.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65_535); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error(`${archivePath} is not a zip archive (no end-of-central-directory record)`);
  const entries = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (entries === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) throw new Error("zip64 archives are not supported here");
  if (entries > MAX_ENTRIES) throw new Error(`archive names ${entries} entries, above the ${MAX_ENTRIES} this reader accepts`);

  const dest = path.resolve(destination);
  let p = cdOffset;
  let total = 0;
  let written = 0;
  for (let n = 0; n < entries; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error(`central directory entry ${n} is malformed`);
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const compressedSize = buf.readUInt32LE(p + 20);
    const uncompressedSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString("utf8");
    p += 46 + nameLen + extraLen + commentLen;

    if (flags & 0x1) throw new Error(`entry "${name}" is encrypted, which this reader refuses`);
    if (method !== 0 && method !== 8) throw new Error(`entry "${name}" uses compression method ${method}, which this reader does not support`);
    total += uncompressedSize;
    if (total > MAX_TOTAL_BYTES) throw new Error(`archive expands past ${MAX_TOTAL_BYTES} bytes, which this reader refuses`);

    // The entry's name decides where it lands, and it must land inside the
    // destination: "../" in a name is an escape, not a file.
    const target = path.resolve(dest, name);
    if (target !== dest && !target.startsWith(dest + path.sep)) throw new Error(`entry "${name}" would be written outside the destination`);

    if (name.endsWith("/")) {
      mkdirSync(target, { recursive: true });
      continue;
    }
    // Local header: skip its own name and extra field to reach the data.
    if (buf.readUInt32LE(localOffset) !== 0x04034b50) throw new Error(`local header for "${name}" is malformed`);
    const localNameLen = buf.readUInt16LE(localOffset + 26);
    const localExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const raw = buf.subarray(dataStart, dataStart + compressedSize);
    const data = method === 8 ? inflateRawSync(raw, { maxOutputLength: uncompressedSize || undefined }) : raw;
    if (uncompressedSize !== 0 && data.length !== uncompressedSize) throw new Error(`entry "${name}" expanded to ${data.length} bytes, not the ${uncompressedSize} its header names`);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, data);
    written++;
  }
  return { entries, filesWritten: written, bytes: total };
}
