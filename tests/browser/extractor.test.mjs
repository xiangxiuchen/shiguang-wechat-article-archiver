// SPDX-License-Identifier: MPL-2.0

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildArchiveHtml } from "../../src/shared/archive.js";
import { loadPlaywright, resolveChromiumExecutable } from "../helpers/playwright.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const releaseRoot = path.join(root, "dist", "shiguang-archive-extension");
const sourceExtractor = path.join(root, "src", "content", "extractor-core.js");

async function withFixture(
  name,
  callback,
  extractorPath = path.join(releaseRoot, "src", "content", "extractor-core.js")
) {
  const { chromium } = loadPlaywright(import.meta.url);
  const executablePath = resolveChromiumExecutable();
  const headless = process.env.PLAYWRIGHT_HEADLESS !== "false";
  const browser = await chromium.launch({ headless, executablePath });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    const articleUrl = "https://mp.weixin.qq.com/s/test";
    const html = await readFile(path.join(root, "tests", "fixtures", name), "utf8");
    await page.route("**/*", (route) => {
      if (route.request().isNavigationRequest() && route.request().url() === articleUrl) {
        return route.fulfill({
          status: 200,
          contentType: "text/html;charset=utf-8",
          body: html
        });
      }
      return route.abort("blockedbyclient");
    });
    await page.goto(articleUrl, { waitUntil: "domcontentloaded", timeout: 15_000 });
    await page.addScriptTag({ path: extractorPath });
    await callback(page);
  } finally {
    await browser.close().catch(() => {});
  }
}

test("提取标准公众号 DOM、懒加载图片并去重", async () => {
  await withFixture("canonical.html", async (page) => {
    const result = await page.evaluate(() => globalThis.ShiguangExtractorCore.extract());
    assert.equal(result.title, "一篇用于测试的公众号文章");
    assert.equal(result.account, "拾光测试号");
    assert.equal(result.publishTime, "2026-08-20 10:30");
    assert.equal(result.images.length, 1);
    assert.equal(result.imageCount, 1);
    assert.match(result.bodyHtml, /data-shiguang-image="sg-img-1"/);
    assert.doesNotMatch(result.bodyHtml, /onclick|onerror|background-image|data-original|data-src/);
    assert.match(result.bodyHtml, /text-align:center/);
    assert.deepEqual(result.lossManifest, [
      { type: "css-background-image", label: "CSS 背景图", count: 1 }
    ]);
  });
});

test("危险 HTML 被清洗，外部图片不保留远程地址", async () => {
  await withFixture("malicious.html", async (page) => {
    const result = await page.evaluate(() => globalThis.ShiguangExtractorCore.extract());
    assert.equal(result.unsupportedMediaCount, 2);
    assert.equal(result.images.length, 0);
    assert.doesNotMatch(result.bodyHtml, /script|iframe|form|input|svg|video/i);
    assert.doesNotMatch(result.bodyHtml, /onclick|onerror|srcdoc|ping|javascript:|evil\.test|http:|url\s*\(/i);
    assert.match(result.bodyHtml, /安全正文/);
    assert.match(result.bodyHtml, /data-shiguang-image="sg-img-1"/);
    assert.match(result.bodyHtml, /请返回原文查看/);
    assert.equal(
      result.lossManifest.find((loss) => loss.type === "unsupported-visual")?.count,
      1
    );
  });
});

test("纯图片文章可保存，高优先级懒加载地址无效时会继续回退", async () => {
  await withFixture("pure-image.html", async (page) => {
    const analysis = await page.evaluate(() => globalThis.ShiguangExtractorCore.analyze());
    assert.equal(analysis.imageCount, 1);
    const result = await page.evaluate(() => globalThis.ShiguangExtractorCore.extract());
    assert.equal(result.images.length, 1);
    assert.equal(result.images[0].url, "https://mmbiz.qpic.cn/fallback.png");
    assert.match(result.bodyHtml, /data-shiguang-image="sg-img-1"/);

    const textOnly = await page.evaluate(() => globalThis.ShiguangExtractorCore.extract(
      document,
      { includeImages: false }
    ));
    assert.equal(textOnly.images.length, 0);
    assert.match(textOnly.bodyHtml, /data-shiguang-image="sg-img-1"/);
  });
});

test("SVG-only 文章不会被当成空文章，且必须记录损失并留占位", async () => {
  await withFixture("svg-only.html", async (page) => {
    const result = await page.evaluate(() => globalThis.ShiguangExtractorCore.extract());
    assert.equal(
      result.lossManifest.find((loss) => loss.type === "unsupported-visual")?.count,
      1
    );
    assert.match(result.bodyHtml, /图形或特殊视觉内容无法安全离线保留/);
    assert.doesNotMatch(result.bodyHtml, /<svg|<script/i);
  });
});

test("删除带内容的特殊结构会记为损失且不收集脱离正文树的图片", async () => {
  await withFixture("dropped-markup.html", async (page) => {
    const result = await page.evaluate(() => globalThis.ShiguangExtractorCore.extract());
    const droppedMarkup = result.lossManifest.find((loss) => loss.type === "dropped-markup");

    assert.equal(droppedMarkup?.count, 5);
    assert.equal(result.images.length, 1);
    assert.equal(result.images[0].url, "https://mmbiz.qpic.cn/kept.png");
    assert.match(result.bodyHtml, /应保留的正文开头/);
    assert.match(result.bodyHtml, /应保留的正文结尾/);
    assert.match(result.bodyHtml, /data-shiguang-image="sg-img-1"/);
    assert.doesNotMatch(
      result.bodyHtml,
      /<form|<template|<noscript|<select|<textarea|表单里的文字|模板里的隐藏正文|无脚本正文|选择项正文|文本框正文|orphan-in-/i
    );

    const archive = buildArchiveHtml(result, result.images.map((image) => ({
      id: image.id,
      ok: true,
      dataUrl: "data:image/png;base64,iVBORw0KGgo="
    })));
    assert.equal(archive.status, "partial");
    assert.equal(archive.contentLossCount, 5);
  }, sourceExtractor);
});
