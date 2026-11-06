// compose 配置解析与校验（唯一配置入口）
import { homedir } from "node:os";
import path from "node:path";

export const PAYLOAD_KINDS = ["none", "community", "genx"];

export const DEFAULT_CONFIG = {
  // observe = 只观测不注入（默认，零风险）；write = 真的注入；off = 完全停用
  mode: "observe",
  // 预设 → 载荷。key 用小写的 preset id；default 是兜底。
  matrix: { redteam: "community", unrestricted: "community", research: "genx", dev: "genx", default: "none" },
  // 单写原则：拒答策略只能一家负责，另一家降级为观测
  refuseStrategy: "community",
  // 载荷来源（community 的载荷不 vendor，按运行时路径读）
  communityPayloadPath: path.join(homedir(), ".dsh", "prompt-inject.md"),
  genxPayloadPath: null, // null = 包内 vendor/gen-x/infinite-gen-x.md
  order: { kernel: 100, corrective: 150, reinforce: 200, cwd: 900, boost: 1000 },
  sectionNames: { kernel: "compose:kernel", corrective: "compose:refusal-corrective" },
  armor: {
    enabled: true,
    projection: false,
    stateFile: path.join(homedir(), ".dsh", "compose", "armor.jsonl"),
    window: 160,
    // 0.8.0：落盘轮转。超过 rotateBytes 就切一卷（armor-YYYYMMDD-HHmmss.jsonl），
    // 切卷与旧卷只保留 keepDays 天（0 = 不删）
    rotateBytes: 8 * 1024 * 1024,
    keepDays: 14,
  },
  // 0.8.0：装配校验。每次 assembly 检查"我们的段还在不在、排第几、多少字"；
  // canary 串可选（设了就顺带验证它是否出现在最终 prompt 里）
  canary: { enabled: true, token: null, injectText: false },
  // 0.8.0：宿主审计（规则 live/legacy/dead）。hostRoot 为空时按 Electron 路径自动探测
  audit: { hostRoot: null, maxFiles: 3000, maxBytes: 48 * 1024 * 1024 },
  // 0.9.0：清洗规则子集。all = 41 条全跑（默认，行为与 0.8.0 一致）；
  //        live   = 只跑"今天还有目标"的规则（启动时扫一次宿主，扫不到就退回 all）
  //        shadow = 同 live，但把停用规则"如果还开着会改什么"记账（不生效），用于决定能不能删
  scrubMode: "all",
  scrubLegacy: true,
  // 0.23.0：可移植机制段（默认全关，按需开）。见 lib/extras.js
  extras: { refusalTaxonomy: false, plainSpeech: false, antiWake: false },
  // 0.9.0：破甲率告警。最近 window 轮里 refusal+fallback 占比 ≥ threshold 且样本 ≥ minTurns 就报一次
  alarm: { enabled: true, window: 50, threshold: 0.05, minTurns: 20, cooldownMs: 10 * 60 * 1000 },
  // B 阶段开关：write 模式下是否把载荷段提到最前（assembly 重排）
  assemble: true,
  // A 阶段开关：能力选用协议段 / 指令权威清洗（两者都移植自 community）
  capabilityProtocol: true,
  authorityScrub: true,
  // 尾部权威块（community 的 dsh_boost，放在最后一段）
  boost: true,
  // 清洗后补一行静态工作目录声明（community 同款，稳定前缀缓存）
  cwdSuffix: true,
  // 诊断金丝雀：write 模式下若设置，只注入这一行（用于验证 section 是否真的进入了系统提示）
  debugCanary: null,
  // 要注册的 agent 预设（模式下拉里可见）：[{ id, dir? }]，dir 缺省为 ~/.dsh/.agent-presets/<id>
  presets: [],
  // 加载标记：插件真的被宿主 apply 过就写一次，便于"装没装进去"一眼判断
  markerFile: path.join(homedir(), ".dsh", "compose", "last-load.json"),
};

