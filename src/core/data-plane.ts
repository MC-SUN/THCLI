/**
 * 数据面请求的鉴权头：所有协议统一 `Authorization: Bearer <API Key>`。
 *
 * Anthropic 路径平台同时兼容 x-api-key 与 Bearer（文档 1823/130079），这里统一用 Bearer：
 * 我们给 Claude Code 写的是 ANTHROPIC_AUTH_TOKEN，Claude Code 用它发的正是 Authorization: Bearer，
 * CLI 与接入的工具走同一种鉴权，排查时只有一种情况要看。
 * Anthropic 协议另需 anthropic-version 头（协议版本，不是鉴权）。
 *
 * +chat、agent 的连通性验证共用这一份。
 */

/** 数据面协议 */
export type WireProtocol = "openai" | "anthropic";

/** Anthropic 协议版本头，标准 API 要求携带 */
export const ANTHROPIC_VERSION = "2023-06-01";

/** 某协议的请求头（含 Content-Type） */
export function authHeadersOf(protocol: WireProtocol, apiKey: string): Record<string, string> {
  const headers: Record<string, string> = { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };
  if (protocol === "anthropic") {
    headers["anthropic-version"] = ANTHROPIC_VERSION;
  }
  return headers;
}
