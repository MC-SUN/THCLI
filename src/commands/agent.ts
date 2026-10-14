/**
 * equip：把 TokenHub 的模型一键接入本地 Agent 工具（Claude Code / Codex / CodeBuddy …）。
 *
 * 与 +connect 互补：+connect 把 thcli 的 skills 装进 Agent（让 Agent 会用 thcli）；
 * equip 改 Agent 的模型配置（让 Agent 用 TokenHub 的模型）。
 *
 *   thcli equip [tool...]           接入（完整：登录 → 选工具 → 选通道/Key/模型 → 写配置 → 验证）
 *   thcli equip install [tool...]   只装 Agent 程序（npm install -g），不登录、不写配置
 *   thcli equip list                支持的工具与检测结果
 *   thcli equip restore [tool...]   按台账还原配置（不卸载 Agent 程序）
 *
 * 接入 / models 要求先登录：Key 与模型列表都按账号从云 API 取，未登录给出登录引导后退出。
 * 接装的顺序：登录 → 选 Agent → 定通道与地域 → 选 Key → 选模型（Key 能调的范围内）→ 汇总确认 → 安装缺失的 Agent → 写入 → 验证。
 * 选 Agent 放在取 Key 之前：选错或一个都没检测到时，不该先去云端建 Key / 取明文。
 * Agent 的 Key 只从云端来源选（或 --api-key / 粘贴），与 thcli 自己的本地 keystore（+chat 用）互不相干。
 */
import { Command } from "commander";

import { buildClient } from "../core/client.js";
import { allowedRegions, allowedSites, areaCloudRegion, DEFAULT_REGION, defaultPlanRegion } from "../core/config.js";
import { type GlobalArgs, mask, parseGlobalArgs, readCredentialFile, resolveEnv, resolveProfile, resolveSite } from "../core/credentials.js";
import { maybeRefreshCredential } from "../core/oauth.js";
import { getSetting } from "../core/settings.js";
import { printTable, splitCsv } from "../core/format.js";
import { t } from "../core/i18n.js";
import { emitJson, isJson } from "../core/output.js";
import { productTypeOf, type Series } from "../core/personal-plan.js";
import { ask, confirm } from "../core/prompt.js";
import { authHeadersOf } from "../core/data-plane.js";
import {
  AGENT_PLANS,
  type AgentPlan,
  apiBaseOf,
  capabilityOf,
  type CatalogKey,
  type Endpoint,
  isAgentTextModel,
  type ModelCapability,
  type ModelCatalog,
  type ModelMeta,
  resolveCatalog,
  resolveEndpoint,
  sanitizeModelIds,
  type WireProtocol,
} from "../core/agent/catalog.js";
import {
  CLAUDE_TIERS,
  type ClaudeTier,
  claudeTiersOf,
  CONFIGURATORS,
  type ConfigureInput,
  guiGuide,
  protocolOf,
} from "../core/agent/configurators.js";
import {
  type AgentEnv,
  defaultAgentEnv,
  loadState,
  restoreFile,
  saveState,
  type ToolRecord,
  WriteSession,
} from "../core/agent/files.js";
import { chooseAuto, chooseKey, findKeyMeta, type KeySource, parsePicks, type PickedKey, SHOW_LIMIT } from "../core/agent/key-picker.js";
import { enterpriseSource, listEnterprisePlans, payAsYouGoSource, personalSource } from "../core/agent/key-sources.js";
import { installCommandOf, isInstalled, runInstall, TOOLS, toolOf, type ToolSpec } from "../core/agent/tools.js";
import { fetchPersonalModels } from "./plan-personal.js";
import { personalKeyClient } from "../core/personal-key.js";

/** install 的参数 */
interface InstallOptions {
  plan?: string;
  series?: string;
  teamId?: string;
  model?: string;
  models?: string;
  apiKey?: string;
  area?: string;
  verify?: boolean;
  dryRun?: boolean;
  yes?: boolean;
}

/** 一次接入解析出的全部上下文（写入前确定，写入阶段只读） */
interface InstallContext {
  plan: AgentPlan;
  site: string;
  endpoint: Endpoint;
  catalog: ModelCatalog;
  models: string[];
  defaultModel: string;
  apiKey: string;
  /** Key 在云端的名称（反查得到；查不到为空） */
  keyName?: string;
  /** Key 来源说明（哪个地域 / 哪个套餐） */
  keySource: string;
  /** Key 只绑定了部分模型时为 true（模型列表已收窄到它能调的） */
  keyPartial: boolean;
  /** Claude Code 各档位的模型（只在选了 Claude Code 时有） */
  claudeTiers?: Partial<Record<ClaudeTier, string>>;
}

type Row = Record<string, unknown>;

/** Key 字符集：Key 会被写进 shell / TOML / JSON，含元字符一律拒绝（真实 Key 只有字母数字连字符） */
const SAFE_KEY = /^[A-Za-z0-9._-]{10,}$/;

/** 按量模型列表分页：DescribeModelList 单页上限 100 */
const MODEL_PAGE_SIZE = 100;

function parsePlan(value: string | undefined): AgentPlan {
  const plan = (value ?? "th") as AgentPlan;
  if (!AGENT_PLANS.includes(plan)) {
    throw new Error(t("agent.err.badPlan", { options: AGENT_PLANS.join(" | ") }));
  }
  return plan;
}

