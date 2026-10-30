/**
 * doctor 命令组：只读体检与诊断。不改任何资源。
 */
import { Command } from "commander";
import { isIP } from "node:net";

import { buildClient } from "../core/client.js";
import { allowedRegions, allowedSites, areaCloudRegion, cloudRegionArea, DEFAULT_REGION } from "../core/config.js";
import {
  mask,
  parseGlobalArgs,
  resolveProfile,
  resolveSite,
  type GlobalArgs,
} from "../core/credentials.js";
import { DEFAULT_ALIAS, loadDataConfig, resolveRegionKey } from "../core/keystore.js";
import { CLOUD_CODES, ERROR_CODES, GATEWAY_CODES, lookupError } from "../core/errors.js";
import { apiSupportsModel, APIS } from "../core/gen-registry.js";
import { listDataPlaneKeys } from "../core/provision.js";
import { keyCoversModel, quotaExhausted, serviceCheck, type ServiceCheck } from "../core/gen-check.js";
import { matchesMasked } from "../core/agent/key-picker.js";
import { findVendorErrors, genFixOf, lookupVendorError, vendorCodes, VENDOR_NAMES, VENDORS, type VendorErrorInfo, type VendorId } from "../core/gen-errors.js";
import { human, pad, stopReasonAdvice } from "../core/format.js";
import { emitJson, emitJsonSafe, isJson } from "../core/output.js";
import { t } from "../core/i18n.js";
import { formatTokenSummary } from "../core/plan-format.js";

function checkCredential(globals: GlobalArgs): void {
  const cred = parseGlobalArgs(globals);
  if (cred.source === "none") {
    console.log(t("doctor.cred.none"));
    return;
  }
  if (cred.raw.type === "oauth" && cred.raw.expiresAt) {
    const remaining = cred.raw.expiresAt - Date.now() / 1000;
    if (remaining <= 0) {
      console.log(
        t("doctor.cred.expired", { when: new Date(cred.raw.expiresAt * 1000).toLocaleString() }),
      );
      return;
    }
  }
  console.log(
    t("doctor.cred.ok", {
      source: cred.source,
      profile: cred.profile,
      site: cred.site,
      secretId: mask(cred.secretId),
      type: cred.raw.type ?? "-",
    }),
  );
}

function checkSiteRegion(globals: GlobalArgs): void {
  const site = resolveSite(globals);
  if (!allowedSites().includes(site)) {
    console.log(t("doctor.site.bad", { site, options: allowedSites().join(", ") }));
    return;
  }
  console.log(t("doctor.site.ok", { site, regions: allowedRegions(site).join(", ") }));
}

async function checkControlPlane(globals: GlobalArgs): Promise<void> {
  try {
    const client = buildClient(globals);
    await client.call("DescribeApiKeyList", { Platform: "maas", Limit: 1 });
    console.log(t("doctor.api.ok"));
  } catch (err) {
    console.log(t("doctor.api.fail", { message: (err as Error).message }));
  }
}

function checkDataPlaneKey(globals: GlobalArgs): void {
  const profile = resolveProfile(globals);
  const site = resolveSite(globals);
  try {
    const key = resolveRegionKey(loadDataConfig(profile), site, DEFAULT_REGION, "th");
    if (key) {
      console.log(t("doctor.key.ok", { scope: `${site}/${DEFAULT_REGION}/th`, masked: mask(key) }));
    } else {
      console.log(
        t("doctor.key.missing", { scope: `${site}/${DEFAULT_REGION}/th` }),
      );
    }
  } catch (err) {
    console.log(t("doctor.key.readFail", { message: (err as Error).message }));
  }
}

/**
 * 体检各项的结构化结论，供 --json 用。
 *
 * 文本模式下每项检查直接打印人类可读结论；JSON 模式则要把同样的判断表达成
 * ok/detail，让调用方不必解析文案。两者共用同一份判断逻辑，避免结论分叉。
 */
