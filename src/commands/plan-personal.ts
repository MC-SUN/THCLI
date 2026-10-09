/**
 * plan personal：个人版 TokenPlan（通用 / Hy 两个系列）。
 *
 * 接口都在 tokenhub 产品（2026-03-22），与企业版同源：
 *   - 套餐详情：DescribeTokenPlanPersonalPackage，入参 ProductType 区分系列；
 *   - 可用模型：DescribeTokenPlanPersonalModelList，入参同上；
 *   - 共享 Key：DescribeTokenPlanPersonalApiKey / ...Secret / ModifyTokenPlanPersonalApiKeySecret；
 *   - 调用明细：DescribeTokenPlanPersonalApiKeyUsageDetail。
 * 用量趋势走云监控（Barad）的 TpEPkg* 指标。
 * 两系列通过 --series common|hy 区分，参数值对齐控制台路径 /tokenplan/common、/tokenplan/hy。
 *
 * buy / renew / upgrade / autorenew 没有开放接口，只打印控制台直达链接，不伪造调用
 * （与一期 plan available 的处理方式一致）。
 */
import { Command } from "commander";

import { type Client } from "../core/client.js";
import { mask, type GlobalArgs, resolveSite } from "../core/credentials.js";
import { human, printAligned, printTable, verticalChart } from "../core/format.js";
import { t, lang } from "../core/i18n.js";
import {
  buildMonitorClient,
  packageMetricByKey,
  type MetricSeries,
} from "../core/monitor.js";
import { emitJson, emitJsonSafe } from "../core/output.js";
import {
  fetchPersonalKey,
  fetchPersonalKeySecret,
  keyIdOf,
  personalKeyClient,
  savePersonalKey,
} from "../core/personal-key.js";
import {
  consoleKeyUrl,
  consoleUrlOf,
  packageStatusKey,
  parseSeries,
  productTypeOf,
  renewFlagKey,
  remainingDays,
  SERIES,
  type Series,
  tierOfInquiryKey,
} from "../core/personal-plan.js";
import { confirm } from "../core/prompt.js";
import { assertRfc3339, toOffsetIso, utcRangeEndingAt, utcRangeMinutesAgo } from "../core/time.js";

/** 调用明细的默认时间窗：最近 24 小时 */
const RECORDS_DEFAULT_MINUTES = 24 * 60;

/** 趋势的快捷时间窗：range 名 → 天数。默认 7day */
const TREND_RANGES: Record<string, number> = { today: 1, "7day": 7, "30day": 30 };

/** 趋势缺省 range */
const TREND_DEFAULT_RANGE = "7day";

/**
 * 细粒度（分钟级）趋势的时间跨度上限：超过它就不出分钟级图，只按天聚合。
 *
 * 监控接口按 Period 收数据，Period 越小点数越多：跨 3 天按 300s 聚合是 864 个点，
 * 已接近图表的可读上限；再长就必须退回按天，否则一张图挤成一团、请求也更大。
 */
const TREND_FINE_SPAN_DAYS = 3;

/** 分钟级聚合粒度（秒） */
const FINE_PERIOD = 300;

/** 按天聚合粒度（秒） */
const DAILY_PERIOD = 86400;

type Row = Record<string, unknown>;

// 个人版共享 Key 的请求 / 本地保存已下沉到 core（core/agent/key-sources 也要用，不能
// core→命令层反向依赖）。这里重新导出，保持既有导入路径可用。
export { fetchPersonalKey, fetchPersonalKeySecret, savePersonalKey } from "../core/personal-key.js";

/** 系列的展示名 */
function seriesLabel(series: Series): string {
  return t(`personal.series.${series}`);
}

/** --series 必填时的校验 */
function requireSeries(value: string | undefined, command: string): Series {
  const series = parseSeries(value);
  if (!series) {
    throw new Error(t("personal.badSeries", { command, options: SERIES.join(" | ") }));
  }
  return series;
}

