/**
 * +gen 的错误处理：厂商错误码表、厂商错误的定位与展示，以及平台网关错误在 +gen 场景下的补充
 * （401007/401008 改给 models activate、上游码 upstream_code、按报错原文的建议、Retry-After）。
 * 平台通用部分（网关错误体解析、平台码表、doctor 诊断命令）在 errors.ts，这里经 gatewayErrorLines 的扩展点接入。
 *
 * 厂商错误码来源：《厂商错误码说明》（tools/actions/视频生成模型/）。
 * 各厂商的错误字段位置、类型都不同，必须先定位再解析：
 *   PixVerse    ErrCode（number，0 成功）+ ErrMsg；生成期失败看 Resp.status（7 审核失败 / 8 生成失败）
 *   Kling       code（number，0 成功）+ message；生成期失败看 data[].status=failed + task_status_msg / message
 *   Vidu        err_code（string，空串成功）
 *   MiniMax     base_resp.status_code（number，0 成功）+ status_msg
 *   MiniMax H3  平台侧：顶层 error.type + error.message；厂商侧：task.error.code + task.error.message
 *
 * 平台在鉴权 / 限流 / 参数校验不通过时也会按厂商格式返回（HTTP 可能仍是 2xx），取值见各表「平台侧」条目；
 * 这些值与厂商同值时无法区分来源，但处理动作一致（修参数 / 降频）。
 *
 * 每个码归入一个类别，修复建议按类别给（locales 的 vendor.fix.<类别>）；个别码有专门的建议时单独覆盖。
 */
import { extractBusinessCode, extractErrorDetail, gatewayErrorLines, type GatewayErrorScene } from "./errors.js";
import { lang, t } from "./i18n.js";

export type VendorId = "pixverse" | "kling" | "vidu" | "minimax" | "minimax-h3";

export const VENDORS: VendorId[] = ["pixverse", "kling", "vidu", "minimax", "minimax-h3"];

/** 厂商展示名 */
export const VENDOR_NAMES: Record<VendorId, string> = {
  pixverse: "PixVerse",
  kling: "Kling",
  vidu: "Vidu",
  minimax: "MiniMax",
  "minimax-h3": "MiniMax H3",
};

/** 修复建议类别 */
export type VendorErrorCategory =
  | "param"
  | "media"
  | "moderation"
  | "rateLimit"
  | "balance"
  | "auth"
  | "permission"
  | "notFound"
  | "busy"
  | "genFailed"
  | "cancelled"
  | "ticket";

type Text = { zh: string; en: string };

interface VendorCode {
  category: VendorErrorCategory;
  reason: Text;
  /** 该码专门的修复建议（缺省按类别） */
  fix?: Text;
}

/** [码, 类别, 中文说明, 英文说明, 专门的修复建议？] */
type Row = [string, VendorErrorCategory, string, string, Text?];

const tableOf = (rows: Row[]): Record<string, VendorCode> =>
  Object.fromEntries(rows.map(([code, category, zh, en, fix]) => [code, { category, reason: { zh, en }, ...(fix ? { fix } : {}) }]));

