/**
 * Metaplex Core plugin decoding - the custody facts nobody surfaces.
 *
 * A Core asset is one account: the base asset (owner, authority, name, uri),
 * then an optional plugin header pointing at a plugin registry, with each
 * plugin's data laid out in between. A Core collection has the same shape
 * after its own base. Marketplaces show the picture and the price. They do
 * not show that the issuer kept a permanent transfer delegate (they can move
 * your card without your signature), that the asset is frozen, that
 * royalties are enforced by an allow-list, or that a pack is designed to be
 * burned on open. Those are the facts that decide what "owning" it means.
 *
 * Plugins on the COLLECTION apply to every asset in it unless the asset
 * carries the same plugin itself, so reading only the asset can say "nothing
 * can freeze this" about an asset whose collection freezes everything. The
 * derive step takes both.
 *
 * Layout verified against the program source (mpl-core, main, 2026-09-01):
 *   AssetV1       key=1 owner(32) update_authority(1 [+32]) name(4+n) uri(4+n) seq(1 [+8])
 *   CollectionV1  key=5 update_authority(32) name(4+n) uri(4+n) num_minted u32 current_size u32
 *   PluginHeaderV1  key=3 (1) plugin_registry_offset u64 (8)   - immediately after the base
 *   PluginRegistryV1 key=4 (1) Vec<RegistryRecord> Vec<ExternalRegistryRecord>
 *   RegistryRecord  plugin_type u8, Authority (u8 [+32]), offset u64
 *   Authority: 0 None, 1 Owner, 2 UpdateAuthority, 3 Address{pubkey}
 * Plugin type discriminants follow the Plugin enum order in plugins/mod.rs.
 *
 * Everything here is read-only bytes-to-facts. Unknown plugin types are named
 * by number and skipped, never guessed - the registry is designed to be read
 * even when some plugins are newer than the reader. External plugin adapters
 * (oracles, lifecycle hooks) are counted, not decoded, and their presence is
 * reported as a gap in the custody picture rather than ignored.
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

const KEY_ASSET = 1;
const KEY_PLUGIN_HEADER = 3;
const KEY_PLUGIN_REGISTRY = 4;
const KEY_COLLECTION = 5;

export interface DecodedPlugin {
  type: string;
  /** Who can act on this plugin: none, owner, update authority, or a specific address. */
  authority: string;
  /** Decoded fields for the plugin types that carry data an owner should know. */
  data?: Record<string, unknown>;
  /** Set when the plugin lives on the collection and applies to this asset by inheritance. */
  inheritedFromCollection?: boolean;
}

export interface DecodedAccount {
  kind: "asset" | "collection";
  /** Assets only: the collection this asset belongs to, or null when it is standalone. */
  collection: string | null;
  plugins: DecodedPlugin[];
  /** Assets only: the base account's update authority is None, so nobody can edit metadata. */
  updateAuthorityIsNone: boolean;
  /** Count of external plugin adapters (oracles, lifecycle hooks) present but not decoded. */
  externalPlugins: number;
  /** Present only when the layout could not be walked to the end. */
  decodeNote?: string;
}

