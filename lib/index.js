// dsh-purge-compose — community × gen-x 复合插件
// 契约与两家一致：export name / inject / apply(ctx, config)
//
// 0.9.0：观测接上动作 —— 破甲率告警（alarm.js）+ 规则子集（scrubMode）+ 审计结果回写 marker
// 0.8.0：把"静默失效"变成"可观测"
//   ① 规则表化 + 每轮清洗命中计数（scrub.js stripWithReport）
//   ② 装配校验（verify.js）：每次 assembly 确认注入段还在、排第几、多少字、canary 是否出现
//   ③ 宿主审计（audit.js）：每条规则 live / legacy / dead，工具 compose_audit 随时可查
//   ④ armor 落盘轮转 + 带 type 的记录（verdict / hello / assembly）
import { randomBytes, createHash } from "node:crypto";
import { resolveConfig } from "./config.js";
import { planInjection, payloadTextForPreset, selectPayloadKind, normalizeEntry } from "./arbitration.js";
import { presetFromContext } from "./preset.js";
import { rewriteAssembly, CWD_SUFFIX } from "./assemble.js";
import { capabilityText } from "./capability.js";
import { boostText } from "./boost.js";
import { registerPresets } from "./presets.js";
import { loadPayload } from "./payloads.js";
import { createSink, reduceArmor, armorTextOf, EMPTY_STATE, readArmorRecords } from "./armor.js";
import { verifyAssembly, sameVerification } from "./verify.js";
import { auditHost, detectHostRoot, formatAudit, readHostVersion, scanHost } from "./audit.js";
import { createAlarmGate, rateOf } from "./alarm.js";
import { summarizeRecords, formatReport } from "./report.js";
import { runSelfTest, formatSelfTest } from "./selftest.js";
import { pickExtras } from "./extras.js";
import { modelOf, contextShape } from "./model.js";
import { toJsonSchema } from "./tool-schema.js";
import { compareWindows, formatComparison } from "./ab.js";
import { RULES } from "./scrub.js";
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";

const DEFAULT_CANARY = `compose-canary-${randomBytes(4).toString("hex")}`;

/** 只有显式给了 canary.token（或 canary.injectText=true）才往载荷里塞标记，默认不改载荷一个字节 */
function canaryTokenOf(cfg) {
  if (cfg.canary?.enabled === false) return null;
  if (typeof cfg.canary?.token === "string" && cfg.canary.token.trim()) return cfg.canary.token.trim();
  if (cfg.canary?.injectText === true) return DEFAULT_CANARY;
  return null;
}

function writeMarker(cfg, payload) {
  if (!cfg.markerFile) return false;
  try {
    mkdirSync(path.dirname(cfg.markerFile), { recursive: true });
    writeFileSync(cfg.markerFile, JSON.stringify({ ts: new Date().toISOString(), pid: process.pid, ...payload }, null, 2));
    return true;
  } catch {
    return false;
  }
}

export const name = "dsh-purge-compose";
export const inject = ["systemPrompt", "tools"];

/**
 * 读 armor JSONL 的尾部摘要：verdict 分布 + 最近一次装配校验 + 最近一次 hello。
 * 带 type 的记录分流处理，老的无 type 行仍按 verdict 计。
 */
function readArmorSummary(stateFile, mode, perFile = 20000) {
  const out = { mode, verdict: null, domain: null, turns: 0, keywordCounts: {}, lastTs: null, firstTs: null, assembly: null, hello: null, alarm: null, skips: 0, lastSkip: null, verdicts: [], conflicts: 0, scrubHits: {}, shadowHits: {} };
  try {
    // 跨切卷读：否则一切卷，verdict/rate 就会"重置"
    for (const rec of readArmorRecords(stateFile, { limitPerFile: perFile })) {
      if (rec.type === "assembly") { out.assembly = rec; continue; }
      if (rec.type === "hello") { out.hello = rec; continue; }
      if (rec.type === "alarm") { out.alarm = rec; continue; }
      if (rec.type === "assembly-skip") { out.skips = (out.skips || 0) + 1; out.lastSkip = rec; continue; }
      if (rec.type) { continue; } // 其它类型的记录不参与 verdict 统计
      out.turns += 1;
      if (rec.combined || rec.verdict) {
        out.verdicts.push(rec.combined ?? rec.verdict);
        if (out.verdicts.length > 500) out.verdicts.splice(0, out.verdicts.length - 500);
      }
      if (!out.firstTs && rec.ts) out.firstTs = rec.ts;
      if (rec.conflict === true) out.conflicts = (out.conflicts || 0) + 1;
      out.verdict = rec.verdict ?? out.verdict;
      out.domain = rec.domain ?? out.domain;
      out.lastTs = rec.ts ?? out.lastTs;
      if (rec.verdict) out.keywordCounts[rec.verdict] = (out.keywordCounts[rec.verdict] || 0) + 1;
      for (const hit of rec.scrub || []) out.scrubHits[hit.id] = (out.scrubHits[hit.id] || 0) + (hit.count || 1);
      for (const hit of rec.shadow || []) out.shadowHits[hit.id] = (out.shadowHits[hit.id] || 0) + (hit.count || 1);
    }
  } catch { /* 文件不存在 = 还没跑过 */ }
  return out;
}

