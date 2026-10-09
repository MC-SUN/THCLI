/**
 * 管控面接口的时间参数处理。
 *
 * 这些接口收 RFC3339 字符串，且**必须带时区**（`Z` 或 `±HH:MM`）。不带时区的
 * 写法会被拒绝，而 JS 的 `new Date("2026-09-02T16:12:02")` 却会把它当本地时间
 * 照常解析——所以不能只用 Date 判断有效性，必须显式检查时区部分，否则本地看着
 * 通过、发出去才失败。
 */
import { t } from "./i18n.js";

/** RFC3339：日期 T 时间 [.毫秒] 时区，时区不可省 */
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/**
 * 校验用户传入的时间参数。不合法就带上参数名与示例报错，
 * 而不是把它原样发出去等对端拒绝——那样的报错看不出是哪个参数、错在哪。
 */
export function assertRfc3339(value: string | undefined, optName: string): void {
  if (value === undefined) return;
  if (!RFC3339.test(value) || Number.isNaN(new Date(value).getTime())) {
    throw new Error(t("time.needRfc3339", { opt: optName, value }));
  }
}

/** Date → 不带毫秒的 RFC3339 UTC 字符串，与接口接受的形态一致 */
function utcString(d: Date): string {
  return `${d.toISOString().slice(0, 19)}Z`;
}

/** 从当前时刻往前推 N 分钟，返回 [start, end] 的 RFC3339 UTC 字符串 */
export function utcRangeMinutesAgo(minutes: number): { start: string; end: string } {
  const now = new Date();
  return { start: utcString(new Date(now.getTime() - minutes * 60 * 1000)), end: utcString(now) };
}

/**
 * 以给定时刻为终点往前推 N 分钟，返回 [start, end] 的 RFC3339 UTC 字符串。
 *
 * 只给了 `--to`（未给 `--from`）时用它：窗口应对齐到用户指定的终点，
 * 而不是"现在"——按"现在"算会出现 From 晚于 To 的空窗口。
 */
export function utcRangeEndingAt(end: string, minutes: number): { start: string; end: string } {
  const to = new Date(end);
  return { start: utcString(new Date(to.getTime() - minutes * 60 * 1000)), end: utcString(to) };
}

/**
 * RFC3339 → 带时区偏移的 ISO8601（`2026-08-23T00:00:00+08:00`），按运行机器的本地时区。
 *
 * 云监控（Barad）的 GetMonitorData 收这种带偏移的写法，与管控面那套以 `Z` 结尾的
 * UTC 不通用。非法输入直接报错，不原样发出去等对端拒绝。
 */
export function toOffsetIso(value: string): string {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) {
    throw new Error(t("time.badFormat", { value }));
  }
  const p = (n: number): string => String(n).padStart(2, "0");
  const offsetMin = -d.getTimezoneOffset();
  const sign = offsetMin >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMin);
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` +
    `T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}` +
    `${sign}${p(Math.floor(abs / 60))}:${p(abs % 60)}`
  );
}
