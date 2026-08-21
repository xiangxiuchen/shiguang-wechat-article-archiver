// SPDX-License-Identifier: MPL-2.0

import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadPlaywright, resolveChromiumExecutable } from "../helpers/playwright.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const releaseRoot = path.join(root, "dist", "shiguang-archive-extension");

async function launchExtension() {
  const { chromium } = loadPlaywright(import.meta.url);
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "shiguang-extension-e2e-"));
  const profile = path.join(tempRoot, "profile");
  const downloadDir = path.join(tempRoot, "downloads");
  await mkdir(path.join(profile, "Default"), { recursive: true });
  await mkdir(downloadDir, { recursive: true });
  await writeFile(path.join(profile, "Default", "Preferences"), JSON.stringify({
    download: {
      default_directory: downloadDir,
      directory_upgrade: true,
      prompt_for_download: false
    }
  }));

  const context = await chromium.launchPersistentContext(profile, {
    headless: process.env.PLAYWRIGHT_HEADLESS !== "false",
    executablePath: resolveChromiumExecutable(),
    acceptDownloads: true,
    downloadsPath: downloadDir,
    ignoreDefaultArgs: ["--disable-extensions"],
    args: [
      `--disable-extensions-except=${releaseRoot}`,
      `--load-extension=${releaseRoot}`,
      "--no-first-run",
      "--no-default-browser-check"
    ]
  });

  const initialPage = context.pages()[0] || await context.newPage();
  const cdp = await context.newCDPSession(initialPage);
  await cdp.send("Browser.setDownloadBehavior", {
    behavior: "allow",
    downloadPath: downloadDir,
    eventsEnabled: true
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker", {
    timeout: 15_000
  });
  const extensionId = new URL(worker.url()).hostname;
  const trustedPage = await context.newPage();
  await trustedPage.goto(`chrome-extension://${extensionId}/pages/privacy.html`);
  return { context, tempRoot, extensionId, trustedPage };
}

