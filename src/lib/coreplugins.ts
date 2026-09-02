/**
 * Metaplex Core plugin decoding - the custody facts nobody surfaces.
 *
 * A Core asset is one account: the base asset (owner, authority, name, uri),
 * then an optional plugin header pointing at a plugin registry, with each
 * plugin's data laid out in between. Marketplaces show the picture and the
 * price. They do not show that the issuer kept a permanent transfer delegate
 * (they can move your card without your signature), that the asset is frozen,
 * that royalties are enforced by an allow-list, or that a pack is designed to
 * be burned on open. Those are the facts that decide what "owning" it means.
 *
 * Layout verified against the program source (mpl-core, main, 2026-09-01):
 *   AssetV1  key(1) owner(32) update_authority(1 [+32]) name(4+n) uri(4+n) seq(1 [+8])
 *   PluginHeaderV1  key=3 (1) plugin_registry_offset u64 (8)   - immediately after AssetV1
 *   PluginRegistryV1 key=4 (1) Vec<RegistryRecord> Vec<ExternalRegistryRecord>
 *   RegistryRecord  plugin_type u8, Authority (u8 [+32]), offset u64
 *   Authority: 0 None, 1 Owner, 2 UpdateAuthority, 3 Address{pubkey}
 * Plugin type discriminants follow the Plugin enum order in plugins/mod.rs.
 *
 * Everything here is read-only bytes-to-facts. Unknown plugin types are named
 * by number and skipped, never guessed - the registry is designed to be read
 * even when some plugins are newer than the reader.
 */

import { base58Encode } from "../sources/solana.js";

const PLUGIN_NAMES = [
  "Royalties",
  "FreezeDelegate",
  "BurnDelegate",
  "TransferDelegate",
  "UpdateDelegate",
  "PermanentFreezeDelegate",
  "Attributes",
  "PermanentTransferDelegate",
  "PermanentBurnDelegate",
  "Edition",
  "MasterEdition",
  "AddBlocker",
  "ImmutableMetadata",
  "VerifiedCreators",
  "Autograph",
  "BubblegumV2",
  "FreezeExecute",
  "PermanentFreezeExecute",
  "Groups",
] as const;

const KEY_PLUGIN_HEADER = 3;
const KEY_PLUGIN_REGISTRY = 4;

export interface DecodedPlugin {
  type: string;
  /** Who can act on this plugin: none, owner, update authority, or a specific address. */
  authority: string;
  /** Decoded fields for the plugin types that carry data an owner should know. */
  data?: Record<string, unknown>;
}

export interface CoreTrust {
  plugins: DecodedPlugin[];
  /** Plain-language custody facts, worst first. Empty means nothing unusual. */
  warnings: string[];
  /** Things that are actively good for the holder. */
  assurances: string[];
  frozen: boolean;
  /** True when a party other than the owner can move or burn it without the owner's signature. */
  ownerIsNotSoleController: boolean;
  /** Present only when the layout could not be walked to the end. */
  decodeNote?: string;
}

class Reader {
  off = 0;
  constructor(private buf: Buffer) {}
  u8() { return this.buf.readUInt8(this.off++); }
  u16() { const v = this.buf.readUInt16LE(this.off); this.off += 2; return v; }
  u32() { const v = this.buf.readUInt32LE(this.off); this.off += 4; return v; }
  u64() { const v = Number(this.buf.readBigUInt64LE(this.off)); this.off += 8; return v; }
  pubkey() { const v = base58Encode(this.buf.subarray(this.off, this.off + 32)); this.off += 32; return v; }
  str() { const n = this.u32(); if (n > 4096) throw new Error("implausible string length"); const s = this.buf.toString("utf8", this.off, this.off + n); this.off += n; return s; }
  option<T>(read: () => T): T | null { return this.u8() === 1 ? read() : null; }
  seek(o: number) { if (o < 0 || o > this.buf.length) throw new Error("offset outside account"); this.off = o; }
  get remaining() { return this.buf.length - this.off; }
}