/**
 * 登录前提：Key 要从账号取（或建）、模型列表要按账号的开通情况查，未登录做不了。
 * 不做"未登录时退到文档"的半成品流程——那样写进工具的模型可能根本没开通，调用时才 401/403。
 *
 * OAuth 临时密钥会过期：先按云 API 调用前的同一套规则尝试续期，续不上（refreshToken 也失效）就当作未登录，
 * 免得流程走到取 Key / 查模型才报 AuthFailure。命令行 / 环境变量给的永久密钥不过期，不受影响。
 */
async function requireLogin(globals: GlobalArgs, site: string): Promise<void> {
  const profile = resolveProfile(globals);
  await maybeRefreshCredential(profile, site);
  const cred = parseGlobalArgs(globals);
  if (!cred.secretId || !cred.secretKey) {
    throw new Error(`${t("agent.err.needLogin", { site })}\n${t("agent.err.needLoginFix", { site })}`);
  }
  if (cred.source === "file" && credentialExpired(readCredentialFile(profile, site))) {
    throw new Error(`${t("agent.err.loginExpired", { site })}\n${t("agent.err.needLoginFix", { site })}`);
  }
}

/** OAuth 临时密钥已过期（永久密钥没有 expiresAt，永不过期） */
function credentialExpired(cred: ReturnType<typeof readCredentialFile>): boolean {
  return cred.type === "oauth" && typeof cred.expiresAt === "number" && cred.expiresAt <= Date.now() / 1000;
}

/** 某个站点的登录状态：有可用凭证 / 凭证已过期（续期也失败）/ 没登录 */
async function loginStateOf(profile: string, site: string): Promise<"ok" | "expired" | "none"> {
  if (!readCredentialFile(profile, site).secretId) return "none";
  // 列菜单时只探测、不报错：续期失败的原因由选定站点后的 requireLogin 统一说一次
  await maybeRefreshCredential(profile, site, true);
  const cred = readCredentialFile(profile, site);
  if (!cred.secretId || !cred.secretKey) return "none";
  return credentialExpired(cred) ? "expired" : "ok";
}

/**
 * 先定站点，再看登录：国内站和国际站是两套独立凭证，"登录了"必须指明在哪个站。
 * 命令行 / 环境变量 / site use 已定站点时直接用；否则交互列出候选（当前 profile 已登录的排前面），
 * 选定后写进 globals 的 site，后续登录判断、Key、模型都按这个站点走。非交互默认国内站。
 */
async function resolveSiteChoice(globals: GlobalArgs): Promise<GlobalArgs> {
  if (globals.site || process.env["THCLI_SITE"] || !process.stdin.isTTY || isJson()) {
    return globals;
  }
  const profile = resolveProfile(globals);
  const active = getSetting("site");
  if (active) return globals;
  const sites = allowedSites();
  if (sites.length < 2) return globals;
  const states = Object.fromEntries(await Promise.all(sites.map(async (s) => [s, await loginStateOf(profile, s)] as const)));
  const preferred = sites.filter((s) => states[s] === "ok");
  const ordered = [...preferred, ...sites.filter((s) => !preferred.includes(s))];
  console.log(t("agent.site.header", { profile }));
  const mark = { ok: t("agent.site.loggedIn"), expired: t("agent.site.expired"), none: t("agent.site.notLoggedIn") };
  ordered.forEach((s, i) => console.log(`  ${i + 1}. ${s} — ${mark[states[s]!]}`));
  const answer = (await ask(t("agent.site.prompt")))?.trim().toLowerCase() ?? "";
  const picked = ordered[Number(answer) - 1] ?? (sites.includes(answer) ? answer : undefined);
  return picked ? { ...globals, site: picked } : globals;
}

/**
 * 通道的地域：给了 --area 用它；否则个人版用它在该站点唯一的地域（国内 gz / 国际 sg），
 * 按量与企业版用缺省地域 gz。
 */
function regionOf(plan: AgentPlan, site: string, area: string | undefined): string {
  const region = area ?? (plan === "th" ? DEFAULT_REGION : defaultPlanRegion(plan, site));
  if (!allowedRegions(site).includes(region)) {
    throw new Error(t("chat.badArea", { site, area: region, options: allowedRegions(site).join(", ") }));
  }
  return region;
}

/** 交互 + 非 --yes / --json 时才问用户 */
function canAsk(opts: InstallOptions): boolean {
  return Boolean(process.stdin.isTTY) && !opts.yes && !isJson();
}

/** 通道：给了 --plan 用它；交互时让用户选（按量 / 个人版 / 企业版）；否则按量 */
async function choosePlan(opts: InstallOptions): Promise<AgentPlan> {
  if (opts.plan || !canAsk(opts)) return parsePlan(opts.plan);
  console.log(t("agent.plan.header"));
  AGENT_PLANS.forEach((p, i) => console.log(`  ${i + 1}. ${t(`agent.plan.${p}`)}`));
  const answer = (await ask(t("agent.plan.prompt")))?.trim() ?? "";
  return AGENT_PLANS[Number(answer) - 1] ?? (AGENT_PLANS.includes(answer as AgentPlan) ? (answer as AgentPlan) : "th");
}

/** 个人版系列：给了 --series 用它；交互时问（通用 / Hy）；否则通用 */
async function chooseSeries(plan: AgentPlan, opts: InstallOptions): Promise<Series> {
  if (plan !== "tp") return "common";
  if (opts.series || !canAsk(opts)) return opts.series === "hy" ? "hy" : "common";
  const answer = (await ask(t("agent.series.prompt")))?.trim().toLowerCase() ?? "";
  return answer === "2" || answer === "hy" ? "hy" : "common";
}

