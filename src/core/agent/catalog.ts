/**
 * agent 接入的"接到哪"与"有哪些模型"。
 *
 * 端点：按通道（th 按量 / tp 个人版 / tp-ep 企业版）× 站点 × 地域，复用一期
 * config.ts 的 chatHostOf / planOriginOf，不另起一套域名表。
 *
 * 模型列表三级来源（需求：未登录退避到文档）：
 *   api      已登录时查云 API（命令层负责，结果传进来）
 *   doc      拉官方文档页，解析 "Model Name | Model ID" 表
 *   builtin  随版本发布的快照（builtin-models.ts）
 * 每一级都过模型 ID 白名单，最终结果标明来源。
 */
import { chatHostOf, DEFAULT_ENV, planOriginOf } from "../config.js";
import type { WireProtocol } from "../data-plane.js";
import { BUILTIN_MODELS, BUILTIN_SNAPSHOT_DATE } from "./builtin-models.js";

/** 接入通道 */
export type AgentPlan = "th" | "tp" | "tp-ep";

/** 合法通道 */
export const AGENT_PLANS: AgentPlan[] = ["th", "tp", "tp-ep"];

/** 模型目录的键：按量 / 个人版两个系列 / 企业版 */
export type CatalogKey = "th" | "tp-common" | "tp-hy" | "tp-ep";

/**
 * 解析出的端点。对外只有一个服务地址（origin），各工具要不要加后缀、加什么，
 * 由该工具的 configurator 按自己的协议决定（apiBaseOf），使用方不用感知。
 */
export interface Endpoint {
  plan: AgentPlan;
  site: string;
  region: string;
  /** 服务地址，如 https://tokenhub.tencentmaas.com */
  origin: string;
}

export type { WireProtocol } from "../data-plane.js";

/**
 * 通道 → 各协议的路径前缀。按量在网关根下（OpenAI 走 /v1，Anthropic 由 SDK 自己拼
 * /v1/messages，所以前缀为空）；套餐在 /plan 下。实测（2026-10-01，真实 Key）：
 *   tokenhub.tencentmaas.com/v1/chat/completions     200（按量 Key）
 *   tokenhub.tencentmaas.com/v1/messages             200（按量 Key）
 *   <host>/plan/v3/chat/completions、/plan/anthropic/v1/messages 存在（401 = 路由在、Key 不匹配）
 */
const PATH_PREFIX: Record<AgentPlan, Record<WireProtocol, string>> = {
  th: { openai: "/v1", anthropic: "" },
  tp: { openai: "/plan/v3", anthropic: "/plan/anthropic" },
  "tp-ep": { openai: "/plan/v3", anthropic: "/plan/anthropic" },
};

/** 按通道解析端点（只解析服务地址） */
export function resolveEndpoint(plan: AgentPlan, site: string, region: string, env = DEFAULT_ENV): Endpoint {
  const origin = plan === "th" ? `https://${chatHostOf(site, region, env)}` : planOriginOf(plan, site, region, env);
  return { plan, site, region, origin: origin.replace(/\/$/, "") };
}

/** 某协议在该端点上的 base URL（写进工具配置的那个值） */
export function apiBaseOf(ep: Endpoint, protocol: WireProtocol): string {
  return `${ep.origin}${PATH_PREFIX[ep.plan][protocol]}`;
}


/** 模型 ID 白名单：模型 ID 会被写进 TOML/JSON/shell，含其它字符的一律丢弃（防注入） */
export const SAFE_MODEL_ID = /^[A-Za-z0-9._/-]+$/;

/** 过滤 + 去重，保持顺序 */
export function sanitizeModelIds(ids: unknown[]): string[] {
  const out: string[] = [];
  for (const raw of ids) {
    const id = String(raw ?? "").trim();
    if (id && SAFE_MODEL_ID.test(id) && !out.includes(id)) out.push(id);
  }
  return out;
}

/** 模型来源 */
export type ModelSource = "api" | "doc" | "builtin";

/** 模型能力（来自模型广场的 Tags），用于需要声明能力的工具（WorkBuddy） */
export interface ModelCapability {
  vision: boolean;
  reasoning: boolean;
}

/** 一份模型目录 */
export interface ModelCatalog {
  source: ModelSource;
  models: string[];
  /** 来源说明：api 为 Action 名，doc 为文档 URL，builtin 为快照日期 */
  detail: string;
  /** 已知能力的模型（只有云 API 来源才有；查不到的模型按未知处理） */
  capabilities?: Record<string, ModelCapability>;
}

/**
 * 各目录对应的官方文档页与表格选择。
 * 个人版通用 / Hy 在同一页的两张表里：通用表首行是 tc-code-latest，Hy 表首行是 hy3。
 */
const DOC_PAGES: Record<CatalogKey, { url: string; firstId?: string; table?: number }> = {
  "tp-common": { url: "https://cloud.tencent.com/document/product/1823/130060", firstId: "tc-code-latest" },
  "tp-hy": { url: "https://cloud.tencent.com/document/product/1823/130060", firstId: "hy3" },
  // 企业专业套餐的模型表。轻享套餐（只有 auto）由云 API 那一级按 ProductType 处理
  "tp-ep": { url: "https://cloud.tencent.com/document/product/1823/130659", table: 0 },
  // 按量：模型列表页的第一张表是语言模型（后面是生图/生视频等，不适合接入编程工具）
  th: { url: "https://cloud.tencent.com/document/product/1823/130051", table: 0 },
};