export function register(ctx, rawConfig) {
  const { cfg, issues } = resolveConfig(rawConfig);
  const canaryToken = canaryTokenOf(cfg);
  // 诊断用：进入点先落一次标记（若宿主 apply 到一半抛错，也能看出走到哪）
  writeMarker(cfg, { stage: "enter", mode: cfg.mode });
  const report = { config: cfg, issues, plans: [], sections: [], warnings: [], host: null };
  const hostRoot = cfg.audit?.hostRoot || detectHostRoot().root;
  try {
    const version = readHostVersion(hostRoot);
    report.host = { root: hostRoot ?? null, version };
  } catch { report.host = { root: hostRoot ?? null, version: null }; }

  if (issues.length) {
    report.warnings.push(...issues);
    // 配置非法时宁可不注入，只保留观测
    cfg.mode = "observe";
  }

  const sink = cfg.armor?.enabled
    ? createSink(cfg.armor.stateFile, { rotateBytes: cfg.armor.rotateBytes, keepDays: cfg.armor.keepDays })
    : () => false;

  // ── 1) 注入计划：observe 模式下 sections 恒为空（零风险） ──
  const presets = Object.keys(cfg.matrix).filter((k) => k !== "default");
  const plans = [
    planInjection({ presetId: "", cfg }), // 默认 agent
    ...presets.map((p) => planInjection({ presetId: p, cfg })),
  ];
  report.plans = plans.map((p) => ({ presetId: p.presetId, kind: p.kind, mode: p.mode, sections: p.sections.length, reason: p.reason, warnings: p.warnings }));
  for (const p of plans) for (const w of p.warnings) report.warnings.push(`[${p.presetId || "default"}] ${w}`);

  // ── 0) 清洗规则子集：scrubMode=live 时只跑"今天还有目标"的规则（启动时扫一次宿主） ──
  //      all（默认）= 41 条全跑，行为与 0.8.0 完全一致
  let activeRules = RULES;
  let disabledRules = [];
  report.scrub = { mode: cfg.scrubMode, rules: RULES.length };
  if (cfg.scrubMode === "live" || cfg.scrubMode === "shadow") {
    try {
      const auditRoot = cfg.audit?.hostRoot || hostRoot;
      if (auditRoot) {
        const picked = new Set(
          auditHost({ root: auditRoot })
            .rules.filter((r) => r.status === "live" || r.status === "unprobed" || (cfg.scrubLegacy && r.status === "legacy"))
            .map((r) => r.id),
        );
        // 扫描没拿到东西（宿主布局变了 / 目录不对）时不能"只留 format 规则"——
        // 那等于把还在干活的规则也停了。宁可退回 all。
        if (picked.size < 3) {
          report.scrub = { mode: "all", rules: RULES.length, note: "scan-empty-fallback", scanned: picked.size };
          cfg.scrubMode = "all";
          report.warnings.push(`scrubMode 降级为 all：宿主扫描只认出 ${picked.size} 条规则（目录 ${auditRoot}）`);
        } else {
          activeRules = RULES.filter((r) => picked.has(r.id));
          disabledRules = RULES.filter((r) => !picked.has(r.id));
          report.scrub = { mode: cfg.scrubMode, rules: activeRules.length, dropped: disabledRules.length, ids: activeRules.map((r) => r.id) };
        }
      } else {
        report.scrub = { mode: "all", rules: RULES.length, note: "scan-host-unavailable" };
        cfg.scrubMode = "all";
        disabledRules = [];
      }
    } catch {
      report.scrub = { mode: "all", rules: RULES.length, note: "audit-failed" };
      cfg.scrubMode = "all";
      disabledRules = [];
    }
  }

  // 破甲率告警闸门（只读判定结果，不碰注入）
  const gate = cfg.alarm?.enabled === false ? null : createAlarmGate({
    threshold: cfg.alarm?.threshold,
    window: cfg.alarm?.window,
    minTurns: cfg.alarm?.minTurns,
    cooldownMs: cfg.alarm?.cooldownMs,
  });

  // marker 统一从 report 落盘：任何阶段都能写一份"当前全貌"
  const flush = (stage) => {
    writeMarker(cfg, {
      stage,
      mode: cfg.mode,
      host: report.host,
      sections: report.sections.map((s) => ({ name: s.name, order: s.order })),
      armor: report.armor,
      scrub: report.scrub,
      canary: report.canary ? { token: report.canary.token, firstCheck: report.canary.firstCheck } : undefined,
      alarm: report.alarm,
      audit: report.audit,
      presets: report.presets,
      warnings: report.warnings,
    });
  };

  // text() 每轮都会被宿主调用一次：第一次替某个预设算文本 = 真的进了管线
  const heardPresets = new Set();
  const presetBySession = new WeakMap();
  const modelBySession = new WeakMap();
  let probedContext = false;
  const rememberPreset = (context, preset) => {
    try {
      const session = context?.agent?.session ?? context?.session;
      if (session && preset) presetBySession.set(session, preset);
      if (session) {
        const found = modelOf(context);
        if (found.model) modelBySession.set(session, found.model);
        else if (!probedContext && cfg.armor?.enabled) {
          // 拿不到模型：落一次形状诊断（只记键名），用于定位真实字段
          probedContext = true;
          sink({ type: "ctx-probe", ts: new Date().toISOString(), shape: contextShape(context) });
        }
      }
    } catch { /* WeakMap 只吃对象；拿不到就算了 */ }
  };
  const noteCall = (preset, context) => {
    rememberPreset(context, preset);
    if (!cfg.armor?.enabled) return;
    const key = preset || "default";
    if (heardPresets.has(key)) return;
    heardPresets.add(key);
    let payloadSha = null;
    try {
      const loaded = loadPayload(selectPayloadKind(key, cfg).kind, cfg);
      if (loaded.text) payloadSha = createHash("sha256").update(loaded.text).digest("hex").slice(0, 12);
    } catch { /* 拿不到就算了 */ }
    sink({ type: "hello", ts: new Date().toISOString(), preset: key, mode: cfg.mode, host: report.host.version ?? null, kernel: cfg.sectionNames.kernel, scrub: report.scrub.mode, payloadSha });
  };

  // ── 2) 写模式：注册一个 section，文本按「当次 assembly 的 preset」现算 ──
  if (cfg.mode === "write") {
    const kinds = [...new Set(Object.values(cfg.matrix).map((v) => normalizeEntry(v).kind).filter((k) => k && k !== "none"))];
    const usable = cfg.debugCanary ? ["canary"] : kinds.filter((k) => Boolean(loadPayload(k, cfg).text));
    if (!usable.length) report.warnings.push(`写模式无可用载荷（矩阵: ${kinds.join(",") || "-"}），未注册 section`);

    const selOf = (context) => selectPayloadKind(presetFromContext(context), cfg);
    const active = (context) => {
      const sel = selOf(context);
      return sel.kind === "none" ? null : sel;
    };

    if (usable.length) {
      const regs = [
        [cfg.sectionNames.kernel, cfg.order.kernel, (context) => {
          const preset = presetFromContext(context);
          const sel = selectPayloadKind(preset, cfg);
          if (sel.kind !== "none") noteCall(preset, context);
          const text = payloadTextForPreset(preset, cfg);
          return canaryToken ? `${text}\n<!-- ${canaryToken} -->`.trim() : text;
        }],
        ["compose:capabilities", cfg.order.corrective, (context) => {
          const sel = active(context);
          if (!sel || sel.capability === false) return "";
          return capabilityText(/red-?team/i.test(presetFromContext(context)));
        }],
        ["compose:cwd", cfg.order.cwd ?? 900, (context) => {
          const sel = active(context);
          return !sel || sel.cwdSuffix === false ? "" : CWD_SUFFIX;
        }],
        ["compose:boost", cfg.order.boost ?? 1000, (context) => {
          const sel = active(context);
          return !sel || sel.boost === false ? "" : boostText(true);
        }],
      ];
      for (const [name, order, text] of regs) {
        const reg = ctx.systemPrompt.section({ name, order, text });
        report.sections.push({ name, order, dispose: typeof reg === "function" });
      }
      // 可移植机制段（默认关；cfg.extras 里开了才注册）
      const extras = pickExtras(cfg.extras);
      for (const extra of extras) {
        const reg = ctx.systemPrompt.section({ name: extra.name, order: extra.order, text: extra.text });
        report.sections.push({ name: extra.name, order: extra.order, dispose: typeof reg === "function" });
      }
      if (extras.length) report.extras = extras.map((e) => ({ key: e.key, name: e.name, order: e.order, chars: e.text.length }));
    }
  }

  // ── 2b) assembly 重排（仅 write 模式）：载荷段提到最前 + 补闭合标签 + 清洗其余段 ──
  //      顺带做装配校验：这一段真的在最终 prompt 里吗？清洗改了几条、多少字？
  if (cfg.mode === "write" && cfg.assemble !== false) {
    let lastVerification = null;
    ctx.effect(() => {
      if (typeof ctx.on !== "function") return () => {};
      const off = ctx.on(
        "system-prompt/assemble",
        async (assembly, second, third) => {
          try {
            // 宿主 0.2.x：waterfall(name, assembly, context, fallback) → (assembly, context, next)
            // community 老写法：(assembly, next, context)。两种顺序都认。
            const next = typeof third === "function" ? third : (typeof second === "function" ? second : null);
            const context = typeof third === "function" ? second : (typeof second === "function" ? third : second);
            const base = next ? await next() : assembly;
            const preset = presetFromContext(context);
            rememberPreset(context, preset);
            const sel = selectPayloadKind(preset, cfg);
            if (sel.kind === "none") {
              // 诊断：段里有载荷文本、却判成不注入 —— 说明 preset 解析没拿到（签名/级联问题）
              try {
                const kernelSection = Array.isArray(base?.sections) ? base.sections.find((s) => s && s.name === cfg.sectionNames.kernel) : null;
                const kernelChars = kernelSection && typeof kernelSection.text === "string" ? kernelSection.text.length : 0;
                if (kernelChars > 0 && cfg.armor?.enabled) {
                  sink({
                    type: "assembly-skip",
                    ts: new Date().toISOString(),
                    preset: preset || "",
                    kernelChars,
                    sections: Array.isArray(base?.sections) ? base.sections.length : 0,
                    note: "preset 解析为空但载荷段有文本",
                  });
                }
              } catch { /* 诊断不影响主流程 */ }
              return base;
            }
            const out = rewriteAssembly(base, {
              sectionName: cfg.sectionNames.kernel,
              lead: sel.lead !== false,
              scrub: sel.scrub !== false,
              rules: cfg.scrubMode === "all" ? undefined : activeRules,
              shadowRules: cfg.scrubMode === "shadow" ? disabledRules : undefined,
            });

            if (cfg.armor?.enabled) {
              try {
                const check = verifyAssembly(out, { sectionName: cfg.sectionNames.kernel, preset: preset || "default", token: canaryToken });
                if (report.canary === undefined) report.canary = { token: canaryToken ?? null, firstCheck: check };
                // 只在形态变化时落一行，避免每个 step 都写
                const fingerprint = {
                  preset: check.preset,
                  sections: check.sections,
                  kernelIndex: check.kernelIndex,
                  kernelChars: check.kernelChars,
                  kernelHash: check.kernelHash,
                  totalChars: check.totalChars,
                  tokenFound: check.tokenFound,
                  shadowRules: disabledRules.length,
                  injected: check.injected,
                  atHead: check.atHead,
                  atTail: check.atTail,
                };
                if (!sameVerification(lastVerification, fingerprint)) {
                  lastVerification = fingerprint;
                  const scrubHits = (out.scrubbed?.hits ?? []).filter((h) => h.kind !== "format");
                  const shadowHits = (out.shadow?.hits ?? []).filter((h) => h.kind !== "format");
                  sink({ type: "assembly", ts: new Date().toISOString(), mode: cfg.mode, ...fingerprint, scrub: scrubHits, ...(shadowHits.length ? { shadow: shadowHits } : {}) });
                }
              } catch { /* 校验失败不影响注入 */ }
            }
            return out;
          } catch {
            return assembly;
          }
        },
        { global: true, prepend: true },
      );
      return typeof off === "function" ? off : () => {};
    });
  }

  // ── 3) armor 观测：默认走 session/event（零契约风险），投影作为可选项 ──
  if (cfg.armor.enabled) {
    const perSession = new WeakMap();
    // 宿主会对同一条 assistant 消息触发多次（流式/重放），不去重会把 A/B 的 n 和长度都灌水
    const lastDigestBySession = new WeakMap();
    ctx.effect(() => {
      if (typeof ctx.on !== "function") return () => {};
      const off = ctx.on("session/event", (session, event) => {
        // 观测层永不影响宿主：任何异常都吞掉（否则会顺着事件总线炸掉会话）
        try {
          const prev = perSession.get(session) ?? EMPTY_STATE;
          const next = reduceArmor(prev, event);
          perSession.set(session, next);
          // 新一轮从 user/message 开始：允许同样的文本再记一次
          if (event && event.type === "user/message") {
            try { lastDigestBySession.delete(session); } catch { /* 忽略 */ }
          }
          let duplicate = false;
          let digest = null;
          if (event && event.type === "assistant/message") {
            try {
              const text = armorTextOf(event?.data?.message?.content);
              if (text) {
                digest = createHash("sha256").update(text).digest("hex").slice(0, 16);
                if (lastDigestBySession.get(session) === digest) duplicate = true;
                else lastDigestBySession.set(session, digest);
              }
            } catch { /* 去重失败就当不是重复 */ }
          }
          if (!duplicate && event && event.type === "assistant/message" && next.verdict) {
            sink({
              ts: new Date().toISOString(),
              preset: (() => { try { return presetBySession.get(session) ?? null; } catch { return null; } })(),
              model: (() => { try { return modelBySession.get(session) ?? null; } catch { return null; } })(),
              digest,
              verdict: next.verdict,
              combined: next.combined,
              structure: next.structure,
              signals: next.signals ?? null,
              conflict: next.conflict === true,
              domain: next.domain,
              len: next.lastLen,
              counts: next.counts,
            });
            if (gate) {
              const result = gate.push(next.combined ?? next.verdict);
              if (result && result.alarm) {
                const record = {
                  type: "alarm",
                  ts: new Date().toISOString(),
                  reason: result.reason,
                  window: cfg.alarm.window,
                  threshold: cfg.alarm.threshold,
                  ...result.stats,
                };
                sink(record);
                report.alarm = { at: record.ts, rate: record.rate, turns: record.turns, refusal: record.refusal, fallback: record.fallback };
                try { flush("done"); } catch { /* 标记写不了不影响会话 */ }
              }
            }
          }
        } catch { /* 忽略 */ }
      });
      return typeof off === "function" ? off : () => {};
    });
    report.armor = { enabled: true, via: "session/event", rotateBytes: cfg.armor.rotateBytes, keepDays: cfg.armor.keepDays };

    if (cfg.armor.projection) {
      const projection = {
        key: "compose-armor",
        stateVersion: 1,
        stateSchema: { parse: (v) => v },
        init: () => ({ ...EMPTY_STATE }),
        apply: (state, event) => reduceArmor(state, event),
      };
      ctx.effect(() => {
        const projections = typeof ctx.get === "function" ? ctx.get("sessionProjections") : null;
        if (projections && typeof projections.register === "function") projections.register(projection);
        return () => {};
      });
      report.armor.projection = projection.key;
    }
  } else {
    report.armor = { enabled: false };
  }

  // ── 4) 观测工具：compose_verdict（结论） + compose_audit（规则存活） ──
  let auditCache = null;
  ctx.effect(() => {
    if (!ctx.tools || typeof ctx.tools.register !== "function") return () => {};

    ctx.tools.register({
      name: "compose_verdict",
      description: "读取破甲观测结论（mode/verdict/domain/轮次/计数/装配校验）。只读，不改变任何输出。",
      parameters: { type: "object", additionalProperties: false, properties: {} },
      output: {
        schema: { type: "object", additionalProperties: false, properties: { text: { type: "string" } } },
        render: (_args, value) => [{ type: "text", text: String(value?.text ?? "") }],
      },
      async execute() {
        const s = readArmorSummary(cfg.armor.stateFile, cfg.mode);
        const counts = Object.entries(s.keywordCounts).map(([k, v]) => `${k}=${v}`).join(" ") || "-";
        const scrubTop = Object.entries(s.scrubHits).sort((a, b) => b[1] - a[1]).slice(0, 5)
          .map(([id, n]) => `${id}×${n}`).join(" ") || "-";
        const a = s.assembly;
        const stats = rateOf(s.verdicts ?? [], cfg.alarm?.window ?? 50);
        const alarm = report.alarm ?? s.alarm ?? null;
        return {
          text: [
            `mode: ${s.mode}`,
            `rate: 最近 ${stats.turns} 轮 → pass=${stats.pass} refusal=${stats.refusal} fallback=${stats.fallback}（bad ${(stats.rate * 100).toFixed(1)}%，阈值 ${((cfg.alarm?.threshold ?? 0.05) * 100).toFixed(0)}%）`,
            alarm ? `alarm: ${alarm.at ?? alarm.ts} rate=${(alarm.rate * 100).toFixed(1)}% turns=${alarm.turns}` : "alarm: 无",
            `verdict: ${s.verdict ?? "-"}`,
            `domain: ${s.domain ?? "-"}`,
            `turns: ${s.turns}${s.firstTs ? `（自 ${s.firstTs.slice(0, 16)}）` : ""}`,
            `counts-kw: ${counts}（最近 ${stats.turns} 轮的关键词判定）`,
            `counts: pass=${stats.pass} refusal=${stats.refusal} fallback=${stats.fallback}（按 combined 口径）`,
            `last: ${s.lastTs ?? "-"}`,
            `host: ${report.host?.version ?? "-"}`,
            a ? `assembly: injected=${a.injected} preset=${a.preset} index=${a.kernelIndex}/${a.sections} kernel=${a.kernelChars}字 total=${a.totalChars}字 canary=${a.tokenFound ?? "-"}` : "assembly: 未记录",
            `structure: 两轨冲突 ${s.conflicts ?? 0} 次（关键词 vs 结构）`,
            s.skips ? `skip: ${s.skips} 次（最近：preset=${JSON.stringify(s.lastSkip?.preset ?? "")} kernel=${s.lastSkip?.kernelChars ?? 0}字）` : "skip: 无",
            `scrub: mode=${report.scrub.mode} rules=${report.scrub.rules}${report.scrub.dropped ? ` dropped=${report.scrub.dropped}` : ""}`,
            `scrub-hits: ${scrubTop}`,
            `shadow-hits: ${Object.entries(s.shadowHits).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([id, n]) => `${id}×${n}`).join(" ") || "-"}`,
            s.hello ? `hello: preset=${s.hello.preset} host=${s.hello.host ?? "-"}` : "hello: 未记录",
          ].join("\n"),
        };
      },
    });

    ctx.tools.register({
      name: "compose_variant",
      description: "临时切换某个预设的注入变体（如 lead true/false）并记账，不用重启宿主。用于受控 A/B（ABBA 交替）。只影响矩阵里该预设，不写配置文件。",
      parameters: toJsonSchema({
        lead: { type: "boolean", required: true, description: "true = 载荷前置；false = 载荷在尾部" },
        preset: { type: "string", description: "目标预设，默认 matrix 里唯一非 default 的那个" },
      }),
      output: {
        schema: { type: "object", additionalProperties: false, properties: { text: { type: "string" } } },
        render: (_args, value) => [{ type: "text", text: String(value?.text ?? "") }],
      },
      async execute(args) {
        const targets = Object.keys(cfg.matrix).filter((k) => k !== "default");
        const preset = String(args?.preset || targets[0] || "").trim();
        if (!preset || !(preset in cfg.matrix)) throw new Error(`矩阵里没有预设 ${JSON.stringify(preset)}（可选：${targets.join(",")}）`);
        const lead = args?.lead === true;
        const entry = typeof cfg.matrix[preset] === "string" ? { payload: cfg.matrix[preset] } : { ...cfg.matrix[preset] };
        cfg.matrix[preset] = { ...entry, lead };
        const record = { type: "variant", ts: new Date().toISOString(), preset, lead, by: "compose_variant" };
        if (cfg.armor?.enabled !== false) sink(record);
        return { text: `变体已切换：preset=${preset} lead=${lead}（${record.ts}）\n下一步请在同一会话里跑同一道题，再用 compose_ab { byVariant: true, preset: "${preset}", metric: "deliverable" } 看对比。` };
      },
    });

    ctx.tools.register({
      name: "compose_ab",
      description: "按时间点把 armor 账本切成两段，比较坏轮次（refusal+fallback）比例，带两比例 z 检验。改注入参数后跑够样本再用。只读。",
      parameters: toJsonSchema({
        split: { type: "string", required: true, description: "切分点（ISO 时间），通常填参数改动的那一刻" },
        days: { type: "number", description: "每侧窗口天数，默认 14" },
        minTurns: { type: "number", description: "每侧最小样本，默认 200" },
        preset: { type: "string", description: "只比较某个预设（如 cold-deep-scout）；不填则全部" },
        model: { type: "string", description: "只比较某个模型（如 deepseek-flash）；不填则全部" },
        metric: { type: "string", description: "bad | deliverable | length | codeblocks（每轮代码块数）" },
        since: { type: "string", description: "只看这个时间之后的记录（ISO），用于按题分窗" },
        until: { type: "string", description: "只看这个时间之前的记录（ISO）" },
        byVariant: { type: "boolean", description: "true = 按账本里的 compose_variant 记录分桶（ABBA 交替也成立），不需要 split" },
      }),
      output: {
        schema: { type: "object", additionalProperties: false, properties: { text: { type: "string" } } },
        render: (_args, value) => [{ type: "text", text: String(value?.text ?? "") }],
      },
      async execute(args) {
        const byVariant = args?.byVariant === true;
        const split = String(args?.split || "").trim();
        if (!byVariant && !split) throw new Error("要给 split（ISO 时间），或传 byVariant: true");
        const records = readArmorRecords(cfg.armor.stateFile, { limitPerFile: 20000 });
        const result = compareWindows(records, {
          dedupe: "auto",
          byVariant,
          splitAt: byVariant ? "1970-01-01T00:00:00Z" : split,
          windowDays: Number(args?.days) || 14,
          minTurns: Number(args?.minTurns) || 200,
          preset: args?.preset ? String(args.preset) : null,
          model: args?.model ? String(args.model) : null,
          metric: ["deliverable", "length", "codeblocks"].includes(args?.metric) ? args.metric : "bad",
          since: args?.since ? String(args.since) : null,
          until: args?.until ? String(args.until) : null,
        });
        return { text: formatComparison(result) };
      },
    });

    ctx.tools.register({
      name: "compose_selftest",
      description: "在宿主进程里把整条链路走一遍：宿主版本、载荷、预设路由、现算文本、清洗（含 shadow）、装配校验、告警闸门。不依赖切预设，只读。",
      parameters: toJsonSchema(),
      output: {
        schema: { type: "object", additionalProperties: false, properties: { text: { type: "string" } } },
        render: (_args, value) => [{ type: "text", text: String(value?.text ?? "") }],
      },
      async execute() {
        const result = runSelfTest({
          cfg,
          host: report.host,
          scrub: report.scrub,
          rules: cfg.scrubMode === "all" ? RULES : activeRules,
        });
        return { text: formatSelfTest(result, { mode: cfg.mode, scrubMode: cfg.scrubMode }) };
      },
    });

    ctx.tools.register({
      name: "compose_report",
      description: "汇总 armor 全部切卷：轮次、两套判定分布、冲突率、装配校验、告警、scrub/shadow 命中、按天趋势。只读，用于 A/B 基线与切换 scrubMode 前的证据。",
      parameters: toJsonSchema({
        days: { type: "number", description: "按天趋势看最近多少天，默认 7" },
      }),
      output: {
        schema: { type: "object", additionalProperties: false, properties: { text: { type: "string" } } },
        render: (_args, value) => [{ type: "text", text: String(value?.text ?? "") }],
      },
      async execute(args) {
        const records = readArmorRecords(cfg.armor.stateFile, { limitPerFile: 20000 });
        const summary = summarizeRecords(records, { days: Number(args?.days) || 7 });
        return { text: formatReport(summary, { host: report.host?.version ?? null, scrubMode: report.scrub?.mode }) };
      },
    });

    ctx.tools.register({
      name: "compose_audit",
      description: "审计清洗规则在今天的宿主里还有没有目标：逐条判 live（真在干活）/ legacy（只剩旧会话回放常量）/ dead（已过期）。只读扫描宿主包，不执行宿主代码。",
      parameters: toJsonSchema({
        refresh: { type: "boolean", description: "true 时重新扫描（默认用 10 分钟内的缓存）" },
      }),
      output: {
        schema: { type: "object", additionalProperties: false, properties: { text: { type: "string" } } },
        render: (_args, value) => [{ type: "text", text: String(value?.text ?? "") }],
      },
      async execute(args) {
        const now = Date.now();
        if (!args?.refresh && auditCache && now - auditCache.at < 10 * 60 * 1000) {
          return { text: auditCache.text };
        }
        const root = cfg.audit?.hostRoot || detectHostRoot().root;
        if (!root) {
          return { text: `审计不可用：没有找到宿主目录。在 config.audit.hostRoot 里写死（例如 C:/Users/<you>/AppData/Local/Programs/DeepSeek Harness/resources/app/dsh），或设环境变量 DSH_HOST_ROOT。` };
        }
        const scan = scanHost(root, { maxFiles: cfg.audit?.maxFiles, maxBytes: cfg.audit?.maxBytes });
        const audit = auditHost({ root, scan });
        const text = formatAudit(audit);
        auditCache = { at: now, text };
        report.audit = { at: new Date(now).toISOString(), host: audit.host, summary: audit.summary, scanned: audit.scanned };
        try { flush("done"); } catch { /* 标记写不了不影响工具 */ }
        return { text };
      },
    });
    return () => {};
  });

  // ── 4b) 注册 agent 预设（模式下拉可见；失败只记录） ──
  report.presets = [];
  if (Array.isArray(cfg.presets) && cfg.presets.length) {
    ctx.effect(() => {
      let cancelled = false;
      const releases = [];
      (async () => {
        const resolveRegistry = () => {
          try {
            const proxy = ctx.agentPresets;
            if (proxy && typeof proxy.register === "function") return proxy;
          } catch { /* 未 inject 时读属性会抛 */ }
          try {
            const viaGet = typeof ctx.get === "function" ? ctx.get("agentPresets") : null;
            if (viaGet && typeof viaGet.register === "function") return viaGet;
          } catch { /* 服务还没起 */ }
          return null;
        };
        const done = await registerPresets(resolveRegistry, cfg.presets, { retries: 30, delayMs: 500 });
        if (cancelled) {
          for (const d of done) if (d.release) try { d.release(); } catch { /* 忽略 */ }
          return;
        }
        for (const d of done) {
          releases.push(d.release);
          report.presets.push(
            d.error
              ? { id: d.id, error: d.error }
              : { id: d.id, entries: d.entries, migration: d.migration, note: d.note || undefined, registered: d.registered },
          );
        }
        // 注册结果单独落一次标记：异步完成，主标记那时还是空的
        flush("presets");
      })();
      return () => {
        cancelled = true;
        for (const r of releases) try { if (typeof r === "function") r(); } catch { /* 忽略 */ }
      };
    });
  }

  // ── 5) 加载标记（能落到这里 = 宿主确实 apply 了本插件） ──
  flush("done");
  report.marker = true;

  return report;
}

export function apply(ctx, config) {
  try {
    return register(ctx, config);
  } catch (e) {
    try {
      const { cfg } = resolveConfig(config);
      writeMarker(cfg, { stage: "error", error: String(e && e.message ? e.message : e), stack: String(e && e.stack ? e.stack : "").split("\n").slice(0, 6) });
    } catch { /* 连标记都写不了就算了 */ }
    throw e;
  }
}