/**
 * 企业版套餐：给了 --team-id 用它；否则列出该地域可用的套餐（套餐按地域分，接口翻完所有页），
 * 只有一个直接用，多个时交互选、非交互取第一个。显示上限与 Key 列表一致，超出靠名称 / TeamId 搜索。
 */
async function chooseTeam(region: string, opts: InstallOptions, globals: GlobalArgs): Promise<string> {
  if (opts.teamId) return opts.teamId;
  const plans = (await listEnterprisePlans(globals, region)).filter((p) => p["Status"] === "enable");
  if (!plans.length) throw new Error(t("agent.err.noEnterprisePlan", { cloudRegion: areaCloudRegion(region) }));
  if (plans.length === 1 || !canAsk(opts)) return String(plans[0]!["TeamId"]);
  let shown = plans.slice(0, SHOW_LIMIT);
  console.log(t("agent.team.listHeader", { cloudRegion: areaCloudRegion(region), count: plans.length, shown: shown.length }));
  for (;;) {
    printTable(
      ["#", "TEAM_ID", "NAME", "TYPE", "KEYS"],
      shown.map((p, i) => [String(i + 1), String(p["TeamId"] ?? ""), String(p["Name"] ?? ""), String(p["ProductType"] ?? ""), `${p["ApiKeyCount"] ?? 0}/${p["ApiKeyMax"] ?? 0}`]),
    );
    const answer = (await ask(t("agent.team.prompt")))?.trim() ?? "";
    if (!answer) return String(shown[0]!["TeamId"]);
    // 只认序号与 TeamId（唯一）；套餐名可重名，当搜索词
    const picked = (/^\d+$/.test(answer) ? shown[Number(answer) - 1] : undefined) ?? plans.find((p) => p["TeamId"] === answer);
    if (picked) return String(picked["TeamId"]);
    const needle = answer.toLowerCase();
    const matched = plans.filter((p) => `${p["Name"] ?? ""} ${p["TeamId"] ?? ""}`.toLowerCase().includes(needle));
    if (!matched.length) {
      console.log(t("agent.key.searchNone", { text: answer }));
      continue;
    }
    shown = matched.slice(0, SHOW_LIMIT);
    console.log(t("agent.team.searchHit", { text: answer, count: matched.length, shown: shown.length }));
  }
}

/** 目录键：个人版按系列，企业版、按量各一份 */
function catalogKeyOf(plan: AgentPlan, series: Series): CatalogKey {
  if (plan === "tp") return series === "hy" ? "tp-hy" : "tp-common";
  return plan;
}

/** 按量：所在地域模型广场里的文本对话模型（各地域上架的模型不同），带能力（视觉 / 深度思考） */
async function loadPayAsYouGoModels(globals: GlobalArgs, region: string) {
  const client = buildClient({ ...globals, region: areaCloudRegion(region) });
  const first = await client.call("DescribeModelList", { Limit: MODEL_PAGE_SIZE, Offset: 0, ModelTypes: ["Text"] });
  const total = Number(first["TotalCount"] ?? 0);
  // 第一页拿到总数后，剩余页并发拉
  const rest = await Promise.all(
    Array.from({ length: Math.max(0, Math.ceil(total / MODEL_PAGE_SIZE) - 1) }, (_, i) =>
      client.call("DescribeModelList", { Limit: MODEL_PAGE_SIZE, Offset: (i + 1) * MODEL_PAGE_SIZE, ModelTypes: ["Text"] }),
    ),
  );
  const all = [first, ...rest].flatMap((r) => (r["ModelSet"] as ModelMeta[] | undefined) ?? []).filter(isAgentTextModel);
  const capabilities: Record<string, ModelCapability> = Object.fromEntries(all.map((m) => [String(m.ModelId), capabilityOf(m)]));
  return { models: all.map((m) => String(m.ModelId)), detail: `DescribeModelList(Text, ${areaCloudRegion(region)})`, capabilities };
}

/**
 * 企业版：轻享套餐（enterprise-auto）只有智能路由 auto；专业版是 DescribeTokenPlanModelList（无参）的
 * 固定清单，按地域不同（ap-guangzhou / ap-singapore 各一份）。清单里的 all 是"放开全部"的占位、不是模型，
 * 与 offline 的一起去掉。
 */
async function loadEnterpriseModels(globals: GlobalArgs, region: string, id: string) {
  const client = buildClient({ ...globals, region: areaCloudRegion(region) });
  const resp = await client.call("DescribeTokenPlan", { TeamId: id });
  const team = (resp["Team"] ?? resp) as Row;
  if (team["ProductType"] === "enterprise-auto") {
    return { models: ["auto"], detail: `DescribeTokenPlan(${id}, enterprise-auto)` };
  }
  const list = await client.call("DescribeTokenPlanModelList", {});
  const models = ((list["Models"] as Row[] | undefined) ?? [])
    .filter((m) => m["ModelStatus"] === "online" && m["ModelId"] !== "all")
    .map((m) => String(m["ModelId"]));
  return { models, detail: `DescribeTokenPlanModelList(${areaCloudRegion(region)})` };
}

/**
 * 模型列表：已登录 → 云 API。云 API 这一级失败（凭证过期、无权限、网络问题）时才退到
 * 官方文档 / 内置快照，并在汇总里标出来源，让用户知道这份列表不是按账号查的。
 */
