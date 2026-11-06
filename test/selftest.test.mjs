import test from "node:test";
import assert from "node:assert/strict";
import { runSelfTest, formatSelfTest } from "../lib/selftest.js";
import { RULES } from "../lib/scrub.js";
import { resolveConfig } from "../lib/config.js";

const rawCfg = {
  mode: "write",
  refuseStrategy: "genx",
  matrix: { "cold-deep-scout": { payload: "genx", lead: false, capability: false, boost: false, scrub: true }, default: "none" },
  sectionNames: { kernel: "compose:kernel" },
};
const baseCfg = resolveConfig(rawCfg).cfg;

test("自检：默认配置全项 PASS（宿主版本缺失只 WARN）", () => {
  const r = runSelfTest({ cfg: baseCfg, host: { version: "0.2.1-rc.2", root: "/x" } });
  assert.equal(r.ok, true);
  const byName = Object.fromEntries(r.checks.map((c) => [c.name, c]));
  assert.equal(byName.host.status, "PASS");
  assert.equal(byName.payload.status, "PASS");
  assert.equal(byName["preset-route"].status, "PASS");
  assert.equal(byName.kernel.status, "PASS");
  assert.equal(byName.assembly.status, "PASS");
  assert.equal(byName["alarm-gate"].status, "PASS");
});

test("自检：宿主版本缺失不判 FAIL", () => {
  const r = runSelfTest({ cfg: baseCfg, host: { version: null, root: null } });
  assert.equal(r.ok, true);
  assert.equal(r.checks.find((c) => c.name === "host").status, "WARN");
});

test("自检：载荷缺失判 FAIL 并说清原因", () => {
  const cfg = resolveConfig({ ...rawCfg, matrix: { "cold-deep-scout": { payload: "community" }, default: "none" }, communityPayloadPath: "Z:/nope/prompt-inject.md" }).cfg;
  const r = runSelfTest({ cfg, host: { version: "x" } });
  const payload = r.checks.find((c) => c.name === "payload");
  assert.equal(payload.status, "FAIL");
  assert.match(payload.detail, /missing-file/);
  assert.equal(r.ok, false);
});

test("自检：lead=true 时装配位置为头部", () => {
  const cfg = resolveConfig({ ...rawCfg, matrix: { "cold-deep-scout": { payload: "genx", lead: true }, default: "none" } }).cfg;
  const r = runSelfTest({ cfg, host: { version: "x" } });
  const assembly = r.checks.find((c) => c.name === "assembly");
  assert.equal(assembly.status, "PASS");
  assert.match(assembly.detail, /index=0\//);
});

test("自检：shadow 模式会报出被停用规则的命中", () => {
  const liveOnly = RULES.filter((rule) => rule.kind === "format");
  const r = runSelfTest({ cfg: baseCfg, host: { version: "x" }, scrub: { mode: "shadow" }, rules: liveOnly });
  const scrub = r.checks.find((c) => c.name === "scrub");
  assert.match(scrub.detail, /shadow/);
});

test("格式化：带模式行与逐项状态", () => {
  const r = runSelfTest({ cfg: baseCfg, host: { version: "0.2.1-rc.2" } });
  const text = formatSelfTest(r, { mode: "write", scrubMode: "shadow" });
  assert.match(text, /selftest: OK/);
  assert.match(text, /mode: write/);
  assert.match(text, /scrubMode: shadow/);
  assert.match(text, /PASS host:/);
});