function collectChecks(globals: GlobalArgs): Record<string, unknown> {
  const cred = parseGlobalArgs(globals);
  const site = resolveSite(globals);
  const profile = resolveProfile(globals);

  const credOk =
    cred.source !== "none" &&
    !(cred.raw.type === "oauth" && cred.raw.expiresAt && cred.raw.expiresAt - Date.now() / 1000 <= 0);

  let dataKey: string | undefined;
  let dataKeyError: string | undefined;
  try {
    dataKey = resolveRegionKey(loadDataConfig(profile), site, DEFAULT_REGION, "th");
  } catch (err) {
    dataKeyError = (err as Error).message;
  }

  return {
    Credential: {
      Ok: credOk,
      Source: cred.source,
      Profile: cred.profile,
      Site: cred.site,
      SecretId: mask(cred.secretId),
      Type: cred.raw.type ?? null,
      ExpiresAt: cred.raw.expiresAt ?? null,
    },
    SiteRegion: {
      Ok: allowedSites().includes(site),
      Site: site,
      AllowedRegions: allowedSites().includes(site) ? allowedRegions(site) : [],
    },
    DataPlaneKey: {
      Ok: Boolean(dataKey),
      Scope: `${site}/${DEFAULT_REGION}/th`,
      ApiKey: dataKey ? mask(dataKey) : null,
      Error: dataKeyError ?? null,
    },
  };
}

async function allCommand(globals: GlobalArgs): Promise<void> {
  if (isJson()) {
    // 管控面连通性要真发一次请求，单独测，不能只看本地状态
    const checks = collectChecks(globals);
    let apiOk = true;
    let apiError: string | null = null;
    try {
      await buildClient(globals).call("DescribeApiKeyList", { Platform: "maas", Limit: 1 });
    } catch (err) {
      apiOk = false;
      apiError = (err as Error).message;
    }
    emitJson({ ...checks, ControlPlane: { Ok: apiOk, Error: apiError } });
    return;
  }

  console.log(t("doctor.all.title", { site: resolveSite(globals) }));
  console.log("");
  checkCredential(globals);
  checkSiteRegion(globals);
  await checkControlPlane(globals);
  checkDataPlaneKey(globals);
  console.log("");
  console.log(
    t("doctor.all.footer"),
  );
}

// ── +gen 模型诊断（doctor model 对 +gen 模型追加）──
// +gen 只走按量（th Key），沿请求链路逐项确认：模型未下线 → 接入点在运行 → 能计费（免费额度 / 后付费）
// → 本地有对应地域 / 别名的 Key → 这把 Key 在云端启用、范围含该模型、额度未用完。给出可用的 +gen 接口写法或补齐步骤。

type Row = Record<string, unknown>;

/**
 * 本地按量 Key 在云端的状态：
 * ok 可用 / missing 本地没配 / disabled 已停用 / noScope 范围不含该模型 / quotaExceeded 额度用完或停用 /
 * notMatched 云端列表里对不上（已删除或属于其他账号） / ambiguous 打码形式撞上多把 / error 查询失败
 */
type KeyState = "ok" | "missing" | "disabled" | "noScope" | "quotaExceeded" | "notMatched" | "ambiguous" | "error";

type KeyCheck = { Scope: string; State: KeyState; KeyId?: string; Name?: string; Error?: string; Targets?: string[] };

/** doctor model 选项 */
interface ModelCheckOptions {
  id: string;
}

/** +gen 模型诊断的结论（JSON 输出的 GenRoute 即此结构） */
interface GenRouteResult {
  /** 该模型对应的 +gen 接口 */
  GenApis: string[];
  /** 服务侧：模型状态、接入点、计费 */
  Service: ServiceCheck;
  /** 本地按量 Key 在云端的状态 */
  Key: KeyCheck;
  /** 推荐的 +gen 调用写法（每个接口一条）；有阻断问题时为空 */
  Recommend: string[];
  /** 补齐配置的步骤 */
  Hints: string[];
}

/** genRoute 的输入：doctor model 已查好的模型与接入点，及同地域的云 API 客户端（不重复查） */
interface GenRouteInput {
  model: string;
  genApis: string[];
  /** 按量诊断的数据面地域（由 --region 反查，默认 gz） */
  area: string;
  /** 模型状态；undefined 表示该地域查不到模型 */
  modelStatus: string | undefined;
  endpoints: Row[];
  client: ReturnType<typeof buildClient>;
}

/**
 * 本地按量 Key 对上云端那把再检查：按打码形式的前后缀比对，不取明文；
 * 撞上多把（极少见）时不猜，报 ambiguous。
 */