export function resolveConfig(raw) {
  const src = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const cfg = {
    ...DEFAULT_CONFIG,
    ...src,
    // 用户显式给 matrix 时按"替换"语义（否则无法关掉内置映射），缺 default 时补 none
    matrix: src.matrix && typeof src.matrix === "object" && !Array.isArray(src.matrix)
      ? { ...src.matrix, default: src.matrix.default ?? "none" }
      : { ...DEFAULT_CONFIG.matrix },
    order: { ...DEFAULT_CONFIG.order, ...(src.order || {}) },
    sectionNames: { ...DEFAULT_CONFIG.sectionNames, ...(src.sectionNames || {}) },
    armor: { ...DEFAULT_CONFIG.armor, ...(src.armor || {}) },
    canary: { ...DEFAULT_CONFIG.canary, ...(src.canary || {}) },
    audit: { ...DEFAULT_CONFIG.audit, ...(src.audit || {}) },
    alarm: { ...DEFAULT_CONFIG.alarm, ...(src.alarm || {}) },
    extras: { ...DEFAULT_CONFIG.extras, ...(src.extras || {}) },
  };
  const issues = validateConfig(cfg);
  return { cfg, issues };
}

export function validateConfig(cfg) {
  const issues = [];
  if (!["observe", "write", "off"].includes(cfg.mode)) issues.push(`mode 非法: ${cfg.mode}`);
  if (!PAYLOAD_KINDS.includes(cfg.refuseStrategy)) issues.push(`refuseStrategy 非法: ${cfg.refuseStrategy}`);
  const KIND_FLAGS = ["lead", "capability", "scrub", "boost", "cwdSuffix"];
  for (const [preset, value] of Object.entries(cfg.matrix)) {
    const kind = typeof value === "string" ? value : value && typeof value === "object" ? (value.payload ?? value.kind ?? "none") : null;
    if (!PAYLOAD_KINDS.includes(kind)) {
      issues.push(`matrix["${preset}"] 非法载荷: ${typeof value === "object" ? JSON.stringify(value) : value}`);
      continue;
    }
    if (value && typeof value === "object") {
      for (const flag of KIND_FLAGS) {
        if (flag in value && typeof value[flag] !== "boolean") issues.push(`matrix["${preset}"].${flag} 必须是布尔`);
      }
    }
  }
  for (const [k, v] of Object.entries(cfg.order)) {
    if (!Number.isInteger(v)) issues.push(`order.${k} 必须是整数`);
  }
  if (!Number.isFinite(cfg.armor.rotateBytes) || cfg.armor.rotateBytes < 0) issues.push("armor.rotateBytes 必须是非负数");
  if (!Number.isFinite(cfg.armor.keepDays) || cfg.armor.keepDays < 0) issues.push("armor.keepDays 必须是非负数");
  if (cfg.canary && typeof cfg.canary !== "object") issues.push("canary 必须是对象");
  if (cfg.canary && cfg.canary.token != null && typeof cfg.canary.token !== "string") issues.push("canary.token 必须是字符串或 null");
  if (cfg.canary && cfg.canary.injectText !== undefined && typeof cfg.canary.injectText !== "boolean") issues.push("canary.injectText 必须是布尔");
  if (cfg.audit && typeof cfg.audit !== "object") issues.push("audit 必须是对象");
  if (cfg.audit && cfg.audit.hostRoot != null && typeof cfg.audit.hostRoot !== "string") issues.push("audit.hostRoot 必须是字符串或 null");
  if (!["all", "live", "shadow"].includes(cfg.scrubMode)) issues.push(`scrubMode 非法: ${cfg.scrubMode}`);
  if (typeof cfg.scrubLegacy !== "boolean") issues.push("scrubLegacy 必须是布尔");
  if (!Number.isFinite(cfg.alarm.window) || cfg.alarm.window < 1) issues.push("alarm.window 必须是正数");
  if (!Number.isFinite(cfg.alarm.threshold) || cfg.alarm.threshold < 0 || cfg.alarm.threshold > 1) issues.push("alarm.threshold 必须在 0..1");
  if (!Number.isFinite(cfg.alarm.minTurns) || cfg.alarm.minTurns < 1) issues.push("alarm.minTurns 必须是正数");
  if (!Number.isFinite(cfg.alarm.cooldownMs) || cfg.alarm.cooldownMs < 0) issues.push("alarm.cooldownMs 必须是非负数");
  for (const [k, v] of Object.entries(cfg.extras || {})) if (typeof v !== "boolean") issues.push(`extras.${k} 必须是布尔`);
  return issues;
}
