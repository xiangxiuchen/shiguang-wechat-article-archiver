// SPDX-License-Identifier: MPL-2.0

import test from "node:test";
import assert from "node:assert/strict";
import { buildArchiveHtml } from "../../src/shared/archive.js";

const article = {
  sourceUrl: "https://mp.weixin.qq.com/s/abc",
  title: "测试 <文章>",
  account: "拾光号",
  author: "作者",
  publishTime: "2026-08-20",
  bodyHtml: '<p>第一段</p><img data-shiguang-image="sg-img-1" alt="图一"><img data-shiguang-image="sg-img-2" alt="图二">'
};

test("输出包含严格 CSP、来源与安全转义", () => {
  const result = buildArchiveHtml(article, [
    { id: "sg-img-1", ok: true, dataUrl: "data:image/png;base64,iVBORw0KGgo=" },
    { id: "sg-img-2", ok: false }
  ], new Date("2026-08-20T12:00:00+08:00"));
  assert.equal(result.status, "partial");
  assert.equal(result.savedImages, 1);
  assert.equal(result.failedImages, 1);
  assert.match(result.html, /Content-Security-Policy/);
  assert.match(result.html, /connect-src 'none'/);
  assert.match(result.html, /测试 &lt;文章&gt;/);
  assert.match(result.html, /https:\/\/mp\.weixin\.qq\.com\/s\/abc/);
  assert.match(result.html, /data:image\/png;base64/);
  assert.match(result.html, /未能离线保存/);
  assert.doesNotMatch(result.html, /src="https?:\/\//);
  assert.doesNotMatch(result.html, /<script/i);
});

test("所有图片成功时为完整成功", () => {
  const result = buildArchiveHtml({ ...article, bodyHtml: '<img data-shiguang-image="sg-img-1" alt="图">' }, [
    { id: "sg-img-1", ok: true, dataUrl: "data:image/gif;base64,R0lGODlh" }
  ]);
  assert.equal(result.status, "success");
  assert.equal(result.failedImages, 0);
});

test("存在音视频或互动组件时明确标记为部分成功", () => {
  const result = buildArchiveHtml({
    ...article,
    bodyHtml: "<p>正文</p>",
    unsupportedMediaCount: 2
  }, []);
  assert.equal(result.status, "partial");
  assert.equal(result.unsupportedMediaCount, 2);
  assert.match(result.html, /2 个音视频或互动组件未纳入离线文件/);
});

test("任何视觉内容损失都不得误报完整成功", () => {
  const result = buildArchiveHtml({
    ...article,
    bodyHtml: "<p>正文</p>",
    lossManifest: [
      { type: "css-background-image", label: "CSS 背景图", count: 1 },
      { type: "unsupported-visual", label: "SVG、Canvas 或嵌入式视觉内容", count: 2 }
    ]
  }, []);
  assert.equal(result.status, "partial");
  assert.equal(result.contentLossCount, 3);
  assert.match(result.html, /1 处CSS 背景图未能完整保留/);
  assert.match(result.html, /2 处SVG、Canvas 或嵌入式视觉内容未能完整保留/);
});

test("正文里的未知图片标记也计入失败且不回退远程地址", () => {
  const result = buildArchiveHtml({ ...article, bodyHtml: '<img data-shiguang-image="sg-img-99" alt="外部图">' }, []);
  assert.equal(result.status, "partial");
  assert.equal(result.failedImages, 1);
  assert.doesNotMatch(result.html, /data-shiguang-image/);
  assert.doesNotMatch(result.html, /src="https?:\/\//);
});