async function checkPaygKey(input: GenRouteInput, globals: GlobalArgs, localKey: string, endpointIds: string[]): Promise<Omit<KeyCheck, "Scope">> {
  try {
    const matches = (await listDataPlaneKeys(globals, input.area)).filter((k) => matchesMasked(k.ApiKey, localKey));
    if (!matches.length) return { State: "notMatched" };
    if (matches.length > 1) return { State: "ambiguous" };
    const key = matches[0]! as unknown as Row;
    // 部分绑定时带上现有目标：范围不够时的 key scope 命令要全量覆盖，提示里直接带齐
    const targets = Array.isArray(key["BindingItems"]) ? (key["BindingItems"] as Row[]).map((b) => String(b["ResourceId"] ?? "")).filter(Boolean) : [];
    const base = { KeyId: String(key["ApiKeyId"] ?? ""), Name: String(key["Name"] ?? ""), Targets: targets };
    if (String(key["Status"] ?? "") !== "enable") return { ...base, State: "disabled" };
    if (!keyCoversModel(key, input.model, endpointIds)) return { ...base, State: "noScope" };
    const detailResp = await input.client.call("DescribeApiKey", { Platform: "maas", ApiKeyId: base.KeyId });
    // 详情里带明文，只取额度字段，不保留、不输出
    const detail = (detailResp["ApiKeyInfo"] ?? detailResp) as Row;
    return { ...base, State: quotaExhausted(detail) ? "quotaExceeded" : "ok" };
  } catch (err) {
    return { State: "error", Error: (err as Error).message };
  }
}

/**
 * +gen 模型诊断：按量是否已开后付费、本地按量 Key（{area}/default，area 由 --region 反查、默认 gz，
 * 与 +gen / +chat 不传 --area 时取 Key 的默认规则一致）在云端能否调它，给出推荐写法与补齐步骤。
 * 全程只读，不发模型调用。
 */
async function genRoute(input: GenRouteInput, globals: GlobalArgs): Promise<GenRouteResult> {
  const { model, genApis, area, modelStatus, endpoints } = input;
  const site = resolveSite(globals);
  const alias = DEFAULT_ALIAS;
  const scope = `${site}/${area}/th/${alias}`;
  const service = serviceCheck(model, modelStatus, endpoints);
  const endpointIds = endpoints.map((e) => String(e["EndpointId"] ?? "")).filter(Boolean);

  let key: KeyCheck;
  try {
    const localKey = resolveRegionKey(loadDataConfig(resolveProfile(globals)), site, area, "th", alias);
    key = { Scope: scope, ...(localKey ? await checkPaygKey(input, globals, localKey, endpointIds) : { State: "missing" as const }) };
  } catch (err) {
    key = { Scope: scope, State: "error", Error: (err as Error).message };
  }

  // 推荐：服务侧可调，且本地 Key 没有确定的阻断问题（对不上 / 查询失败只提示、不拦推荐）
  const keyBlocks = key.State === "missing" || key.State === "disabled" || key.State === "noScope" || key.State === "quotaExceeded";
  const recommend =
    service.State === "ok" && !keyBlocks ? genApis.map((ep) => `thcli +gen ${ep} --model ${model}`) : [];

  const hints = serviceHints(service, model, area);
  // 模型查不到 / 已下线时，Key 范围 / 额度提示没有意义（提示里的模型本身就不可调）
  if (service.State !== "notFound" && service.State !== "offline") {
    const keyHint: Partial<Record<KeyState, string>> = {
      missing: t("doctor.route.hint.thKey", { area, alias }),
      disabled: t("doctor.route.hint.keyDisabled", { id: key.KeyId ?? "" }),
      noScope: t("doctor.route.hint.keyScope", { id: key.KeyId ?? "", targets: [...(key.Targets ?? []), model].join(",") }),
      quotaExceeded: t("doctor.route.hint.keyQuota", { id: key.KeyId ?? "" }),
      notMatched: t("doctor.route.hint.keyNotMatched", { region: areaCloudRegion(area) }),
    };
    if (keyHint[key.State]) hints.push(keyHint[key.State]!);
  }
  return { GenApis: genApis, Service: service, Key: key, Recommend: recommend, Hints: hints };
}

/** 停止原因属于计费（没有免费包 / 免费额度用完）时，开后付费即可恢复 */
const BILLING_STOP_REASONS = new Set(["NO_FREE_PACKAGE", "FREE_QUOTA_EXHAUSTED"]);

