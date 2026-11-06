// 破甲率告警：最近 N 轮里 rejection / fallback 占比超过阈值就报一次
//
// 目的：把"这轮突然只会给替代方案了"从体感变成事件。
// 只读判定器的输出，不改任何注入；告警本身也是一条 armor 记录（type: "alarm"）。

const VERDICTS = new Set(["pass", "refusal", "fallback"]);

/** 统计一段 verdict 序列（按窗口裁剪到最近 window 条） */
export function rateOf(verdicts, window = 50) {
  const list = Array.isArray(verdicts) ? verdicts.filter((v) => VERDICTS.has(v)) : [];
  const tail = window > 0 ? list.slice(-window) : list;
  const counts = { pass: 0, refusal: 0, fallback: 0 };
  for (const v of tail) counts[v] += 1;
  const turns = tail.length;
  const bad = counts.refusal + counts.fallback;
  return {
    turns,
    ...counts,
    bad,
    rate: turns ? bad / turns : 0,
    refusalRate: turns ? counts.refusal / turns : 0,
  };
}

/** 是否该报：样本够 + 超阈值 */
export function shouldAlarm(stats, { threshold = 0.05, minTurns = 20 } = {}) {
  return stats.turns >= minTurns && stats.rate >= threshold;
}

/**
 * 带去抖的告警闸门：同一状态在 cooldown 内只报一次；恢复（rate 回到阈值下）后可再报。
 * @returns {{push:(verdict:string)=>({stats:object, alarm:boolean, reason:string}|null), state:()=>object}}
 */
export function createAlarmGate({ threshold = 0.05, window = 50, minTurns = 20, cooldownMs = 10 * 60 * 1000, now = Date.now } = {}) {
  let history = [];
  let lastAlarmAt = Number.NEGATIVE_INFINITY; // 首次不因冷却被吞
  let armed = true;
  return {
    push(verdict) {
      if (!VERDICTS.has(verdict)) return null;
      history.push(verdict);
      if (history.length > window * 4) history = history.slice(-window * 4);
      const stats = rateOf(history, window);
      if (stats.turns < minTurns) return { stats, alarm: false, reason: "warming-up" };
      const hot = stats.rate >= threshold;
      if (!hot) {
        armed = true;
        return { stats, alarm: false, reason: "ok" };
      }
      if (!armed) return { stats, alarm: false, reason: "cooldown" };
      if (now() - lastAlarmAt < cooldownMs) return { stats, alarm: false, reason: "cooldown" };
      armed = false;
      lastAlarmAt = now();
      return { stats, alarm: true, reason: "threshold" };
    },
    state() {
      return { ...rateOf(history, window), armed, lastAlarmAt };
    },
  };
}
