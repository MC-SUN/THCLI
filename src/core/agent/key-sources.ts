/**
 * agent install 三种通道的 Key 来源（供 key-picker 使用）。
 *
 *   按量 th     该地域的 API Key 列表；云端 Key 按地域分池，云 API 地域由 --area 换算
 *   企业版 tp-ep 某个套餐下的专属 Key；套餐也按地域分（ap-guangzhou / ap-singapore 各一份列表）
 *   个人版 tp    账号下唯一一把共享 Key；只有它一把，没有列表可挑、也不在这里新建
 */
import { buildClient, type Client } from "../client.js";
import { areaCloudRegion } from "../config.js";
import type { GlobalArgs } from "../credentials.js";
import { t } from "../i18n.js";
import { fetchPersonalKey, fetchPersonalKeySecret } from "../personal-key.js";
import {
  createDataPlaneKey,
  DEFAULT_KEY_NAME,
  listDataPlaneKeys,
  obtainDefaultKey,
  revealDataPlaneKey,
} from "../provision.js";
import type { KeyBrief, KeySource } from "./key-picker.js";

type Row = Record<string, unknown>;

/** 列表接口单页上限 */
const PAGE_SIZE = 100;

/** 翻完所有页：按 TotalCount 停，或某页不满一页时停 */
async function pageAll(client: Client, action: string, params: Row, listField: string): Promise<Row[]> {
  const all: Row[] = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const resp = await client.call(action, { ...params, Limit: PAGE_SIZE, Offset: offset });
    const page = (resp[listField] as Row[] | undefined) ?? [];
    all.push(...page);
    if (page.length < PAGE_SIZE || all.length >= Number(resp["TotalCount"] ?? 0)) return all;
  }
}

/** 某数据面地域对应的云 API 客户端 */
function clientFor(globals: GlobalArgs, area: string): Client {
  return buildClient({ ...globals, region: areaCloudRegion(area) });
}

/** 按量：该地域的 API Key */
export function payAsYouGoSource(globals: GlobalArgs, area: string): KeySource {
  const cloudRegion = areaCloudRegion(area);
  return {
    label: t("agent.key.src.th", { cloudRegion }),
    list: async () =>
      (await listDataPlaneKeys(globals, area)).map((k) => {
        const partial = Boolean(k.BindType) && k.BindType !== "all";
        return {
          id: k.ApiKeyId ?? "",
          name: k.Name,
          masked: k.ApiKey,
          enabled: (k.Status ?? "").toLowerCase() !== "disable",
          scope: partial ? t("agent.key.scope.partial") : t("agent.key.scope.all"),
          partial,
          // 部分绑定：BindingItems 的 ResourceId 是模型名或 ep- 开头的服务 ID，调用方与模型列表取交集
          models: partial ? (k.BindingItems ?? []).map((b) => String(b["ResourceId"] ?? "")).filter(Boolean) : undefined,
          createdAt: k.CreateTime,
        };
      }),
    reveal: (id) => revealDataPlaneKey(globals, area, id),
    create: (name) => createDataPlaneKey(globals, area, name),
    defaultName: `${DEFAULT_KEY_NAME}-${area}`,
    auto: () => obtainDefaultKey(globals, area),
    autoLabel: t("agent.key.opt.auto", { name: DEFAULT_KEY_NAME }),
  };
}

/** 企业版专属 Key 的 AllowedModels：接口给的是 JSON 字符串（如 "[\"all\"]"） */
export function allowedModelsOf(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map(String);
  try {
    const parsed = JSON.parse(String(raw ?? "[]")) as unknown;
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

/** 企业版：套餐 teamId 下的专属 Key */
export function enterpriseSource(globals: GlobalArgs, area: string, teamId: string): KeySource {
  const client = clientFor(globals, area);
  return {
    label: t("agent.key.src.tpEp", { teamId, cloudRegion: areaCloudRegion(area) }),
    list: async () => {
      // 一个套餐最多可建 200 把专属 Key（实测 ApiKeyMax=200），要翻页
      const keys = await pageAll(client, "DescribeTokenPlanApiKeyList", { TeamId: teamId }, "ApiKeySet");
      return keys.map((k): KeyBrief => {
        const models = allowedModelsOf(k["AllowedModels"]);
        const all = !models.length || models.includes("all");
        return {
          id: String(k["ApiKeyId"] ?? ""),
          name: k["Name"] as string | undefined,
          masked: k["ApiKey"] as string | undefined,
          // Status 是开关，UseStatus 反映额度等是否可用，两者都 enable 才算能用
          enabled: k["Status"] === "enable" && (k["UseStatus"] ?? "enable") === "enable",
          scope: all ? t("agent.key.scope.all") : models.join(","),
          partial: !all,
          models: all ? undefined : models,
          createdAt: String(k["CreatedAt"] ?? "").slice(0, 19).replace("T", " "),
        };
      });
    },
    reveal: async (id) => {
      const resp = await client.call("DescribeTokenPlanApiKeySecret", { ApiKeyId: id });
      const secret = resp["ApiKey"] ?? resp["Secret"];
      return typeof secret === "string" && secret ? secret : undefined;
    },
  };
}

/** 个人版：唯一一把共享 Key */
export function personalSource(globals: GlobalArgs, area: string): KeySource {
  const client = clientFor(globals, area);
  return {
    label: t("agent.key.src.tp"),
    list: async () => {
      // fetchPersonalKey 只把 ResourceNotFound 当"没有 Key"，其它错误照抛——
      // 凭证过期 / 无权限不会再被吞成"没有 Key"（那会把用户引去重复建 Key）
      const k = await fetchPersonalKey(client);
      if (!k) return [];
      return [
        {
          id: String(k["ApiKeyId"]),
          name: t("agent.key.personalName"),
          masked: k["ApiKey"] as string | undefined,
          enabled: String(k["ApiKeyStatus"] ?? "enable").toLowerCase() !== "disable",
        },
      ];
    },
    reveal: async (id) => (await fetchPersonalKeySecret(client, id))?.secret,
    autoLabel: t("agent.key.opt.autoPersonal"),
    single: true,
  };
}

/** 企业版套餐列表（该地域），供选择套餐 */
export async function listEnterprisePlans(globals: GlobalArgs, area: string): Promise<Row[]> {
  return pageAll(clientFor(globals, area), "DescribeTokenPlanList", {}, "TokenPlanSet");
}