function authority(r: Reader): string {
  const tag = r.u8();
  switch (tag) {
    case 0: return "none";
    case 1: return "owner";
    case 2: return "update authority";
    case 3: return `address ${r.pubkey()}`;
    default: return `unknown(${tag})`;
  }
}

/** Walk past AssetV1 so the reader sits on the plugin header, if any. */
function skipBaseAsset(r: Reader) {
  r.seek(0);
  if (r.u8() !== 1) throw new Error("not an AssetV1 account");
  r.pubkey(); // owner
  const ua = r.u8(); // UpdateAuthority: 0 None, 1 Address, 2 Collection
  if (ua === 1 || ua === 2) r.pubkey();
  r.str(); // name
  r.str(); // uri
  r.option(() => r.u64()); // seq
}

function pluginData(type: number, r: Reader): Record<string, unknown> | undefined {
  switch (type) {
    case 0: { // Royalties
      const basisPoints = r.u16();
      const n = r.u32();
      const creators: { address: string; percentage: number }[] = [];
      for (let i = 0; i < n && i < 64; i++) creators.push({ address: r.pubkey(), percentage: r.u8() });
      const rs = r.u8();
      const ruleSet = rs === 0 ? "none" : rs === 1 ? "program allow-list" : rs === 2 ? "program deny-list" : `unknown(${rs})`;
      return { percent: basisPoints / 100, creators, ruleSet };
    }
    case 1: case 5: case 16: case 17: // Freeze / PermanentFreeze / FreezeExecute / PermanentFreezeExecute
      return { frozen: r.u8() === 1 };
    case 4: { // UpdateDelegate
      const n = r.u32(); const extra: string[] = [];
      for (let i = 0; i < n && i < 32; i++) extra.push(r.pubkey());
      return { additionalDelegates: extra };
    }
    case 6: { // Attributes
      const n = r.u32(); const list: Record<string, string> = {};
      for (let i = 0; i < n && i < 128; i++) { const k = r.str(); list[k] = r.str(); }
      return { attributes: list };
    }
    case 9: return { edition: r.u32() };
    case 10: { // MasterEdition
      const maxSupply = r.option(() => r.u32());
      const name = r.option(() => r.str());
      const uri = r.option(() => r.str());
      return { maxSupply, name, uri };
    }
    default: return undefined;
  }
}

/**
 * Decode the plugin registry of a Core asset account (base64 data from
 * getAccountInfo) into custody facts. Throws only for a non-asset account;
 * a malformed registry yields what could be read plus a decodeNote.
 */
