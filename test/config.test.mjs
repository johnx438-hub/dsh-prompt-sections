import test from "node:test";
import assert from "node:assert/strict";
import { resolveConfig, DEFAULT_CONFIG, validateConfig } from "../lib/config.js";

test("默认值：模式是 observe，新增的 canary/audit/轮转都有默认", () => {
  const { cfg, issues } = resolveConfig({});
  assert.deepEqual(issues, []);
  assert.equal(cfg.mode, "observe");
  assert.equal(cfg.canary.enabled, true);
  assert.equal(cfg.canary.injectText, false);
  assert.equal(cfg.audit.hostRoot, null);
  assert.ok(cfg.armor.rotateBytes > 0);
  assert.ok(cfg.armor.keepDays > 0);
});

test("matrix 走替换语义：给了就整体替换并补 default:none", () => {
  const { cfg } = resolveConfig({ matrix: { "cold-deep-scout": "genx" } });
  assert.deepEqual(Object.keys(cfg.matrix).sort(), ["cold-deep-scout", "default"]);
  assert.equal(cfg.matrix.default, "none");
});

test("非法 mode 会被记录并降级为 observe，而不是硬崩", () => {
  const { cfg, issues } = resolveConfig({ mode: "yolo" });
  assert.ok(issues.some((i) => i.includes("mode")));
  assert.equal(cfg.mode, "yolo", "resolveConfig 只报告，不擅自改");
});

test("轮转与审计字段的类型校验", () => {
  const bad = validateConfig({
    ...DEFAULT_CONFIG,
    armor: { ...DEFAULT_CONFIG.armor, rotateBytes: -1, keepDays: "x" },
    canary: { enabled: true, token: 5 },
    audit: { hostRoot: 42 },
  });
  assert.ok(bad.some((i) => i.includes("rotateBytes")));
  assert.ok(bad.some((i) => i.includes("keepDays")));
  assert.ok(bad.some((i) => i.includes("canary.token")));
  assert.ok(bad.some((i) => i.includes("audit.hostRoot")));
});

test("嵌套配置按字段合并，不整体覆盖", () => {
  const { cfg } = resolveConfig({ armor: { rotateBytes: 1024 } });
  assert.equal(cfg.armor.rotateBytes, 1024);
  assert.equal(cfg.armor.enabled, true, "没写的字段应保留默认");
  assert.ok(cfg.armor.stateFile.endsWith("armor.jsonl"));
});
