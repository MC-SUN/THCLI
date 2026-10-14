/**
 * 数据面 Key（按量 th）的获取与本地保存。
 *
 * - ensureDataPlaneKey：登录后自动为用户备一把 thcli-key，省掉「去控制台建 Key 再复制粘贴」。
 *   best-effort：此时管控凭证已落盘、登录已经成功，这一步任何失败都只返回提示文案，
 *   不影响登录结果。用固定名字做幂等，避免每次登录都新建一把。
 * - listDataPlaneKeys / revealDataPlaneKey / createDataPlaneKey / storeDataPlaneKey：
 *   equip 完整接入让用户挑选、新建 Key 时用。
 *
 * 云端 API Key 按地域分开：同一账号在 ap-guangzhou、ap-singapore 下的 Key 列表不同，
 * Key 只能在所属地域的网关用。所以这里的每个函数都按数据面地域（gz / sg）换算成
 * 云 API 地域，通过 globals.region 传给 buildClient——与 `key list --region` 同一机制。
 */
import { buildClient, type Client } from "./client.js";
import { t } from "./i18n.js";
import { areaCloudRegion, DEFAULT_REGION } from "./config.js";
import type { GlobalArgs } from "./credentials.js";
import { loadDataConfig, saveDataConfig, setRegionKey } from "./keystore.js";

/** 幂等用的固定 Key 名 */
export const DEFAULT_KEY_NAME = "thcli-key";
const PLATFORM = "maas";
const BIND_TYPE = "all";
const FIELD = "th";
const ALIAS = "default";
/** 列表分页大小（DescribeApiKeyList 单页上限 100） */
const PAGE_SIZE = 100;

/** 列表里一把 Key 的摘要（ApiKey 字段是服务端打码后的形式，如 sk-A****ppCX） */
export interface ApiKeyBrief {
  ApiKeyId?: string;
  Name?: string;
  ApiKey?: string;
  Status?: string;
  BindType?: string;
  /** 部分绑定时的资源清单（ResourceId 为模型名或 ep- 开头的服务 ID） */
  BindingItems?: Array<Record<string, unknown>>;
  CreateTime?: string;
}

/** 某数据面地域对应的云 API 客户端 */
function clientFor(args: GlobalArgs, area: string): Client {
  return buildClient({ ...args, region: areaCloudRegion(area) });
}

/** 存进本地 <site>/<area>/th/<alias>，+chat 与 agent 都从这里读 */
export function storeDataPlaneKey(profile: string, site: string, area: string, plaintext: string, alias = ALIAS): string {
  const cfg = loadDataConfig(profile);
  setRegionKey(cfg, site, area, FIELD, plaintext, alias);
  saveDataConfig(profile, cfg);
  return `${site}/${area}/${FIELD}/${alias}`;
}

/** 该地域下的全部 Key（翻完所有页，按创建时间倒序） */
export async function listDataPlaneKeys(args: GlobalArgs, area: string, name?: string): Promise<ApiKeyBrief[]> {
  const client = clientFor(args, area);
  // 云 API 只支持 FUZZY 匹配，调用方需要全等时自己再筛
  const filters = name ? { Filters: [{ Name: "apiKeyName", Op: "FUZZY", Values: [name] }] } : {};
  const keys: ApiKeyBrief[] = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const resp = await client.call("DescribeApiKeyList", { Platform: PLATFORM, ...filters, Limit: PAGE_SIZE, Offset: offset });
    const page = (resp["ApiKeySet"] as ApiKeyBrief[] | undefined) ?? [];
    keys.push(...page);
    if (page.length < PAGE_SIZE || keys.length >= Number(resp["TotalCount"] ?? 0)) break;
  }
  return keys.sort((a, b) => String(b.CreateTime ?? "").localeCompare(String(a.CreateTime ?? "")));
}

/** 取明文（列表接口只给打码形式，要再查一次详情） */
export async function revealDataPlaneKey(args: GlobalArgs, area: string, keyId: string): Promise<string | undefined> {
  const detail = await clientFor(args, area).call("DescribeApiKey", { Platform: PLATFORM, ApiKeyId: keyId });
  const plaintext = detail["ApiKey"];
  return typeof plaintext === "string" && plaintext ? plaintext : undefined;
}

/** 新建一把可调用全部模型的 Key，返回 ApiKeyId */
export async function createDataPlaneKey(args: GlobalArgs, area: string, name: string): Promise<string | undefined> {
  const created = await clientFor(args, area).call("CreateApiKey", {
    Platform: PLATFORM,
    ApiKeyName: name,
    BindType: BIND_TYPE,
    Remark: "created by thcli",
  });
  return created["ApiKeyId"] as string | undefined;
}

/**
 * 在该地域找名为 thcli-key 的 Key，没有就新建，返回明文（不写本地）。
 * 已存在但被停用时抛错。
 */
export async function obtainDefaultKey(args: GlobalArgs, area: string): Promise<{ key: string; name: string }> {
  // FUZZY 可能匹配到名字含 thcli-key 的其它 Key，本地按全等再筛
  const hit = (await listDataPlaneKeys(args, area, DEFAULT_KEY_NAME)).find((k) => k.Name === DEFAULT_KEY_NAME);
  if (hit && (hit.Status ?? "").toLowerCase() === "disable") {
    throw new Error(t("provision.keyDisabled", { name: DEFAULT_KEY_NAME, id: hit.ApiKeyId }));
  }
  const keyId = hit?.ApiKeyId ?? (await createDataPlaneKey(args, area, DEFAULT_KEY_NAME));
  if (!keyId) throw new Error(t("provision.noKeyId"));
  const plaintext = await revealDataPlaneKey(args, area, keyId);
  if (!plaintext) throw new Error(t("provision.noSecret"));
  return { key: plaintext, name: DEFAULT_KEY_NAME };
}

/**
 * 登录后自动备 Key：obtainDefaultKey + 存进本地。返回给用户看的提示；失败只提示不抛错。
 *
 * area 决定去哪个地域找 / 建 thcli-key，也决定存到本地哪个地域槽。
 * 登录时不知道用户之后用哪个地域，按缺省地域。
 */
export async function ensureDataPlaneKey(args: GlobalArgs, area: string = DEFAULT_REGION): Promise<string> {
  try {
    const { key } = await obtainDefaultKey(args, area);
    const client = clientFor(args, area);
    const scope = storeDataPlaneKey(client.profile, client.site, area, key);
    return t("provision.done", { name: DEFAULT_KEY_NAME, scope });
  } catch (err) {
    return `${t("provision.failed", { message: (err as Error).message })}\n${t("provision.failedHint")}`;
  }
}