const PIXVERSE = tableOf([
  ["400011", "param", "参数为空", "Empty parameter"],
  ["400012", "auth", "无效账号", "Invalid account"],
  ["400013", "param", "无效绑定请求：参数类型或值错误", "Invalid binding request: incorrect parameter type or value"],
  ["400017", "param", "参数无效", "Invalid parameter"],
  ["400018", "param", "提示词超过长度限制", "Prompt length exceeds limit"],
  ["400019", "param", "提示词或负向提示词超过长度限制", "Prompt / negative prompt length exceeds limit"],
  ["400032", "media", "图片 ID 无效", "Invalid image ID"],
  ["500008", "notFound", "请求数据未找到", "Requested data not found"],
  ["500020", "permission", "当前账号无操作权限", "No permission"],
  ["500030", "media", "图片大小或分辨率超过限制", "Image size exceeded"],
  ["500031", "media", "获取图片信息失败", "Failed to retrieve image information"],
  ["500032", "media", "图片格式无效", "Invalid image format"],
  ["500033", "media", "图片宽度或高度无效", "Invalid image width or height"],
  ["500041", "media", "图片上传失败", "Image upload failed"],
  ["500042", "media", "图片路径无效", "Invalid image path"],
  ["500044", "rateLimit", "并发生成任务数已达上限", "Concurrent generation limit reached"],
  ["500054", "moderation", "内容审核未通过", "Content moderation failure"],
  ["500060", "rateLimit", "本月特效激活次数已达上限", "Monthly effects activation limit reached", {
    zh: "本月特效激活次数已用完：下月再试，或改用不带特效的生成",
    en: "This month's effect activations are used up: retry next month, or generate without the effect",
  }],
  ["500063", "moderation", "输入内容触发前置审核", "Pre-moderation failed"],
  ["500064", "notFound", "内容已被删除", "Content has been deleted"],
  ["500069", "busy", "系统负载过高", "High load"],
  ["500070", "param", "当前模板未激活", "Template not activated", {
    zh: "检查模板 ID（template_id）是否正确、是否已激活，或换一个模板",
    en: "Check that the template ID (template_id) is correct and activated, or use another template",
  }],
  ["500071", "param", "当前特效不支持指定分辨率", "Unsupported resolution for effect"],
  ["500090", "balance", "余额不足", "Insufficient balance"],
  ["500100", "busy", "服务内部错误", "Internal error"],
  ["10005", "auth", "API Key 缺失、无效、过期或已撤销", "apiKey is not registered (missing, invalid, expired or revoked)"],
  ["99999", "busy", "未知错误", "Unknown error"],
  // 平台侧按 PixVerse 格式返回的值
  ["400", "param", "平台侧参数校验未通过", "Platform-side parameter validation failed"],
  ["429", "rateLimit", "平台侧限流", "Platform-side rate limit"],
  // 生成期：Resp.status（不是 ErrCode，统一记成 status:<值>）
  ["status:7", "moderation", "生成内容审核未通过（Resp.status=7）", "Generated content failed moderation (Resp.status=7)"],
  ["status:8", "genFailed", "生成失败（Resp.status=8）", "Generation failed (Resp.status=8)"],
]);

const KLING = tableOf([
  ["1000", "auth", "身份验证失败", "Authentication failed"],
  ["1001", "auth", "身份验证失败：Authorization 为空", "Authentication failed: Authorization is empty"],
  ["1002", "auth", "身份验证失败：Authorization 值非法", "Authentication failed: invalid Authorization"],
  ["1003", "auth", "身份验证失败：Authorization 未到有效时间", "Authentication failed: Authorization not yet valid"],
  ["1004", "auth", "身份验证失败：Authorization 已失效", "Authentication failed: Authorization expired"],
  ["1100", "permission", "账户异常", "Account exception"],
  ["1101", "balance", "账户欠费（后付费场景）", "Account in arrears (postpaid)"],
  ["1102", "balance", "资源包已用完或已过期（预付费场景）", "Resource package used up or expired (prepaid)", {
    zh: "购买额外的资源包，或开通后付费（thcli models activate <模型ID>）",
    en: "Buy another resource package, or enable pay-as-you-go (thcli models activate <model-id>)",
  }],
  ["1103", "permission", "请求的资源无权限（如接口、模型）", "No permission for the requested resource (API or model)"],
  ["1200", "param", "请求参数非法", "Invalid request parameters"],
  ["1201", "param", "参数非法（key 写错或 value 非法；也可能是平台侧参数校验）", "Invalid parameter (wrong key or value; may also be platform-side validation)"],
  ["1202", "notFound", "请求的 method 无效", "Invalid request method"],
  ["1203", "notFound", "请求的资源不存在（如模型）", "Requested resource does not exist (e.g. model)"],
  ["1300", "ticket", "触发平台策略", "Platform policy triggered"],
  ["1301", "moderation", "触发内容安全策略", "Content safety policy triggered"],
  ["1302", "rateLimit", "请求过快，超过速率限制", "Requests too fast, rate limit exceeded"],
  ["1303", "rateLimit", "并发或 QPS 超出限制（也可能是平台侧限流）", "Concurrency or QPS limit exceeded (may also be platform-side rate limiting)"],
  ["1304", "ticket", "触发 IP 白名单策略", "IP whitelist policy triggered"],
  ["5000", "busy", "服务器内部错误", "Internal server error"],
  ["5001", "busy", "服务器暂时不可用（通常在维护）", "Server temporarily unavailable (usually maintenance)"],
  ["5002", "busy", "服务器内部超时（通常是任务积压）", "Server timeout (usually backlog)"],
]);

