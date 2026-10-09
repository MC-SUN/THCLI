/**
 * 个人版 TokenPlan（通用 / Hy）的纯逻辑：系列 ↔ 接口产品类型、档位解析、状态文案。
 *
 * 不发请求、不打印，命令层（commands/plan-personal.ts）和 agent 接入共用，也便于单测。
 */

/** 个人版的两个系列，参数值对齐控制台路径 /tokenplan/common、/tokenplan/hy */
export type Series = "common" | "hy";

/** 合法系列，用于参数校验与遍历 */
export const SERIES: Series[] = ["common", "hy"];

/**
 * 系列 → 接口的 ProductType 参数。
 *
 * 通用版叫 personal 而不是 common：这是接口侧的历史命名（空值时也按 personal
 * 处理），与 CLI 参数不一致是有意的——CLI 对齐控制台路径，接口值只在这里出现。
 */
const PRODUCT_TYPE_OF: Record<Series, string> = {
  common: "personal",
  hy: "personal-hunyuan",
};

/** 档位，从低到高 */
export const TIERS = ["lite", "standard", "pro", "max"] as const;

/** 档位名 */
export type Tier = (typeof TIERS)[number];

/** 校验并返回系列；不传返回 undefined，非法值也返回 undefined（由调用方报错） */
export function parseSeries(value: string | undefined): Series | undefined {
  if (value === undefined) {
    return undefined;
  }
  const v = value.trim().toLowerCase();
  return (SERIES as string[]).includes(v) ? (v as Series) : undefined;
}

/** 系列对应的 ProductType */
export function productTypeOf(series: Series): string {
  return PRODUCT_TYPE_OF[series];
}

/** ProductType 反查系列；空串按 personal（接口约定） */
export function seriesOfProductType(productType: unknown): Series | undefined {
  const p = String(productType ?? "").trim().toLowerCase() || "personal";
  return (Object.keys(PRODUCT_TYPE_OF) as Series[]).find((s) => PRODUCT_TYPE_OF[s] === p);
}

/**
 * 从 PrepayInquiryKey 解析档位：`sv_lmp_tokenplan_eh_pro` → pro。
 *
 * 接口不给独立的档位字段，档位只出现在这个询价键的末段。末段不在档位表里就原样返回，
 * 宁可显示原值也不猜错。
 */
export function tierOfInquiryKey(key: unknown): string {
  const raw = String(key ?? "").trim().toLowerCase();
  const tail = raw.split("_").pop() ?? raw;
  return (TIERS as readonly string[]).includes(tail) ? tail : raw;
}

/** 控制台购买/管理页（buy/renew/upgrade/autorenew 都没有接口，统一引导到这里） */
export function consoleUrlOf(series: Series, site: string): string {
  const host = site === "intl" ? "console.tencentcloud.com" : "console.cloud.tencent.com";
  return `https://${host}/tokenhub/tokenplan/${series}`;
}

/**
 * 控制台的个人版 API Key 页（key create / delete 都不由 CLI 调用，引导到这里）。
 * 路径与国内站 tokenplan-quick-setup 的 key_url（/tokenhub/tokenplan/common/api-key）一致，
 * 国际站只换域名。
 */
export function consoleKeyUrl(series: Series, site: string): string {
  return `${consoleUrlOf(series, site)}/api-key`;
}

/**
 * 套餐状态 → 文案键。接口按 PackageStatus 回英文枚举。
 *
 * 只有 ACTIVE 与 UNPURCHASED 实测确认（另有 EXPIRED 一类未购/过期形态），认不出的
 * 原样回显，不猜含义。
 */
export function packageStatusKey(status: unknown): string {
  const s = String(status ?? "").trim().toUpperCase();
  if (s === "ACTIVE") return "personal.status.active";
  if (s === "UNPURCHASED") return "personal.status.unpurchased";
  if (s === "EXPIRED") return "personal.status.expired";
  return s ? s : "personal.status.unknown";
}

/** 自动续费标记 → 文案键。0 手动 / 1 自动 / 2 不自动 */
export function renewFlagKey(flag: unknown): string {
  const n = Number(flag);
  if (n === 1) return "personal.renew.auto";
  if (n === 2) return "personal.renew.never";
  if (n === 0) return "personal.renew.manual";
  return "personal.renew.unknown";
}

/**
 * 距过期的剩余天数（向下取整），过期返回负数。时间无法解析返回 undefined。
 *
 * 接口给的是 "YYYY-MM-DD HH:MM:SS"（东八区本地时间，不带时区），按 +08:00 解析——
 * 不能交给 Date 按运行机器的时区解释，否则海外机器上会差出几个小时、跨日时差一天。
 */
export function remainingDays(expireTime: unknown, now: number = Date.now()): number | undefined {
  const s = String(expireTime ?? "").trim();
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})$/.exec(s);
  if (!m) {
    return undefined;
  }
  const at = Date.parse(`${m[1]}T${m[2]}+08:00`);
  if (Number.isNaN(at)) {
    return undefined;
  }
  return Math.floor((at - now) / 86_400_000);
}

/** 百分比，保留 1 位；分母为 0 或非数字返回 undefined */
export function percentOf(used: unknown, total: unknown): number | undefined {
  const u = Number(used);
  const tot = Number(total);
  if (!Number.isFinite(u) || !Number.isFinite(tot) || tot <= 0) {
    return undefined;
  }
  return Math.round((u / tot) * 1000) / 10;
}