/** 个人版套餐 / Key / 明细统一的客户端：按站点换算云 API 地域 */
function personalClient(globals: GlobalArgs): Client {
  return personalKeyClient(globals);
}

/** DescribeTokenPlanPersonalPackage 的一条响应（未购时只有 ProductType + PackageStatus） */
async function fetchPackage(client: Client, series: Series): Promise<Row> {
  return client.call("DescribeTokenPlanPersonalPackage", { ProductType: productTypeOf(series) });
}

/** "生效中 · 剩余 30 天 · 自动续费" 这一行 */
function packageSummary(p: Row): string {
  const days = remainingDays(p["ExpireTime"]);
  const parts = [
    t(packageStatusKey(p["PackageStatus"])),
    t(renewFlagKey(p["AutoRenewFlag"])),
    days === undefined ? "" : days >= 0 ? t("personal.daysLeft", { days }) : t("personal.expired"),
  ];
  return parts.filter(Boolean).join(" · ");
}

async function listCommand(globals: GlobalArgs): Promise<void> {
  const client = personalClient(globals);
  // 两系列各一次调用（接口按 ProductType 只回一个系列）。
  // 未购时 PackageStatus=UNPURCHASED，只回 ProductType，其余字段全无。
  const owned = await Promise.all(SERIES.map(async (s) => ({ series: s, pkg: await fetchPackage(client, s) })));
  if (emitJson({ Packages: owned.map((x) => ({ Series: x.series, ...x.pkg })) })) return;

  for (const { series, pkg } of owned) {
    console.log(
      String(pkg["PackageStatus"] ?? "").toUpperCase() === "UNPURCHASED"
        ? `${seriesLabel(series)}  ${t("personal.notOwned", { series })}`
        : `${seriesLabel(series)}  ${packageSummary(pkg)}`,
    );
  }
}

/**
 * 某系列的可用模型。用 DescribeTokenPlanPersonalModelList（按 ProductType 区分系列）；
 * agent 接入也复用。
 */
export async function fetchPersonalModels(client: Client, series: Series): Promise<Row[]> {
  const resp = await client.call("DescribeTokenPlanPersonalModelList", { ProductType: productTypeOf(series) });
  return (resp["Models"] as Row[] | undefined) ?? [];
}

async function modelsCommand(opts: Record<string, string>, globals: GlobalArgs): Promise<void> {
  const series = requireSeries(opts["series"], "plan personal models");
  const models = await fetchPersonalModels(personalClient(globals), series);
  if (emitJson({ Series: series, Models: models })) return;

  console.log(t("personal.models.header", { series: seriesLabel(series), count: models.length }));
  printTable(
    [t("personal.col.modelName"), t("personal.col.modelId"), t("personal.col.owner")],
    models.map((m) => [String(m["DisplayName"] ?? ""), String(m["ModelId"] ?? ""), String(m["Provider"] ?? "")]),
  );
  console.log(t("personal.models.chatHint", { model: String(models[0]?.["ModelId"] ?? "") }));
}