/** 服务侧阻断项的补齐步骤；预下线额外提示迁移 */
function serviceHints(s: ServiceCheck, model: string, area: string): string[] {
  const activate = t("doctor.route.hint.activate", { model });
  const hints: string[] = [];
  switch (s.State) {
    case "notFound":
      // 该地域没有这个模型（如 sg 未上线）：提示换地域，否则用户只看到「查不到」不知道下一步
      hints.push(t("doctor.route.hint.notFoundArea", { model, area }));
      break;
    case "offline":
      hints.push(t("doctor.route.hint.offline", { model }));
      break;
    case "noEndpoint":
    case "noBilling":
      hints.push(activate);
      break;
    case "notReady": {
      // VIRTUAL：平台预置但未开通，开后付费即转为可用；计费类停止原因同理；其他原因按 stopReason 给建议
      const id = s.EndpointId ?? "";
      const reason = s.StopReason ?? "";
      if (s.EndpointStatus === "VIRTUAL" || BILLING_STOP_REASONS.has(reason)) hints.push(activate);
      else hints.push((reason && stopReasonAdvice(reason, id)) || t("doctor.route.hint.endpointNotReady", { id, status: s.EndpointStatus ?? "" }));
      break;
    }
  }
  if (s.ModelStatus === "pre-offline") hints.push(t("doctor.route.hint.preOffline", { model }));
  return hints;
}

function modelStatusText(s: ServiceCheck): string {
  if (s.State === "notFound") return t("doctor.route.model.notFound");
  if (s.State === "offline") return t("doctor.route.model.offline", { status: s.ModelStatus ?? "" });
  if (s.ModelStatus === "pre-offline") return t("doctor.route.model.preOffline");
  return t("doctor.route.model.ok", { status: s.ModelStatus || "-" });
}

function endpointText(s: ServiceCheck): string {
  if (s.State === "noEndpoint") return t("doctor.route.endpoint.none");
  const vars = { id: s.EndpointId ?? "", status: s.EndpointStatus ?? "", reason: s.StopReason ? `, ${s.StopReason}` : "" };
  return t(s.State === "notReady" ? "doctor.route.endpoint.notReady" : "doctor.route.endpoint.ok", vars);
}

function billingText(s: ServiceCheck): string {
  if (s.Billing === "postpaid") return t("doctor.route.billing.postpaid");
  if (s.Billing === "free" && s.FreeQuota) {
    const { Used, Total, ExpireTime } = s.FreeQuota;
    return t("doctor.route.billing.free", { left: (Total - Used).toLocaleString(), total: Total.toLocaleString(), expire: ExpireTime?.slice(0, 10) ?? "-" });
  }
  return t("doctor.route.billing.none");
}

function printGenRoute(r: GenRouteResult): void {
  const { Service: s, Key: key } = r;
  const keyText = t(`doctor.route.key.${key.State}`, { name: key.Name || t("agent.key.unnamed"), id: key.KeyId ?? "", message: key.Error ?? "" });
  console.log(t("doctor.route.title"));
  console.log(`   ${t("doctor.route.row.apis")}${r.GenApis.join(", ")}`);
  console.log(`   ${t("doctor.route.row.model")}${modelStatusText(s)}`);
  // 链路上靠后的环节只在前面通过时才有意义：查不到 / 已下线就不再列接入点，接入点没运行就不再列计费
  if (s.State !== "notFound" && s.State !== "offline") console.log(`   ${t("doctor.route.row.endpoint")}${endpointText(s)}`);
  if (s.State === "ok" || s.State === "noBilling") console.log(`   ${t("doctor.route.row.billing")}${billingText(s)}`);
  console.log(`   ${t("doctor.route.row.thKey", { scope: key.Scope })}${keyText}`);
  if (r.Recommend.length) {
    console.log(t("doctor.route.recommendHeader"));
    for (const cmd of r.Recommend) console.log(`   ${cmd}`);
    if (r.Hints.length) console.log(t("doctor.route.alsoNote"));
  } else {
    console.log(t("doctor.route.none"));
  }
  for (const hint of r.Hints) console.log(`   - ${hint}`);
}

/**
 * 取本机出口公网 IP，用于比对 Key 的 IP 白名单。
 *
 * 这会向第三方服务（ipify.org）发一次请求——云 API 没有"查我的出口 IP"这类接口，
 * 而白名单校验必须知道出口 IP 才能给出有用的结论。调用前先告知用户，别偷偷外发：
 * 出口 IP 虽不算机密，但把它送去哪里应当由用户看得见。
 */
