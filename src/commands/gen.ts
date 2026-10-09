/**
 * +gen：生图 / 生视频 / 生 3D（数据面，Bearer API Key）。
 *
 * 与 +chat 同属数据面直连（命令名同样带 + 前缀），Key 解析也与 +chat 一致
 * （--api-key > keystore th/<alias>）。厂商差异全部在 core/media-registry.ts 的
 * 注册表里，这里只做：参数归一 → 本地图片编码 → 提交 → 轮询 → 打印 / 下载。
 *
 * 结果 URL 是临时签名地址（约 12 小时），所以 --output 时直接下载到本地。
 */
import fs from "node:fs";
import path from "node:path";
import { Command } from "commander";

import { classifyInput } from "../core/chat-content.js";
import { authHeadersOf } from "../core/data-plane.js";
import { allowedRegions, chatHostOf, DEFAULT_REGION, deepMerge } from "../core/config.js";
import { type GlobalArgs, resolveEnv, resolveProfile, resolveSite } from "../core/credentials.js";
import { collect, printAligned, printTable } from "../core/format.js";
import {
  findTask,
  forEachLimit,
  type GenTask,
  loadTasks,
  needsRefresh,
  recordState,
  recordSubmitted,
  scopeOf,
} from "../core/gen-tasks.js";
import { t } from "../core/i18n.js";
import { DEFAULT_ALIAS, loadDataConfig, resolveRegionKey } from "../core/keystore.js";
import {
  FAMILIES,
  familyOf,
  type FamilySpec,
  type GenOption,
  type GenRequest,
  type MediaKind,
  parseParams,
  type QuerySpec,
  type TaskResult,
} from "../core/media-registry.js";
import { emitJson, isJson, traceRequest, traceResponse } from "../core/output.js";
import { logDataPlaneCall } from "../core/telemetry.js";

type Obj = Record<string, unknown>;

/** +gen 子命令的参数（commander 解析后） */
interface GenOptions {
  model?: string;
  image?: string[];
  size?: string;
  ratio?: string;
  duration?: string;
  resolution?: string;
  negativePrompt?: string;
  audio?: string;
  param?: string[];
  body?: string;
  wait?: boolean;
  output?: string;
  timeout?: string;
  interval?: string;
  apiKey?: string;
  alias?: string;
  area?: string;
  verbose?: boolean;
}

/** 轮询缺省值：文档建议 3~5 秒一次；视频通常数分钟 */
const DEFAULT_INTERVAL_SEC = 5;
const DEFAULT_TIMEOUT_SEC = 600;

/** 数据面上下文：origin + Key + 日志维度 */
interface GenContext {
  origin: string;
  apiKey: string;
  profile: string;
  site: string;
  /** 数据面地域（记进本地任务记录：之后查询要用同一地域的 Key） */
  area: string;
  /** 把每次请求与原始响应打到 stderr（Key 打码，Base64 截断），排查与核对参数用 */
  verbose: boolean;
}

function contextOf(opts: GenOptions, globals: GlobalArgs): GenContext {
  const profile = resolveProfile(globals);
  const site = resolveSite(globals);
  const region = opts.area ?? DEFAULT_REGION;
  if (!allowedRegions(site).includes(region)) {
    throw new Error(t("chat.badArea", { site, area: region, options: allowedRegions(site).join(", ") }));
  }
  const apiKey = opts.apiKey ?? resolveRegionKey(loadDataConfig(profile), site, region, "th", opts.alias);
  if (!apiKey) {
    throw new Error(
      `${t("chat.noKey", { site, area: region, type: "th", alias: opts.alias ?? DEFAULT_ALIAS })}\n${t(
        "chat.noKeyFix",
        { type: "th", area: region },
      )}`,
    );
  }
  return { origin: `https://${chatHostOf(site, region, resolveEnv())}`, apiKey, profile, site, area: region, verbose: Boolean(opts.verbose) };
}

/**
 * 一次数据面请求。失败时把网关错误体原样带出（含 request_id），不吞信息——
 * 生成类接口的报错（内容审核、未开通后付费、并发超限）只有原文能看出原因。
 */