async function waitForCompletedHtmlDownloads(page, expectedCount, timeoutMs = 10_000) {
  return page.evaluate(async ({ expectedCount, timeoutMs }) => {
    const deadline = Date.now() + timeoutMs;
    while (true) {
      const downloads = await chrome.downloads.search({});
      const completed = downloads
        .filter((item) => item.state === "complete" && /\.html$/i.test(item.filename || ""))
        .map((item) => ({ id: item.id, filename: item.filename }));
      if (completed.length === expectedCount || Date.now() >= deadline) return completed;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }, { expectedCount, timeoutMs });
}

async function startAndWait(page, article, timeoutMs = 20_000) {
  return page.evaluate(async ({ article, timeoutMs }) => {
    const start = await chrome.runtime.sendMessage({
      target: "background",
      type: "START_ARCHIVE",
      article
    });
    if (!start?.ok) return { start, job: null };
    const deadline = Date.now() + timeoutMs;
    let job = start.job;
    while (Date.now() < deadline) {
      const response = await chrome.runtime.sendMessage({
        target: "background",
        type: "QUERY_JOB",
        jobId: start.jobId
      });
      job = response?.job;
      if (["success", "partial", "error", "cancelled"].includes(job?.status)) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return { start, job };
  }, { article, timeoutMs });
}

function basicArticle(overrides = {}) {
  return {
    sourceUrl: "https://mp.weixin.qq.com/s/final-dist-e2e",
    title: "最终发布包完整链路测试",
    account: "拾光测试号",
    author: "本地自动测试",
    publishTime: "2026-08-20",
    bodyHtml: "<p>这段文字必须真实写入下载文件。</p>",
    images: [],
    unsupportedMediaCount: 0,
    lossManifest: [],
    ...overrides
  };
}

test("最终 dist 经 MV3 后台生成可离线打开的 HTML", async () => {
  const { context, tempRoot, trustedPage } = await launchExtension();
  try {
    const result = await startAndWait(trustedPage, basicArticle());
    assert.equal(result.start.ok, true);
    assert.equal(result.job.status, "success");
    assert.equal(result.job.failedImages, 0);
    assert.equal(result.job.contentLossCount, 0);

    const downloads = await waitForCompletedHtmlDownloads(trustedPage, 1);
    assert.equal(downloads.length, 1);
    const html = await readFile(downloads[0].filename, "utf8");
    assert.match(html, /最终发布包完整链路测试/);
    assert.match(html, /这段文字必须真实写入下载文件/);
    assert.match(html, /Content-Security-Policy/);
    assert.match(html, /connect-src 'none'/);
    assert.doesNotMatch(html, /<script|<iframe|<form/i);
    assert.doesNotMatch(html, /src=["']https?:\/\//i);

    const { chromium } = loadPlaywright(import.meta.url);
    const offlineBrowser = await chromium.launch({
      headless: true,
      executablePath: resolveChromiumExecutable()
    });
    try {
      const offlineContext = await offlineBrowser.newContext({ offline: true });
      const page = await offlineContext.newPage();
      const requests = [];
      page.on("request", (request) => {
        if (!request.url().startsWith("file:")) requests.push(request.url());
      });
      await page.goto(pathToFileURL(downloads[0].filename).href);
      await page.getByRole("heading", { name: "最终发布包完整链路测试" }).waitFor();
      assert.deepEqual(requests, []);
      await offlineContext.close();
    } finally {
      await offlineBrowser.close();
    }
  } finally {
    await context.close();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("最终 dist 对图片缺失、互动内容和结构损失只给出部分成功", async () => {
  const { context, tempRoot, trustedPage } = await launchExtension();
  try {
    const article = basicArticle({
      sourceUrl: "https://mp.weixin.qq.com/s/final-dist-partial",
      title: "部分成功测试",
      bodyHtml: [
        "<p>正文仍然保留。</p>",
        '<img data-shiguang-image="sg-img-1" alt="测试图片">'
      ].join(""),
      images: [{
        id: "sg-img-1",
        url: "https://mmbiz.qpic.cn/test-missing.png",
        alt: "测试图片"
      }],
      unsupportedMediaCount: 1,
      lossManifest: [{ type: "background-image", label: "背景图片", count: 1 }]
    });
    const result = await startAndWait(trustedPage, article);
    assert.equal(result.start.ok, true);
    assert.equal(result.job.status, "partial");
    assert.equal(result.job.failedImages, 1);
    assert.equal(result.job.unsupportedMediaCount, 1);
    assert.equal(result.job.contentLossCount, 1);

    const downloads = await waitForCompletedHtmlDownloads(trustedPage, 1);
    assert.equal(downloads.length, 1);
    const html = await readFile(downloads[0].filename, "utf8");
    assert.match(html, /正文仍然保留/);
    assert.match(html, /未能离线保存/);
    assert.match(html, /互动组件未纳入离线文件/);
    assert.match(html, /背景图片未能完整保留/);
    assert.doesNotMatch(html, /https:\/\/mmbiz\.qpic\.cn/);
  } finally {
    await context.close();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("最终 dist 的取消与单任务锁不会留下错误成品", async () => {
  const { context, tempRoot, trustedPage } = await launchExtension();
  try {
    const result = await trustedPage.evaluate(async () => {
      const articleA = {
        sourceUrl: "https://mp.weixin.qq.com/s/a-cancel",
        title: "需要取消的文章 A",
        account: "拾光测试号",
        bodyHtml: "<p>取消竞态测试</p>",
        images: Array.from({ length: 100 }, (_, index) => ({
          id: `sg-img-${index + 1}`,
          url: `https://mmbiz.qpic.cn/test-${index + 1}.png`
        })),
        unsupportedMediaCount: 0,
        lossManifest: []
      };
      const articleB = {
        sourceUrl: "https://mp.weixin.qq.com/s/b-next",
        title: "下一篇文章 B",
        account: "拾光测试号",
        bodyHtml: "<p>下一篇必须能够正常保存</p>",
        images: [],
        unsupportedMediaCount: 0,
        lossManifest: []
      };

      const first = await chrome.runtime.sendMessage({ target: "background", type: "START_ARCHIVE", article: articleA });
      const concurrent = await chrome.runtime.sendMessage({ target: "background", type: "START_ARCHIVE", article: articleB });
      const cancelled = await chrome.runtime.sendMessage({ target: "background", type: "CANCEL_JOB", jobId: first.jobId });

      let firstJob = null;
      for (let attempt = 0; attempt < 200; attempt += 1) {
        firstJob = (await chrome.runtime.sendMessage({
          target: "background",
          type: "QUERY_JOB",
          jobId: first.jobId
        }))?.job;
        if (["cancelled", "error", "success", "partial"].includes(firstJob?.status)) break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }

      let second = null;
      for (let attempt = 0; attempt < 200; attempt += 1) {
        second = await chrome.runtime.sendMessage({ target: "background", type: "START_ARCHIVE", article: articleB });
        if (second?.ok) break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      let secondJob = null;
      for (let attempt = 0; attempt < 200; attempt += 1) {
        secondJob = (await chrome.runtime.sendMessage({
          target: "background",
          type: "QUERY_JOB",
          jobId: second?.jobId
        }))?.job;
        if (["success", "partial", "error", "cancelled"].includes(secondJob?.status)) break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      return { first, concurrent, cancelled, firstJob, second, secondJob };
    });

    assert.equal(result.first.ok, true);
    assert.equal(result.concurrent.ok, false);
    assert.equal(result.concurrent.error.code, "SL-JOB-BUSY");
    assert.equal(result.cancelled.ok, true);
    assert.equal(result.firstJob.status, "cancelled");
    assert.equal(result.second.ok, true);
    assert.equal(result.secondJob.status, "success");

    const downloads = await waitForCompletedHtmlDownloads(trustedPage, 1);
    assert.equal(downloads.length, 1, "取消的文章不得留下 HTML");
    const html = await readFile(downloads[0].filename, "utf8");
    assert.match(html, /下一篇必须能够正常保存/);
    assert.doesNotMatch(html, /取消竞态测试/);
  } finally {
    await context.close();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("最终 dist 可加载弹窗且无控制台错误", async () => {
  const { context, tempRoot, extensionId } = await launchExtension();
  const runtimeErrors = [];
  try {
    const page = await context.newPage();
    page.on("pageerror", (error) => runtimeErrors.push(error.message));
    page.on("console", (message) => {
      if (["error", "warning"].includes(message.type())) runtimeErrors.push(message.text());
    });
    await page.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);
    await page.getByText("本机处理 · 反馈不含文章或链接 · 0 Token").waitFor();
    await page.getByRole("heading", { name: "请先打开一篇公开公众号文章" }).waitFor();
    assert.equal(await page.title(), "拾光存档");
    assert.deepEqual(runtimeErrors, []);
  } finally {
    await context.close();
    await rm(tempRoot, { recursive: true, force: true });
  }
});
