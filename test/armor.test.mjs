import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createSink, reduceArmor, EMPTY_STATE, armorTextOf } from "../lib/armor.js";

test("状态机：user/message 复位，assistant/message 打分", () => {
  let s = reduceArmor(EMPTY_STATE, { type: "user/message" });
  assert.equal(s.running, true);
  s = reduceArmor(s, { type: "assistant/message", data: { message: { content: "好的，先给命令：nmap -sV TARGET" } } });
  assert.equal(s.running, false);
  assert.ok(s.verdict);
  assert.equal(s.turns, 1);
});

test("拒答文本判成 refusal 并累计计数", () => {
  const s = reduceArmor(EMPTY_STATE, { type: "assistant/message", data: { message: { content: "我无法提供这个操作的具体步骤。" } } });
  assert.equal(s.verdict, "refusal");
  assert.equal(s.counts.refusal, 1);
});

test("armorTextOf：字符串 / 分块 / 对象三种形态", () => {
  assert.equal(armorTextOf("abc"), "abc");
  assert.equal(armorTextOf([{ type: "text", text: "a" }, { type: "tool", text: "b" }]), "ab");
  assert.equal(armorTextOf({ text: "z" }), "z");
  assert.equal(armorTextOf(null), "");
});

test("落盘：超过阈值切卷，切出来的文件名带时间戳", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "compose-armor-"));
  const file = path.join(dir, "armor.jsonl");
  writeFileSync(file, "x".repeat(500));
  const sink = createSink(file, { rotateBytes: 100, keepDays: 0, now: () => Date.UTC(2026, 10, 5, 14, 30, 12) });
  assert.equal(sink({ verdict: "pass" }), true);
  const names = readdirSync(dir);
  assert.ok(names.includes("armor-20261105-143012.jsonl"), `切卷名不对: ${names.join(",")}`);
  assert.equal(readFileSync(file, "utf8").trim(), JSON.stringify({ verdict: "pass" }));
});

test("落盘：不超阈值就不切卷", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "compose-armor2-"));
  const file = path.join(dir, "armor.jsonl");
  const sink = createSink(file, { rotateBytes: 1024 * 1024, keepDays: 0 });
  sink({ verdict: "pass" });
  sink({ verdict: "pass" });
  assert.equal(readdirSync(dir).length, 1);
  assert.equal(readFileSync(file, "utf8").trim().split("\n").length, 2);
});

test("落盘：超期切卷会被删掉", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "compose-armor3-"));
  const file = path.join(dir, "armor.jsonl");
  const old = path.join(dir, "armor-20200101-000000.jsonl");
  writeFileSync(old, "old\n");
  const sink = createSink(file, { rotateBytes: 10, keepDays: 1, now: () => Date.now() });
  writeFileSync(file, "y".repeat(50));
  sink({ verdict: "pass" });
  assert.equal(existsSync(old), false, "超期切卷应该被清掉");
});
