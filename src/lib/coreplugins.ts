/**
 * Metaplex Core plugin decoding - the custody facts nobody surfaces.
 *
 * A Core asset is one account: the base asset (owner, authority, name, uri),
 * then an optional plugin header pointing at a plugin registry, with each
 * plugin's data laid out in between. A Core collection has the same shape
 * after its own base. Marketplaces show the picture and the price. They do
 * not show that the issuer kept a permanent transfer delegate (they can move
 * your card without your signature), that the asset is frozen, that a
 * royalty allow-list limits where it can trade (without checking the fee is
 * paid), or that a pack is designed to be burned on open. Those are the facts that decide what "owning" it means.
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
 * even when some plugins are newer than the reader.
 *
 * External plugin adapters follow the internal records (verified against
 * mpl-core plugin_registry.rs and oracle.rs, main, 2026-10-26):
 *   ExternalRegistryRecord  plugin_type u8, Authority, Option<Vec<(event u8, flags u32)>>,
 *                           offset u64, data_offset Option<u64>, data_len Option<u64>
 *   flags: 1 listen, 2 approve, 4 reject; events: 0 create 1 transfer 2 burn 3 update 4 execute
 *   Oracle (at offset, after its adapter tag) base_address(32) Option<ExtraAccount>
 *                           results_offset: 0 none, 1 anchor (8), 2 custom u64
 *   OracleValidation in the oracle account: 0 uninitialized, 1 V1 {create, transfer, burn, update}
 *   ExternalValidationResult: 0 approved, 1 rejected, 2 pass
 * An Oracle with a fixed account is decoded here and its answer read by the
 * caller. One whose account is derived per transaction, and every other
 * adapter type, stays a named gap in the custody picture.
 */

import { base58Encode } from "../sources/solana.js";
import { clean, safeHttpsUrl } from "./untrusted.js";

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

/** Owns every ordinary wallet; on a royalty allow-list it lets plain wallet-to-wallet transfers through. */
const SYSTEM_PROGRAM = "11111111111111111111111111111111";
const KEY_ASSET = 1;
const KEY_PLUGIN_HEADER = 3;
const KEY_PLUGIN_REGISTRY = 4;
const KEY_COLLECTION = 5;

export interface DecodedPlugin {
  type: string;
  /** Who can act on this plugin: none, owner, update authority, or a specific address. */
  authority: string;
  /** True when the registry lists the plugin but its data could not be decoded: present, not absent. */
  unreadable?: boolean;
  /** True when the plugin type is newer than this reader: present, and what it permits is unknown. */
  unsupported?: boolean;
  /** Decoded fields for the plugin types that carry data an owner should know. */
  data?: Record<string, unknown>;
  /** Set when the plugin lives on the collection and applies to this asset by inheritance. */
  inheritedFromCollection?: boolean;
}

const EXTERNAL_NAMES = ["LifecycleHook", "Oracle", "AppData", "LinkedLifecycleHook", "LinkedAppData", "DataSection", "AgentIdentity"] as const;
const LIFECYCLE_EVENTS = ["create", "transfer", "burn", "update", "execute"] as const;
const ORACLE_RESULTS = ["approved", "rejected", "pass"] as const;
export type OracleResult = (typeof ORACLE_RESULTS)[number];

export interface DecodedExternal {
  type: string;
  authority: string;
  /** The lifecycle events the program consults this adapter on, and what it may do there. */
  checks: { event: string; canReject: boolean; canApprove: boolean; canListen: boolean }[];
  /** Oracles only: the account whose bytes answer each check, or the base address when it is derived per transaction. */
  oracle?: { account: string; resultsOffset: number } | { derivedFrom: string };
  /** Oracles only: the base address the program keys this record by. */
  oracleBase?: string;
  /** True when the record or the adapter body could not be decoded. */
  unreadable?: boolean;
  inheritedFromCollection?: boolean;
}

