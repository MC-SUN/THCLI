/**
 * 内置模型目录快照：云 API 与官方文档都拿不到时的最后兜底。
 *
 * 来源（2026-10-01 抓取并去掉已公告下线的型号）：
 *   tp-common   个人版通用  https://cloud.tencent.com/document/product/1823/130060
 *   tp-hy       个人版 Hy   同上页第二张表
 *   tp-ep       企业专业    https://cloud.tencent.com/document/product/1823/130659
 *   th          按量后付费  https://cloud.tencent.com/document/product/1823/130051（语言模型）
 *
 * 模型上下线频繁，这份快照只保证"能接上"，不保证全；发版前对照上述文档页更新。
 */
import type { CatalogKey } from "./catalog.js";

/** 快照日期，展示给用户 */
export const BUILTIN_SNAPSHOT_DATE = "2026-10-01";

/** 各目录的模型 ID（首个即默认推荐） */
export const BUILTIN_MODELS: Record<CatalogKey, readonly string[]> = {
  "tp-common": [
    "tc-code-latest",
    "deepseek/deepseek-flash",
    "deepseek-v4-flash-202605",
    "deepseek-v4-pro-202606",
    "minimax-m2.7",
    "minimax-m3",
    "glm-5.2",
    "glm-5.3",
    "glm-5.3-flash",
    "hy4-preview",
    "kimi-k2.7-code",
    "kimi-k3",
    "mimo-v2.6-flash",
  ],
  "tp-hy": ["hy3", "hy4-preview"],
  "tp-ep": [
    "auto",
    "hy4-preview",
    "glm-5.3-flash",
    "glm-5.3",
    "glm-5.2",
    "kimi-k3",
    "kimi-k2.7-code",
    "kimi-k2.7-code-highspeed",
    "kimi-k2.6",
    "minimax-m2.7",
    "minimax-m3",
    "deepseek-v4.1-flash",
    "deepseek-v4-pro",
    "deepseek-v4-pro-0813",
    "deepseek-v4-flash-202605",
    "deepseek-v4-pro-202606",
    "mimo-v2.6-pro",
    "mimo-v2.6-flash",
  ],
  th: [
    "glm-5.3",
    "deepseek-v4-pro",
    "kimi-k3",
    "hy3",
    "hy4-preview",
    "glm-5.3-flash",
    "glm-5.2",
    "deepseek-v4.1-flash",
    "deepseek-v4-pro-0813",
    "kimi-k2.7-code",
    "kimi-k2.7-code-highspeed",
    "kimi-k2.6",
    "minimax-m3",
    "minimax-m2.7",
    "mimo-v2.6-pro",
    "mimo-v2.6-flash",
  ],
};
