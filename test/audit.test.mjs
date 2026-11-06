import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { auditHost, classifyRules, detectHostRoot, formatAudit, readHostVersion, scanHost } from "../lib/audit.js";

const LIVE = "You are interacting with the user through the DeepSeek Harness Web GUI at X.";
const LEGACY = "const LEGACY_SOURCE = { prefix: \"The DeepSeek Harness implementation checkout is at \", suffix: \"\" };";

function fakeHost() {
  const root = mkdtempSync(path.join(tmpdir(), "compose-audit-"));
  const pkg = path.join(root, "node_modules", "@deepseek-ai", "dsh-fake", "lib");
  mkdirSync(pkg, { recursive: true });
  writeFileSync(path.join(pkg, "index.js"), `${LIVE}\n${LEGACY}\nconst other = "nothing to see";\n`);
  writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "dsh", version: "0.2.1-rc.2" }));
  return root;
}

test("扫描：把宿主 lib 下的 js 收进语料并读出版本", () => {
  const root = fakeHost();
  const scan = scanHost(root);
  assert.equal(scan.files.length, 1);
  assert.ok(scan.bytes > 0);
  assert.equal(readHostVersion(root), "0.2.1-rc.2");
});

test("分类：live / legacy / dead 三态分开", () => {
  const root = fakeHost();
  const { rules, summary } = classifyRules(scanHost(root));
  const byId = Object.fromEntries(rules.map((r) => [r.id, r]));
  assert.equal(byId["tool:web-gui"].status, "live");
  assert.equal(byId["template:checkout-hint"].status, "legacy");
  assert.equal(byId["foreign:claude"].status, "dead");
  assert.equal(byId["format:collapse-spaces"].status, "unprobed");
  assert.equal(summary.live + summary.legacy + summary.dead + summary.unprobed, rules.length);
});

test("审计报告：文本里带三态计数与文件名", () => {
  const root = fakeHost();
  const report = auditHost({ root });
  assert.equal(report.host.version, "0.2.1-rc.2");
  assert.ok(report.summary.live >= 1);
  const text = formatAudit(report);
  assert.match(text, /rules: live=\d+ legacy=\d+ dead=\d+/);
  assert.match(text, /tool:web-gui/);
});

test("detectHostRoot：环境变量优先", () => {
  const got = detectHostRoot({ DSH_HOST_ROOT: "C:/fake/dsh" }, {}, "C:/fake/electron.exe");
  assert.equal(got.root, "C:/fake/dsh");
  assert.equal(got.source, "DSH_HOST_ROOT");
});

test("detectHostRoot：没有线索时返回 null 而不是猜", () => {
  const got = detectHostRoot({}, {}, "C:/nope/app.exe");
  assert.equal(got.root, null);
  assert.ok(Array.isArray(got.tried));
});