async function loadCatalog(plan: AgentPlan, series: Series, site: string, region: string, opts: InstallOptions, globals: GlobalArgs): Promise<ModelCatalog> {
  const loaders: Record<AgentPlan, () => Promise<{ models: string[]; detail: string; capabilities?: Record<string, ModelCapability> } | undefined>> = {
    th: () => loadPayAsYouGoModels(globals, region),
    "tp-ep": () => loadEnterpriseModels(globals, region, opts.teamId ?? ""),
    tp: async () => {
      const models = await fetchPersonalModels(personalKeyClient(globals), series);
      return {
        models: models.map((m) => String(m["ModelId"])),
        detail: `DescribeTokenPlanPersonalModelList(${productTypeOf(series)})`,
      };
    },
  };
  return resolveCatalog(catalogKeyOf(plan, series), site, loaders[plan]);
}

/**
 * 把目录收窄到这把 Key 能调的模型。Key 绑定全部（models 为空）时就是整份目录；
 * 部分绑定时取交集——绑定里 ep- 开头的服务 ID 不是模型名，不在目录里，自然被排除。
 */
export function scopeToKey(catalog: ModelCatalog, picked: PickedKey): string[] {
  if (!picked.models) return catalog.models;
  const scoped = catalog.models.filter((m) => picked.models!.includes(m));
  if (!scoped.length) {
    throw new Error(t("agent.err.keyNoModels", { name: picked.name ?? t("agent.key.unnamed"), bound: picked.models.join(", ") || "-" }));
  }
  return scoped;
}

/** 校验用户给的模型 ID：字符白名单；目录按账号查到（api）时还必须在可用范围里，文档 / 快照可能过期则放行 */
export function checkModels(wanted: string[], available: string[], source: ModelCatalog["source"]): string[] {
  const bad = wanted.filter((m) => !sanitizeModelIds([m]).length);
  if (bad.length) throw new Error(t("agent.err.badModelId", { model: bad.join(", ") }));
  const unknown = wanted.filter((m) => !available.includes(m));
  if (unknown.length && source === "api") {
    throw new Error(t("agent.err.unknownModels", { models: unknown.join(", ") }));
  }
  return [...new Set(wanted)];
}

/**
 * 选要写进 Agent 的模型：列出这把 Key 能调的全部，多选；第一个选中的就是默认模型。
 * 回车 = 全部（默认模型为列表第一个）。--models / --model 给了或不能交互时不问：
 * --models 缺省 = 全部；--model 缺省 = 所选的第一个，给了但不在 --models 里时补到最前。
 * explicit 表示模型是用户逐个点名的（交互勾选或 --models），此时顺序有意义（Claude Code 按它填档位）。
 */
async function chooseModels(available: string[], catalog: ModelCatalog, opts: InstallOptions): Promise<{ models: string[]; defaultModel: string; explicit: boolean }> {
  let models = opts.models ? checkModels(splitCsv(opts.models), available, catalog.source) : available;
  let explicit = Boolean(opts.models);
  if (!opts.models && !opts.model && canAsk(opts) && available.length > 1) {
    console.log(t("agent.models.pickHeader", { count: available.length, source: t(`agent.source.${catalog.source}`) }));
    available.forEach((m, i) => console.log(`  ${String(i + 1).padStart(2)}. ${m}`));
    for (;;) {
      const answer = (await ask(t("agent.models.pickPrompt", { first: available[0] })))?.trim() ?? "";
      const picked = answer ? parsePicks(answer, available) : available;
      if (picked?.length) {
        models = picked;
        explicit = Boolean(answer);
        break;
      }
      console.log(t("agent.models.pickInvalid"));
    }
  }
  const defaultModel = opts.model ? checkModels([opts.model], available, catalog.source)[0]! : models[0]!;
  if (!models.includes(defaultModel)) models = [defaultModel, ...models];
  return { models, defaultModel, explicit };
}

/** --dry-run 的占位 Key：预演不建 Key、不取明文，汇总里说明正式安装会怎么取 */
const DRY_RUN_KEY_PLACEHOLDER = "dry-run-pending-key";

/** 某通道的 Key 来源（企业版需要已选定的套餐） */
function keySourceOf(plan: AgentPlan, region: string, teamId: string | undefined, globals: GlobalArgs): KeySource {
  if (plan === "th") return payAsYouGoSource(globals, region);
  if (plan === "tp") return personalSource(globals, region);
  return enterpriseSource(globals, region, teamId ?? "");
}

/**
 * 取 Agent 用的 API Key：--api-key > 交互选择（自动 / 从列表挑 / 新建 / 粘贴）> 自动获取（需 --yes）。
 * 只从云端来源取，不读也不写 thcli 本地 keystore。
 *
 * --api-key 与粘贴的明文按打码形式到来源列表里反查名称与模型范围；反查不到就当作绑定全部模型。
 * --dry-run 不建 Key、不取明文、不问输入。
 */
async function resolveApiKey(plan: AgentPlan, region: string, teamId: string | undefined, opts: InstallOptions, globals: GlobalArgs): Promise<PickedKey> {
  const source = keySourceOf(plan, region, teamId, globals);
  let picked: PickedKey | undefined;
  if (opts.apiKey) {
    picked = { key: opts.apiKey };
  } else if (opts.dryRun) {
    console.log(t("agent.key.dryRun", { source: source.label }));
    return { key: DRY_RUN_KEY_PLACEHOLDER };
  } else if (canAsk(opts)) {
    picked = await chooseKey(source, plan);
  } else if (await confirm(t("agent.key.autoConfirm", { source: source.label }), opts.yes)) {
    picked = await chooseAuto(source);
  }
  if (!picked) throw new Error(t("agent.err.noKey", { plan, hint: t(`agent.key.hint.${plan}`) }));
  if (picked.resolved) return picked;
  const meta = await findKeyMeta(source, picked.key);
  return { ...picked, name: picked.name ?? meta?.name, models: meta?.models };
}