async function egressIp(): Promise<string | undefined> {
  console.log(t("doctor.keyCheck.ipLookupNotice"));
  try {
    const resp = await fetch("https://api.ipify.org?format=json", {
      signal: AbortSignal.timeout(5000),
    });
    const body = (await resp.json()) as { ip?: string };
    return body.ip;
  } catch {
    return undefined;
  }
}

/** 判断 ip 是否落在 entry（单 IP 或 CIDR）内 */
function ipMatches(ip: string, entry: string): boolean {
  if (!entry.includes("/")) {
    return ip === entry;
  }
  const [network, bitsRaw] = entry.split("/");
  const bits = Number(bitsRaw);
  if (!network || isIP(network) !== 4 || isIP(ip) !== 4 || Number.isNaN(bits)) {
    // IPv6 或格式异常时不做判断，交给上层按"无法确定"处理
    return false;
  }
  const toInt = (addr: string): number =>
    addr.split(".").reduce((acc, part) => (acc << 8) + Number(part), 0) >>> 0;
  const maskBits = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (toInt(ip) & maskBits) === (toInt(network) & maskBits);
}

async function keyCommand(opts: Record<string, string>, globals: GlobalArgs): Promise<void> {
  if (!opts["id"]) throw new Error(t("arg.missing", { command: "doctor key", args: "--id" }));
  const client = buildClient(globals);
  const resp = await client.call("DescribeApiKey", { Platform: "maas", ApiKeyId: opts["id"] });
  const key = (resp["ApiKeyInfo"] ?? resp) as Record<string, unknown>;

  if (emitJsonSafe(key)) return;

  const status = String(key["Status"] ?? "");
  console.log(
    status === "enable"
      ? t("doctor.keyCheck.statusOk")
      : t("doctor.keyCheck.statusBad", { status, id: opts["id"] }),
  );
  const bindType = String(key["BindType"] ?? "-");
  const bindings = (key["BindingItems"] as Array<Record<string, unknown>> | undefined) ?? [];
  if (bindType === "all") {
    console.log(t("doctor.keyCheck.scopeAll"));
  } else if (!bindings.length) {
    console.log(
      t("doctor.keyCheck.scopeEmpty", { bindType }),
    );
  } else {
    // 绑定的资源自身可能已下线，这种 Key 看着正常却调不通，值得单独指出
    const offline = bindings.filter((b) => String(b["Status"] ?? "").toLowerCase() !== "online");
    if (offline.length) {
      const names = offline.map((b) => String(b["ResourceId"])).join(", ");
      console.log(
        t("doctor.keyCheck.scopeOffline", { bindType, count: bindings.length, offline: offline.length, names }),
      );
    } else {
      console.log(t("doctor.keyCheck.scopeOk", { bindType, count: bindings.length }));
    }
  }

  // 额度是最常见的"看着正常却调不通"根因，必须逐条比对已用/总量
  const quotas = (key["QuotaSet"] as Array<Record<string, unknown>> | undefined) ?? [];
  const quotaStatus = String(key["QuotaStatus"] ?? "");
  if (!quotas.length) {
    console.log(t("doctor.keyCheck.quotaNone"));
  } else {
    for (const q of quotas) {
      const used = Number(q["CycleUsed"] ?? 0);
      const total = Number(q["CycleCredits"] ?? 0);
      const percent = total > 0 ? ((used / total) * 100).toFixed(2) : "-";
      const unit = String(q["CycleUnit"] ?? "");
      const cycle = t(`key.cycle.${unit}`).startsWith("key.cycle.") ? unit : t(`key.cycle.${unit}`);
      const detail = `${cycle} ${used.toLocaleString()}/${total.toLocaleString()} tokens（${percent}%）`;
      if (total > 0 && used >= total) {
        console.log(
          t("doctor.keyCheck.quotaExceeded", { detail, id: opts["id"] }),
        );
      } else {
        console.log(t("doctor.keyCheck.quotaOk", { detail }));
      }
    }
    if (quotaStatus === "inactive") {
      console.log(t("doctor.keyCheck.quotaInactive"));
    }
  }

  const whitelist = (key["IpWhitelist"] as string[] | undefined) ?? [];
  if (!whitelist.length) {
    console.log(t("doctor.keyCheck.ipNone"));
    return;
  }
  const ip = await egressIp();
  if (!ip) {
    console.log(t("doctor.keyCheck.ipUnknown", { list: whitelist.join(", ") }));
    return;
  }
  if (whitelist.some((entry) => ipMatches(ip, entry))) {
    console.log(t("doctor.keyCheck.ipHit", { ip }));
  } else {
    console.log(
      t("doctor.keyCheck.ipMiss", { ip, list: whitelist.join(", "), id: opts["id"] }),
    );
  }
}