const VIDU = tableOf([
  ["BadRequest", "param", "不合法的请求", "Bad request"],
  ["FieldLacking", "param", "缺少字段（具体字段见错误信息）", "A field is missing or empty (see message)"],
  ["FieldUnwanted", "param", "传了不需要的字段（具体字段见错误信息）", "Unwanted field (see message)"],
  ["FieldItemCountOutOfRange", "param", "字段数量超限", "Field item count out of range"],
  ["FieldInvalid", "param", "参数未通过合法性校验（如提示词超长）", "Invalid field (e.g. prompt too long)"],
  ["Conflict", "param", "资源主键冲突", "Resource conflict"],
  ["PageSizeOutOfRange", "media", "图像尺寸有问题：需小于 50MB、格式 jpg/jpeg/png/webp、长宽比在 1:4~4:1 之间（跳舞特效 1:1.2~1:2）", "Image size out of range: <50MB, jpg/jpeg/png/webp, aspect ratio 1:4~4:1 (dance effect 1:1.2~1:2)"],
  ["ImageDownloadFailure", "media", "下载图片 URL 失败", "Failed to download the image URL"],
  ["ImageFormatInvalid", "media", "图像格式不符合要求", "Invalid image format"],
  ["ImageSizeInvalid", "media", "图片尺寸过大或过小", "Image size too large or too small"],
  ["ImageCheckBodyJointsFailed", "media", "输入图人体检测失败", "Body detection failed on the input image"],
  ["ImageCheckFaceFailed", "media", "输入图人脸检测失败", "Face detection failed on the input image"],
  ["ImageObjectsUndetected", "media", "输入图的人体或人脸有遮挡", "Body or face in the input image is occluded"],
  ["FaceDetectFailure", "media", "人脸检测失败", "Face detection failure"],
  ["FaceDetectNotPass", "media", "人脸检测不通过", "Face detection did not pass"],
  ["NoFaceDetected", "media", "检测不到人脸", "No face detected"],
  ["MultiFaceDetected", "media", "检测到多张人脸", "Multiple faces detected"],
  ["VideoDownloadFailure", "media", "视频下载失败", "Video download failure"],
  ["VideoFormatInvalid", "media", "视频格式错误", "Invalid video format"],
  ["TaskPromptPolicyViolation", "moderation", "提示词触发安全审核", "Prompt policy violation"],
  ["AuditSubmitIllegal", "moderation", "输入没有通过安全审核", "Input failed the safety review"],
  ["CreationPolicyViolation", "moderation", "生成物触发风控", "Generated content policy violation"],
  ["PhotoAuditNotPass", "moderation", "图片审核不通过", "Photo audit did not pass"],
  ["AuditFailed", "moderation", "审核失败", "Audit failed"],
  ["CreditInsufficient", "balance", "积分不足", "Insufficient credits"],
  ["Unauthorized", "auth", "未鉴权", "Unauthorized"],
  ["Forbidden", "permission", "请求没有权限", "Forbidden"],
  ["ModelUnavailable", "notFound", "请求的模型不可用", "Model unavailable"],
  ["TaskNotFound", "notFound", "任务 ID 不存在", "Task not found"],
  ["CreationNotFound", "notFound", "Creation ID 不存在", "Creation not found"],
  ["NotFound", "notFound", "请求资源不存在", "Not found"],
  ["QuotaExceeded", "rateLimit", "超过并发限制", "Concurrency quota exceeded"],
  ["TooManyRequests", "rateLimit", "请求太频繁", "Too many requests"],
  ["SystemThrottling", "rateLimit", "资源超过限制", "System is throttling"],
  ["OperationInProcess", "busy", "请求处理中", "Operation in process, please retry later"],
  ["InternalServiceFailure", "busy", "服务器内部错误", "Internal service failure"],
  ["Unknown", "busy", "未知原因", "Unknown"],
  ["UserCancelled", "cancelled", "用户手动终止了任务", "Task cancelled by the user"],
  ["Canceled", "cancelled", "请求被取消", "Request canceled by client"],
]);