/** 选工具：显式指定 > 交互勾选 > --yes / 非交互下全部已检测到的 */
async function selectTools(names: string[], opts: InstallOptions, env: AgentEnv): Promise<ToolSpec[]> {
  if (names.length) {
    const tools = names.map((n) => toolOf(n));
    const bad = names.filter((_, i) => !tools[i]);
    if (bad.length) {
      throw new Error(t("agent.err.unknownTool", { tools: bad.join(", "), options: TOOLS.map((x) => x.key).join(", ") }));
    }
    return tools as ToolSpec[];
  }
  const detected = TOOLS.filter((tool) => isInstalled(tool, env));
  if (!detected.length) {
    throw new Error(t("agent.err.noneDetected", { options: TOOLS.map((x) => x.key).join(", ") }));
  }
  if (opts.yes || !process.stdin.isTTY) {
    return detected;
  }
  // 列出全部支持的 Agent，检测到的排前面；每项标明选了以后会发生什么（回车 = 接入检测到的这些）
  const detectedSet = new Set(detected.map((x) => x.key));
  const ordered = [...detected, ...TOOLS.filter((x) => !detectedSet.has(x.key))];
  console.log(t("agent.select.header"));
  ordered.forEach((tool, i) => {
    console.log(`  ${i + 1}. ${tool.name} (${tool.key}) — ${selectMark(tool, detectedSet.has(tool.key))}`);
  });
  const answer = (await ask(t("agent.select.prompt", { detected: detected.length })))?.trim().toLowerCase() ?? "";
  if (!answer || answer === "all" || answer === "a") return detected;
  const picked = splitCsv(answer)
    .map((x) => ordered[Number(x) - 1] ?? toolOf(x))
    .filter((x): x is ToolSpec => Boolean(x));
  if (!picked.length) throw new Error(t("agent.err.noSelection"));
  return [...new Set(picked)];
}

/** 选择菜单里每个 Agent 的标注：已安装 / 未安装时选了会怎样 / 界面填写 */
function selectMark(tool: ToolSpec, installed: boolean): string {
  if (tool.mode === "gui") return t("agent.mode.gui");
  if (installed) return t("agent.select.detected");
  if (installCommandOf(tool)) return t("agent.select.npmInstall");
  return t(tool.extensionId ? "agent.select.extensionInstall" : "agent.select.manualInstall");
}

/** 单次验证请求的超时；网关偶发挂起时不让用户干等，超时后重试一次 */
const VERIFY_TIMEOUT_MS = 15_000;

/**
 * 对默认模型发一次 max_tokens=1 的请求，按工具实际使用的协议验证：
 * OpenAI 兼容走 /chat/completions，Anthropic（Claude Code）走 /v1/messages。
 * 两条路径在网关上是不同的路由，只测一条不能代表另一条也通。
 */
async function verifyProtocol(ep: Endpoint, protocol: WireProtocol, apiKey: string, model: string): Promise<string | undefined> {
  const first = await verifyOnce(ep, protocol, apiKey, model);
  // 只对超时重试：鉴权 / 模型不存在之类的 HTTP 错误重试也一样
  return first && first.startsWith("timeout") ? verifyOnce(ep, protocol, apiKey, model) : first;
}

async function verifyOnce(ep: Endpoint, protocol: WireProtocol, apiKey: string, model: string): Promise<string | undefined> {
  const base = apiBaseOf(ep, protocol);
  const anthropic = protocol === "anthropic";
  try {
    const resp = await fetch(anthropic ? `${base}/v1/messages` : `${base}/chat/completions`, {
      method: "POST",
      headers: authHeadersOf(protocol, apiKey),
      body: JSON.stringify({ model, max_tokens: 1, messages: [{ role: "user", content: "ping" }], ...(anthropic ? {} : { stream: false }) }),
      signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
    });
    if (resp.ok) return undefined;
    return `HTTP ${resp.status} ${(await resp.text()).slice(0, 300)}`;
  } catch (err) {
    return (err as Error).name === "TimeoutError" ? `timeout (${VERIFY_TIMEOUT_MS / 1000}s)` : (err as Error).message;
  }
}

/** 解析写入前需要的全部上下文 */
async function prepare(tools: ToolSpec[], opts: InstallOptions, globals: GlobalArgs): Promise<InstallContext> {
  const plan = await choosePlan(opts);
  const series = await chooseSeries(plan, opts);
  const site = resolveSite(globals);
  const region = regionOf(plan, site, opts.area);
  const endpoint = resolveEndpoint(plan, site, region, resolveEnv());
  const teamId = plan === "tp-ep" ? await chooseTeam(region, opts, globals) : undefined;
  const picked = await resolveApiKey(plan, region, teamId, opts, globals);
  if (picked.key !== DRY_RUN_KEY_PLACEHOLDER && !SAFE_KEY.test(picked.key)) {
    throw new Error(t("agent.err.badKey"));
  }
  const catalog = await loadCatalog(plan, series, site, region, { ...opts, teamId }, globals);
  const { models, defaultModel, explicit } = await chooseModels(scopeToKey(catalog, picked), catalog, opts);
  // Claude Code 的档位按用户点名的顺序填；没点名（全部）时各档位都用默认模型，不按目录顺序乱填
  const claudeTiers = tools.some((x) => x.key === "claude-code") && explicit ? claudeTiersOf(models, defaultModel) : undefined;
  return {
    plan,
    site,
    endpoint,
    catalog,
    models,
    defaultModel,
    claudeTiers,
    apiKey: picked.key,
    keyName: picked.name,
    keySource: keySourceOf(plan, region, teamId, globals).label,
    keyPartial: Boolean(picked.models),
  };
}

