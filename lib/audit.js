// 宿主审计：每条清洗规则今天还有没有目标？（live / legacy / dead）
//
// 背景：0.8.0 之前 scrub 是"一把正则链"，宿主动一句文案就静默失效。
// 这里把规则表的 probe 拿去扫宿主包，给出三态：
//   live   —— 今天的宿主文本里还有这条规则的目标（真的在干活）
//   legacy —— 只出现在 LEGACY_* / 旧文案常量里（只在旧会话回放时生效）
//   dead   —— 一个目标都找不到（规则已过期，纯粹空转）
//
// 纯读、纯函数；不加载宿主代码、不执行它。

import path from "node:path";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { RULES } from "./scrub.js";

const DEFAULT_MAX_FILES = 3000;
const DEFAULT_MAX_BYTES = 48 * 1024 * 1024;
const LEGACY_WINDOW = 400;

/** 探测宿主安装目录（Electron 桌面端优先；找不到就返回 null，由调用方提示配置） */
const looksLikeHost = (dir) => {
  if (!dir) return false;
  try { return statSync(path.join(dir, "node_modules", "@deepseek-ai")).isDirectory(); } catch { return false; }
};

/**
 * 探测宿主安装目录。顺序：环境变量 → Electron 二进制旁 → 常见安装路径（CLI 场景）。
 * 探测不到就返回 null，由调用方决定降级；绝不猜一个不存在的路径。
 */
export function detectHostRoot(env = process.env, versions = process.versions, execPath = process.execPath) {
  const tried = [];
  const candidates = [];
  const push = (p, source) => { if (p && !candidates.some((c) => c.path === p)) candidates.push({ path: p, source }); };

  if (env.DSH_HOST_ROOT) push(env.DSH_HOST_ROOT, "DSH_HOST_ROOT");
  if (versions && versions.electron && execPath) {
    push(path.join(path.dirname(execPath), "resources", "app", "dsh"), "electron");
  }
  for (const base of [env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, "Programs"), env.ProgramFiles, env["ProgramFiles(x86)"]]) {
    if (base) push(path.join(base, "DeepSeek Harness", "resources", "app", "dsh"), "install-path");
  }

  for (const candidate of candidates) {
    tried.push(candidate.path);
    // 显式指定的路径直接信，其余靠"有没有 @deepseek-ai 目录"判断（扫空时调用方会降级）
    if (candidate.source === "DSH_HOST_ROOT" || looksLikeHost(candidate.path)) {
      return { root: candidate.path, tried, source: candidate.source };
    }
  }
  return { root: null, tried, source: "none" };
}

/** 读宿主版本（dsh 包或 dsh-base 包的 version） */
export function readHostVersion(root) {
  if (!root) return null;
  const candidates = [
    path.join(root, "package.json"),
    path.join(root, "node_modules", "@deepseek-ai", "dsh", "package.json"),
    path.join(root, "node_modules", "@deepseek-ai", "dsh-base", "package.json"),
  ];
  for (const file of candidates) {
    try {
      const doc = JSON.parse(readFileSync(file, "utf8"));
      if (doc && typeof doc.version === "string") return doc.version;
    } catch { /* 试下一个 */ }
  }
  return null;
}

/**
 * 扫宿主 node_modules/@deepseek-ai/<pkg>/lib 下的 .js，拼成 {file, text} 清单。
 * 预算超了就停（并在 truncated 里说明），不抛错。
 */
export function scanHost(root, { maxFiles = DEFAULT_MAX_FILES, maxBytes = DEFAULT_MAX_BYTES } = {}) {
  const files = [];
  let bytes = 0;
  let truncated = false;
  if (!root) return { files, bytes, truncated, reason: "no-root" };
  const pkgRoot = path.join(root, "node_modules", "@deepseek-ai");
  const walk = (dir) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (truncated) return;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!/\.(js|mjs)$/.test(entry.name)) continue;
      let st;
      try { st = statSync(full); } catch { continue; }
      if (!st.isFile() || st.size > 4 * 1024 * 1024) continue;
      if (files.length >= maxFiles || bytes + st.size > maxBytes) { truncated = true; return; }
      try {
        const text = readFileSync(full, "utf8");
        files.push({ file: path.relative(root, full), text });
        bytes += st.size;
      } catch { /* 跳过读不了的 */ }
    }
  };
  walk(pkgRoot);
  return { files, bytes, truncated };
}

/** 命中点的上下文里有没有 LEGACY_ 标记（判断这条只是旧文案） */
function isLegacyHit(text, index) {
  const from = Math.max(0, index - LEGACY_WINDOW);
  return /LEGACY_[A-Z_]*|legacyPrompt|DEPRECATED_/.test(text.slice(from, index));
}

/**
 * 逐条规则分类。
 * @returns {{rules:Array, summary:{live:number,legacy:number,dead:number,unprobed:number}}}
 */
export function classifyRules(scan, rules = RULES) {
  const rows = [];
  const summary = { live: 0, legacy: 0, dead: 0, unprobed: 0 };
  for (const rule of rules) {
    if (!rule.probe) {
      summary.unprobed += 1;
      rows.push({ id: rule.id, kind: rule.kind, status: "unprobed", live: 0, legacy: 0, files: [] });
      continue;
    }
    let live = 0;
    let legacy = 0;
    const files = [];
    for (const { file, text } of scan.files) {
      let idx = text.indexOf(rule.probe);
      if (idx < 0) continue;
      if (files.length < 3 && !files.includes(file)) files.push(file);
      while (idx >= 0) {
        if (isLegacyHit(text, idx)) legacy += 1;
        else live += 1;
        idx = text.indexOf(rule.probe, idx + rule.probe.length);
      }
    }
    const status = live > 0 ? "live" : legacy > 0 ? "legacy" : "dead";
    summary[status] += 1;
    rows.push({ id: rule.id, kind: rule.kind, status, live, legacy, files });
  }
  return { rules: rows, summary };
}

/** 一次完整审计：扫描 + 分类 + 宿主版本 */
export function auditHost({ root, scan, rules, maxFiles, maxBytes } = {}) {
  const scanResult = scan ?? scanHost(root, { maxFiles, maxBytes });
  const { rules: rows, summary } = classifyRules(scanResult, rules);
  return {
    host: { root: root ?? null, version: readHostVersion(root) },
    scanned: { files: scanResult.files.length, bytes: scanResult.bytes, truncated: scanResult.truncated === true, reason: scanResult.reason },
    summary,
    rules: rows,
  };
}

/** 把审计结果压成一行可读文本（工具输出用） */
export function formatAudit(report) {
  const head = [
    `host: ${report.host.version ?? "-"} @ ${report.host.root ?? "-"}`,
    `scanned: ${report.scanned.files} files / ${(report.scanned.bytes / 1048576).toFixed(1)} MB${report.scanned.truncated ? " (truncated)" : ""}`,
    `rules: live=${report.summary.live} legacy=${report.summary.legacy} dead=${report.summary.dead} unprobed=${report.summary.unprobed}`,
  ];
  const rows = report.rules
    .filter((r) => r.status !== "unprobed")
    .map((r) => `  ${r.status.padEnd(6)} ${r.id}${r.live || r.legacy ? ` (live ${r.live} / legacy ${r.legacy})` : ""}${r.files.length ? ` → ${r.files[0]}` : ""}`);
  return [...head, ...rows].join("\n");
}
