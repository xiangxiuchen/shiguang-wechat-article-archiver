// SPDX-License-Identifier: MPL-2.0

import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyAbortReason,
  findBusyJob,
  findRecoverableJob,
  isTerminalJob
} from "../../src/shared/job-state.js";

test("用户取消、自动超时和浏览器中断有不同结果", () => {
  assert.deepEqual(classifyAbortReason({ code: "SL-CANCELLED" }), {
    status: "cancelled",
    code: "SL-CANCELLED",
    message: "已取消保存"
  });
  assert.equal(classifyAbortReason({ name: "TimeoutError" }).code, "SL-JOB-TIMEOUT");
  assert.equal(classifyAbortReason(new Error("中断")).code, "SL-JOB-INTERRUPTED");
});

function job(id, sourceUrl, status, extra = {}) {
  return { id, sourceUrl, status, processing: false, ...extra };
}

test("只恢复当前文章的最近终态", () => {
  const jobs = new Map([
    ["a", job("a", "https://mp.weixin.qq.com/s/a", "success", { updatedAt: 2 })]
  ]);
  assert.equal(findRecoverableJob(jobs, {
    sourceUrl: "https://mp.weixin.qq.com/s/b"
  }), null);
  assert.equal(findRecoverableJob(jobs, {
    sourceUrl: "https://mp.weixin.qq.com/s/a"
  }), jobs.get("a"));
});

test("仅恢复当前文章仍在运行的任务", () => {
  const running = job("a", "https://mp.weixin.qq.com/s/a", "running");
  const jobs = new Map([[running.id, running]]);
  assert.equal(findRecoverableJob(jobs, { sourceUrl: running.sourceUrl }), running);
  assert.equal(findRecoverableJob(jobs, { sourceUrl: "https://mp.weixin.qq.com/s/b" }), null);
});

test("Beta 版同一时间只允许一个处理或下载任务", () => {
  const processing = job("a", "https://mp.weixin.qq.com/s/a", "cancelled", { processing: true });
  const jobs = new Map([[processing.id, processing]]);
  assert.equal(findBusyJob(jobs), processing);

  processing.processing = false;
  const downloads = new Map([[processing.id, { downloadId: 1 }]]);
  assert.equal(findBusyJob(jobs, downloads), processing);
  assert.equal(isTerminalJob(processing), true);
});

test("切换到另一篇文章时优先恢复全局忙任务", () => {
  const running = job("a", "https://mp.weixin.qq.com/s/a", "running", { updatedAt: 3 });
  const jobs = new Map([[running.id, running]]);
  assert.equal(findRecoverableJob(jobs, {
    sourceUrl: "https://mp.weixin.qq.com/s/b",
    includeGlobalBusy: true
  }), running);
});
