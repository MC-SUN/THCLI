/**
 * +gen 模型可用性判断（doctor model 诊断 +gen 模型时用）。全是纯函数，只看云 API 返回的字段：
 *   - 服务侧：模型是否下线 → 接入点是否在运行 → 能否计费（剩余免费额度 / 已开后付费）
 *   - Key 侧：范围是否覆盖模型、额度是否用完
 * 本地明文对上云端那把用 agent/key-picker 的 matchesMasked（只比打码前后缀），不输出任何一把 Key 的明文。
 */
import { parseFreeQuota } from "./format.js";

type Row = Record<string, unknown>;

/** 模型已下线（不可调）的状态；pre-offline 预下线期间仍可调，只提示迁移 */
const OFFLINE_MODEL_STATUS = new Set(["offline", "discontinued"]);

/** 接入点能接请求的状态（MODEL_PRE_OFFLINE：模型预下线期间仍可调） */
const SERVING_ENDPOINT_STATUS = new Set(["ACTIVE", "RUNNING", "MODEL_PRE_OFFLINE"]);

/**
 * 服务侧结论：ok 可调 / notFound 该地域查不到模型 / offline 模型已下线 / noEndpoint 没有接入点 /
 * notReady 接入点未运行（VIRTUAL 未开通、INACTIVE 已停止、CREATING 创建中等）/ noBilling 无剩余免费额度且未开后付费
 */
export type ServiceState = "ok" | "notFound" | "offline" | "noEndpoint" | "notReady" | "noBilling";

export interface ServiceCheck {
  State: ServiceState;
  /** 模型状态：online / pre-offline / discontinued 等 */
  ModelStatus?: string;
  /** 判断所依据的接入点 */
  EndpointId?: string;
  EndpointStatus?: string;
  StopReason?: string;
  /** State=ok 时的计费方式：已开后付费优先，其次免费额度 */
  Billing?: "postpaid" | "free";
  FreeQuota?: { Used: number; Total: number; ExpireTime?: string };
}

/** 未过期且没用完的免费额度；否则 undefined */
export function remainingFreeQuota(endpoint: Row, now = Date.now()): ServiceCheck["FreeQuota"] {
  const quota = parseFreeQuota(typeof endpoint["ChargeDetail"] === "string" ? endpoint["ChargeDetail"] : undefined);
  if (!quota) return undefined;
  const total = Number(quota["TotalQuota"] ?? 0);
  const used = Number(quota["UsedQuota"] ?? 0);
  const expire = typeof quota["ExpireTime"] === "string" ? quota["ExpireTime"] : undefined;
  if (total <= used || (expire && Date.parse(expire) <= now)) return undefined;
  return { Used: used, Total: total, ...(expire ? { ExpireTime: expire } : {}) };
}

function endpointFields(e: Row): Pick<ServiceCheck, "EndpointId" | "EndpointStatus" | "StopReason"> {
  return {
    EndpointId: String(e["EndpointId"] ?? ""),
    EndpointStatus: String(e["Status"] ?? ""),
    ...(e["StopReason"] ? { StopReason: String(e["StopReason"]) } : {}),
  };
}

/**
 * 服务侧能否调通，按请求链路依次判断，返回第一个阻断项：
 * 模型存在且未下线 → 接入点在运行 → 有剩余免费额度或已开后付费。
 *
 * +gen 按模型 ID 调用，命中的是与模型同名的默认接入点（自建的 ep-xxx 要显式指定才会用到），
 * 所以只看同名那个；列表里没有同名的才退回看全部，避免因命名假设误判为不可用。
 */
export function serviceCheck(model: string, modelStatus: string | undefined, endpoints: Row[], now = Date.now()): ServiceCheck {
  if (modelStatus === undefined) return { State: "notFound" };
  const base = { ModelStatus: modelStatus };
  if (OFFLINE_MODEL_STATUS.has(modelStatus)) return { ...base, State: "offline" };

  const named = endpoints.filter((e) => e["EndpointId"] === model);
  const candidates = named.length ? named : endpoints;
  if (!candidates.length) return { ...base, State: "noEndpoint" };
  const serving = candidates.filter((e) => SERVING_ENDPOINT_STATUS.has(String(e["Status"] ?? "").toUpperCase()));
  if (!serving.length) return { ...base, State: "notReady", ...endpointFields(candidates[0]!) };

  const postpaid = serving.find((e) => e["PaymentEnabled"] === true);
  if (postpaid) return { ...base, State: "ok", ...endpointFields(postpaid), Billing: "postpaid" };
  for (const e of serving) {
    const quota = remainingFreeQuota(e, now);
    if (quota) return { ...base, State: "ok", ...endpointFields(e), Billing: "free", FreeQuota: quota };
  }
  return { ...base, State: "noBilling", ...endpointFields(serving[0]!) };
}

/** Key 的绑定范围是否覆盖该模型：全部绑定，或绑定项里有该模型 / 其推理服务 */
export function keyCoversModel(key: Row, model: string, endpointIds: string[]): boolean {
  if (String(key["BindType"] ?? "") === "all") return true;
  const items = Array.isArray(key["BindingItems"]) ? (key["BindingItems"] as Row[]) : [];
  return items.some((b) => {
    const id = String(b["ResourceId"] ?? "");
    return id === model || endpointIds.includes(id);
  });
}

/** 额度是否已用完 / 已停用（DescribeApiKey 详情里的 QuotaSet / QuotaStatus） */
export function quotaExhausted(detail: Row): boolean {
  if (String(detail["QuotaStatus"] ?? "") === "inactive") return true;
  const quotas = (detail["QuotaSet"] as Row[] | undefined) ?? [];
  return quotas.some((q) => {
    const total = Number(q["CycleCredits"] ?? 0);
    return total > 0 && Number(q["CycleUsed"] ?? 0) >= total;
  });
}
