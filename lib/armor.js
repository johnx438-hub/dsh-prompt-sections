// armor 观测层：只读打分（复用 gen-x MIT scorer），可落盘 JSONL，不改写任何输出
//
// 0.8.0：落盘加轮转（按大小切卷 + 按天保留），并支持带 type 的记录
//   （verdict / hello / assembly），读侧据此分流。
import { appendFileSync, mkdirSync, statSync, renameSync, readdirSync, unlinkSync, readFileSync } from "node:fs";
import path from "node:path";
import { scoreResponse } from "../vendor/gen-x/scorer.mjs";
import { scoreStructure, combineVerdict } from "./structure.js";

export function armorTextOf(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((p) => p && (p.type === "text" || typeof p.text === "string"))
      .map((p) => (typeof p.text === "string" ? p.text : ""))
      .join("");
  }
  if (content && typeof content.text === "string") return content.text;
  return "";
}

export const EMPTY_STATE = Object.freeze({
  running: false, verdict: null, combined: null, structure: null, conflict: false,
  words: [], safe: [], risk: [], domain: null, domainHits: 0, turns: 0,
  counts: {}, combinedCounts: {}, conflicts: 0,
});

/** 纯函数：投影状态机（与 gen-x 同语义，额外累计计数便于面板展示） */
export function reduceArmor(state, event) {
  const s = state && typeof state === "object" ? state : { ...EMPTY_STATE };
  if (!event || typeof event !== "object") return s;
  if (event.type === "user/message") {
    return { ...s, running: true, verdict: null, combined: null, structure: null, conflict: false, words: [], safe: [], risk: [], domain: null, domainHits: 0 };
  }
  if (event.type !== "assistant/message") return s;
  const text = armorTextOf(event?.data?.message?.content);
  if (!text.trim()) return s;
  const scored = scoreResponse(text);
  const structure = scoreStructure(text);
  const combined = combineVerdict(scored.verdict, structure);
  const counts = { ...(s.counts || {}) };
  counts[scored.verdict] = (counts[scored.verdict] || 0) + 1;
  const combinedCounts = { ...(s.combinedCounts || {}) };
  combinedCounts[combined.verdict] = (combinedCounts[combined.verdict] || 0) + 1;
  return {
    ...s,
    running: false,
    verdict: scored.verdict,
    combined: combined.verdict,
    structure: structure.verdict,
    signals: structure.signals,
    conflict: !combined.agree,
    conflictNote: combined.note,
    combinedCounts,
    conflicts: (s.conflicts || 0) + (combined.agree ? 0 : 1),
    words: scored.words ?? [],
    safe: scored.safe ?? [],
    risk: scored.risk ?? [],
    domain: scored.domain ?? null,
    domainHits: scored.domainHits ?? 0,
    turns: (s.turns || 0) + 1,
    counts,
    lastLen: text.length,
  };
}

const pad = (n) => String(n).padStart(2, "0");

/**
 * 读一个 stateFile 及其所有切卷，按时间顺序返回解析后的记录（坏行跳过）。
 * @param {{limitPerFile?:number}} opts 每个文件最多取后 N 行（默认 5000）
 */
export function readArmorRecords(stateFile, opts = {}, deps = {}) {
  const limitPerFile = Number.isFinite(opts.limitPerFile) ? opts.limitPerFile : 5000;
  const readdir = deps.readdirSync || readdirSync;
  const read = deps.readFileSync || readFileSync;
  const stat = deps.statSync || statSync;
  const dir = path.dirname(stateFile);
  const stem = path.basename(stateFile).replace(/\.jsonl$/, "");
  const files = [];
  try {
    for (const name of readdir(dir)) {
      if (name !== path.basename(stateFile) && !(name.startsWith(`${stem}-`) && name.endsWith(".jsonl"))) continue;
      const file = path.join(dir, name);
      let mtime = 0;
      try { mtime = stat(file).mtimeMs; } catch { /* 忽略 */ }
      files.push({ name, file, mtime });
    }
  } catch { /* 目录读不了 */ }
  files.sort((x, y) => x.mtime - y.mtime);
  const records = [];
  for (const { name, file } of files) {
    let text = "";
    try { text = read(file, "utf8"); } catch { continue; }
    const lines = text.split("\n").filter(Boolean);
    const tail = limitPerFile > 0 ? lines.slice(-limitPerFile) : lines;
    for (const line of tail) {
      try { records.push({ ...JSON.parse(line), _file: name }); } catch { /* 坏行 */ }
    }
  }
  return records;
}

/** 切卷文件名后缀（UTC）：20261105-143012 */
export function stampOf(ms) {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`
    + `-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
}

/** 从切卷文件名读回时间；不是切卷名就返回 null */
export function stampTimeOf(name, stem) {
  const escaped = stem.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const matched = new RegExp(`^${escaped}-(\\d{8})-(\\d{6})\\.jsonl$`).exec(name);
  if (!matched) return null;
  const [, day, clock] = matched;
  const ms = Date.UTC(
    Number(day.slice(0, 4)), Number(day.slice(4, 6)) - 1, Number(day.slice(6, 8)),
    Number(clock.slice(0, 2)), Number(clock.slice(2, 4)), Number(clock.slice(4, 6)),
  );
  return Number.isFinite(ms) ? ms : null;
}

/**
 * 落盘实现（fs 可注入，便于测试）。
 * @param {string} stateFile 当前写入的 JSONL
 * @param {{rotateBytes?:number, keepDays?:number, now?:()=>number}} opts
 */
export function createSink(stateFile, opts = {}, deps = {}) {
  const rotateBytes = Number.isFinite(opts.rotateBytes) ? opts.rotateBytes : 8 * 1024 * 1024;
  const keepDays = Number.isFinite(opts.keepDays) ? opts.keepDays : 14;
  const now = opts.now || Date.now;
  const mkdir = deps.mkdirSync || mkdirSync;
  const append = deps.appendFileSync || appendFileSync;
  const stat = deps.statSync || statSync;
  const rename = deps.renameSync || renameSync;
  const readdir = deps.readdirSync || readdirSync;
  const unlink = deps.unlinkSync || unlinkSync;
  const dir = path.dirname(stateFile);
  const stem = path.basename(stateFile).replace(/\.jsonl$/, "");

  /** 删掉超期的切卷（先看文件名里的时间，读不到再看 mtime） */
  function prune() {
    if (!keepDays) return 0;
    const cutoff = now() - keepDays * 86400000;
    let removed = 0;
    try {
      for (const name of readdir(dir)) {
        if (!name.startsWith(`${stem}-`) || !name.endsWith(".jsonl")) continue;
        const file = path.join(dir, name);
        try {
          const stamped = stampTimeOf(name, stem) ?? stat(file).mtimeMs;
          if (stamped < cutoff) { unlink(file); removed += 1; }
        } catch { /* 单个文件失败不影响别的 */ }
      }
    } catch { /* 目录读不了就算了 */ }
    return removed;
  }

  /** 超阈值就把当前文件改名切卷 */
  function rotateIfNeeded() {
    if (!(rotateBytes > 0)) return false;
    let size = 0;
    try { size = stat(stateFile).size; } catch { return false; }
    if (size < rotateBytes) return false;
    try { rename(stateFile, path.join(dir, `${stem}-${stampOf(now())}.jsonl`)); } catch { return false; }
    prune();
    return true;
  }

  return (record) => {
    try {
      mkdir(dir, { recursive: true });
      rotateIfNeeded();
      append(stateFile, JSON.stringify(record) + "\n");
      return true;
    } catch {
      return false;
    }
  };
}