async function endpointCommand(opts: Record<string, string>, globals: GlobalArgs): Promise<void> {
  if (!opts["id"]) throw new Error(t("arg.missing", { command: "doctor endpoint", args: "--id" }));
  const client = buildClient(globals);
  const resp = await client.call("DescribeEndpoint", { EndpointId: opts["id"] });
  const e = (resp["Endpoint"] ?? resp) as Record<string, unknown>;

  if (emitJson(e)) return;

  console.log(
    t("doctor.endpointCheck.header", {
      name: e["EndpointName"] ?? "",
      id: e["EndpointId"] ?? "",
      status: e["Status"] ?? "",
      chargeType: e["ChargeType"] ?? "-",
      postpaid: e["PaymentEnabled"] ? "on" : "off",
    }),
  );
  const status = String(e["Status"] ?? "").toUpperCase();
  if (status === "ACTIVE" || status === "RUNNING") {
    console.log(t("doctor.endpointCheck.running"));
    return;
  }
  const reason = String(e["StopReason"] ?? "");
  const advice =
    stopReasonAdvice(reason, String(e["EndpointId"] ?? "")) ||
    t("doctor.endpointCheck.adviceFallback");
  console.log(
      t("doctor.endpointCheck.stopped", {
        reason: reason || t("doctor.endpointCheck.reasonUnknown"),
        advice,
      }),
    );
}

/**
 * 诊断模型：是否存在、有无可用接入点；若是 +gen 模型，再追加按量调用诊断（后付费 / 本地按量 Key /
 * 推荐的 +gen 写法）。
 *
 * 云 API 地域统一由全局 --region 决定（两类模型同一语义）；+gen 按量诊断的数据面地域由 --region
 * 反查得出（ap-guangzhou→gz、ap-singapore→sg，默认 gz），与 +gen / +chat 的 --area 一一对应：
 * 用 +gen --area sg / +chat --area sg 调用的，传 --region ap-singapore 即可诊断同一地域。
 */
async function modelCommand(opts: ModelCheckOptions, globals: GlobalArgs): Promise<void> {
  const id = opts.id;
  if (!id) throw new Error(t("arg.missing", { command: "doctor model", args: "--id" }));
  const site = resolveSite(globals);
  const genApis = APIS.filter((e) => apiSupportsModel(e, id)).map((e) => e.id);
  const area = cloudRegionArea(globals.region);
  if (genApis.length && !allowedRegions(site).includes(area)) {
    throw new Error(t("chat.badArea", { site, area, options: allowedRegions(site).join(", ") }));
  }
  const client = buildClient(globals);

  const listResp = await client.call("DescribeModelList", { ModelIds: [id] });
  const models = (listResp["ModelSet"] as Row[] | undefined) ?? [];
  const model = models.find((m) => m["ModelId"] === id);
  // 查不到时不再查接入点；+gen 模型仍往下走，给出「换地域 / 核对 ID」的提示
  const endpoints = model
    ? ((await client.call("DescribeModelEndpointList", { Filters: [{ Name: "ModelId", Op: "EXACT", Values: [id] }] }))["ModelEndpointSet"] as Row[] | undefined) ?? []
    : [];
  const active = endpoints.filter((e) => {
    const s = String(e["Status"] ?? "").toUpperCase();
    return s === "ACTIVE" || s === "RUNNING";
  });
  const route = genApis.length
    ? await genRoute({ model: id, genApis, area, modelStatus: model ? String(model["Status"] ?? "") : undefined, endpoints, client }, globals)
    : undefined;

  // 诊断结论由「模型 + 其接入点（+ +gen 按量调用）」共同决定，一起给出，调用方不必再猜
  if (isJson()) {
    emitJson(
      model || route
        ? { Model: model ?? null, Endpoints: endpoints, ActiveEndpointCount: active.length, ...(route ? { GenRoute: route } : {}) }
        : null,
    );
    return;
  }

  if (!model) {
    console.log(t("doctor.modelCheck.notFound", { id }));
  } else {
    console.log(t("doctor.modelCheck.found", { name: model["ModelName"] ?? "", id: model["ModelId"] ?? "", status: model["Status"] ?? "" }));
    if (!endpoints.length) {
      console.log(t("doctor.modelCheck.noEndpoint"));
    } else if (!active.length) {
      console.log(t("doctor.modelCheck.noneActive", { count: endpoints.length }));
    } else {
      console.log(t("doctor.modelCheck.ok", { count: endpoints.length, active: active.length }));
    }
  }
  if (route) {
    console.log("");
    printGenRoute(route);
  } else if (model) {
    console.log(t("doctor.modelCheck.note"));
  }
}

