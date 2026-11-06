// 载荷加载：community（运行时路径）与 gen-x（包内 vendor），都不做内容改写
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const VENDOR_GENX = path.resolve(HERE, "..", "vendor", "gen-x", "infinite-gen-x.md");

export function payloadPath(kind, cfg) {
  if (kind === "community") return cfg.communityPayloadPath;
  if (kind === "genx") return cfg.genxPayloadPath || VENDOR_GENX;
  return null;
}

/**
 * @returns {{kind:string, text:string|null, source:string|null, reason:string}}
 */
export function loadPayload(kind, cfg, deps = {}) {
  const exists = deps.existsSync || existsSync;
  const read = deps.readFileSync || ((p) => readFileSync(p, "utf8"));
  if (kind === "none") return { kind, text: null, source: null, reason: "no-payload" };
  const p = payloadPath(kind, cfg);
  if (!p || !exists(p)) return { kind, text: null, source: p, reason: "missing-file" };
  const text = read(p);
  if (typeof text !== "string" || text.trim() === "") return { kind, text: null, source: p, reason: "empty-file" };
  return { kind, text, source: p, reason: "ok" };
}
