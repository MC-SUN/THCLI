/**
 * +gen 的 doctor 诊断：服务侧可用性（模型状态 / 接入点 / 计费）、按量 Key 云端状态判断（gen-check；
 * 打码比对复用 key-picker 的 matchesMasked，测试在 agent-config）。
 * 报错时附的 doctor 诊断命令（errors.ts 的 diagnoseCommandOf）见 errors.test.ts。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { cloudRegionArea } from "../../src/core/config.js";
import { keyCoversModel, quotaExhausted, remainingFreeQuota, serviceCheck } from "../../src/core/gen-check.js";

const NOW = Date.parse("2026-10-15T00:00:00Z");
const free = (used: number, total: number, expire = "2027-01-01T00:00:00Z") =>
  JSON.stringify({ FreeQuota: { TotalQuota: total, UsedQuota: used, ExpireTime: expire } });

describe("诊断地域（doctor model --region → 数据面 area）", () => {
  it("ap-guangzhou→gz、ap-singapore→sg；未传 / 未知地域回 gz", () => {
    assert.equal(cloudRegionArea("ap-guangzhou"), "gz");
    assert.equal(cloudRegionArea("ap-singapore"), "sg");
    assert.equal(cloudRegionArea(undefined), "gz");
    assert.equal(cloudRegionArea("ap-shanghai"), "gz");
  });
});

describe("服务侧可用性（doctor model）", () => {
  it("模型：查不到 / 已下线直接阻断；pre-offline 仍按后续环节判断", () => {
    assert.equal(serviceCheck("m", undefined, []).State, "notFound");
    assert.equal(serviceCheck("m", "discontinued", [{ EndpointId: "m", Status: "ACTIVE", PaymentEnabled: true }]).State, "offline");
    const pre = serviceCheck("m", "pre-offline", [{ EndpointId: "m", Status: "MODEL_PRE_OFFLINE", PaymentEnabled: true }]);
    assert.equal(pre.State, "ok");
    assert.equal(pre.ModelStatus, "pre-offline");
  });

  it("接入点：没有 / 未运行时阻断，并带上状态与停止原因", () => {
    assert.equal(serviceCheck("m", "online", []).State, "noEndpoint");
    const inactive = serviceCheck("m", "online", [{ EndpointId: "m", Status: "INACTIVE", StopReason: "NO_FREE_PACKAGE", PaymentEnabled: true }]);
    assert.deepEqual([inactive.State, inactive.EndpointStatus, inactive.StopReason], ["notReady", "INACTIVE", "NO_FREE_PACKAGE"]);
    assert.equal(serviceCheck("m", "online", [{ EndpointId: "m", Status: "VIRTUAL" }]).State, "notReady");
  });

  it("接入点：只看与模型同名的默认接入点；没有同名的才看全部", () => {
    const eps = [
      { EndpointId: "m", Status: "INACTIVE" },
      { EndpointId: "ep-1", Status: "ACTIVE", PaymentEnabled: true },
    ];
    assert.equal(serviceCheck("m", "online", eps).State, "notReady", "自建 ep-1 可用不代表 +gen 调的默认接入点可用");
    const other = serviceCheck("m", "online", [{ EndpointId: "ep-1", Status: "ACTIVE", PaymentEnabled: true }]);
    assert.deepEqual([other.State, other.EndpointId], ["ok", "ep-1"]);
  });

  it("计费：已开后付费优先；未开时有剩余免费额度也可调；都没有则阻断", () => {
    const paid = serviceCheck("m", "online", [{ EndpointId: "m", Status: "ACTIVE", PaymentEnabled: true, ChargeDetail: free(0, 100) }], NOW);
    assert.equal(paid.Billing, "postpaid");
    const trial = serviceCheck("m", "online", [{ EndpointId: "m", Status: "ACTIVE", PaymentEnabled: false, ChargeDetail: free(10, 100) }], NOW);
    assert.deepEqual([trial.State, trial.Billing, trial.FreeQuota?.Used], ["ok", "free", 10]);
    assert.equal(serviceCheck("m", "online", [{ EndpointId: "m", Status: "ACTIVE", PaymentEnabled: false }], NOW).State, "noBilling");
  });

  it("免费额度：用完或过期都不算", () => {
    assert.equal(remainingFreeQuota({ ChargeDetail: free(100, 100) }, NOW), undefined);
    assert.equal(remainingFreeQuota({ ChargeDetail: free(0, 100, "2026-01-01T00:00:00Z") }, NOW), undefined);
    assert.equal(remainingFreeQuota({ ChargeDetail: "not json" }, NOW), undefined);
    assert.deepEqual(remainingFreeQuota({ ChargeDetail: free(1, 100) }, NOW), { Used: 1, Total: 100, ExpireTime: "2027-01-01T00:00:00Z" });
  });
});

describe("按量 Key 云端状态判断（doctor model）", () => {
  it("范围：全部绑定 / 绑定了模型 / 绑定了该模型的推理服务", () => {
    assert.equal(keyCoversModel({ BindType: "all" }, "m", []), true);
    assert.equal(keyCoversModel({ BindType: "custom", BindingItems: [{ ResourceId: "m" }] }, "m", []), true);
    assert.equal(keyCoversModel({ BindType: "custom", BindingItems: [{ ResourceId: "ep-1" }] }, "m", ["ep-1"]), true);
    assert.equal(keyCoversModel({ BindType: "custom", BindingItems: [{ ResourceId: "other" }] }, "m", ["ep-1"]), false);
    assert.equal(keyCoversModel({ BindType: "custom" }, "m", []), false);
  });

  it("额度：用完或 inactive 判为不可用", () => {
    assert.equal(quotaExhausted({}), false);
    assert.equal(quotaExhausted({ QuotaSet: [{ CycleCredits: "100", CycleUsed: 99 }] }), false);
    assert.equal(quotaExhausted({ QuotaSet: [{ CycleCredits: "100", CycleUsed: 100 }] }), true);
    assert.equal(quotaExhausted({ QuotaStatus: "inactive" }), true);
  });
});

