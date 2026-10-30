/**
 * 平台错误的公共组件：tokenhub 错误码表（原因 + 修复建议）与数据面网关错误体的解析、展示。
 *
 * 共用方：doctor error（主动查）、顶层错误处理、+chat / +gen 的网关错误展示（命令报错时自动附上建议）。
 * 报错时当场看到怎么修才是主战场，不用事后手查。
 * +gen 专有的部分（厂商错误码、上游码、按报错原文的建议等）在 gen-errors.ts，经 gatewayErrorLines 的扩展点接入。
 *
 * 文案在 locales 里（键 `errcode.<码>.reason` / `.fix`，码里的点换成下划线），
 * 这里只留码清单。这样切英文时连原因与修复建议一起变，而不是只翻标签。
 */
import { lang, t } from "./i18n.js";

/** 一条错误码释义 */
export interface ErrorInfo {
  reason: string;
  fix: string;
}

/** 管控面（云 API）错误码。顺序即 doctor error 的列出顺序 */
export const CLOUD_CODES: string[] = [
  "AuthFailure.SecretIdNotFound",
  "AuthFailure.SignatureFailure",
  "AuthFailure.TokenFailure",
  "AuthFailure.SecretIdMalformed",
  "AuthFailure.UnauthorizedOperation",
  "UnauthorizedOperation",
  "RequestLimitExceeded",
  "ResourceNotFound",
  "ResourceNotFound.EndpointNotExist",
  "InvalidParameter",
  "LimitExceeded",
  "FailedOperation.RefreshTokenError",
  "UnsupportedRegion",
  "UnsupportedOperation",
];

/**
 * 数据面（网关）业务码。用户跑 +chat 撞到的是这一类，与 HTTP 状态码独立。
 *
 * 从服务端的错误码定义摘录而来，一次性拷入、不做自动同步——服务端加码时这里
 * 不会自动知道，`doctor error <码>` 会走"未收录"分支列出清单，不会给错答案。
 * 码段划分：400xxx 请求非法 / 401xxx 认证与额度 / 403xxx 权限与封禁 /
 * 410·413·429·451·499xxx 各类拒绝 / 5xxxxx 服务端。
 */
export const GATEWAY_CODES: string[] = [
  "400001",
  "400002",
  "400003",
  "400004",
  "400005",
  "400006",
  "401001",
  "401002",
  "401003",
  "401004",
  "401005",
  "401006",
  "401007",
  "401008",
  "401009",
  "401010",
  "403001",
  "403002",
  "403003",
  "403004",
  "403005",
  "403006",
  "410001",
  "413001",
  "429001",
  "429002",
  "429003",
  "429004",
  "429005",
  "429006",
  "451001",
  "499001",
  "500001",
  "502001",
  "503001",
  "504001",
];

/** 已收录的全部错误码 */
export const ERROR_CODES: string[] = [...CLOUD_CODES, ...GATEWAY_CODES];

/** 码 → locales 键前缀。点在键里会与层级分隔混淆，故换成下划线 */
function keyOf(code: string): string {
  return `errcode.${code.replace(/\./g, "_")}`;
}

/** 取一个码的释义；未收录返回 undefined */
function infoOf(code: string): ErrorInfo | undefined {
  if (!ERROR_CODES.includes(code)) {
    return undefined;
  }
  return { reason: t(`${keyOf(code)}.reason`), fix: t(`${keyOf(code)}.fix`) };
}

/** 按错误码查释义，支持前缀回退（如 AuthFailure.Xxx 未收录时退到 AuthFailure 的通用建议） */
export function lookupError(code: string): ErrorInfo | undefined {
  const direct = infoOf(code);
  if (direct) {
    return direct;
  }
  // 带命名空间的码，退到父命名空间找一个宽泛建议
  const dot = code.indexOf(".");
  if (dot > 0) {
    return infoOf(code.slice(0, dot));
  }
  return undefined;
}

/** 腾讯云 SDK 异常上带的 code 字段，官方类型未导出，此处按实际形态取 */
export function errorCodeOf(err: unknown): string | undefined {
  if (err && typeof err === "object" && "code" in err) {
    const code = (err as { code?: unknown }).code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}

// ── 数据面网关错误体 ──
// 形如 {"error":{"message","message_zh","code":"401002","request_id"}}；
// 业务码（六位数字，与 HTTP 状态码独立）已收录时，再补一条带 thcli 命令的修复建议。

type Obj = Record<string, unknown>;

/** 解析失败（非 JSON）时返回原文 */
export function parseGatewayBody(text: string): Obj | string {
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Obj) : text;
  } catch {
    return text;
  }
}