async function planCommand(opts: Record<string, string>, globals: GlobalArgs): Promise<void> {
  if (!opts["teamId"]) throw new Error(t("arg.missing", { command: "doctor plan", args: "--team-id" }));
  const client = buildClient(globals);
  const resp = await client.call("DescribeTokenPlan", { TeamId: opts["teamId"] });
  const p = (resp["Team"] ?? resp) as Record<string, unknown>;

  if (emitJson(p)) return;

  console.log(
    t("doctor.planCheck.header", {
      name: p["Name"] ?? "",
      id: p["TeamId"] ?? "",
      productType: p["ProductType"] ?? "",
    }),
  );
  const status = String(p["Status"] ?? "");
  const stopReason = String(p["StopReason"] ?? "");
  if (status === "enable" && (!stopReason || stopReason === "NORMAL")) {
    console.log(t("doctor.planCheck.statusOk"));
  } else {
    console.log(t("doctor.planCheck.statusBad", { status, stopReason: stopReason || "-" }));
  }
  const productType = String(p["ProductType"] ?? "");
  // 专业版按积分计价、轻享版按 token，标错单位会让人误以为额度算错了
  const unit = productType === "enterprise" ? t("plan.unit.credit") : t("plan.unit.token");
  const pkg = (p["PackageInfo"] ?? {}) as Record<string, unknown>;
  if (Object.keys(pkg).length) {
    const total = Number(pkg["TotalQuota"] ?? pkg["TotalCredits"] ?? 0);
    const used = Number(pkg["TotalUsed"] ?? 0);
    const percent = total > 0 ? (used / total) * 100 : 0;
    const detail = `${human(used)} / ${human(total)} ${unit}（${percent.toFixed(2)}%）`;
    // 快用完时提前预警，别等真的调不通了才发现
    if (total > 0 && used >= total) {
      console.log(t("doctor.planCheck.quotaExhausted", { detail }));
    } else if (percent >= 80) {
      console.log(t("doctor.planCheck.quotaLow", { detail }));
    } else {
      console.log(t("doctor.keyCheck.quotaOk", { detail }));
    }
  }

  const summary = (p["TokenSummary"] ?? {}) as Record<string, unknown>;
  if (Object.keys(summary).length) {
    for (const line of formatTokenSummary(summary, productType)) {
      console.log(`   ${line}`);
    }
  }
}

/** 打印全部收录的错误码清单（不含详情） */
function listErrorCodes(): void {
  console.log(t("doctor.error.listHeader", { count: ERROR_CODES.length }));
  // 分两组打印：管控面码是字母命名空间、数据面码是六位数字，混排时看不出这是两套体系，
  // 也看不出自己手上的码该在哪一组里找
  for (const [title, codes] of [
    [t("doctor.error.groupCloud"), CLOUD_CODES],
    [t("doctor.error.groupGateway"), GATEWAY_CODES],
  ] as Array<[string, string[]]>) {
    console.log("");
    console.log(`  ${title}`);
    for (const code of codes) {
      const info = lookupError(code);
      console.log(`    ${pad(code, 34)} ${info?.reason ?? ""}`);
    }
  }
  console.log("");
  console.log(t("doctor.error.listFooter"));
  console.log(t("doctor.error.vendorFooter"));
}

/** 打印一个厂商错误码的说明 */
function printVendorError(info: VendorErrorInfo): void {
  console.log(t("doctor.error.vendorHeader", { vendor: VENDOR_NAMES[info.vendor], code: info.code }));
  console.log(`  ${t("error.reason", { reason: info.reason })}`);
  console.log(`  ${t("error.fix", { fix: info.fix })}`);
}