async function infoCommand(opts: Record<string, string>, globals: GlobalArgs): Promise<void> {
  const series = requireSeries(opts["series"], "plan personal info");
  const client = personalClient(globals);
  const [pkg, key] = await Promise.all([fetchPackage(client, series), fetchPersonalKey(client)]);

  if (emitJsonSafe({ Series: series, Package: pkg, ApiKey: key ?? null })) return;

  if (String(pkg["PackageStatus"] ?? "").toUpperCase() === "UNPURCHASED") {
    console.log(t("personal.notOwned", { series }));
    console.log(`  ${t("personal.buyAt", { url: consoleUrlOf(series, resolveSite(globals)) })}`);
    return;
  }
  const days = remainingDays(pkg["ExpireTime"]);
  const left = days === undefined ? "" : days >= 0 ? t("personal.daysLeft", { days }) : t("personal.expired");
  printAligned([
    [t("personal.label.series"), seriesLabel(series)],
    [t("personal.label.tier"), tierOfInquiryKey(pkg["PrepayInquiryKey"])],
    [t("personal.label.status"), t(packageStatusKey(pkg["PackageStatus"]))],
    [
      t("personal.label.period"),
      t("personal.period", {
        from: String(pkg["StartTime"] ?? "-"),
        to: String(pkg["ExpireTime"] ?? "-"),
        left: left ? t("personal.periodLeft", { left }) : "",
      }),
    ],
    [t("personal.label.renew"), t(renewFlagKey(pkg["AutoRenewFlag"]))],
    [t("personal.label.resource"), String(pkg["ResourceId"] ?? "-")],
    [
      t("personal.label.credits"),
      t("personal.creditsLeft", {
        used: human(Number(pkg["TotalUsed"] ?? 0)),
        total: human(Number(pkg["TotalCredits"] ?? 0)),
        cycle: human(Number(pkg["CycleCredits"] ?? 0)),
      }),
    ],
    [
      t("personal.label.cycles"),
      t("personal.cyclesInfo", {
        current: String(pkg["CurrentCycle"] ?? "-"),
        total: String(pkg["TotalCycles"] ?? "-"),
        remain: String(pkg["RemainCycles"] ?? "-"),
      }),
    ],
    [
      t("personal.label.key"),
      key ? t("personal.keyShared", { masked: mask(String(key["ApiKey"] ?? "")) }) : t("personal.keyNone"),
    ],
  ]);
  if (Number(pkg["AutoRenewFlag"]) !== 1) {
    console.log(t("personal.renewHint", { url: consoleUrlOf(series, resolveSite(globals)) }));
  }
}

// ------------------------------------------------------------- 用量趋势（云监控）

/**
 * 趋势窗口。优先 --from/--to；否则按 --range 快捷窗（最近 N×24h 滚动窗）：
 *   today  → 最近 24h
 *   7day   → 最近 7×24h
 *   30day  → 最近 30×24h
 * 监控接口收带时区偏移的 ISO8601，统一折算。
 */
function trendWindow(opts: { from?: string; to?: string; range?: string }): {
  startTime: string;
  endTime: string;
} {
  // 给了具体时间就用它（只给 --to 时以它为终点回推 1 天）
  if (opts.from || opts.to) {
    const fallback = opts.to ? utcRangeEndingAt(opts.to, 24 * 60) : utcRangeMinutesAgo(24 * 60);
    return {
      startTime: toOffsetIso(opts.from ?? fallback.start),
      endTime: toOffsetIso(opts.to ?? fallback.end),
    };
  }

  const range = opts.range ?? TREND_DEFAULT_RANGE;
  const days = TREND_RANGES[range];
  if (days === undefined) {
    throw new Error(t("personal.badRange", { options: Object.keys(TREND_RANGES).join(" | ") }));
  }
  const win = utcRangeMinutesAgo(days * 24 * 60);
  return { startTime: toOffsetIso(win.start), endTime: toOffsetIso(win.end) };
}

/**
 * 按时间跨度自动定聚合粒度：跨度 ≤ 3 天出分钟级多指标，超过只出每日总量。
 *
 * 用户不感知 daily / minute——窗口本身就是语义：看最近几小时想看走势，看一个月
 * 只关心每天的总量。硬要暴露两个开关，用户还得先知道"多细算细"。
 */
function granularityOf(window: { startTime: string; endTime: string }): {
  period: number;
  keysOf: (kind: "tokens" | "credits") => string[];
} {
  const spanMs = new Date(window.endTime).getTime() - new Date(window.startTime).getTime();
  const fine = Number.isFinite(spanMs) && spanMs <= TREND_FINE_SPAN_DAYS * 86_400_000;
  if (!fine) {
    // 每日只有总量指标，没有"每日输入 / 输出"
    return { period: DAILY_PERIOD, keysOf: (kind) => [kind === "tokens" ? "token" : "credits"] };
  }
  // 分钟级：总量 / 输入 / 输出，Token 与积分一一对应
  return {
    period: FINE_PERIOD,
    keysOf: (kind) =>
      kind === "tokens"
        ? ["tpm", "input-tpm", "output-tpm"]
        : ["credits-pm", "input-credits", "output-credits"],
  };
}