/** 国际站文档未提供可解析的套餐模型表，只用国内站页；国际站直接退到快照 */
export function docUrlOf(key: CatalogKey): string {
  return DOC_PAGES[key].url;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCharCode(Number(n)));
}

function cellText(html: string): string {
  return decodeEntities(html.replace(/<[^>]+>/g, " "))
    .replace(/﻿/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * 从文档 HTML 里抽出所有"模型表"：表头有一列叫 Model ID / model（调用参数）。
 * 每行取该列的**第一个** ID（同一格里常并列别名，如 "glm-5.3 glm-5-3"，首个是主 ID）。
 */
export function parseModelTables(html: string): string[][] {
  const tables: string[][] = [];
  for (const table of html.match(/<table[\s\S]*?<\/table>/gi) ?? []) {
    const rows = (table.match(/<tr[\s\S]*?<\/tr>/gi) ?? []).map((r) =>
      (r.match(/<t[dh][^>]*>[\s\S]*?<\/t[dh]>/gi) ?? []).map(cellText),
    );
    const header = rows[0] ?? [];
    const col = header.findIndex((h) => /model\s*id|model\s*[（(]调用参数[)）]/i.test(h));
    if (col < 0) continue;
    const ids = rows
      .slice(1)
      // 已公告下线的型号（名称或备注里写着"下线"）不再接入，免得过几天就调不通
      .filter((r) => !r.some((cell) => cell.includes("下线")))
      .map((r) => (r[col] ?? "").split(" ")[0] ?? "")
      .filter((id) => SAFE_MODEL_ID.test(id));
    if (ids.length) tables.push(ids);
  }
  return tables;
}

/** 按目录键从文档 HTML 里选出对应那张表 */
export function pickDocModels(key: CatalogKey, html: string): string[] {
  const tables = parseModelTables(html);
  const page = DOC_PAGES[key];
  const table = page.firstId ? tables.find((ids) => ids[0] === page.firstId) : tables[page.table ?? 0];
  const ids = sanitizeModelIds(table ?? []);
  // 按量的语言模型表里混着翻译 / 角色扮演模型，接编程工具没有意义
  return key === "th" ? ids.filter((id) => !NON_AGENT_MODEL.test(id)) : ids;
}

/**
 * 文档来源只有模型 ID、没有 Tags，只能按 ID 排除翻译（hy-mt*）与角色扮演（*-role*）模型。
 * 云 API 来源按 Tags 判断（isAgentTextModel），这里是它在文档兜底时的近似，锚定前后缀避免误伤。
 */
const NON_AGENT_MODEL = /^hy-mt|(^|-)role(-|$)/;

/** 拉文档页并解析；任何失败返回 undefined（交给下一级） */
export async function fetchDocModels(key: CatalogKey, timeoutMs = 8000): Promise<string[] | undefined> {
  try {
    const resp = await fetch(docUrlOf(key), { signal: AbortSignal.timeout(timeoutMs) });
    if (!resp.ok) return undefined;
    const ids = pickDocModels(key, await resp.text());
    return ids.length ? ids : undefined;
  } catch {
    return undefined;
  }
}

/** 内置快照 */
export function builtinCatalog(key: CatalogKey): ModelCatalog {
  return { source: "builtin", models: [...BUILTIN_MODELS[key]], detail: BUILTIN_SNAPSHOT_DATE };
}

/**
 * 三级回退：api（调用方给）→ doc（国内站才有可解析的页）→ builtin。
 * apiLoader 返回 undefined 或抛错都视为"这一级不可用"。
 */
export async function resolveCatalog(
  key: CatalogKey,
  site: string,
  apiLoader?: () => Promise<{ models: string[]; detail: string; capabilities?: Record<string, ModelCapability> } | undefined>,
  docLoader: (k: CatalogKey) => Promise<string[] | undefined> = fetchDocModels,
): Promise<ModelCatalog> {
  if (apiLoader) {
    try {
      const fromApi = await apiLoader();
      const models = sanitizeModelIds(fromApi?.models ?? []);
      if (models.length) return { source: "api", models, detail: fromApi!.detail, capabilities: fromApi!.capabilities };
    } catch {
      // 已登录但这一级失败（凭证过期、无权限、网络问题）才会走到这里，退到文档
    }
  }
  if (site === "cn") {
    const fromDoc = await docLoader(key);
    if (fromDoc?.length) return { source: "doc", models: fromDoc, detail: docUrlOf(key) };
  }
  return builtinCatalog(key);
}

/**
 * 按量模型里挑出适合接编程工具的文本对话模型。
 * DescribeModelList 的 ModelType=Text 里还混着翻译、角色扮演（Tags 区分），这里排除掉；
 * 已下线与即将下线的也排除。
 */
export function isAgentTextModel(model: ModelMeta): boolean {
  if (model.ModelType !== "Text") return false;
  // pre-offline = 已公告下线，与文档来源过滤"下线"标注的口径一致
  if (model.Status === "discontinued" || model.Status === "offline" || model.Status === "pre-offline") return false;
  const tags = model.Tags ?? [];
  return !tags.includes("翻译") && !tags.includes("角色扮演");
}

/** 模型广场条目里本模块用到的字段 */
export interface ModelMeta {
  ModelId?: string;
  ModelType?: string;
  Tags?: string[];
  Status?: string;
}

/** 从模型广场的 Tags 推出能力：视觉理解 / 多模态理解 → vision，深度思考 → reasoning */
export function capabilityOf(model: ModelMeta): ModelCapability {
  const tags = model.Tags ?? [];
  return {
    vision: tags.includes("视觉理解") || tags.includes("多模态理解"),
    reasoning: tags.includes("深度思考"),
  };
}
