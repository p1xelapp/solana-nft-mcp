/**
 * The running version, read from package.json once, and the User-Agent every
 * outbound request carries.
 *
 * The User-Agent used to be typed by hand in each source file and had drifted
 * to "1.0" and "1.1" while the server was on 1.17. A venue reading its logs to
 * find out which build is misbehaving deserves the real number.
 */
import { createRequire } from "node:module";

export const VERSION: string = (createRequire(import.meta.url)("../../package.json") as { version: string }).version;

export const USER_AGENT = `solana-nft-mcp/${VERSION} (+https://github.com/p1xelapp/solana-nft-mcp)`;
