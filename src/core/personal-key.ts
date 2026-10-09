/**
 * 个人版共享 Key 的管控请求（tokenhub 产品，DescribeTokenPlanPersonalApiKey 系列）。
 *
 * 与同目录的 personal-plan.ts 分工：那边是纯逻辑（系列、档位、价目表、时间换算），
 * 这边发请求、写本地。放在 core 而不是命令层，是为了让 agent 接入（core/agent/key-sources）
 * 与命令层共用同一套判定，避免"没有 Key"和"查询失败"在两个调用点被判成不同的结果。
 *
 * Key 按地域分池，个人版只在该站点的那一个地域有服务（国内 gz / 国际 sg）——所有请求
 * 都经 personalKeyClient 按站点换算云 API 地域，不能沿用凭证默认地域。
 */
import { buildClient, type Client } from "./client.js";
import { areaCloudRegion, defaultPlanRegion } from "./config.js";
import { type GlobalArgs, resolveSite } from "./credentials.js";
import { errorCodeOf } from "./errors.js";
import { loadDataConfig, saveDataConfig, setRegionKey } from "./keystore.js";

type Row = Record<string, unknown>;

/**
 * 个人版 Key / 调用明细所在的 tokenhub 管控客户端。
 *
 * 实测：国际站个人版 Key 只存在于 ap-singapore，默认的 ap-guangzhou 会查空。所以必须
 * 按站点换算成云 API 地域传下去，否则国际站会误报"没有 Key"。
 */
export function personalKeyClient(globals: GlobalArgs): Client {
  const site = resolveSite(globals);
  return buildClient({ ...globals, region: areaCloudRegion(defaultPlanRegion("tp", site)) });
}

/**
 * 个人版共享 Key（两系列共用、每账号仅 1 把）；没有时返回 undefined。
 *
 * 只把 ResourceNotFound 一类错误当"没有 Key"，其它错误（凭证过期、无权限等）照抛——
 * 否则会把"查不了"误报成"没创建"，用户按提示去建 Key 也只是重复踩同一个错。
 */
export async function fetchPersonalKey(client: Client): Promise<Row | undefined> {
  try {
    const resp = await client.call("DescribeTokenPlanPersonalApiKey", {});
    return resp["ApiKeyId"] ? resp : undefined;
  } catch (err) {
    if (/^ResourceNotFound/.test(errorCodeOf(err) ?? "")) return undefined;
    throw err;
  }
}

/** 解析要操作的 Key：给了 --id 用它，否则取账号下唯一那把 */
export async function keyIdOf(client: Client, id: string | undefined): Promise<string | undefined> {
  return id ?? ((await fetchPersonalKey(client))?.["ApiKeyId"] as string | undefined);
}

/** 取共享 Key 明文（DescribeTokenPlanPersonalApiKeySecret）。agent 接入在用户确认后也会用到 */
export async function fetchPersonalKeySecret(
  client: Client,
  id?: string,
): Promise<{ id: string; secret: string } | undefined> {
  const keyId = await keyIdOf(client, id);
  if (!keyId) {
    return undefined;
  }
  const resp = await client.call("DescribeTokenPlanPersonalApiKeySecret", { ApiKeyId: keyId });
  const secret = resp["ApiKey"];
  return typeof secret === "string" && secret ? { id: keyId, secret } : undefined;
}

/**
 * 把个人版 Key 写进本地 keystore 的 tp/default，+chat --plan tp 与 agent install 直接可用。
 * 地域取该站点套餐网关所在地（国内 gz / 国际 sg）：国际站没有广州的套餐网关，
 * 存到 gz 会让 +chat --plan tp --area sg 找不到 Key。
 */
export function savePersonalKey(profile: string, site: string, secret: string): string {
  const region = defaultPlanRegion("tp", site);
  const cfg = loadDataConfig(profile);
  setRegionKey(cfg, site, region, "tp", secret);
  saveDataConfig(profile, cfg);
  return `${site}/${region}/tp/default`;
}