/**
 * request_id：优先响应头（MiniMax 用 trace_id），其次响应体：厂商信封顶层 request_id、
 * OpenAI 协议 error.request_id、Anthropic 协议 error.reqid、云 API Response.RequestId，
 * 最后才用顶层 id（+chat 补全的 chatcmpl-xxx；生成类响应的 id 是任务 ID，所以排在最后）。空串不算。
 */
export function extractRequestId(headers: Headers, body?: Obj): string | undefined {
  const fromHeader = headers.get("x-request-id") ?? headers.get("x-trace-id") ?? headers.get("trace_id") ?? headers.get("trace-id");
  if (fromHeader) return fromHeader;
  if (!body) return undefined;
  const error = body["error"] as Obj | undefined;
  const resp = body["Response"] as Obj | undefined;
  for (const value of [body["request_id"], error?.["request_id"], error?.["reqid"], resp?.["RequestId"], body["id"]]) {
    if (typeof value === "string" && value) return value;
  }
  return undefined;
}

/** 业务码：`error.code` */
export function extractBusinessCode(body: Obj | string): string | undefined {
  if (typeof body === "string") return undefined;
  const error = body["error"] as Obj | undefined;
  const code = error?.["code"];
  if (typeof code === "string") return code;
  if (typeof code === "number") return String(code);
  return undefined;
}

/** 人能读的错误说明：按当前语言取 message_zh / message，缺一个就用另一个；中文环境下译文与原文并存 */
export function extractErrorDetail(body: Obj | string): string {
  if (typeof body === "string") return body;
  const error = body["error"] as Obj | undefined;
  if (error) {
    const zhRaw = error["message_zh"];
    const zh = typeof zhRaw === "string" ? zhRaw : undefined;
    const msgRaw = error["message"];
    const msg = typeof msgRaw === "string" ? msgRaw : undefined;
    if (lang() === "zh") {
      // message_zh 可能是笼统翻译（如 502001 一律「后端语音服务返回业务错误」），原文才带修复线索，两者都给
      if (zh) return msg && msg !== zh ? t("error.detailWithOriginal", { detail: zh, original: msg }) : zh;
      if (msg) return msg;
    } else if (msg ?? zh) {
      return (msg ?? zh)!;
    }
  }
  const resp = body["Response"] as Obj | undefined;
  const respError = resp?.["Error"] as Obj | undefined;
  if (respError && typeof respError["Message"] === "string") return respError["Message"];
  return JSON.stringify(body);
}

/** 调用场景：决定要不要附诊断命令（目前只有 +gen 传，+chat 不传） */
export interface GatewayErrorScene {
  /** 本次调用对应的 doctor 诊断命令；Key、范围、后付费类错误时附上 */
  diagnose?: string;
}

/** 根因在 Key / 可访问范围 / 后付费的码：doctor model（+gen 模型）能逐项查清 */
const DIAGNOSABLE_CODES = new Set(["401002", "401006", "401007", "401008", "403002"]);

/** 本次调用对应的 doctor 诊断命令 */
export function diagnoseCommandOf(model: string): string {
  return `thcli doctor model --id ${model}`;
}

/** gatewayErrorLines 的扩展点：调用方在平台展示的固定位置补内容（+gen 用，+chat 不传） */
export interface GatewayErrorExtension {
  /** 改写已收录业务码的修复建议；入参 fix 是平台默认建议 */
  fix?: (code: string, fix: string) => string;
  /** 业务码之后、诊断命令之前追加的行；fixShown = 前面是否已给出修复建议 */
  extraLines?: (fixShown: boolean) => string[];
}

/** 网关错误的展示行：说明、业务码 + 修复建议（已收录时）、[扩展行]、诊断命令、Request ID */
export function gatewayErrorLines(
  body: Obj | string,
  requestId: string | undefined,
  scene: GatewayErrorScene = {},
  extension: GatewayErrorExtension = {},
): string[] {
  const code = extractBusinessCode(body);
  const lines = [t("chat.errorDetail", { detail: extractErrorDetail(body) })];
  let fixShown = false;
  if (code) {
    lines.push(`  ${t("error.code", { code })}`);
    const fix = lookupError(code)?.fix;
    if (fix) {
      lines.push(`  ${t("error.fix", { fix: extension.fix ? extension.fix(code, fix) : fix })}`);
      fixShown = true;
    }
  }
  if (extension.extraLines) lines.push(...extension.extraLines(fixShown));
  if (code && scene.diagnose && DIAGNOSABLE_CODES.has(code)) {
    lines.push(`  ${t("error.diagnose", { cmd: scene.diagnose })}`);
  }
  lines.push(`Request ID: ${requestId ?? "-"}`);
  return lines;
}