export function decodeCoreTrust(b64: string): CoreTrust {
  const buf = Buffer.from(b64, "base64");
  const r = new Reader(buf);
  skipBaseAsset(r);

  const out: CoreTrust = { plugins: [], warnings: [], assurances: [], frozen: false, ownerIsNotSoleController: false };
  if (r.remaining < 9 || buf[r.off] !== KEY_PLUGIN_HEADER) {
    out.assurances.push("No plugins attached: nothing but the owner's own signature can move, freeze or burn this asset.");
    return out;
  }
  r.u8();
  const registryOffset = r.u64();

  try {
    r.seek(registryOffset);
    if (r.u8() !== KEY_PLUGIN_REGISTRY) throw new Error("registry key mismatch");
    const n = r.u32();
    if (n > 64) throw new Error("implausible registry length");
    const records: { type: number; auth: string; offset: number }[] = [];
    for (let i = 0; i < n; i++) records.push({ type: r.u8(), auth: authority(r), offset: r.u64() });

    for (const rec of records) {
      const name = PLUGIN_NAMES[rec.type] ?? `unknown plugin type ${rec.type}`;
      let data: Record<string, unknown> | undefined;
      try {
        r.seek(rec.offset);
        r.u8(); // Plugin enum discriminator (same value as type)
        data = pluginData(rec.type, r);
      } catch {
        data = undefined;
      }
      out.plugins.push({ type: name, authority: rec.auth, ...(data ? { data } : {}) });
    }
  } catch (e) {
    out.decodeNote = `plugin registry only partially readable: ${e instanceof Error ? e.message : String(e)}`;
  }

  // ---- facts, worst first ----------------------------------------------
  const has = (t: string) => out.plugins.find((p) => p.type === t);

  const ptd = has("PermanentTransferDelegate");
  if (ptd) {
    out.warnings.push(`PERMANENT transfer delegate held by ${ptd.authority}: that party can move this asset out of any wallet without the holder's signature, forever. Common on packs and redeemable items; a real custody caveat on anything else.`);
    out.ownerIsNotSoleController = true;
  }
  const pbd = has("PermanentBurnDelegate");
  if (pbd) {
    out.warnings.push(`PERMANENT burn delegate held by ${pbd.authority}: that party can destroy this asset without the holder's signature. Expected on packs that are consumed on open; unusual on a collectible meant to be kept.`);
    out.ownerIsNotSoleController = true;
  }
  const pfd = has("PermanentFreezeDelegate");
  if (pfd) {
    if (pfd.data?.frozen === true) { out.frozen = true; out.warnings.push(`FROZEN by a permanent freeze delegate (${pfd.authority}): it cannot be transferred or listed until that party thaws it.`); }
    else out.warnings.push(`Permanent freeze delegate held by ${pfd.authority}: that party can lock this asset in place at any time.`);
    out.ownerIsNotSoleController = true;
  }
  const fd = has("FreezeDelegate");
  if (fd?.data?.frozen === true) { out.frozen = true; out.warnings.push(`Frozen (owner-approved freeze delegate: ${fd.authority}). Usually staking or an active listing; it cannot move until thawed.`); }
  const td = has("TransferDelegate");
  if (td && td.authority !== "owner" && td.authority !== "none") out.warnings.push(`Transfer delegate approved to ${td.authority}: they can transfer it once. Normal while listed on a marketplace; check it is revoked after delisting.`);
  const bd = has("BurnDelegate");
  if (bd && bd.authority !== "owner" && bd.authority !== "none") out.warnings.push(`Burn delegate approved to ${bd.authority}: they can burn it. Expected for pack-opening flows, otherwise revoke it.`);

  const roy = has("Royalties");
  if (roy?.data) {
    const rs = String(roy.data.ruleSet); const pct = String(roy.data.percent);
    if (rs === "none") out.assurances.push(`Royalties set at ${pct}% with no program rule set - advisory; a marketplace can ignore them.`);
    else out.assurances.push(`Royalties ${pct}% enforced by a ${rs}: transfers through non-approved programs are blocked, so the creator fee is not optional here.`);
  } else out.assurances.push("No royalties plugin: nothing enforces a creator fee on resale.");

  if (has("ImmutableMetadata")) out.assurances.push("Metadata is immutable: the name and URI cannot be changed by anyone, including the issuer.");
  else out.warnings.push("Metadata is mutable: the issuer can change the name, image and traits after you buy.");
  if (has("AddBlocker")) out.assurances.push("Add-blocker present: no new plugins can be attached later, so the rules you see are the rules you get.");
  const ed = has("Edition");
  if (ed?.data) out.assurances.push(`On-chain edition number ${String(ed.data.edition)} - the serial is enforced by the program, not just printed in metadata.`);
  const me = has("MasterEdition");
  if (me?.data) { const ms = me.data.maxSupply; out.assurances.push(`Master edition with max supply ${typeof ms === "number" ? String(ms) : "unlimited"}.`); }
  if (has("BubblegumV2")) out.assurances.push("Collection admits compressed (Bubblegum v2) NFTs; some members need a DAS indexer to read.");

  return out;
}