const MINIMAX = tableOf([
  ["1000", "busy", "未知错误 / 系统默认错误", "Unknown error / system default error"],
  ["1001", "busy", "请求超时", "Request timeout"],
  ["1002", "rateLimit", "请求频率超限（也可能是平台侧限流）", "Rate limit exceeded (may also be platform-side rate limiting)"],
  ["1004", "auth", "未授权 / Token 不匹配", "Unauthorized / token mismatch"],
  ["1008", "balance", "余额不足", "Insufficient balance"],
  ["1024", "busy", "内部错误", "Internal error"],
  ["1026", "moderation", "输入内容涉敏", "Sensitive input content"],
  ["1027", "moderation", "输出内容涉敏", "Sensitive output content"],
  ["1033", "busy", "系统错误 / 下游服务错误", "System / downstream service error"],
  ["1039", "param", "Token 限制", "Token limit", { zh: "调小 max_tokens 或缩短输入", en: "Lower max_tokens or shorten the input" }],
  ["1041", "ticket", "连接数限制", "Connection limit"],
  ["1042", "param", "不可见字符比例超限（非法字符超过 10%）", "Too many invisible / illegal characters (over 10%)", {
    zh: "检查输入里是否混入不可见字符或非法字符",
    en: "Check the input for invisible or illegal characters",
  }],
  ["2013", "param", "参数错误（也可能是平台侧参数校验）", "Invalid parameters (may also be platform-side validation)"],
  ["2045", "rateLimit", "请求频率增长超限", "Request rate growth limit exceeded", {
    zh: "避免请求量骤增骤减，平滑地提升请求频率",
    en: "Avoid sudden spikes and drops in request volume; ramp up gradually",
  }],
  ["2049", "auth", "无效的 API Key", "Invalid API key"],
  ["2056", "rateLimit", "超出 Token Plan 资源限制", "Token Plan resource limit exceeded", {
    zh: "等下一个时间段资源释放后再试",
    en: "Wait for resources to be released in the next period, then retry",
  }],
]);

const MINIMAX_H3 = tableOf([
  ["invalid_request_error", "param", "请求参数不合法（平台侧，HTTP 400）", "Invalid request (platform side, HTTP 400)"],
  ["rate_limit_error", "rateLimit", "请求频率超限（平台侧，HTTP 429）", "Rate limit exceeded (platform side, HTTP 429)"],
  ["insufficient_balance_error", "balance", "余额不足（HTTP 402）", "Insufficient balance (HTTP 402)"],
  ["authentication_error", "auth", "鉴权失败（HTTP 401 / 403）", "Authentication failed (HTTP 401 / 403)"],
  ["internal_error", "busy", "内部错误（厂商未返回具体错误码时也用这个值兜底）", "Internal error (also the fallback when the vendor returns no code)"],
]);

const TABLES: Record<VendorId, Record<string, VendorCode>> = {
  pixverse: PIXVERSE,
  kling: KLING,
  vidu: VIDU,
  minimax: MINIMAX,
  "minimax-h3": MINIMAX_H3,
};

const textOf = (x: Text): string => (lang() === "zh" ? x.zh : x.en);

/** 一个厂商错误码的说明；未收录返回 undefined */
export interface VendorErrorInfo {
  vendor: VendorId;
  code: string;
  category: VendorErrorCategory;
  reason: string;
  fix: string;
}

export function lookupVendorError(vendor: VendorId, code: string): VendorErrorInfo | undefined {
  const table = TABLES[vendor];
  const key = table[code] ? code : Object.keys(table).find((k) => k.toLowerCase() === code.toLowerCase());
  const entry = key ? table[key] : undefined;
  if (!entry || !key) return undefined;
  return {
    vendor,
    code: key,
    category: entry.category,
    reason: textOf(entry.reason),
    fix: entry.fix ? textOf(entry.fix) : t(`vendor.fix.${entry.category}`),
  };
}

/** 全部厂商里同一个码的说明（码在不同厂商可能同值，如 Kling 与 MiniMax 的 1002） */
export function findVendorErrors(code: string): VendorErrorInfo[] {
  return VENDORS.map((v) => lookupVendorError(v, code)).filter((x): x is VendorErrorInfo => Boolean(x));
}

/** 某厂商收录的全部码 */
export function vendorCodes(vendor: VendorId): string[] {
  return Object.keys(TABLES[vendor]);
}

/** 从响应里取到的厂商错误 */
export interface VendorErrorHit {
  vendor: VendorId;
  /** 厂商错误码；生成期失败而厂商没给码时为空 */
  code?: string;
  /** 厂商原文 */
  message?: string;
}

type Obj = Record<string, unknown>;

const strOf = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const codeOf = (v: unknown): string | undefined =>
  typeof v === "number" ? String(v) : typeof v === "string" && v.trim() ? v.trim() : undefined;
const isOk = (v: unknown): boolean => v === undefined || v === null || v === "" || Number(v) === 0;
const objOf = (v: unknown): Obj | undefined => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : undefined);