async function request(ctx: GenContext, method: "GET" | "POST", urlPath: string, body?: Obj): Promise<Obj> {
  const start = Date.now();
  // 生成类接口都是 Bearer（各厂商调用指南）；GET 查询没有请求体，不带 Content-Type
  const { "Content-Type": contentType, ...auth } = authHeadersOf("openai", ctx.apiKey);
  const headers: Record<string, string> = body ? { ...auth, "Content-Type": contentType! } : auth;
  if (ctx.verbose) traceRequest(method, `${ctx.origin}${urlPath}`, headers, body);
  const resp = await fetch(`${ctx.origin}${urlPath}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await resp.text();
  let parsed: Obj = {};
  try {
    parsed = JSON.parse(text) as Obj;
  } catch {
    // 非 JSON 错误体，下面按原文报错
  }
  const requestId = resp.headers.get("x-request-id") ?? (typeof parsed["request_id"] === "string" ? parsed["request_id"] : undefined);
  logDataPlaneCall(ctx.profile, ctx.site, {
    channel: `gen:${urlPath.split("/").slice(0, 5).join("/")}`,
    requestId: requestId ?? undefined,
    durationMs: Date.now() - start,
    status: resp.ok ? "ok" : "error",
    error: resp.ok ? undefined : `HTTP ${resp.status}`,
  });
  if (ctx.verbose) traceResponse(resp.status, Date.now() - start, text);
  if (!resp.ok) {
    throw new Error(t("gen.httpFailed", { status: resp.status, url: urlPath, detail: text.slice(0, 2000) }));
  }
  return parsed;
}

/**
 * --image 归一：URL 原样；本地文件按族的编码约定转换。
 * 只收 URL 的族遇到本地文件直接拦截——发出去也只会收到一个看不出原因的 400。
 */
function encodeImages(family: FamilySpec, raws: string[]): string[] {
  if (raws.length > family.maxImages) {
    throw new Error(t("gen.tooManyImages", { model: family.id, max: family.maxImages }));
  }
  return raws.map((raw) => {
    const input = classifyInput(raw.startsWith("image:") ? raw : `image:${raw}`);
    if (input.origin === "url") {
      return input.ref;
    }
    if (family.encoding === "urlOnly") {
      throw new Error(t("gen.urlOnly", { model: family.id }));
    }
    const b64 = fs.readFileSync(input.ref).toString("base64");
    return family.encoding === "raw" ? b64 : `data:${input.mime};base64,${b64}`;
  });
}

/** --body 支持内联 JSON 或 @file */
function readBodyOverride(raw: string | undefined): Obj {
  if (!raw) return {};
  const text = raw.startsWith("@") ? fs.readFileSync(raw.slice(1), "utf8") : raw;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Obj;
    }
  } catch {
    // 落到下面统一报错
  }
  throw new Error(t("gen.badBody"));
}

function numberOpt(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(t("gen.badNumber", { name }));
  }
  return n;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 轮询到终态或超时。进度打到 stderr，stdout 只留结果（便于管道） */
async function poll(ctx: GenContext, family: FamilySpec, model: string, taskId: string, opts: GenOptions): Promise<{ result: TaskResult; raw: Obj }> {
  const interval = (numberOpt(opts.interval, "--interval") ?? DEFAULT_INTERVAL_SEC) * 1000;
  const deadline = Date.now() + (numberOpt(opts.timeout, "--timeout") ?? DEFAULT_TIMEOUT_SEC) * 1000;
  const spec = family.query!(model, taskId);
  let last = "";
  for (;;) {
    const raw = await queryOnce(ctx, spec);
    const result = family.parse(raw);
    if (result.state === "succeeded" || result.state === "failed") {
      return { result, raw };
    }
    if (result.state !== last) {
      recordState(taskId, result.state, new Date());
      if (!isJson()) console.error(t("gen.progress", { state: result.state }));
      last = result.state;
    }
    if (Date.now() >= deadline) {
      throw new Error(t("gen.timeout", { cmd: statusCommandOf(model, taskId) }));
    }
    await sleep(interval);
  }
}

function queryOnce(ctx: GenContext, spec: QuerySpec): Promise<Obj> {
  return request(ctx, spec.method, spec.path, spec.body);
}

function statusCommandOf(model: string, taskId: string): string {
  return `thcli +gen status --model ${model} --task-id ${taskId}`;
}

/** 下载结果到目录，文件名取 URL 路径的 basename（去掉签名参数） */
async function download(urls: string[], dir: string): Promise<string[]> {
  fs.mkdirSync(dir, { recursive: true });
  const saved: string[] = [];
  for (const [i, url] of urls.entries()) {
    const resp = await fetch(url);
    if (!resp.ok) {
      throw new Error(t("gen.downloadFailed", { status: resp.status, url }));
    }
    const base = path.basename(new URL(url).pathname) || `result-${i}`;
    const file = path.join(dir, base);
    fs.writeFileSync(file, Buffer.from(await resp.arrayBuffer()));
    saved.push(file);
  }
  return saved;
}

/** 终态输出：成功打印 URL（可选下载），失败抛错带原因 */
async function finish(result: TaskResult, raw: Obj, opts: GenOptions, taskId?: string): Promise<void> {
  const saved = result.state === "succeeded" && opts.output ? await download(result.urls, opts.output) : [];
  if (taskId) recordState(taskId, result.state, new Date(), saved);
  if (emitJson({ TaskId: taskId ?? null, State: result.state, Urls: result.urls, ExtraUrls: result.extraUrls, Saved: saved, Raw: raw })) {
    return;
  }
  if (result.state === "failed") {
    throw new Error(t("gen.failed", { reason: result.error ?? JSON.stringify(raw).slice(0, 500) }));
  }
  for (const url of result.urls) console.log(url);
  for (const url of result.extraUrls) console.log(t("gen.preview", { url }));
  if (saved.length) {
    for (const file of saved) console.log(t("gen.saved", { file }));
  } else {
    console.error(t("gen.expiryHint"));
  }
}

async function generate(kind: MediaKind, prompt: string, opts: GenOptions, globals: GlobalArgs): Promise<void> {
  const model = opts.model!;
  const family = familyOf(model, kind);
  if (!family) {
    throw new Error(t("gen.unknownModel", { model, kind, cmd: `thcli +gen models --type ${kind}` }));
  }
  const images = encodeImages(family, opts.image ?? []);
  if (!prompt && !images.length) {
    throw new Error(t("gen.needInput"));
  }
  const req: GenRequest = {
    model,
    prompt: prompt || undefined,
    images,
    size: opts.size,
    ratio: opts.ratio,
    duration: numberOpt(opts.duration, "--duration"),
    resolution: opts.resolution,
    negativePrompt: opts.negativePrompt,
    audio: opts.audio,
  };
  // 传了本模型不用的选项：不报错（请求照发），但要说出来——否则用户以为 --ratio 生效了
  const ignored = OPTION_FLAGS.filter(([key, flag]) => req[key] !== undefined && !family.options.includes(key)).map(([, flag]) => flag);
  if (ignored.length && !isJson()) {
    console.error(t("gen.optionIgnored", { model, flags: ignored.join(" "), cmd: `thcli +gen models --model ${model}` }));
  }
  const submit = family.submit(req);
  // 表外参数不逐一建模：--param 逐项覆盖，--body 整段合并
  const body = deepMerge(deepMerge(submit.body, parseParams(opts.param ?? [])), readBodyOverride(opts.body));

  const ctx = contextOf(opts, globals);
  if (family.sync && !isJson()) {
    // 同步族一次请求即返回结果，但生图仍要等十几到几十秒；不打提示用户会以为卡住
    console.error(t("gen.generating"));
  }
  const resp = await request(ctx, "POST", submit.path, body);

  if (family.sync) {
    await finish(family.parse(resp), resp, opts);
    return;
  }
  const taskId = family.taskIdOf!(resp);
  if (!taskId) {
    // 部分厂商提交即失败时仍回 HTTP 200，失败原因在 body 里（如混元 3D / YT 的
    // {"id":"","status":"failed","error":{"code":"ResourceInsufficient"}}）——先按失败解读
    const submitted = family.parse(resp);
    if (submitted.state === "failed") {
      throw new Error(t("gen.failed", { reason: submitted.error ?? JSON.stringify(resp).slice(0, 500) }));
    }
    throw new Error(t("gen.noTaskId", { body: JSON.stringify(resp).slice(0, 1000) }));
  }
  // 先落本地记录再做别的：之后无论是 --no-wait、等待超时还是终端被关，都能用 +gen status（不带 --task-id）找回任务 ID
  recordSubmitted({
    taskId,
    model,
    kind,
    prompt,
    createdAt: new Date().toISOString(),
    profile: ctx.profile,
    site: ctx.site,
    area: ctx.area,
  });
  if (opts.wait === false) {
    if (emitJson({ TaskId: taskId, Model: model, Raw: resp })) return;
    console.log(t("gen.submitted", { id: taskId }));
    console.log(`  ${statusCommandOf(model, taskId)} --wait`);
    return;
  }
  if (!isJson()) {
    console.error(t("gen.submittedWaiting", { id: taskId }));
  }
  const { result, raw } = await poll(ctx, family, model, taskId, opts);
  await finish(result, raw, opts, taskId);
}

/** +gen status 的参数：给 --task-id 查单个任务，不给则列出最近任务 */
type StatusOptions = GenOptions & { taskId?: string; limit?: string; all?: boolean; state?: string; refresh?: boolean };

/**
 * +gen status：一个命令覆盖"查单个"和"看最近"。
 *   不给 --task-id：列出本机最近提交的任务，并先向平台查一轮未完成任务的最新状态
 *   给 --task-id ：查这个任务（--wait 等到完成）
 * 之所以合并：拿到任务 ID 的第一步就是"看看最近有哪些任务"，分成两个命令还要多记一个。
 */
async function statusCommand(opts: StatusOptions, globals: GlobalArgs): Promise<void> {
  if (!opts.taskId) {
    await listCommand(opts, globals);
    return;
  }
  const taskId = opts.taskId;
  // 本机提交过的任务有记录：--model 可省，账号 / 站点 / 地域也沿用提交时的（命令行显式给了则以命令行为准）
  const known = findTask(taskId);
  const model = opts.model ?? known?.model;
  if (!model) {
    // 无记录 = 不是本机提交的，或在本机记录功能加入之前提交的；任务 ID 前缀（WandVideo 等）多家共用，推断不出模型
    throw new Error(t("gen.status.needModel", { id: taskId }));
  }
  const family = familyOf(model);
  if (!family || family.sync) {
    throw new Error(t("gen.statusUnsupported", { model }));
  }
  const area = process.argv.includes("--area") ? opts.area : known?.area ?? opts.area;
  const ctx = contextOf({ ...opts, area }, known ? scopeOf(known, globals) : globals);
  if (ctx.profile !== resolveProfile(globals) || ctx.site !== resolveSite(globals)) {
    // 沿用了提交时的账号 / 站点，与当前默认不同：说一声，免得用户以为查错了号
    console.error(t("gen.status.scope", { profile: ctx.profile, site: ctx.site }));
  }
  if (opts.wait) {
    const { result, raw } = await poll(ctx, family, model, taskId, opts);
    await finish(result, raw, opts, taskId);
    return;
  }
  const raw = await queryOnce(ctx, family.query!(model, taskId));
  const result = family.parse(raw);
  if (result.state === "succeeded" || result.state === "failed") {
    await finish(result, raw, opts, taskId);
    return;
  }
  recordState(taskId, result.state, new Date());
  if (emitJson({ TaskId: taskId, State: result.state, Raw: raw })) return;
  console.log(t("gen.progress", { state: result.state }));
}

/** ISO 时间 → 本地 "MM-DD HH:mm"（列表里看的是"什么时候提交的"，本地时间最直观） */
function localShort(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 列表刷新时同时查询的任务数上限：任务多时不一次打出几十个请求 */
const REFRESH_CONCURRENCY = 4;

/** 重新查询还没到终态的任务，把最新状态写回本地记录 */
async function refreshPending(tasks: GenTask[], opts: GenOptions, globals: GlobalArgs): Promise<void> {
  const now = new Date();
  const pending = tasks.filter((x) => needsRefresh(x, now));
  // 各任务互不相关，限并发查询；每个任务用提交时的账号 / 站点 / 地域（--all 时可能各不相同）。
  // 单个失败（过期、Key 被删）保留上次状态，不影响其余
  await forEachLimit(pending, REFRESH_CONCURRENCY, async (task) => {
    const family = familyOf(task.model);
    if (!family?.query) return;
    try {
      const ctx = contextOf({ ...opts, area: task.area }, scopeOf(task, globals));
      task.state = family.parse(await queryOnce(ctx, family.query(task.model, task.taskId))).state;
      recordState(task.taskId, task.state, new Date());
    } catch {
      // 保留上次的状态
    }
  });
}

/** 默认列出的条数 */
const TASKS_DEFAULT_LIMIT = 20;

/** 列出本机最近任务；默认先刷新一轮未完成任务的状态（--no-refresh 跳过） */
async function listCommand(opts: StatusOptions, globals: GlobalArgs): Promise<void> {
  const profile = resolveProfile(globals);
  const site = resolveSite(globals);
  const limit = numberOpt(opts.limit, "--limit") ?? TASKS_DEFAULT_LIMIT;
  // 默认只看当前账号 + 站点的；--all 时各任务按各自提交时的账号刷新
  let tasks = loadTasks().filter((x) => opts.all || (x.profile === profile && x.site === site));
  if (opts.model) tasks = tasks.filter((x) => x.model === opts.model);
  tasks = tasks.slice(0, limit);
  if (opts.refresh !== false) await refreshPending(tasks, opts, globals);
  if (opts.state) tasks = tasks.filter((x) => x.state === opts.state);

  if (emitJson(tasks)) return;
  if (!tasks.length) {
    console.log(t("gen.tasks.none"));
    return;
  }
  printTable(
    [t("gen.tasks.col.time"), t("gen.col.models"), t("gen.tasks.col.state"), t("gen.tasks.col.id"), t("gen.tasks.col.prompt")],
    tasks.map((x) => [localShort(x.createdAt), x.model, x.state, x.taskId, x.prompt]),
  );
  console.log("");
  const now = new Date();
  if (tasks.some((x) => x.state !== "succeeded" && x.state !== "failed" && !needsRefresh(x, now))) {
    console.log(t("gen.tasks.stale"));
  }
  console.log(t("gen.tasks.footer"));
}

/** 通用选项 → 命令行写法，用于"支持哪些选项"的展示与"被忽略"的提示 */
const OPTION_FLAGS: Array<[GenOption, string]> = [
  ["size", "--size"],
  ["ratio", "--ratio"],
  ["resolution", "--resolution"],
  ["duration", "--duration"],
  ["negativePrompt", "--negative-prompt"],
  ["audio", "--audio"],
];

/** 单个模型的调用说明：支持哪些选项、参考图怎么传、完整参数去哪看 */
function modelDetail(model: string): void {
  const f = familyOf(model);
  if (!f) {
    throw new Error(t("gen.unknownModel", { model, kind: "", cmd: "thcli +gen models" }));
  }
  const flags = OPTION_FLAGS.filter(([key]) => f.options.includes(key)).map(([, flag]) => flag);
  const detail = {
    Model: model,
    Kind: f.kind,
    Family: f.id,
    Sync: f.sync,
    MaxImages: f.maxImages,
    ImageInput: f.encoding,
    Options: flags,
    Doc: f.doc,
  };
  if (emitJson(detail)) return;
  printAligned([
    [t("gen.col.models"), model],
    [t("gen.col.kind"), f.kind],
    [t("gen.col.mode"), f.sync ? t("gen.mode.sync") : t("gen.mode.async")],
    [t("gen.col.images"), f.encoding === "urlOnly" ? t("gen.images.urlOnly", { max: f.maxImages }) : String(f.maxImages)],
    [t("gen.detail.options"), flags.join(" ") || t("common.none")],
    [t("gen.detail.doc"), f.doc],
  ]);
  console.log("");
  console.log(t("gen.detail.paramHint"));
}

function modelsCommand(opts: { type?: string; model?: string }): void {
  if (opts.model) {
    modelDetail(opts.model);
    return;
  }
  const kinds = opts.type ? [opts.type] : ["image", "video", "3d"];
  const rows = FAMILIES.filter((f) => kinds.includes(f.kind));
  if (emitJson(rows.map((f) => ({ Family: f.id, Kind: f.kind, Models: f.models, Sync: f.sync, ImageInput: f.encoding, MaxImages: f.maxImages, Options: f.options, Doc: f.doc })))) {
    return;
  }
  // 一个模型一行：同族模型挤在一格里会超出终端宽度被折行，折下来的半截像是"空了几列的新行"
  printTable(
    [t("gen.col.kind"), t("gen.col.models"), t("gen.col.mode"), t("gen.col.images"), t("gen.col.family")],
    rows.flatMap((f) =>
      f.models.map((model) => [
        f.kind,
        model,
        f.sync ? t("gen.mode.sync") : t("gen.mode.async"),
        f.encoding === "urlOnly" ? t("gen.images.urlOnly", { max: f.maxImages }) : String(f.maxImages),
        f.id,
      ]),
    ),
  );
  console.log("");
  console.log(t("gen.models.legendMode"));
  console.log(t("gen.models.legendImages"));
  console.log(t("gen.models.detailHint"));
  console.log(t("gen.models.footer"));
}

/** 生成类子命令共用的选项 */
function withCommonOptions(cmd: Command): Command {
  return cmd
    .option("--param <key=value>", t("gen.opt.param"), collect)
    .option("--body <json>", t("gen.opt.body"))
    .option("--no-wait", t("gen.opt.noWait"))
    .option("--output <dir>", t("gen.opt.output"))
    .option("--timeout <sec>", t("gen.opt.timeout", { default: DEFAULT_TIMEOUT_SEC }))
    .option("--interval <sec>", t("gen.opt.interval", { default: DEFAULT_INTERVAL_SEC }))
    .option("--api-key <key>", t("chat.opt.apiKey"))
    .option("--alias <alias>", t("opt.aliasPick"), DEFAULT_ALIAS)
    .option("--area <area>", t("opt.areaChat"), DEFAULT_REGION)
    .option("--verbose", t("gen.opt.verbose"));
}

/** 装配 +gen */
export function registerGenCommands(program: Command, getGlobals: () => GlobalArgs): void {
  const gen = program.command("+gen").description(t("group.gen.desc"));

  const kinds: Array<[MediaKind, string]> = [
    ["image", "gen.image.desc"],
    ["video", "gen.video.desc"],
    ["3d", "gen.3d.desc"],
  ];
  for (const [kind, desc] of kinds) {
    const cmd = gen
      .command(kind)
      .description(t(desc))
      .argument("[prompt...]", t("gen.arg.prompt"))
      .requiredOption("--model <model>", t("gen.opt.model", { cmd: `thcli +gen models --type ${kind}` }))
      .option("--image <path|url>", t(`gen.opt.image.${kind}`), collect);
    if (kind === "image") {
      cmd.option("--size <WxH>", t("gen.opt.size"));
    }
    if (kind !== "3d") {
      cmd.option("--ratio <ratio>", t("gen.opt.ratio")).option("--resolution <res>", t("gen.opt.resolution"));
    }
    if (kind === "video") {
      cmd
        .option("--duration <sec>", t("gen.opt.duration"))
        .option("--negative-prompt <text>", t("gen.opt.negativePrompt"))
        .option("--audio <url>", t("gen.opt.audio"));
    }
    withCommonOptions(cmd).action(async (words: string[], opts: GenOptions) =>
      generate(kind, words.join(" "), opts, getGlobals()),
    );
  }

  withCommonOptions(
    gen
      .command("status")
      .description(t("gen.status.desc"))
      .option("--task-id <id>", t("gen.status.opt.taskId"))
      .option("--model <model>", t("gen.status.opt.model"))
      .option("--wait", t("gen.status.opt.wait"))
      .option("--limit <n>", t("gen.tasks.opt.limit", { default: TASKS_DEFAULT_LIMIT }))
      .option("--state <state>", "queued | running | succeeded | failed")
      .option("--no-refresh", t("gen.tasks.opt.noRefresh"))
      .option("--all", t("gen.tasks.opt.all")),
  ).action(async (opts) => statusCommand(opts, getGlobals()));

  gen
    .command("models")
    .description(t("gen.models.desc"))
    .option("--type <type>", "image | video | 3d")
    .option("--model <model>", t("gen.models.opt.model"))
    .action((opts) => modelsCommand(opts));
}
