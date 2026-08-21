// SPDX-License-Identifier: MPL-2.0

import test from "node:test";
import assert from "node:assert/strict";
import {
  LIMITS,
  assertDecodedRasterBudget,
  assertRasterBudget,
  assertArticlePayload,
  canonicalizeArticleUrl,
  createRasterBudget,
  detectRasterMime,
  inspectRasterMetadata,
  makeArchiveFilename,
  reserveRasterBudget,
  validateArticleUrl,
  validateImageUrl
} from "../../src/shared/policy.js";

test("只允许精确的公开公众号文章 URL", () => {
  assert.equal(validateArticleUrl("https://mp.weixin.qq.com/s/abc").hostname, "mp.weixin.qq.com");
  assert.equal(validateArticleUrl("https://mp.weixin.qq.com/s?__biz=a&mid=1").pathname, "/s");
  for (const value of [
    "http://mp.weixin.qq.com/s/abc",
    "https://mp.weixin.qq.com.evil.test/s/abc",
    "https://mp.weixin.qq.com/cgi-bin/home",
    "file:///tmp/article.html",
    "https://127.0.0.1/s/abc"
  ]) {
    assert.throws(() => validateArticleUrl(value));
  }
});

test("规范化原文链接会移除追踪与凭证类参数", () => {
  const result = canonicalizeArticleUrl(
    "https://mp.weixin.qq.com/s?__biz=a&mid=1&idx=2&sn=x&scene=99&pass_ticket=secret#part"
  );
  assert.equal(result, "https://mp.weixin.qq.com/s?__biz=a&mid=1&idx=2&sn=x");
  assert.doesNotMatch(result, /scene|pass_ticket|#/);
});

test("图片只允许精确 HTTPS qpic 域名", () => {
  assert.equal(validateImageUrl("https://mmbiz.qpic.cn/a.png").hostname, "mmbiz.qpic.cn");
  for (const value of [
    "http://mmbiz.qpic.cn/a.png",
    "https://mmbiz.qpic.cn.evil.test/a.png",
    "https://127.0.0.1/a.png",
    "data:image/png;base64,AA=="
  ]) {
    assert.throws(() => validateImageUrl(value));
  }
});

test("只接受 JPEG PNG GIF WebP 文件签名", () => {
  assert.equal(detectRasterMime(Uint8Array.from([0xff, 0xd8, 0xff, 0x00])), "image/jpeg");
  assert.equal(detectRasterMime(Uint8Array.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a])), "image/png");
  assert.equal(detectRasterMime(new TextEncoder().encode("GIF89a")), "image/gif");
  assert.equal(detectRasterMime(new TextEncoder().encode("RIFF0000WEBP")), "image/webp");
  assert.equal(detectRasterMime(new TextEncoder().encode("<svg onload=alert(1)>")), null);
  assert.equal(detectRasterMime(new TextEncoder().encode("<html>not image</html>")), null);
  assert.equal(
    inspectRasterMetadata(Uint8Array.from([0xff, 0xd8, 0xff, 0x00]), "image/jpeg"),
    null,
    "只有文件头的假 JPEG 不能通过结构验证"
  );
});

test("图片结构、尺寸、像素和动图帧数都有独立安全门槛", () => {
  const png = Uint8Array.from([
    0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,
    0,0,0,13, 0x49,0x48,0x44,0x52,
    0,0,0,3, 0,0,0,2, 8,6,0,0,0, 0,0,0,0,
    0,0,0,0, 0x49,0x45,0x4e,0x44, 0,0,0,0
  ]);
  assert.deepEqual(inspectRasterMetadata(png), {
    mime: "image/png",
    width: 3,
    height: 2,
    frameCount: 1
  });
  assert.doesNotThrow(() => assertRasterBudget(inspectRasterMetadata(png)));
  assert.throws(
    () => assertRasterBudget({ width: LIMITS.maxImageWidth + 1, height: 1, frameCount: 1 }),
    (error) => error.code === "SL-IMG-18"
  );
  assert.throws(
    () => assertRasterBudget({ width: 1, height: 1, frameCount: LIMITS.maxAnimatedFrames + 1 }),
    (error) => error.code === "SL-IMG-19"
  );
  assert.throws(
    () => assertRasterBudget({
      width: 8_000,
      height: 5_000,
      frameCount: LIMITS.maxAnimatedFrames
    }),
    (error) => error.code === "SL-IMG-22"
  );
  assert.throws(
    () => assertRasterBudget(null),
    (error) => error.code === "SL-IMG-17"
  );
  assert.doesNotThrow(() => assertDecodedRasterBudget(
    { width: 100, height: 200, frameCount: 1 },
    200,
    100
  ));
  assert.throws(
    () => assertDecodedRasterBudget(
      { width: 100, height: 100, frameCount: 1 },
      101,
      100
    ),
    (error) => error.code === "SL-IMG-25"
  );
});