/**
 * 按厂商格式从响应体里找错误（提交期的错误信封、生成期的失败任务）。没有错误返回 undefined。
 * 平台自己的 {"error":{"code":"401002",...}} 不在这里认，交给网关错误码表。
 */
export function extractVendorError(vendor: VendorId, body: unknown): VendorErrorHit | undefined {
  const resp = objOf(body);
  if (!resp) return undefined;
  switch (vendor) {
    case "pixverse": {
      if (!isOk(resp["ErrCode"])) return { vendor, code: codeOf(resp["ErrCode"]), message: strOf(resp["ErrMsg"]) };
      const status = Number(objOf(resp["Resp"])?.["status"]);
      if (status === 7 || status === 8) return { vendor, code: `status:${status}` };
      return undefined;
    }
    case "kling": {
      if (!isOk(resp["code"])) return { vendor, code: codeOf(resp["code"]), message: strOf(resp["message"]) };
      const data = resp["data"];
      const item = objOf(Array.isArray(data) ? data[0] : data);
      const status = String(item?.["status"] ?? item?.["task_status"] ?? "").toLowerCase();
      if (item && status === "failed") {
        return { vendor, message: strOf(item["task_status_msg"]) ?? strOf(item["message"]) };
      }
      return undefined;
    }
    case "vidu": {
      const code = strOf(resp["err_code"]);
      return code ? { vendor, code } : undefined;
    }
    case "minimax": {
      const base = objOf(resp["base_resp"]);
      if (base && !isOk(base["status_code"])) return { vendor, code: codeOf(base["status_code"]), message: strOf(base["status_msg"]) };
      return undefined;
    }
    case "minimax-h3": {
      // 平台侧：顶层 error 只有 type / message（带 code 的是网关自己的错误，不在这里认）
      const top = objOf(resp["error"]);
      if (top && top["code"] === undefined && strOf(top["type"])) return { vendor, code: strOf(top["type"]), message: strOf(top["message"]) };
      const taskError = objOf(objOf(resp["task"])?.["error"]);
      if (taskError) return { vendor, code: codeOf(taskError["code"]), message: strOf(taskError["message"]) };
      return undefined;
    }
  }
}

/** 根因在 Key / 账号权限的类别：附 doctor model 诊断命令 */
const DIAGNOSABLE_CATEGORIES = new Set<VendorErrorCategory>(["auth", "permission"]);

/**
 * 按报错原文匹配的处理建议：错误码太笼统（如 Kling 1201「参数非法」、任务失败没有错误码）时，
 * 原文里的关键句才能指向具体操作。命中则优先于错误码表的建议。
 */
const MESSAGE_FIXES: Array<{ vendor: VendorId; pattern: RegExp; zh: string; en: string }> = [
  {
    vendor: "kling",
    pattern: /PAR should be 1:1/i,
    zh: "参考视频的像素宽高比（SAR）须严格为 1:1（接近 1:1 也不行，如 12800:12803）。先转码再上传：ffmpeg -i in.mp4 -vf setsar=1 -c:a copy out.mp4（查看：ffprobe -v error -select_streams v:0 -show_entries stream=sample_aspect_ratio -of csv=p=0 in.mp4）",
    en: "The reference video needs a sample aspect ratio (SAR) of exactly 1:1 (close values such as 12800:12803 are rejected). Re-encode before uploading: ffmpeg -i in.mp4 -vf setsar=1 -c:a copy out.mp4 (check: ffprobe -v error -select_streams v:0 -show_entries stream=sample_aspect_ratio -of csv=p=0 in.mp4)",
  },
];

/** 报错原文命中的处理建议（没有命中返回 undefined） */
export function messageFixOf(vendor: VendorId, message: string | undefined): string | undefined {
  if (!message) return undefined;
  const hit = MESSAGE_FIXES.find((x) => x.vendor === vendor && x.pattern.test(message));
  return hit ? textOf(hit) : undefined;
}

/**
 * 厂商错误的展示行：厂商原文、厂商错误码 + 说明、修复建议（已收录时）、诊断命令（鉴权 / 权限类）、Request ID。
 */
