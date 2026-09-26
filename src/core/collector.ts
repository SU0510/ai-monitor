import { invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import {
  listAccounts,
  saveBalanceSnapshot,
  saveQuotaSnapshot,
  getSetting,
  setSetting,
  deleteAccount,
  getDb,
  type AccountRow,
  type BalanceInfo,
} from "./db";
import { getProvider } from "../providers";
import { checkAlerts } from "./alert";
import { syncPricesIfNeeded } from "./platformSync";

/**
 * 用余额差值同步每日真实消耗：
 * 每天首条余额快照 - 当天最后一条 = 当天实际扣费（充值会使差值失真，忽略负值）
 * 结果写入 daily_usage.cost（权威值）；token×单价估算在 cost_estimated（备用）
 */
export async function syncCostFromBalance(): Promise<void> {
  try {
    const d = getDb();
    // 每天每条余额快照（含日期）；只扫近 45 天，避免全表读入 JS
    const rows = await d.select<
      { account_id: number; balance: number; fetched_at: string; day: string }[]
    >(
      `SELECT account_id, balance, fetched_at, substr(fetched_at, 1, 10) AS day
       FROM balance_snapshots
       WHERE fetched_at >= datetime('now', 'localtime', '-45 days')
       ORDER BY account_id, fetched_at ASC`
    );

    // 按账户+天分组，取首末；用「逐段下降求和」而不是简单首末差，
    // 这样中途充值不会抹掉之前的消耗（充值回升时起点重置）。
    const byAcc: Record<number, { day: string; consumed: number; prev: number | null }[]> = {};
    for (const r of rows) {
      const arr = (byAcc[r.account_id] ??= []);
      let found = arr.find((x) => x.day === r.day);
      if (!found) {
        found = { day: r.day, consumed: 0, prev: null };
        arr.push(found);
      }
      if (found.prev === null) {
        found.prev = r.balance;
      } else {
        // 只有下降才计入消耗；上升（充值）重置起点，避免把充值算成消耗或抹掉历史
        if (r.balance < found.prev!) {
          found.consumed += found.prev! - r.balance;
        }
        found.prev = r.balance;
      }
    }
    for (const [accIdStr, days] of Object.entries(byAcc)) {
      const accId = Number(accIdStr);
      for (const dayInfo of days) {
        const diff = dayInfo.consumed; // 正 = 消耗
        if (diff <= 0.0001) continue; // 充值日或余额未变，跳过
        // 余额差值 = 平台真实扣费，是权威值；覆盖代理记账的 token×单价估算
        // （代理估算会因缓存折扣/价格变动/漏记而偏差；余额差值最准）
        await d.execute(
          `INSERT INTO daily_usage (account_id, date, cost, source)
           VALUES ($1, $2, $3, 'balance')
           ON CONFLICT(account_id, date) DO UPDATE SET cost = excluded.cost, source = 'balance'`,
          [accId, dayInfo.day, diff]
        );
      }
    }
  } catch (e) {
    console.error("余额差值计费同步失败", e);
  }
}

export const EVENT_BALANCE_UPDATED = "balance-updated";
export const EVENT_COLLECT_START = "collect-start";
export const EVENT_COLLECT_END = "collect-end";

/** 单账户采集：调平台接口拿余额 → 落库（附带的时间窗口额度一并落库） */
export async function collectAccount(account: AccountRow): Promise<BalanceInfo> {
  const provider = getProvider(account.provider_id);
  if (!provider || !provider.balanceSupported) {
    throw new Error(`${account.name}（${account.provider_id}）暂不支持自动查询余额`);
  }
  const apiKey = await invoke<string>("get_secret", { account: String(account.id) });
  const info = await provider.getBalance(apiKey);
  await saveBalanceSnapshot(account.id, info);
  for (const q of info.quotas ?? []) {
    await saveQuotaSnapshot(account.id, q, info.currency);
  }
  return info;
}

/** 全量采集（跳过未启用/不支持自动查询的账户） */
export async function collectAll(): Promise<{ ok: number; failed: number; errors: string[] }> {
  // 面板窗口和灵动岛窗口都会触发采集，用户也可能连点「全部刷新」。
  // 并发跑会重复打平台余额接口、重复写快照，所以同一时刻只允许一轮。
  if (collectInFlight) return collectInFlight;
  collectInFlight = doCollectAll().finally(() => {
    collectInFlight = null;
  });
  return collectInFlight;
}

let collectInFlight: Promise<{ ok: number; failed: number; errors: string[] }> | null = null;

async function doCollectAll(): Promise<{ ok: number; failed: number; errors: string[] }> {
  await emit(EVENT_COLLECT_START);
  let ok = 0;
  let failed = 0;
  const errors: string[] = [];

  try {
    const accounts = await listAccounts();
    for (const account of accounts) {
      if (!account.enabled) continue;
      const provider = getProvider(account.provider_id);
      if (!provider?.balanceSupported) continue;
      try {
        await collectAccount(account);
        ok++;
      } catch (e) {
        failed++;
        errors.push(`${account.name}: ${(e as Error).message || String(e)}`);
      }
    }
  } catch (e) {
    // 连账户列表都读不出来（数据库异常）也算一次失败的尝试，别让异常穿透出去
    failed++;
    errors.push((e as Error).message || String(e));
  }

  const attemptedAt = new Date().toISOString();
  // 尝试时间与结果无论成败都记下来。只记成功时间的话，「所有账户都采集失败」
  // 和「定时器压根没跑」在库里长得一模一样，排查时分不清是网络问题还是没触发。
  await setSetting("last_collect_attempt_at", attemptedAt).catch(() => {});
  await setSetting("last_collect_outcome", ok > 0 || failed === 0 ? "ok" : "fail").catch(() => {});
  // last_collect_at 仍然是「最近一次确实拿到余额」的时间：采集去重和
  // 「数据更新于」都靠它。失败时不推进，否则另一个窗口会以为刚采过而跳过重试。
  if (ok > 0) {
    await setSetting("last_collect_at", attemptedAt).catch(() => {});
  }

  await emit(EVENT_COLLECT_END, { ok, failed, errors });
  await emit(EVENT_BALANCE_UPDATED);
  await checkAlerts();
  await syncCostFromBalance();
  await emit(EVENT_BALANCE_UPDATED);
  // 每日自动同步平台模型价格（硅基流动等，节流 24h）
  await syncPricesIfNeeded().catch(() => {});
  return { ok, failed, errors };
}

let timer: ReturnType<typeof setTimeout> | null = null;
// 每次 startAutoCollect 递增的代号。旧一轮的续期闭包发现自己代号过期就直接退出，
// 避免「改采集间隔时旧的一轮在飞、它的 finally 又把定时器装回去」导致双定时器。
let generation = 0;

/**
 * 启动定时采集。
 * 面板窗口与悬浮窗都会调用，但二者共享同一 SQLite 里的 last_collect_at，
 * 因此用「距上次采集是否超过间隔」做去重：先触发者写回时间戳，另一个窗口跳过本轮，
 * 保证任意窗口常驻时都会按时采集（全局单例采集）。
 *
 * 用递归 setTimeout 而非固定 setInterval：每次触发前重新读取 collect_interval_minutes，
 * 使修改间隔设置后无需重启窗口即可生效（v0.1.4 之前写死 30 分钟，导致 1 分钟间隔不生效）。
 */
export function startAutoCollect(): void {
  if (timer) return;
  const gen = ++generation;

  const schedule = async () => {
    if (gen !== generation) return;
    let minutes = 30;
    try {
      minutes = await getCollectIntervalMinutes();
    } catch (e) {
      // 读间隔失败也必须继续排下一轮：之前这里一旦抛错就再也不会续期，
      // 定时器静默死亡，界面上只剩「数据一直不更新」。
      console.error("读取采集间隔失败，按 30 分钟继续", e);
    }
    if (gen !== generation) return;
    timer = setTimeout(() => void run(), minutes * 60 * 1000);
  };

  const run = async () => {
    if (gen !== generation) return;
    timer = null;
    try {
      const intervalMs = (await getCollectIntervalMinutes()) * 60 * 1000;
      const lastStr = await getSetting("last_collect_at");
      const lastTs = lastStr ? new Date(lastStr).getTime() : 0;
      if (Date.now() - lastTs < intervalMs - 10_000) return; // 已由另一窗口/实例采集
      await collectAll();
    } catch (e) {
      console.error("自动采集失败", e);
    } finally {
      // 成功、失败、提前返回都要续期
      if (gen === generation) void schedule();
    }
  };

  void schedule();
}

/** 读取并调整采集间隔（分钟），返回当前生效间隔 */
export async function setCollectIntervalMinutes(minutes: number): Promise<number> {
  const safe = Math.min(1440, Math.max(1, Math.floor(minutes)));
  await setSetting("collect_interval_minutes", String(safe));
  // 停止旧定时器并重新调度（generation 保证在飞的那一轮不会把定时器装回来）
  stopAutoCollect();
  startAutoCollect();
  return safe;
}

/** 停止自动采集（仅供内部重调度使用） */
function stopAutoCollect(): void {
  generation++; // 让在飞的那一轮（含它的续期闭包）全部作废
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}

export async function getCollectIntervalMinutes(): Promise<number> {
  const v = await getSetting("collect_interval_minutes");
  return v ? parseInt(v, 10) : 30;
}

/** 删除账户时同时清理系统钥匙串中的密钥 */
export async function deleteAccountAndSecret(accountId: number): Promise<void> {
  try {
    await invoke("delete_secret", { account: String(accountId) });
  } catch {
    // 密钥不存在时忽略
  }
  await deleteAccount(accountId);
}