/** What one oracle account said when it was read. Missing, short and uninitialized accounts all make the program fail the action. */
export interface OracleReading {
  account: string;
  state: "answered" | "missing" | "invalid" | "uninitialized" | "unread";
  results?: Record<"create" | "transfer" | "burn" | "update", OracleResult>;
  owner?: string;
  slot?: number | null;
  note?: string;
}

/** Decode the validation struct an oracle account carries at `offset`. */
export function decodeOracleValidation(b64: string, offset: number): Pick<OracleReading, "state" | "results"> {
  const buf = Buffer.from(b64, "base64");
  if (offset < 0 || offset + 5 > buf.length) return { state: "invalid" };
  const tag = buf[offset];
  if (tag === 0) return { state: "uninitialized" };
  if (tag !== 1) return { state: "invalid" };
  const at = (i: number): OracleResult | null => ORACLE_RESULTS[buf[offset + 1 + i]!] ?? null;
  const [create, transfer, burn, update] = [at(0), at(1), at(2), at(3)];
  if (!create || !transfer || !burn || !update) return { state: "invalid" };
  return { state: "answered", results: { create, transfer, burn, update } };
}

export interface DecodedAccount {
  kind: "asset" | "collection";
  /** Assets only: the collection this asset belongs to, or null when it is standalone. */
  collection: string | null;
  plugins: DecodedPlugin[];
  /** Assets only: the base account's update authority is None, so nobody can edit metadata. */
  updateAuthorityIsNone: boolean;
  /** Count of external plugin adapters (oracles, lifecycle hooks) attached. */
  externalPlugins: number;
  /** The external adapters this reader could decode, in registry order. Absent on hand-built accounts, which count adapters only. */
  external?: DecodedExternal[];
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
  /**
   * Actions an oracle check refused at read time (transfer, burn, update).
   * An ordinary transfer, sale or burn fails on chain while it is listed here.
   * Empty with `incomplete: false` means every attached oracle was read and
   * none refused; with `incomplete: true` an unread adapter may still refuse.
   */
  blockedByOracle: string[];
  /** One row per oracle check, with what its account answered when read. */
  oracleChecks: { account: string; inheritedFromCollection: boolean; events: string[]; reading: OracleReading }[];
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
  // subarray and toString stop quietly at the end of the buffer; a short read
  // here is a misparse, so it throws and the plugin is reported unreadable.
  pubkey() { if (this.off + 32 > this.buf.length) throw new Error("public key runs past the end of the account"); const v = base58Encode(this.buf.subarray(this.off, this.off + 32)); this.off += 32; return v; }
  str() { const n = this.u32(); if (n > 4096) throw new Error("implausible string length"); if (this.off + n > this.buf.length) throw new Error("string runs past the end of the account"); const s = this.buf.toString("utf8", this.off, this.off + n); this.off += n; return s; }
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
      // Reading only the first 64 of a longer list left the cursor in the
      // middle of it, and the rule set was then read from the wrong bytes.
      if (n > 64) throw new Error(`implausible creator count ${n}`);
      const creators: { address: string; percentage: number }[] = [];
      for (let i = 0; i < n; i++) creators.push({ address: r.pubkey(), percentage: r.u8() });
      const rs = r.u8();
      const ruleSet = rs === 0 ? "none" : rs === 1 ? "program allow-list" : rs === 2 ? "program deny-list" : `unknown(${rs})`;
      // The list itself, not just its kind: whether the System Program is on
      // an allow-list decides whether a plain wallet-to-wallet transfer passes.
      if (rs === 1 || rs === 2) {
        const count = r.u32();
        if (count > 64) throw new Error(`implausible program list length ${count}`);
        const programs: string[] = [];
        for (let i = 0; i < count; i++) programs.push(r.pubkey());
        return { percent: basisPoints / 100, creators, ruleSet, programs, programCount: count };
      }
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
      // Issuer-written key/value text: neutralised, capped, and kept as a
      // list so a key like "__proto__" or "constructor" is just a string.
      const n = r.u32(); const list: { key: string; value: string }[] = [];
      for (let i = 0; i < n && i < 64; i++) { const k = r.str(); const v = r.str(); list.push({ key: clean(k).slice(0, 80), value: clean(v).slice(0, 200) }); }
      return { attributes: list, ...(n > 64 ? { truncated: n - 64 } : {}) };
    }
    case 9: return { edition: r.u32() };
    case 10: { // MasterEdition
      const maxSupply = r.option(() => r.u32());
      const name = r.option(() => r.str());
      const uri = r.option(() => r.str());
      return { maxSupply, name: name === null ? null : clean(name).slice(0, 120), uri: safeHttpsUrl(uri, { max: 300 }) };
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
  const out: DecodedAccount = { kind: base.kind, collection: base.collection, plugins: [], updateAuthorityIsNone: base.updateAuthorityIsNone, externalPlugins: 0, external: [] };

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
    // External plugin adapters follow the internal records.
    if (r.remaining >= 4) {
      const ext = r.u32();
      if (ext <= 64) out.externalPlugins = ext;
      else throw new Error(`implausible external plugin count ${ext}`);
    } else {
      throw new Error("registry ends before the external plugin count");
    }
    // Decoded on their own: a misread here must not cost the internal plugins
    // above, so a failure leaves one unreadable row per adapter and moves on.
    const extRecords: { type: number; auth: string; checks: DecodedExternal["checks"]; offset: number }[] = [];
    try {
      for (let i = 0; i < out.externalPlugins; i++) {
        const type = r.u8();
        const auth = authority(r);
        const checks = r.option(() => {
          const n = r.u32();
          if (n > 8) throw new Error(`implausible lifecycle check count ${n}`);
          const list: DecodedExternal["checks"] = [];
          for (let j = 0; j < n; j++) {
            const ev = r.u8();
            const flags = r.u32();
            list.push({ event: LIFECYCLE_EVENTS[ev] ?? `unknown(${ev})`, canListen: (flags & 1) !== 0, canApprove: (flags & 2) !== 0, canReject: (flags & 4) !== 0 });
          }
          return list;
        }) ?? [];
        const offset = r.u64();
        r.option(() => r.u64()); // data_offset
        r.option(() => r.u64()); // data_len
        extRecords.push({ type, auth, checks, offset });
      }
    } catch (e) {
      // Half a list is not a list: every adapter is reported unreadable.
      extRecords.length = 0;
      out.external = Array.from({ length: out.externalPlugins }, () => ({ type: "external adapter", authority: "unknown", checks: [], unreadable: true }));
      out.decodeNote = `external plugin records unreadable: ${e instanceof Error ? e.message : String(e)}`;
    }
    const decodedExternal: DecodedExternal[] = [];
    for (const rec of extRecords) {
      const row: DecodedExternal = { type: EXTERNAL_NAMES[rec.type] ?? `unknown external type ${rec.type}`, authority: rec.auth, checks: rec.checks };
      if (rec.type === 1) {
        try {
          r.seek(rec.offset);
          if (r.u8() !== 1) throw new Error("adapter tag is not Oracle");
          const baseAddress = r.pubkey();
          row.oracleBase = baseAddress;
          // base_address_config: None, or an ExtraAccount. Preconfigured
          // (0-4) and CustomPda (5) derive the account per transaction, so
          // it cannot be read ahead of one; Address (6) names it outright.
          const hasConfig = r.u8();
          let account: string | null = baseAddress;
          if (hasConfig === 1) {
            const extra = r.u8();
            if (extra <= 4) { r.u8(); r.u8(); account = null; }
            else if (extra === 5) { row.oracle = { derivedFrom: baseAddress }; decodedExternal.push(row); continue; }
            else if (extra === 6) { account = r.pubkey(); r.u8(); r.u8(); }
            else throw new Error(`unknown extra account kind ${extra}`);
          } else if (hasConfig !== 0) throw new Error(`option tag ${hasConfig}`);
          const kind = r.u8();
          const resultsOffset = kind === 0 ? 0 : kind === 1 ? 8 : kind === 2 ? r.u64() : -1;
          if (resultsOffset < 0 || resultsOffset > 10_000_000) throw new Error(`unknown results offset kind ${kind}`);
          row.oracle = account ? { account, resultsOffset } : { derivedFrom: baseAddress };
        } catch {
          row.unreadable = true;
        }
      }
      decodedExternal.push(row);
    }
    if (extRecords.length) out.external = decodedExternal;

    const failures: string[] = [];
    for (const rec of records) {
      const known = rec.type < PLUGIN_NAMES.length;
      const name = known ? PLUGIN_NAMES[rec.type]! : `unknown plugin type ${rec.type}`;
      // A type this reader does not know is not "no extra permission": it
      // was being skipped in silence and the picture called complete.
      if (!known) {
        failures.push(`${name}: not decoded by this version, so what it permits is unknown`);
        out.plugins.push({ type: name, authority: rec.auth, unreadable: true, unsupported: true });
        continue;
      }
      let data: Record<string, unknown> | undefined;
      let unreadable = false;
      try {
        r.seek(rec.offset);
        const disc = r.u8(); // Plugin enum discriminator (same value as type)
        if (disc !== rec.type) throw new Error(`discriminator ${disc} != registry type ${rec.type}`);
        data = pluginData(rec.type, r);
      } catch (e) {
        unreadable = true;
        failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`);
      }
      out.plugins.push({ type: name, authority: rec.auth, ...(data ? { data } : {}), ...(unreadable ? { unreadable: true } : {}) });
    }
    if (failures.length) out.decodeNote = [out.decodeNote, `plugin data unreadable for ${failures.join("; ")}`].filter(Boolean).join("; ");
  } catch (e) {
    out.decodeNote = `plugin registry only partially readable: ${e instanceof Error ? e.message : String(e)}`;
  }
  return out;
}

/** A delegate held by someone other than the owner is a controller; "none" means nobody holds it. */
const heldByOther = (p: DecodedPlugin | undefined): boolean =>
  Boolean(p) && p!.authority !== "owner" && p!.authority !== "none";

/**
 * The oracle accounts a caller has to read before deriveTrust can say whether
 * an oracle refuses anything. Deduplicated; derived accounts are not listed
 * because their address depends on the transaction.
 */
export function oracleAccountsToRead(asset: DecodedAccount, collection?: DecodedAccount | null): { account: string; resultsOffset: number }[] {
  const seen = new Map<string, { account: string; resultsOffset: number }>();
  for (const e of [...(asset.external ?? []), ...(collection?.external ?? [])]) {
    if (e.oracle && "account" in e.oracle) seen.set(oracleReadingKey(e.oracle.account, e.oracle.resultsOffset), { account: e.oracle.account, resultsOffset: e.oracle.resultsOffset });
  }
  return [...seen.values()];
}

/** Readings are keyed by account AND offset: two records can read different places in one account. */
export function oracleReadingKey(account: string, resultsOffset: number): string {
  return `${account}@${resultsOffset}`;
}

const ORACLE_FAILS: Record<Exclude<OracleReading["state"], "answered" | "unread">, string> = {
  missing: "the oracle account does not exist, and the program fails the check when it cannot read one",
  invalid: "the oracle account's bytes are not a validation answer, and the program fails the check on that",
  uninitialized: "the oracle account is uninitialized, and the program fails the check on that",
};

/**
 * Turn decoded plugins into custody facts. Collection plugins are inherited
 * by the asset unless the asset carries the same plugin type itself. Oracle
 * answers come from `oracleReadings`, keyed by oracle account; an oracle with
 * no reading stays a gap.
 */
export function deriveTrust(asset: DecodedAccount, collection?: DecodedAccount | null, oracleReadings?: Map<string, OracleReading>): CoreTrust {
  const plugins: DecodedPlugin[] = [...asset.plugins];
  if (collection) {
    for (const cp of collection.plugins) {
      if (!plugins.some((p) => p.type === cp.type)) plugins.push({ ...cp, inheritedFromCollection: true });
    }
  }
  const out: CoreTrust = { plugins, warnings: [], assurances: [], frozen: false, blockedByOracle: [], oracleChecks: [], ownerIsNotSoleController: false, incomplete: false };

  // External adapters: an Oracle whose account was read is a settled fact;
  // anything else attached is a gap that keeps the picture incomplete.
  // An account built by hand (older callers, fixtures) may carry only the
  // count: every adapter it counts is then an unread one.
  const assetExt = asset.external ?? [];
  const collectionExt = collection?.external ?? [];
  // The program keys oracle records by their base address, and the asset's
  // record stands in for a collection record with the same key.
  const assetOracleBases = new Set(assetExt.filter((e) => e.oracleBase).map((e) => e.oracleBase));
  const externals = [
    ...assetExt.map((e) => ({ ...e, inheritedFromCollection: false })),
    ...collectionExt.filter((e) => !(e.oracleBase && assetOracleBases.has(e.oracleBase))).map((e) => ({ ...e, inheritedFromCollection: true })),
  ];
  let unreadExternal = asset.externalPlugins - assetExt.length + (collection ? collection.externalPlugins - collectionExt.length : 0);
  const blocked = new Set<string>();
  const blockedVia = new Set<boolean>();
  const failing: string[] = [];
  for (const e of externals) {
    const events = e.checks.filter((c) => c.canReject).map((c) => c.event);
    if (e.type !== "Oracle" || e.unreadable || !e.oracle || !("account" in e.oracle)) {
      // An adapter that is consulted on nothing and can reject nothing cannot
      // block a transfer; everything else is unread.
      if (e.unreadable || events.length > 0 || e.type !== "Oracle") unreadExternal++;
      continue;
    }
    const reading = oracleReadings?.get(oracleReadingKey(e.oracle.account, e.oracle.resultsOffset)) ?? { account: e.oracle.account, state: "unread" as const };
    out.oracleChecks.push({ account: e.oracle.account, inheritedFromCollection: e.inheritedFromCollection, events, reading });
    if (reading.state === "unread") { if (events.length) unreadExternal++; continue; }
    for (const ev of events) {
      if (ev === "execute") continue;
      const refuses = reading.state === "answered" ? reading.results![ev as keyof NonNullable<OracleReading["results"]>] === "rejected" : true;
      if (!refuses) continue;
      blocked.add(ev);
      blockedVia.add(e.inheritedFromCollection);
      if (reading.state !== "answered") failing.push(`${ev}: ${ORACLE_FAILS[reading.state]}`);
    }
  }
  out.blockedByOracle = ["transfer", "burn", "update", "create"].filter((ev) => blocked.has(ev));
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
  for (const p of plugins) {
    if (p.unreadable && /Freeze/.test(p.type)) out.warnings.push(`${p.type} is present but its frozen state could not be decoded: the asset may be frozen.`);
  }
  // A freeze blocks the HOLDER. A permanent transfer delegate's transfer is
  // force-approved by the program, frozen or not, so an absolute "cannot be
  // transferred" beside that delegate was false reassurance
  // (Metaplex Core docs, permanent transfer delegate).
  const forceApproved = ptd && heldByOther(ptd) ? ` The permanent transfer delegate (${ptd.authority}) is the exception: its transfers are force-approved by the program even while the asset is frozen.` : "";
  for (const p of plugins) {
    if (p.unsupported) out.warnings.push(`${p.type} is attached (authority: ${p.authority}) and this version cannot read it: it may grant a control over transfers, freezes or burns that the picture below does not show.`);
  }
  const pfd = has("PermanentFreezeDelegate");
  if (pfd) {
    if (pfd.data?.frozen === true) { out.frozen = true; out.warnings.push(`FROZEN by a permanent freeze delegate (${pfd.authority})${where(pfd)}: the holder cannot transfer or list it until that party thaws it.${forceApproved}`); }
    else if (heldByOther(pfd)) out.warnings.push(`Permanent freeze delegate held by ${pfd.authority}${where(pfd)}: that party can lock this asset in place at any time.`);
    if (heldByOther(pfd)) out.ownerIsNotSoleController = true;
  }
  const fd = has("FreezeDelegate");
  if (fd?.data?.frozen === true) { out.frozen = true; out.warnings.push(`Frozen (owner-approved freeze delegate: ${fd.authority}). Usually staking or an active listing; the holder cannot move it until thawed.${forceApproved}`); }
  if (heldByOther(fd)) out.ownerIsNotSoleController = true;
  const td = has("TransferDelegate");
  if (heldByOther(td)) { out.warnings.push(`Transfer delegate approved to ${td!.authority}: they can transfer it once. Normal while listed on a marketplace; check it is revoked after delisting.`); out.ownerIsNotSoleController = true; }
  const bd = has("BurnDelegate");
  if (heldByOther(bd)) { out.warnings.push(`Burn delegate approved to ${bd!.authority}: they can burn it. Expected for pack-opening flows, otherwise revoke it.`); out.ownerIsNotSoleController = true; }

  // Whether the picture is complete is decided BEFORE any assurance that
  // rests on absence. "No royalties plugin" beside an unread collection or an
  // unread external adapter was a definite claim built on a hole.
  const contextIncomplete =
    unreadExternal > 0 ||
    Boolean(asset.decodeNote || collection?.decodeNote) ||
    (asset.kind === "asset" && Boolean(asset.collection) && !collection) ||
    plugins.some((p) => p.unsupported);
  const roy = has("Royalties");
  if (roy?.unreadable) out.warnings.push("A Royalties plugin is present but its data could not be decoded: assume a creator fee may apply and may be enforced.");
  else if (roy?.data) {
    const rs = String(roy.data.ruleSet); const pct = String(roy.data.percent);
    // What mpl-core's royalty rule set checks is WHICH PROGRAMS own the
    // accounts in a transfer. It never checks that the fee was paid. It used
    // to be reported as "the creator fee is not optional", which is a
    // financial assurance the program does not give: Candy's allow-list
    // includes the System Program, so a direct wallet-to-wallet transfer
    // passes and pays nothing.
    const programs = Array.isArray(roy.data.programs) ? (roy.data.programs as string[]) : [];
    const count = typeof roy.data.programCount === "number" ? roy.data.programCount : programs.length;
    const listed = `${count} program${count === 1 ? "" : "s"}`;
    if (rs === "none") out.assurances.push(`Royalties set at ${pct}%${where(roy)} with no program rule set - advisory; a marketplace can ignore them.`);
    else if (rs === "program allow-list") {
      out.assurances.push(`Royalties ${pct}%${where(roy)} with a program allow-list of ${listed}: a transfer is refused unless the accounts involved belong to a listed program.`);
      out.warnings.push(
        `That allow-list limits which programs can move the asset; it does not check that the ${pct}% fee is paid. Whether a sale pays it is up to the marketplace that handles it.` +
          // mpl-core's rule passes a transfer when the programs that OWN the
          // signer's account and the new owner's account are both listed
          // (royalties.rs validate_transfer). Every ordinary wallet account is
          // owned by the System Program, so its presence lets a plain
          // wallet-to-wallet transfer through this rule.
          (programs.includes(SYSTEM_PROGRAM)
            ? " The list includes the System Program, which owns every ordinary wallet account, so this rule lets a direct transfer from one wallet to another through, and nothing in such a transfer pays the fee."
            : ""),
      );
    } else if (rs === "program deny-list") {
      out.assurances.push(`Royalties ${pct}%${where(roy)} with a program deny-list of ${listed}: transfers through those programs are refused.`);
      out.warnings.push(`A deny-list only blocks the programs on it. Any other program, and a direct wallet-to-wallet transfer, can move the asset without paying the ${pct}% fee.`);
    } else {
      out.incomplete = true;
      out.warnings.push(`Royalties ${pct}%${where(roy)} with a rule set this version does not recognise (${rs}): what it restricts could not be read, and nothing here says the fee is enforced.`);
    }
  } else if (!roy && contextIncomplete) out.warnings.push("No Royalties plugin in the decoded data, but part of the picture was not read (see the warnings below), so whether a creator fee is enforced on resale cannot be settled from this read.");
  else if (!roy) out.assurances.push("No royalties plugin on the asset or its collection: nothing enforces a creator fee on resale.");

  if (has("ImmutableMetadata")) out.assurances.push("Metadata is immutable: the name and URI cannot be changed by anyone, including the issuer.");
  else if (asset.updateAuthorityIsNone) out.assurances.push("The asset's update authority is None: nobody can change its name or URI.");
  else out.warnings.push("Metadata is mutable: the issuer can change the name, image and traits after you buy.");
  if (has("AddBlocker")) out.assurances.push("Add-blocker present: no new plugins can be attached later, so the rules you see are the rules you get.");
  const ed = has("Edition");
  if (ed?.data) out.assurances.push(`On-chain edition number ${String(ed.data.edition)} - the serial is enforced by the program, not just printed in metadata.`);
  const me = has("MasterEdition");
  if (me?.data) { const ms = me.data.maxSupply; out.assurances.push(`Master edition with max supply ${typeof ms === "number" ? String(ms) : "unlimited"}.`); }
  if (has("BubblegumV2")) out.assurances.push("Collection admits compressed (Bubblegum v2) NFTs; some members need a DAS indexer to read.");

  if (out.blockedByOracle.length) {
    const viaCollection = blockedVia.has(true) ? " It is set on the collection, so it applies to every asset in it." : "";
    const accounts = [...new Set(out.oracleChecks.map((c) => c.account))].join(", ");
    // Say what each refusal stops, and only that: a refused burn says nothing
    // about whether the item can be sold.
    const effects: string[] = [];
    if (blocked.has("transfer")) effects.push("an ordinary transfer, sale or listing that moves the item fails on chain");
    if (blocked.has("burn")) effects.push("a burn by the holder fails");
    if (blocked.has("update")) effects.push("a metadata update fails");
    if (blocked.has("create")) effects.push("creating new items under it fails");
    // Permanent delegates are force-approved before any oracle is asked
    // (mpl-core validate_asset_permissions), so the issuer's own moves pass.
    const exceptions: string[] = [];
    if (ptd && heldByOther(ptd) && blocked.has("transfer")) exceptions.push(`transfers by the permanent transfer delegate (${ptd.authority})`);
    if (pbd && heldByOther(pbd) && blocked.has("burn")) exceptions.push(`burns by the permanent burn delegate (${pbd.authority})`);
    out.warnings.unshift(
      `BLOCKED BY AN ORACLE when read: ${out.blockedByOracle.join(", ")}. The program asks oracle account ${accounts} before ${out.blockedByOracle.length === 1 ? "this action" : "these actions"} and the answer was no${failing.length ? ` (${failing.join("; ")})` : ""}, so ${effects.join(", and ")}, until that answer changes.${viaCollection} Whoever controls that account can change the answer at any time, so this describes the moment of the read.${exceptions.length ? ` The exception is ${exceptions.join(" and ")}: the program force-approves those before it asks the oracle.` : ""}`,
    );
  } else if (out.oracleChecks.some((c) => c.reading.state === "answered")) {
    out.assurances.push(`Oracle check${out.oracleChecks.length === 1 ? "" : "s"} attached (${[...new Set(out.oracleChecks.map((c) => c.account))].join(", ")}) answered without refusing anything when read. Its controller can change that answer at any time.`);
  }
  if (unreadExternal > 0) {
    out.incomplete = true;
    out.warnings.push(`${unreadExternal} external plugin adapter(s) attached (oracles or lifecycle hooks) that this read could not settle. They can veto or gate transfers, burns and updates, so the custody picture above is incomplete.`);
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

  if (!out.incomplete && !out.ownerIsNotSoleController && plugins.length === 0 && externals.length === 0) {
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