export function vendorErrorLines(hit: VendorErrorHit, requestId: string | undefined, diagnose?: string): string[] {
  const info = hit.code ? lookupVendorError(hit.vendor, hit.code) : undefined;
  const name = VENDOR_NAMES[hit.vendor];
  const lines: string[] = [];
  const detail = hit.message ?? info?.reason;
  if (detail) lines.push(t("chat.errorDetail", { detail }));
  if (hit.code) {
    lines.push(`  ${info ? t("vendor.code", { vendor: name, code: hit.code, reason: info.reason }) : t("vendor.codeUnknown", { vendor: name, code: hit.code })}`);
  }
  lines.push(`  ${t("error.fix", { fix: messageFixOf(hit.vendor, hit.message) ?? info?.fix ?? t("vendor.fix.unknown") })}`);
  if (diagnose && info && DIAGNOSABLE_CATEGORIES.has(info.category)) lines.push(`  ${t("error.diagnose", { cmd: diagnose })}`);
  if (!info && hit.code) lines.push(`  ${t("vendor.lookupHint", { vendor: hit.vendor })}`);
  lines.push(`Request ID: ${requestId ?? "-"}`);
  return lines;
}

// ── 平台网关错误在 +gen 场景下的补充 ──

/** +gen 的调用场景：在平台场景（diagnose）之外，补上模型、厂商与响应头信息 */
export interface GenErrorScene extends GatewayErrorScene {
  /** +gen 调用的模型（401007/401008 直接给 models activate <模型>，用户手上没有 ep ID） */
  genModel?: string;
  /** 模型厂商：平台没给业务码时按厂商格式解析（PixVerse ErrCode / Kling code / MiniMax base_resp 等） */
  vendor?: VendorId;
  /** 限流响应头 Retry-After（秒） */
  retryAfter?: string;
  /** HTTP 状态码（上游错误时展示 upstream_status 缺省用它） */
  status?: number;
}

/** +gen 场景下改给的修复建议：码 → locales 键 */
const GEN_FIX_KEY: Record<string, string> = {
  "401007": "errcode.401007.fixGen",
  "401008": "errcode.401008.fixGen",
};

/** 该码在 +gen 调用下的修复建议；不随场景变化的码返回 undefined */
export function genFixOf(code: string, model: string): string | undefined {
  const key = GEN_FIX_KEY[code];
  return key ? t(key, { model }) : undefined;
}

/**
 * +gen 的错误展示行。平台没给业务码、但响应是厂商格式时，按厂商错误码表展示；
 * 否则走平台展示（errors.ts 的 gatewayErrorLines），并在扩展点补上：
 *   - 修复建议：报错原文能对上具体处理办法（如 Kling「PAR should be 1:1」）时优先，其次 +gen 场景的建议
 *   - 上游码（source=upstream 时透传的厂商原始码）及其厂商说明、Retry-After
 */
export function genErrorLines(body: Record<string, unknown> | string, requestId: string | undefined, scene: GenErrorScene = {}): string[] {
  if (!extractBusinessCode(body) && scene.vendor && typeof body !== "string") {
    const hit = extractVendorError(scene.vendor, body);
    if (hit) {
      const lines = vendorErrorLines(hit, requestId, scene.diagnose);
      // 厂商路径同样保留限流提示（与下方网关路径的 retryAfter 一致）
      if (scene.retryAfter) lines.push(`  ${t("gen.retryAfter", { seconds: scene.retryAfter })}`);
      return lines;
    }
  }
  const messageFix = scene.vendor ? messageFixOf(scene.vendor, extractErrorDetail(body)) : undefined;
  return gatewayErrorLines(body, requestId, scene, {
    fix: (code, fix) => messageFix ?? (scene.genModel ? genFixOf(code, scene.genModel) : undefined) ?? fix,
    extraLines: (fixShown) => {
      const lines: string[] = [];
      const error = typeof body === "string" ? undefined : (body["error"] as Obj | undefined);
      const upstreamCode = error?.["upstream_code"];
      if (upstreamCode !== undefined && upstreamCode !== null && upstreamCode !== "") {
        lines.push(`  ${t("gen.upstreamCode", { code: String(upstreamCode), status: String(error?.["upstream_status"] ?? scene.status ?? "-") })}`);
        const info = scene.vendor ? lookupVendorError(scene.vendor, String(upstreamCode)) : undefined;
        if (info) {
          lines.push(`  ${t("vendor.code", { vendor: VENDOR_NAMES[info.vendor], code: info.code, reason: info.reason })}`);
          if (!fixShown) lines.push(`  ${t("error.fix", { fix: messageFix ?? info.fix })}`);
          fixShown = true;
        }
      }
      if (messageFix && !fixShown) lines.push(`  ${t("error.fix", { fix: messageFix })}`);
      if (scene.retryAfter) lines.push(`  ${t("gen.retryAfter", { seconds: scene.retryAfter })}`);
      return lines;
    },
  });
}