/** 写入前的汇总；返回用户是否确认继续 */
async function summarize(ctx: InstallContext, tools: ToolSpec[], opts: InstallOptions, env: AgentEnv): Promise<boolean> {
  if (isJson()) return true;
  console.log(t("agent.summary.endpoint", { plan: ctx.plan, site: ctx.site, base: ctx.endpoint.origin }));
  console.log(t("agent.summary.tools", { tools: tools.map((x) => x.name).join(", ") }));
  // 只列能用 npm 装的；桌面应用（WorkBuddy）装不了，结果里给下载链接
  const viaNpm = tools.filter((x) => x.mode === "file" && installCommandOf(x) && !isInstalled(x, env)).map((x) => x.name);
  if (viaNpm.length) console.log(t("agent.summary.toInstall", { tools: viaNpm.join(", ") }));
  if (ctx.apiKey === DRY_RUN_KEY_PLACEHOLDER) console.log(t("agent.summary.keyPending"));
  else console.log(t("agent.summary.key", { name: ctx.keyName ?? t("agent.key.unnamed"), masked: mask(ctx.apiKey), source: ctx.keySource }));
  console.log(t(ctx.keyPartial ? "agent.summary.modelsScoped" : "agent.summary.models", { count: ctx.models.length, source: t(`agent.source.${ctx.catalog.source}`), detail: ctx.catalog.detail, model: ctx.defaultModel }));
  if (ctx.claudeTiers) {
    console.log(t("agent.summary.claude", { tiers: CLAUDE_TIERS.map((x) => `${x}=${ctx.claudeTiers![x] ?? ctx.defaultModel}`).join("  ") }));
  }
  if (ctx.catalog.source !== "api") console.log(t("agent.summary.notFromApi"));
  // 预演不改任何东西，无需确认；全是界面型 Agent 时本地不写任何文件，直接给填写项，不问"是否写入"
  if (opts.dryRun || tools.every((x) => x.mode === "gui")) return true;
  const gui = tools.filter((x) => x.mode === "gui").map((x) => x.name);
  if (gui.length) console.log(t("agent.summary.guiAfter", { tools: gui.join(", ") }));
  return confirm(t("agent.summary.confirm"), opts.yes);
}

/** 写一个工具的配置并记台账，返回结果行 */
async function configureOne(tool: ToolSpec, ctx: InstallContext, opts: InstallOptions, env: AgentEnv): Promise<Row> {
  const row: Row = { Tool: tool.key, Name: tool.name, Mode: tool.mode };
  if (tool.mode === "file" && !isInstalled(tool, env)) {
    // 能走到这里的未安装 Agent 都有 npm 包（桌面应用已在 guideManualInstalls 里引导先安装）
    const cmd = installCommandOf(tool)!;
    if (opts.dryRun) {
      row["WillInstall"] = cmd.join(" ");
    } else if (await confirm(t("agent.install.confirm", { name: tool.name, cmd: cmd.join(" ") }), opts.yes, true)) {
      // 装失败就不写配置：写了也用不了，还会让 status 显示"已接入"
      if (!runInstall(cmd, env.platform)) {
        row["Error"] = t("agent.result.installFailed", { cmd: cmd.join(" ") });
        return row;
      }
      row["Installed"] = true;
    } else {
      // 用户不装：照常写配置，之后装上即可用（各 Agent 都读固定路径）
      row["NotInstalled"] = t("agent.result.notInstalled");
    }
  }
  const state = loadState(env);
  const previous = state.tools[tool.key];
  const input: ConfigureInput = {
    endpoint: ctx.endpoint,
    apiKey: ctx.apiKey,
    models: ctx.models,
    defaultModel: ctx.defaultModel,
    previousModels: previous?.models ?? [],
    capabilities: ctx.catalog.capabilities,
    claudeTiers: ctx.claudeTiers,
  };
  if (tool.mode === "gui") {
    row["Guide"] = guiGuide(tool, input, mask(ctx.apiKey));
    return row;
  }
  const session = new WriteSession(env, Boolean(opts.dryRun), previous);
  try {
    const outcome = CONFIGURATORS[tool.key]!(input, session);
    Object.assign(row, { BaseUrl: outcome.baseUrl, DefaultModel: outcome.defaultModel, Files: session.files.map((f) => f.path), Notes: outcome.notes });
    if (!opts.dryRun) {
      state.tools[tool.key] = {
        tool: tool.key,
        plan: ctx.plan,
        site: ctx.site,
        baseUrl: outcome.baseUrl,
        defaultModel: outcome.defaultModel,
        models: ctx.models,
        configuredAt: env.now().toISOString(),
        files: session.files,
        mainFile: outcome.mainFile,
      };
      saveState(env, state);
    }
  } catch (err) {
    row["Error"] = (err as Error).message;
    // 中途失败：把本次已写的文件恢复成运行前的样子，台账不动——不留半截配置
    if (!opts.dryRun) {
      const failed = session.rollback();
      row["RolledBack"] = failed.length ? failed : true;
    }
  }
  return row;
}

/**
 * 未安装、又不能用 npm 装的 Agent（桌面应用 WorkBuddy、编辑器扩展 Kilo Code）：不写配置，引导用户先安装、装好后再 equip。
 * 先写配置不可取——应用首次安装 / 启动时可能用自己的默认配置覆盖，用户也看不出是否接好。
 * 去掉它们后一个都不剩就直接结束（不再去取 Key、选模型）。
 */
