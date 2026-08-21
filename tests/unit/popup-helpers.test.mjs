// SPDX-License-Identifier: MPL-2.0

import test from "node:test";
import assert from "node:assert/strict";
import {
  browserLabel,
  buildSafeFeedback,
  openDownloadFromUserGesture,
  platformLabel
} from "../../src/popup/popup-helpers.js";

test("安全反馈只输出允许的运行计数，忽略内容和任务标识", () => {
  const feedback = buildSafeFeedback({
    version: "0.3.2",
    platform: "macOS",
    browser: "Google Chrome 140",
    status: "partial",
    stage: "completed",
    errorCode: "SL-IMG-25",
    savedImages: 8,
    failedImages: 2,
    totalImages: 10,
    unsupportedMediaCount: 1,
    contentLossCount: 3,
    title: "机密文章标题",
    account: "私密公众号",
    bodyHtml: "<p>不得复制的正文</p>",
    sourceUrl: "https://mp.weixin.qq.com/s/secret-token",
    filename: "机密文章.html",
    localPath: "/Users/example/Downloads/机密文章.html",
    downloadId: 9988,
    jobId: "secret-job-id",
    cookie: "session=secret",
    userAgent: "Mozilla/5.0 very-specific-device-build"
  });

  assert.match(feedback, /版本：0\.3\.2/);
  assert.match(feedback, /状态：部分保存/);
  assert.match(feedback, /错误编号：SL-IMG-25/);
  assert.match(feedback, /共 10 张，已保存 8 张，失败 2 张/);
  for (const secret of [
    "机密文章标题",
    "私密公众号",
    "不得复制的正文",
    "secret-token",
    "机密文章.html",
    "/Users/example/Downloads",
    "9988",
    "secret-job-id",
    "session=secret",
    "very-specific-device-build"
  ]) {
    assert.doesNotMatch(feedback, new RegExp(secret));
  }
});

test("平台和浏览器只保留类型与主版本", () => {
  assert.equal(platformLabel({ os: "win" }), "Windows");
  assert.equal(platformLabel({}, { platform: "MacIntel" }), "macOS");
  assert.equal(browserLabel({ userAgent: "Mozilla/5.0 Chrome/140.0.1 Safari/537.36 Edg/140.0.2" }), "Microsoft Edge 140");
  assert.equal(browserLabel({ userAgent: "Mozilla/5.0 Chrome/139.0.1 Safari/537.36" }), "Google Chrome 139");
  assert.equal(browserLabel({ userAgentData: { brands: [{ brand: "Google Chrome", version: "138.0.7204.1" }] } }), "Google Chrome 138");
});

test("失败和取消终态的反馈阶段不会显示未知", () => {
  const failed = buildSafeFeedback({ status: "error", stage: "error" });
  const cancelled = buildSafeFeedback({ status: "cancelled", stage: "cancelled" });
  assert.match(failed, /阶段：已终止/);
  assert.match(cancelled, /阶段：已取消/);
  assert.doesNotMatch(`${failed}\n${cancelled}`, /阶段：未知/);
});

test("打开下载必须在调用时立即触发，成功时不显示文件夹", async () => {
  const calls = [];
  let finish;
  const result = new Promise((resolve) => { finish = resolve; });
  openDownloadFromUserGesture({
    open(id) {
      calls.push(["open", id]);
      return Promise.resolve();
    },
    show(id) {
      calls.push(["show", id]);
    }
  }, 42, finish);

  assert.deepEqual(calls, [["open", 42]], "open 必须在用户点击的同步调用栈中发起");
  assert.deepEqual(await result, { opened: true, fallbackShown: false, reason: "opened" });
  assert.deepEqual(calls, [["open", 42]]);
});

test("直接打开被拒绝时安全回退到在文件夹中显示", async () => {
  const calls = [];
  let finish;
  const result = new Promise((resolve) => { finish = resolve; });
  openDownloadFromUserGesture({
    open(id) {
      calls.push(["open", id]);
      return Promise.reject(new Error("open failed"));
    },
    show(id) {
      calls.push(["show", id]);
    }
  }, 7, finish);

  assert.deepEqual(await result, { opened: false, fallbackShown: true, reason: "open-rejected" });
  assert.deepEqual(calls, [["open", 7], ["show", 7]]);
});

test("直接打开和文件夹定位都失败时返回可见的双失败结果", async () => {
  let finish;
  const result = new Promise((resolve) => { finish = resolve; });
  openDownloadFromUserGesture({
    open() {
      return Promise.reject(new Error("open failed"));
    },
    show() {
      return Promise.reject(new Error("show failed"));
    }
  }, 9, finish);

  assert.deepEqual(await result, { opened: false, fallbackShown: false, reason: "open-rejected" });
});