test("整篇图片预算同步预留且超限时不会部分写入", () => {
  const staticBudget = createRasterBudget();
  for (let index = 0; index < 3; index += 1) {
    reserveRasterBudget(staticBudget, {
      width: 10_000,
      height: 4_000,
      frameCount: 1
    });
  }
  assert.deepEqual(staticBudget, {
    pixelCount: LIMITS.maxTotalImagePixels,
    framePixelCount: LIMITS.maxTotalImagePixels
  });
  assert.throws(
    () => reserveRasterBudget(staticBudget, { width: 1, height: 1, frameCount: 1 }),
    (error) => error.code === "SL-IMG-23"
  );
  assert.deepEqual(staticBudget, {
    pixelCount: LIMITS.maxTotalImagePixels,
    framePixelCount: LIMITS.maxTotalImagePixels
  });

  const animatedBudget = createRasterBudget();
  reserveRasterBudget(animatedBudget, { width: 1_000, height: 1_000, frameCount: 60 });
  reserveRasterBudget(animatedBudget, { width: 1_000, height: 1_000, frameCount: 60 });
  assert.throws(
    () => reserveRasterBudget(animatedBudget, { width: 1, height: 1, frameCount: 1 }),
    (error) => error.code === "SL-IMG-24"
  );
  assert.deepEqual(animatedBudget, {
    pixelCount: 2_000_000,
    framePixelCount: LIMITS.maxTotalFramePixels
  });
});

test("文件名兼容 Windows / Mac 且包含短哈希", () => {
  const filename = makeArchiveFilename({
    sourceUrl: "https://mp.weixin.qq.com/s/abc",
    title: 'CON / 测试:*?"<>|. ',
    account: "公众号",
    publishTime: "2026年8月20日"
  }, new Date("2026-08-20T00:00:00Z"));
  assert.match(filename, /^2026-08-20_公众号_/);
  assert.match(filename, /_[0-9a-f]{8}\.html$/);
  assert.doesNotMatch(filename, /[\\/:*?"<>|]/);
  assert.ok(filename.length < 180);
});

test("正文与图片数量执行集中上限", () => {
  const base = {
    sourceUrl: "https://mp.weixin.qq.com/s/abc",
    title: "测试",
    account: "测试号",
    bodyHtml: "<p>正文</p>",
    images: []
  };
  assert.doesNotThrow(() => assertArticlePayload(base));
  assert.throws(() => assertArticlePayload({ ...base, bodyHtml: "x".repeat(LIMITS.maxBodyBytes + 1) }));
  assert.throws(() => assertArticlePayload({
    ...base,
    images: Array.from({ length: LIMITS.maxImages + 1 }, (_, index) => ({
      id: `sg-img-${index + 1}`,
      url: `https://mmbiz.qpic.cn/${index}.png`
    }))
  }));
});

test("内容损失清单只接受可显示的有效记录", () => {
  const base = {
    sourceUrl: "https://mp.weixin.qq.com/s/abc",
    title: "测试",
    account: "测试号",
    bodyHtml: "<p>正文</p>",
    images: []
  };
  assert.deepEqual(assertArticlePayload({
    ...base,
    lossManifest: [{ type: "css-background-image", label: "CSS 背景图", count: 2 }]
  }).lossManifest, [
    { type: "css-background-image", label: "CSS 背景图", count: 2 }
  ]);
  assert.throws(() => assertArticlePayload({
    ...base,
    lossManifest: [{ type: "<script>", label: "伪造", count: 1 }]
  }), (error) => error.code === "SL-DATA-07");
});