/** --vendor：查该厂商的某个码；不带码时列出该厂商全部收录 */
function vendorErrorCommand(vendor: string, code: string | undefined): void {
  if (!VENDORS.includes(vendor as VendorId)) {
    throw new Error(t("doctor.error.badVendor", { vendor, options: VENDORS.join(" | ") }));
  }
  const v = vendor as VendorId;
  if (code) {
    const info = lookupVendorError(v, code);
    if (info) {
      printVendorError(info);
      return;
    }
    console.log(t("doctor.error.notFound", { code }));
    console.log("");
  }
  const codes = vendorCodes(v);
  console.log(t("doctor.error.vendorListHeader", { vendor: VENDOR_NAMES[v], count: codes.length }));
  for (const c of codes) {
    const info = lookupVendorError(v, c)!;
    console.log(`    ${pad(c, 28)} ${info.reason}`);
  }
}

function errorCommand(code: string | undefined, opts: { vendor?: string } = {}): void {
  if (opts.vendor) {
    vendorErrorCommand(opts.vendor, code);
    return;
  }
  // 不给 code 就列出收录了哪些，而不是报错——这是用户最常见的"我想知道有哪些"诉求
  if (!code) {
    listErrorCodes();
    return;
  }

  const exact = ERROR_CODES.includes(code) ? lookupError(code) : undefined;
  if (exact) {
    console.log(code);
    console.log(`  ${t("error.reason", { reason: exact.reason })}`);
    console.log(`  ${t("error.fix", { fix: exact.fix })}`);
    // +gen 场景下改给的修复建议（如 401007 / 401008 直接给 models activate <模型>）
    const genFix = genFixOf(code, t("doctor.error.modelPlaceholder"));
    if (genFix) console.log(`  ${t("doctor.error.genFix", { fix: genFix })}`);
    return;
  }
  // 平台码没有全等命中：厂商错误码（同一个码可能出现在多个厂商，如 Kling 与 MiniMax 的 1002，全部列出）
  const vendorHits = findVendorErrors(code);
  for (const info of vendorHits) printVendorError(info);
  // 没有全等命中就按前缀找，便于只知道大类时也能查到（如输 AuthFailure 列出所有子码）
  const prefixed = ERROR_CODES.filter((k) => k.startsWith(code));
  if (vendorHits.length && !prefixed.length) return;
  if (prefixed.length) {
    for (const k of prefixed) {
      const info = lookupError(k);
      console.log(k);
      console.log(`  ${t("error.reason", { reason: info?.reason ?? "" })}`);
      console.log(`  ${t("error.fix", { fix: info?.fix ?? "" })}`);
    }
    return;
  }
  // 没命中就把收录清单亮出来，用户能立刻看到该查哪个，而不是干瞪眼
  console.log(t("doctor.error.notFound", { code }));
  console.log("");
  listErrorCodes();
}

/** 装配 doctor 命令组 */
export function registerDoctorCommands(program: Command, getGlobals: () => GlobalArgs): void {
  const doctor = program.command("doctor").description(t("group.doctor.desc"));

  // isDefault：裸跑 `thcli doctor` 直接体检，不打 help。「doctor 就是体检」是用户
  // 和文档的共同预期，多敲一个 all 只是仪式；`doctor all` 仍然可用。
  doctor
    .command("all", { isDefault: true })
    .description(t("doctor.all.desc"))
    .action(async () => allCommand(getGlobals()));

  doctor
    .command("key")
    .description(t("doctor.key.desc"))
    .requiredOption("--id <id>", "ApiKeyId")
    .action(async (opts) => keyCommand(opts, getGlobals()));

  doctor
    .command("endpoint")
    .description(t("doctor.endpoint.desc"))
    .requiredOption("--id <id>", "EndpointId")
    .action(async (opts) => endpointCommand(opts, getGlobals()));

  doctor
    .command("model")
    .description(t("doctor.model.desc"))
    .requiredOption("--id <id>", "ModelId")
    .action(async (opts: ModelCheckOptions) => modelCommand(opts, getGlobals()));

  doctor
    .command("plan")
    .description(t("doctor.plan.desc"))
    .requiredOption("--team-id <id>", t("opt.teamId"))
    .action(async (opts) => planCommand(opts, getGlobals()));

  doctor
    .command("error")
    .description(t("doctor.error.desc"))
    .argument("[code]", t("doctor.error.arg"))
    .option("--vendor <vendor>", t("doctor.error.opt.vendor"))
    .action((code: string | undefined, opts: { vendor?: string }) => errorCommand(code, opts));
}