export interface CoreTrust {
  plugins: DecodedPlugin[];
  /** Plain-language custody facts, worst first. Empty means nothing unusual. */
  warnings: string[];
  /** Things that are actively good for the holder. */
  assurances: string[];
  frozen: boolean;
  /** True when a party other than the owner can move, freeze or burn it without the owner's signature. */
  ownerIsNotSoleController: boolean;
  /** True when the custody picture is known to be incomplete (external plugins, partial registry, collection not read). */
  incomplete: boolean;
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
  peek() { return this.buf[this.off]; }
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

/** Walk past the base account so the reader sits on the plugin header, if any. */
function skipBase(r: Reader): { kind: "asset" | "collection"; updateAuthorityIsNone: boolean; collection: string | null } {
  r.seek(0);
  const key = r.u8();
  if (key === KEY_ASSET) {
    r.pubkey(); // owner
    const ua = r.u8(); // UpdateAuthority: 0 None, 1 Address, 2 Collection
    let collection: string | null = null;
    if (ua === 1 || ua === 2) {
      const addr = r.pubkey();
      if (ua === 2) collection = addr;
    }
    r.str(); // name
    r.str(); // uri
    r.option(() => r.u64()); // seq
    return { kind: "asset", updateAuthorityIsNone: ua === 0, collection };
  }
  if (key === KEY_COLLECTION) {
    r.pubkey(); // update authority
    r.str(); // name
    r.str(); // uri
    r.u32(); // num_minted
    r.u32(); // current_size
    return { kind: "collection", updateAuthorityIsNone: false, collection: null };
  }
  throw new Error("not an AssetV1 or CollectionV1 account");
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
 * Decode the plugin registry of a Core asset OR collection account (base64
 * data from getAccountInfo). Throws only for a non-Core account; a malformed
 * registry yields what could be read plus a decodeNote.
 */
export function decodeCoreAccountPlugins(b64: string): DecodedAccount {
  const buf = Buffer.from(b64, "base64");
  const r = new Reader(buf);
  const base = skipBase(r);
  const out: DecodedAccount = { kind: base.kind, collection: base.collection, plugins: [], updateAuthorityIsNone: base.updateAuthorityIsNone, externalPlugins: 0 };

  if (r.remaining < 9 || r.peek() !== KEY_PLUGIN_HEADER) return out;
  r.u8();
  const registryOffset = r.u64();

  try {
    r.seek(registryOffset);
    if (r.u8() !== KEY_PLUGIN_REGISTRY) throw new Error("registry key mismatch");
    const n = r.u32();
    if (n > 64) throw new Error("implausible registry length");
    const records: { type: number; auth: string; offset: number }[] = [];
    for (let i = 0; i < n; i++) records.push({ type: r.u8(), auth: authority(r), offset: r.u64() });
    // External plugin adapters follow the internal records. Their records are
    // variable-length; the count alone is enough to say the picture is partial.
    if (r.remaining >= 4) {
      const ext = r.u32();
      if (ext <= 64) out.externalPlugins = ext;
      else throw new Error(`implausible external plugin count ${ext}`);
    } else {
      throw new Error("registry ends before the external plugin count");
    }

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
  return out;
}

/** A delegate held by someone other than the owner is a controller; "none" means nobody holds it. */
const heldByOther = (p: DecodedPlugin | undefined): boolean =>
  Boolean(p) && p!.authority !== "owner" && p!.authority !== "none";

/**
 * Turn decoded plugins into custody facts. Collection plugins are inherited
 * by the asset unless the asset carries the same plugin type itself.
 */
export function deriveTrust(asset: DecodedAccount, collection?: DecodedAccount | null): CoreTrust {
  const plugins: DecodedPlugin[] = [...asset.plugins];
  if (collection) {
    for (const cp of collection.plugins) {
      if (!plugins.some((p) => p.type === cp.type)) plugins.push({ ...cp, inheritedFromCollection: true });
    }
  }
  const out: CoreTrust = { plugins, warnings: [], assurances: [], frozen: false, ownerIsNotSoleController: false, incomplete: false };
  const notes = [asset.decodeNote, collection?.decodeNote ? `collection: ${collection.decodeNote}` : undefined].filter(Boolean);
  if (notes.length) out.decodeNote = notes.join("; ");

  const has = (t: string) => plugins.find((p) => p.type === t);
  const where = (p: DecodedPlugin) => (p.inheritedFromCollection ? " (set on the collection, applies to every asset in it)" : "");

  const ptd = has("PermanentTransferDelegate");
  if (ptd && heldByOther(ptd)) {
    out.warnings.push(`PERMANENT transfer delegate held by ${ptd.authority}${where(ptd)}: that party can move this asset out of any wallet without the holder's signature, forever. Common on packs and redeemable items; a real custody caveat on anything else.`);
    out.ownerIsNotSoleController = true;
  }
  const pbd = has("PermanentBurnDelegate");
  if (pbd && heldByOther(pbd)) {
    out.warnings.push(`PERMANENT burn delegate held by ${pbd.authority}${where(pbd)}: that party can destroy this asset without the holder's signature. Expected on packs that are consumed on open; unusual on a collectible meant to be kept.`);
    out.ownerIsNotSoleController = true;
  }
  const pfd = has("PermanentFreezeDelegate");
  if (pfd) {
    if (pfd.data?.frozen === true) { out.frozen = true; out.warnings.push(`FROZEN by a permanent freeze delegate (${pfd.authority})${where(pfd)}: it cannot be transferred or listed until that party thaws it.`); }
    else if (heldByOther(pfd)) out.warnings.push(`Permanent freeze delegate held by ${pfd.authority}${where(pfd)}: that party can lock this asset in place at any time.`);
    if (heldByOther(pfd)) out.ownerIsNotSoleController = true;
  }
  const fd = has("FreezeDelegate");
  if (fd?.data?.frozen === true) { out.frozen = true; out.warnings.push(`Frozen (owner-approved freeze delegate: ${fd.authority}). Usually staking or an active listing; it cannot move until thawed.`); }
  if (heldByOther(fd)) out.ownerIsNotSoleController = true;
  const td = has("TransferDelegate");
  if (heldByOther(td)) { out.warnings.push(`Transfer delegate approved to ${td!.authority}: they can transfer it once. Normal while listed on a marketplace; check it is revoked after delisting.`); out.ownerIsNotSoleController = true; }
  const bd = has("BurnDelegate");
  if (heldByOther(bd)) { out.warnings.push(`Burn delegate approved to ${bd!.authority}: they can burn it. Expected for pack-opening flows, otherwise revoke it.`); out.ownerIsNotSoleController = true; }

  const roy = has("Royalties");
  if (roy?.data) {
    const rs = String(roy.data.ruleSet); const pct = String(roy.data.percent);
    if (rs === "none") out.assurances.push(`Royalties set at ${pct}%${where(roy)} with no program rule set - advisory; a marketplace can ignore them.`);
    else out.assurances.push(`Royalties ${pct}%${where(roy)} enforced by a ${rs}: transfers through non-approved programs are blocked, so the creator fee is not optional here.`);
  } else out.assurances.push("No royalties plugin on the asset or its collection: nothing enforces a creator fee on resale.");

  if (has("ImmutableMetadata")) out.assurances.push("Metadata is immutable: the name and URI cannot be changed by anyone, including the issuer.");
  else if (asset.updateAuthorityIsNone) out.assurances.push("The asset's update authority is None: nobody can change its name or URI.");
  else out.warnings.push("Metadata is mutable: the issuer can change the name, image and traits after you buy.");
  if (has("AddBlocker")) out.assurances.push("Add-blocker present: no new plugins can be attached later, so the rules you see are the rules you get.");
  const ed = has("Edition");
  if (ed?.data) out.assurances.push(`On-chain edition number ${String(ed.data.edition)} - the serial is enforced by the program, not just printed in metadata.`);
  const me = has("MasterEdition");
  if (me?.data) { const ms = me.data.maxSupply; out.assurances.push(`Master edition with max supply ${typeof ms === "number" ? String(ms) : "unlimited"}.`); }
  if (has("BubblegumV2")) out.assurances.push("Collection admits compressed (Bubblegum v2) NFTs; some members need a DAS indexer to read.");

  const ext = asset.externalPlugins + (collection?.externalPlugins ?? 0);
  if (ext > 0) {
    out.incomplete = true;
    out.warnings.push(`${ext} external plugin adapter(s) attached (oracles or lifecycle hooks) that this decoder does not read. They can veto or gate transfers, burns and updates, so the custody picture above is incomplete.`);
  }
  if (asset.decodeNote || collection?.decodeNote) {
    out.incomplete = true;
    out.warnings.push("Part of the plugin registry could not be read, so a plugin may be missing from this picture.");
  }
  if (asset.kind === "asset" && asset.collection && !collection) {
    // The asset belongs to a collection the caller did not supply: its
    // inherited rules are unknown, so say so rather than imply completeness.
    out.incomplete = true;
    out.warnings.push(`This asset belongs to collection ${asset.collection}, whose plugins were not read; rules set there also apply to this asset.`);
  }

  if (!out.incomplete && !out.ownerIsNotSoleController && plugins.length === 0) {
    out.assurances.unshift("No plugins on the asset or its collection: nothing but the owner's own signature can move, freeze or burn this asset.");
  }
  return out;
}

/**
 * Convenience for a single account with no collection context (tests, quick
 * looks). The result is marked incomplete for assets because the collection
 * was not read; callers with the collection bytes should use
 * decodeCoreAccountPlugins + deriveTrust.
 */
export function decodeCoreTrust(b64: string): CoreTrust {
  return deriveTrust(decodeCoreAccountPlugins(b64));
}
