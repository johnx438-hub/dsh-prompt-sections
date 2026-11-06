import test from "node:test";
import assert from "node:assert/strict";
import { rateOf, shouldAlarm, createAlarmGate } from "../lib/alarm.js";

test("rate：只统计窗口内的判定，非法值忽略", () => {
  const stats = rateOf(["pass", "refusal", "x", "pass", "fallback"], 3);
  assert.equal(stats.turns, 3);
  assert.equal(stats.pass + stats.refusal + stats.fallback, 3);
  assert.ok(stats.rate >= 0 && stats.rate <= 1);
});

test("rate：空序列不炸", () => {
  const stats = rateOf([], 50);
  assert.deepEqual({ turns: stats.turns, rate: stats.rate }, { turns: 0, rate: 0 });
});

test("shouldAlarm：样本不够不报，够了且超阈值才报", () => {
  assert.equal(shouldAlarm(rateOf(["refusal", "refusal"], 50), { threshold: 0.05, minTurns: 20 }), false);
  const many = [...Array(19).fill("pass"), "refusal"];
  assert.equal(shouldAlarm(rateOf(many, 50), { threshold: 0.05, minTurns: 20 }), true);
  assert.equal(shouldAlarm(rateOf(many, 50), { threshold: 0.5, minTurns: 20 }), false);
});

test("闸门：同一状态只报一次，恢复后可以再报", () => {
  let clock = 1000;
  const gate = createAlarmGate({ threshold: 0.5, window: 4, minTurns: 4, cooldownMs: 10000, now: () => clock });
  const out = [];
  out.push(gate.push("refusal"));
  out.push(gate.push("refusal"));
  out.push(gate.push("pass"));
  out.push(gate.push("refusal")); // 4 轮里 3 次 bad → 报警
  assert.equal(out.at(-1).alarm, true);
  out.push(gate.push("refusal"));
  assert.equal(out.at(-1).alarm, false, "同一状态不应连报");
  // 恢复：窗口内全是 pass，再来的单次 refusal 不该触发
  clock += 20000;
  for (let i = 0; i < 4; i++) gate.push("pass");
  const back = gate.push("refusal");
  assert.equal(back.alarm, false);
  assert.equal(back.reason, "ok");
});