function guideManualInstalls(tools: ToolSpec[], env: AgentEnv): ToolSpec[] {
  const manual = tools.filter((x) => x.mode === "file" && !installCommandOf(x) && !isInstalled(x, env));
  if (!manual.length) return tools;
  console.log("");
  for (const x of manual) {
    const key = x.extensionId ? "agent.guide.installExtensionFirst" : "agent.guide.installFirst";
    console.log(t(key, { name: x.name, url: x.downloadUrl ?? x.docUrl, key: x.key }));
  }
  console.log("");
  const rest = tools.filter((x) => !manual.includes(x));
  if (!rest.length) throw new Error(t("agent.err.nothingToConfigure"));
  return rest;
}

async function installCommand(names: string[], opts: InstallOptions, globals: GlobalArgs): Promise<void> {
  const scoped = await resolveSiteChoice(globals);
  await requireLogin(scoped, resolveSite(scoped));
  const env = defaultAgentEnv();
  const tools = guideManualInstalls(await selectTools(names, opts, env), env);
  const ctx = await prepare(tools, opts, scoped);
  if (!(await summarize(ctx, tools, opts, env))) return;

  const results: Row[] = [];
  for (const tool of tools) {
    results.push(await configureOne(tool, ctx, opts, env));
  }

  // 每种用到的协议各验证一次（Claude Code 走 Anthropic，其余走 OpenAI 兼容）
  const verify: Partial<Record<WireProtocol, string>> = {};
  if (opts.verify !== false && !opts.dryRun) {
    // 只验证写入成功的 Agent 用到的协议：写失败的不该连带报"验证通过"
    const written = new Set(results.filter((r) => !r["Error"] && r["Files"]).map((r) => String(r["Tool"])));
    const protocols = [...new Set(tools.filter((x) => written.has(x.key)).map((x) => protocolOf(x.key)))];
    for (const p of protocols) {
      verify[p] = (await verifyProtocol(ctx.endpoint, p, ctx.apiKey, ctx.defaultModel)) ?? "ok";
    }
  }

  if (emitJson({ Plan: ctx.plan, Site: ctx.site, Endpoint: ctx.endpoint, ModelSource: ctx.catalog.source, DefaultModel: ctx.defaultModel, Models: ctx.models, Verify: verify, Results: results })) {
    return;
  }
  printInstallResults(results, Boolean(opts.dryRun));
  await offerFullKey(results, ctx, opts);
  for (const [p, r] of Object.entries(verify)) {
    console.log(r === "ok" ? t("agent.verify.ok", { protocol: p, model: ctx.defaultModel }) : t("agent.verify.failed", { protocol: p, model: ctx.defaultModel, reason: r }));
  }
  console.log(t("agent.next.connect"));
  if (results.some((r) => r["Error"]) || Object.values(verify).some((r) => r !== "ok")) {
    process.exitCode = 3;
  }
}

/**
 * GUI 型 Agent 要用户自己粘贴 Key：填写项里只给打码值，填完后单独问一次要不要显示完整 Key（默认否）。
 * 明文打到终端会留在滚动记录 / 日志 / 录屏里，所以不默认显示；非交互、--yes、预演不问。
 */
async function offerFullKey(results: Row[], ctx: InstallContext, opts: InstallOptions): Promise<void> {
  if (!results.some((r) => r["Guide"]) || !canAsk(opts) || opts.dryRun || ctx.apiKey === DRY_RUN_KEY_PLACEHOLDER) return;
  if (await confirm(t("agent.guide.showKey"), false)) console.log(`    API Key: ${ctx.apiKey}\n`);
}

function printInstallResults(results: Row[], dryRun: boolean): void {
  console.log("");
  for (const r of results) {
    if (r["Error"]) {
      console.log(t("agent.result.failed", { name: r["Name"], reason: r["Error"] }));
      const rb = r["RolledBack"];
      if (rb === true) console.log(`    ${t("agent.result.rolledBack")}`);
      else if (Array.isArray(rb)) console.log(`    ${t("agent.result.rollbackFailed", { files: rb.join(", ") })}`);
      continue;
    }
    if (r["Guide"]) {
      console.log(t("agent.result.gui", { name: r["Name"] }));
      for (const line of r["Guide"] as string[]) console.log(line);
      continue;
    }
    console.log(t(dryRun ? "agent.result.dryRun" : "agent.result.ok", { name: r["Name"], model: r["DefaultModel"] }));
    for (const f of (r["Files"] as string[]) ?? []) console.log(`    ${f}`);
    if (r["Installed"]) console.log(`    ${t("agent.result.installed")}`);
    if (r["WillInstall"]) console.log(`    ${t("agent.result.willInstall", { cmd: r["WillInstall"] })}`);
    if (r["NotInstalled"]) console.log(`    ${r["NotInstalled"]}`);
    for (const n of (r["Notes"] as string[]) ?? []) console.log(`    ${n}`);
  }
  console.log("");
}

/**
 * 纯安装：只把 Agent 程序装到本机（`npm install -g <包名>`），不登录、不选通道 / Key / 模型、不写任何配置文件。
 * 与完整接入（裸 equip）互补：适合"先把工具装好、配置之后再说"，或换机后先批量装工具。
 */
