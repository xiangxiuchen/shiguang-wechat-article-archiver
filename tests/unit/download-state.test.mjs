// SPDX-License-Identifier: MPL-2.0

import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyDownloadTerminal,
  mergeTerminalObservation,
  withTimeout
} from "../../src/shared/download-state.js";

test("取消请求只在浏览器确认中断后成为取消终态", () => {
  assert.equal(classifyDownloadTerminal("in_progress", true), null);
  assert.equal(classifyDownloadTerminal("complete", true), "complete");
  assert.equal(classifyDownloadTerminal("interrupted", true), "cancelled");
  assert.equal(classifyDownloadTerminal("interrupted", false), "interrupted");
});

test("完成观察在取消竞态中优先，终态不会被较晚的中断覆盖", () => {
  const interrupted = { state: "interrupted", errorCode: "USER_CANCELED" };
  const complete = { state: "complete", errorCode: "" };
  assert.deepEqual(mergeTerminalObservation(interrupted, complete), complete);
  assert.deepEqual(mergeTerminalObservation(complete, interrupted), complete);
});

test("下载交接超时会先标记超时并以稳定错误结束", async () => {
  let resolveRequest;
  let timeoutMarked = false;
  const request = new Promise((resolve) => {
    resolveRequest = resolve;
  });
  const timeoutError = Object.assign(new Error("交接超时"), {
    code: "SL-DOWNLOAD-09"
  });

  await assert.rejects(
    withTimeout(request, 5, timeoutError, () => {
      timeoutMarked = true;
    }),
    (error) => error === timeoutError && error.code === "SL-DOWNLOAD-09"
  );
  assert.equal(timeoutMarked, true);

  resolveRequest({ ok: true, downloadId: 1 });
  await Promise.resolve();
});

test("下载交接及时响应时不会触发超时清理", async () => {
  let timeoutMarked = false;
  const result = await withTimeout(
    Promise.resolve({ ok: true, downloadId: 7 }),
    50,
    new Error("不应触发"),
    () => {
      timeoutMarked = true;
    }
  );
  assert.deepEqual(result, { ok: true, downloadId: 7 });
  assert.equal(timeoutMarked, false);
});