/** 一张指标趋势图，形态对齐 usage trend 的卡片 */
function renderMetricCard(series: MetricSeries, period: number): void {
  const { meta, timestamps, values } = series;
  console.log(lang() === "en" ? `${meta.label} (${meta.unit})` : `${meta.label}（${meta.unit}）`);
  const present = values.filter((v): v is number => typeof v === "number");
  if (!timestamps.length || !present.length) {
    console.log(`  ${t("chart.noData")}`);
    console.log("");
    return;
  }
  const fmt = (v: number): string => human(v);
  const chart = verticalChart(values, (i) => axisLabel(timestamps[i] ?? 0, period), fmt);
  for (const row of chart.rows) {
    console.log(row);
  }
  console.log(chart.axis);
  console.log(chart.labels);
  const max = Math.max(...present);
  const min = Math.min(...present);
  const avg = present.reduce((sum, v) => sum + v, 0) / present.length;
  console.log(
    `  ${t("chart.stats", {
      max: fmt(max),
      peak: "",
      min: fmt(min),
      avg: fmt(avg),
    })}`,
  );
  console.log("");
}

/** X 轴短标签：天粒度给月-日，分钟粒度给时:分 */
function axisLabel(ts: number, period: number): string {
  const d = new Date(ts * 1000);
  const p = (n: number): string => String(n).padStart(2, "0");
  return period >= 86400
    ? `${p(d.getMonth() + 1)}-${p(d.getDate())}`
    : `${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * 取套餐在某指标上的趋势。
 *
 * `TpEPkg*` 按套餐（PkgId）聚合，故维度用 tpepkgid 而不是 uin；套餐未持有时无 PkgId，
 * 直接返回空图。
 */
async function packageTrend(globals: GlobalArgs, pkg: Row, keys: string[], query: {
  startTime: string;
  endTime: string;
  period: number;
}): Promise<MetricSeries[]> {
  const pkgId = String(pkg["PkgId"] ?? pkg["ResourceId"] ?? "");
  const client = await buildMonitorClient(globals);
  return Promise.all(
    keys.map((k) => {
      const meta = packageMetricByKey(k);
      return pkgId
        ? client.fetch(meta, { ...query, extraDimensions: [{ Name: "tpepkgid", Value: pkgId }] })
        : Promise.resolve({ meta, timestamps: [], values: [] } as MetricSeries);
    }),
  );
}

/** tokens / credits 共用的趋势渲染 */
async function usageTrendCommand(
  kind: "tokens" | "credits",
  opts: Record<string, unknown>,
  globals: GlobalArgs,
): Promise<void> {
  const series = requireSeries(opts["series"] as string | undefined, `plan personal usage ${kind}`);
  const client = personalClient(globals);
  const pkg = await fetchPackage(client, series);
  if (String(pkg["PackageStatus"] ?? "").toUpperCase() === "UNPURCHASED") {
    if (emitJson({ Series: series, Package: pkg, Trend: [] })) return;
    console.log(t("personal.notOwned", { series }));
    return;
  }

  const from = opts["from"] as string | undefined;
  const to = opts["to"] as string | undefined;
  const range = opts["range"] as string | undefined;
  assertRfc3339(from, "--from");
  assertRfc3339(to, "--to");

  // 粒度按窗口跨度自动定：短窗口（today / ≤3 天）出分钟级明细，长窗口只出每日总量（用户不感知）
  const window = trendWindow({ from, to, range });
  const { period, keysOf } = granularityOf(window);
  const results = await packageTrend(globals, pkg, keysOf(kind), { ...window, period });
  if (
    emitJson({
      Series: series,
      Kind: kind,
      PkgId: pkg["PkgId"] ?? null,
      StartTime: window.startTime,
      EndTime: window.endTime,
      Period: period,
      Trend: results.map((s) => ({
        MetricKey: s.meta.key,
        MetricName: s.meta.name,
        Unit: s.meta.unit,
        Timestamps: s.timestamps,
        Values: s.values,
      })),
    })
  ) {
    return;
  }

  for (const s of results) {
    renderMetricCard(s, period);
  }
}

// ------------------------------------------------------------- 调用明细

/**
 * 调用明细：DescribeTokenPlanPersonalApiKeyUsageDetail（tokenhub，按 ProductType 区分系列）。
 *
 * 时间参数与返回都是 RFC3339（返回为 UTC `Z` 结尾）。`--series` 必填——入参 `ProductType`
 * 决定查哪个系列的明细。默认最近 24 小时。
 */
async function recordsCommand(opts: Record<string, string>, globals: GlobalArgs): Promise<void> {
  const series = requireSeries(opts["series"], "plan personal records");
  assertRfc3339(opts["from"], "--from");
  assertRfc3339(opts["to"], "--to");
  const fallback = opts["to"]
    ? utcRangeEndingAt(opts["to"], RECORDS_DEFAULT_MINUTES)
    : utcRangeMinutesAgo(RECORDS_DEFAULT_MINUTES);
  const params: Record<string, unknown> = {
    ProductType: productTypeOf(series),
    From: opts["from"] ?? fallback.start,
    To: opts["to"] ?? fallback.end,
  };
  if (opts["model"]) params["ModelName"] = opts["model"];
  if (opts["sort"]) params["Sort"] = opts["sort"];
  if (opts["limit"] !== undefined) params["Limit"] = Number(opts["limit"]);
  // 翻页游标：上一次响应的 Context 原样回传，其余条件必须保持一致
  if (opts["context"]) params["Context"] = opts["context"];

  const resp = await personalClient(globals).call("DescribeTokenPlanPersonalApiKeyUsageDetail", params);
  const rows = (resp["DetailSet"] as Row[] | undefined) ?? [];
  if (emitJson(resp)) return;

  if (!rows.length) {
    console.log(t("common.noData"));
    return;
  }
  printTable(
    ["REQUEST_TIME", "REQUEST_ID", "MODEL", "IN_TOK", "CACHE_TOK", "OUT_TOK", "TOTAL_TOK", "TOTAL_CR"],
    rows.map((r) => [
      String(r["RequestTime"] ?? ""),
      String(r["RequestId"] ?? ""),
      String(r["ModelName"] ?? ""),
      String(r["InputToken"] ?? 0),
      String(r["CacheToken"] ?? 0),
      String(r["OutputToken"] ?? 0),
      String(r["TotalToken"] ?? 0),
      String(r["TotalQuota"] ?? ""),
    ]),
  );
  if (resp["ListOver"] === false && typeof resp["Context"] === "string" && resp["Context"]) {
    console.log(t("plan.detail.nextPage", { context: resp["Context"] }));
  }
}

// ------------------------------------------------------------- 共享 Key

async function keyShowCommand(globals: GlobalArgs): Promise<void> {
  const key = await fetchPersonalKey(personalClient(globals));
  if (emitJsonSafe({ ApiKey: key ?? null })) return;

  if (!key) {
    console.log(t("personal.key.none"));
    return;
  }
  printAligned([
    ["ApiKeyId", String(key["ApiKeyId"] ?? "")],
    ["ApiKey", mask(String(key["ApiKey"] ?? ""))],
    [t("personal.key.label.status"), String(key["ApiKeyStatus"] ?? "-")],
    [t("personal.key.label.version"), String(key["KeyVersion"] ?? "-")],
    [t("personal.col.created"), String(key["CreatedAt"] ?? "-")],
    [t("personal.key.label.updated"), String(key["UpdatedAt"] ?? "-")],
  ]);
  console.log(t("personal.key.revealHint"));
}

async function keyRevealCommand(opts: Record<string, string>, globals: GlobalArgs): Promise<void> {
  if (!(await confirm(t("personal.key.revealConfirm"), Boolean(opts["yes"])))) {
    return;
  }
  const client = personalClient(globals);
  const found = await fetchPersonalKeySecret(client, opts["id"]);
  if (!found) {
    if (emitJson(null)) return;
    console.log(t("personal.key.none"));
    return;
  }
  const scope = opts["save"] ? savePersonalKey(client.profile, client.site, found.secret) : undefined;
  // 与 plan key reveal 同理：本命令就是来取明文的（已过二次确认），JSON 也给明文，但只给这一个字段
  if (emitJson({ ApiKeyId: found.id, ApiKey: found.secret, SavedTo: scope ?? null })) return;
  console.log(found.secret);
  if (scope) {
    console.log(t("personal.key.saved", { scope }));
  }
}

/**
 * 重置 Key（ModifyTokenPlanPersonalApiKeySecret）：旧密钥立即失效，所有在用的工具都要换新 Key。
 * 本地 keystore 里存的旧 Key 也随之作废，--save 时直接取新明文存回去。
 */
async function keyRotateCommand(opts: Record<string, string>, globals: GlobalArgs): Promise<void> {
  const client = personalClient(globals);
  const keyId = await keyIdOf(client, opts["id"]);
  if (!keyId) throw new Error(t("personal.key.none"));
  if (!(await confirm(t("personal.key.rotateConfirm", { id: keyId }), Boolean(opts["yes"])))) {
    return;
  }
  const resp = await client.call("ModifyTokenPlanPersonalApiKeySecret", { ApiKeyId: keyId });
  const fresh = opts["save"] ? await fetchPersonalKeySecret(client, keyId) : undefined;
  const scope = fresh ? savePersonalKey(client.profile, client.site, fresh.secret) : undefined;
  if (emitJsonSafe({ ...resp, ApiKeyId: keyId, SavedTo: scope ?? null })) return;
  console.log(t("personal.key.rotated", { id: keyId }));
  console.log(scope ? t("personal.key.saved", { scope }) : t("personal.key.rotateHint"));
}

/**
 * key create / key delete：都不做实际调用，只打印控制台链接。
 *
 * create 与 buy/renew/upgrade 同类——它涉及**购买 / 开通行为**（个人版每账号 1 把、与套餐绑定），
 * 不该由 CLI 代建；delete 的同一场景（建 / 删共享 Key）在控制台一步就完成，也没必要单独提供。
 * 两者一律给控制台个人版 Key 页，不伪造调用。
 */
function keyConsoleOnly(action: string, getGlobals: () => GlobalArgs) {
  return (opts: Record<string, string>): void => {
    const series = requireSeries(opts["series"], `plan personal key ${action}`);
    console.log(t("personal.key.consoleOnly", { action: t(`personal.key.actionLabel.${action}`) }));
    console.log(`  ${consoleKeyUrl(series, resolveSite(getGlobals()))}`);
  };
}

/** 无接口的计费操作：打印控制台直达链接 */
function consoleOnly(action: string, getGlobals: () => GlobalArgs) {
  return (opts: Record<string, string>): void => {
    const series = requireSeries(opts["series"], `plan personal ${action}`);
    const site = resolveSite(getGlobals());
    console.log(t("personal.consoleOnly", { action }));
    console.log(`  ${consoleUrlOf(series, site)}`);
  };
}

/** plan personal usage [tokens|credits]：云监控的用量趋势（不感知系列，入参只按 PkgId） */
function registerUsageCommands(personal: Command, getGlobals: () => GlobalArgs): void {
  const seriesOpt = "--series <series>";
  const usage = personal.command("usage").description(t("personal.usage.desc"));

  usage
    .command("tokens")
    .description(t("personal.usage.tokens.desc"))
    .requiredOption(seriesOpt, t("personal.opt.series"))
    .option("--range <range>", t("personal.opt.range"), TREND_DEFAULT_RANGE)
    .option("--from <time>", t("personal.opt.from"))
    .option("--to <time>", t("personal.opt.to"))
    .action(async (opts) => usageTrendCommand("tokens", opts, getGlobals()));

  usage
    .command("credits")
    .description(t("personal.usage.credits.desc"))
    .requiredOption(seriesOpt, t("personal.opt.series"))
    .option("--range <range>", t("personal.opt.range"), TREND_DEFAULT_RANGE)
    .option("--from <time>", t("personal.opt.from"))
    .option("--to <time>", t("personal.opt.to"))
    .action(async (opts) => usageTrendCommand("credits", opts, getGlobals()));

  // 调用明细走 tokenhub（按系列传 ProductType），与趋势不同源，不放在 usage 组下
  personal
    .command("records")
    .description(t("personal.records.desc"))
    .requiredOption(seriesOpt, t("personal.opt.series"))
    .option("--from <time>", t("personal.opt.from"))
    .option("--to <time>", t("personal.opt.to"))
    .option("--model <name>", t("personal.opt.model"))
    .option("--sort <sort>", "asc | desc")
    .option("--limit <n>", t("personal.opt.limit"))
    .option("--context <cursor>", t("plan.detail.opt.context"))
    .action(async (opts) => recordsCommand(opts, getGlobals()));
}

/** plan personal key <verb> */
function registerKeyCommands(personal: Command, getGlobals: () => GlobalArgs): void {
  const key = personal.command("key").description(t("personal.key.desc"));

  key.command("show").description(t("personal.key.show.desc")).action(async () => keyShowCommand(getGlobals()));

  // create / delete 都只给控制台链接：create 涉及购买 / 开通，delete 同一场景在控制台一步完成
  key
    .command("create")
    .description(t("personal.key.create.desc"))
    .requiredOption("--series <series>", t("personal.opt.series"))
    .action(keyConsoleOnly("create", getGlobals));

  key
    .command("reveal")
    .description(t("personal.key.reveal.desc"))
    .option("--id <id>", t("personal.key.opt.id"))
    .option("--save", t("personal.key.opt.save"))
    .option("--yes", t("opt.yes"))
    .action(async (opts) => keyRevealCommand(opts, getGlobals()));

  key
    .command("rotate")
    .description(t("personal.key.rotate.desc"))
    .option("--id <id>", t("personal.key.opt.id"))
    .option("--save", t("personal.key.opt.saveNew"))
    .option("--yes", t("opt.yes"))
    .action(async (opts) => keyRotateCommand(opts, getGlobals()));

  key
    .command("delete")
    .description(t("personal.key.delete.desc"))
    .requiredOption("--series <series>", t("personal.opt.series"))
    .action(keyConsoleOnly("delete", getGlobals));
}

/** 挂到 plan 命令下：plan personal <verb> */
export function registerPersonalPlanCommands(plan: Command, getGlobals: () => GlobalArgs): void {
  const personal = plan.command("personal").description(t("personal.desc"));
  const seriesOpt = "--series <series>";

  personal.command("list").description(t("personal.list.desc")).action(async () => listCommand(getGlobals()));

  personal
    .command("models")
    .description(t("personal.models.desc"))
    .requiredOption(seriesOpt, t("personal.opt.series"))
    .action(async (opts) => modelsCommand(opts, getGlobals()));

  personal
    .command("info")
    .description(t("personal.info.desc"))
    .requiredOption(seriesOpt, t("personal.opt.series"))
    .action(async (opts) => infoCommand(opts, getGlobals()));

  registerUsageCommands(personal, getGlobals);
  registerKeyCommands(personal, getGlobals);

  for (const action of ["buy", "renew", "upgrade", "autorenew"]) {
    personal
      .command(action)
      .description(t(`personal.${action}.desc`))
      .requiredOption(seriesOpt, t("personal.opt.series"))
      // 吞掉 --tier/--months 等原设计参数：命令只做引导，不该因为多给了参数而报错
      .allowUnknownOption()
      .action(consoleOnly(action, getGlobals));
  }
}