async function installOnlyCommand(names: string[], opts: { yes?: boolean }): Promise<void> {
  const env = defaultAgentEnv();
  const tools = await selectTools(names, { yes: opts.yes } as InstallOptions, env);
  const results: Row[] = [];
  let failed = false;
  for (const tool of tools) {
    const row: Row = { Tool: tool.key, Name: tool.name, Mode: tool.mode };
    if (isInstalled(tool, env)) {
      row["Skipped"] = true;
    } else if (!installCommandOf(tool)) {
      // 桌面应用 / 编辑器扩展没有 npm 包，thcli 装不了
      row["Manual"] = true;
    } else {
      const cmd = installCommandOf(tool)!;
      if (await confirm(t("agent.install.confirm", { name: tool.name, cmd: cmd.join(" ") }), opts.yes, true)) {
        if (runInstall(cmd, env.platform)) {
          row["Installed"] = true;
        } else {
          row["Error"] = t("agent.result.installFailed", { cmd: cmd.join(" ") });
          failed = true;
        }
      } else {
        row["NotInstalled"] = t("agent.result.notInstalled");
      }
    }
    results.push(row);
  }

  if (emitJson({ Install: results })) {
    if (failed) process.exitCode = 3;
    return;
  }
  if (!results.some((r) => r["Installed"])) console.log("");
  for (const r of results) {
    if (r["Error"]) {
      console.log(t("agent.result.failed", { name: r["Name"], reason: r["Error"] }));
      continue;
    }
    if (r["Installed"]) console.log(t("agent.installOnly.installed", { name: r["Name"] }));
    else if (r["Skipped"]) console.log(t("agent.installOnly.present", { name: r["Name"] }));
    else if (r["Manual"]) console.log(t("agent.installOnly.manual", { name: r["Name"] }));
    else console.log(t("agent.installOnly.skipped", { name: r["Name"] }));
  }
  console.log("");
  console.log(t("agent.installOnly.next"));
  if (failed) process.exitCode = 3;
}

function listCommand(): void {
  const env = defaultAgentEnv();
  const rows = TOOLS.map((tool) => ({
    Tool: tool.key,
    Name: tool.name,
    Mode: tool.mode,
    Installed: isInstalled(tool, env),
    Config: tool.configPath ? `~/${tool.configPath}` : null,
    Npm: tool.npm?.pkg ?? null,
    Doc: tool.docUrl,
  }));
  if (emitJson(rows)) return;
  printTable(
    [t("agent.col.tool"), t("agent.col.name"), t("agent.col.mode"), t("agent.col.installed"), t("agent.col.config")],
    rows.map((r) => [r.Tool, r.Name, t(`agent.mode.${r.Mode}`), r.Installed ? "✓" : "-", r.Config ?? t("agent.mode.guiHint")]),
  );
  console.log(t("agent.list.footer"));
}

/** 还原一个工具；返回还原失败的路径 */
function restoreTool(r: ToolRecord): string[] {
  return r.files.filter((f) => !restoreFile(f)).map((f) => f.path);
}

async function restoreCommand(names: string[], opts: { yes?: boolean }): Promise<void> {
  const env = defaultAgentEnv();
  const state = loadState(env);
  const targets = names.length ? names : Object.keys(state.tools);
  const records = targets.map((n) => state.tools[n]).filter((r): r is ToolRecord => Boolean(r));
  if (!records.length) {
    console.log(t("agent.status.none"));
    return;
  }
  if (!(await confirm(t("agent.restore.confirm", { tools: records.map((r) => r.tool).join(", ") }), opts.yes))) return;

  const failed: string[] = [];
  for (const r of records) {
    failed.push(...restoreTool(r));
    delete state.tools[r.tool];
    console.log(t("agent.restore.done", { tool: r.tool, count: r.files.length }));
  }
  saveState(env, state);
  if (failed.length) {
    console.log(t("agent.restore.failed", { files: failed.join(", ") }));
    process.exitCode = 3;
  }
}

/** 完整接入的选项定义（裸 equip 用） */
function withInstallOptions(cmd: Command): Command {
  return cmd
    .argument("[tools...]", t("agent.arg.tools"))
    .option("--plan <plan>", t("agent.opt.plan"))
    .option("--series <series>", t("agent.opt.series"))
    .option("--team-id <id>", t("agent.opt.teamId"))
    .option("--model <id>", t("agent.opt.model"))
    .option("--models <ids>", t("agent.opt.models"))
    .option("--api-key <key>", t("agent.opt.apiKey"))
    .option("--area <area>", t("agent.opt.area"))
    .option("--no-verify", t("agent.opt.noVerify"))
    .option("--dry-run", t("agent.opt.dryRun"))
    .option("--yes", t("opt.yes"));
}

/** 装配 equip */
export function registerEquipCommands(program: Command, getGlobals: () => GlobalArgs): void {
  const equip = program.command("equip").description(t("group.equip.desc"));

  // help 里排最前：只装程序，不动配置，不需要登录
  equip
    .command("install")
    .description(t("agent.installOnly.desc"))
    .argument("[tools...]", t("agent.arg.tools"))
    .option("--yes", t("opt.yes"))
    .action(async (tools: string[], opts: { yes?: boolean }) => installOnlyCommand(tools, opts));

  equip.command("list").description(t("agent.list.desc")).action(() => listCommand());

  equip
    .command("restore")
    .description(t("agent.restore.desc"))
    .argument("[tools...]", t("agent.arg.tools"))
    .option("--yes", t("opt.yes"))
    .action(async (tools: string[], opts: { yes?: boolean }) => restoreCommand(tools, opts));

  // 裸 equip = 完整接入
  withInstallOptions(equip).action(async (tools: string[], opts: InstallOptions) => installCommand(tools, opts, getGlobals()));
}
