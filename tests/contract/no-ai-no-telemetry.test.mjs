// SPDX-License-Identifier: MPL-2.0

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const runtimeFiles = [
  "manifest.json",
  "src/shared/policy.js",
  "src/shared/download-state.js",
  "src/shared/archive.js",
  "src/content/extractor-core.js",
  "src/content/content-script.js",
  "src/background/service-worker.js",
  "src/offscreen/offscreen.js",
  "src/popup/popup.js",
  "src/popup/popup-helpers.js"
];

const sources = new Map(
  await Promise.all(runtimeFiles.map(async (relative) => [
    relative,
    await readFile(path.join(root, relative), "utf8")
  ]))
);

test("运行代码不包含模型、统计或开发者服务端", () => {
  const joined = Array.from(sources.values()).join("\n");
  for (const pattern of [
    /api\.openai\.com/i,
    /anthropic\.com/i,
    /generativelanguage\.googleapis\.com/i,
    /segment\.com/i,
    /google-analytics\.com/i,
    /mixpanel/i,
    /sentry\.io/i,
    /posthog/i,
    /api[_-]?key/i
  ]) {
    assert.doesNotMatch(joined, pattern);
  }
});

test("网络能力只有受控图片下载入口", () => {
  for (const [relative, source] of sources) {
    const fetchCount = (source.match(/\bfetch\s*\(/g) || []).length;
    if (relative === "src/offscreen/offscreen.js") assert.equal(fetchCount, 1);
    else assert.equal(fetchCount, 0, `${relative} 不应调用 fetch`);
    assert.doesNotMatch(source, /XMLHttpRequest|sendBeacon|WebSocket|EventSource/);
  }
});

test("图片聚合预算命中后不再启动后续下载或解码", () => {
  const policy = sources.get("src/shared/policy.js");
  const offscreen = sources.get("src/offscreen/offscreen.js");
  for (const token of [
    "maxImageFramePixels",
    "maxTotalImagePixels",
    "maxTotalFramePixels",
    "assertDecodedRasterBudget",
    "reserveRasterBudget"
  ]) {
    assert.match(policy, new RegExp(`\\b${token}\\b`));
  }
  assert.match(offscreen, /budget\.controller\.abort\(error\)/);
  assert.match(offscreen, /createLinkedController\(jobSignal, budget\.controller\.signal\)/);
  assert.match(offscreen, /throwIfAggregateBudgetExhausted\(budget, true\);[\s\S]*?fetch\(imageUrl\.href/);
  assert.match(offscreen, /throwIfAggregateBudgetExhausted\(budget\);[\s\S]*?reserveRasterBudget\(budget\.raster, metadata\);[\s\S]*?createImageBitmap/);
  assert.match(offscreen, /assertDecodedRasterBudget\(metadata, bitmap\.width, bitmap\.height\)/);
  assert.match(offscreen, /error\?\.code === "SL-IMG-25"[\s\S]*?markAggregateBudgetExhausted\(budget, error\)/);
  assert.match(offscreen, /if \(budget\.exhausted\) \{[\s\S]*?reader\.cancel\(budget\.exhausted\)/);
  assert.match(offscreen, /if \(budget\.exhausted\)[\s\S]*?ok: false[\s\S]*?else \{[\s\S]*?fetchImage/);
});

test("扩展 UI 不把远程内容写入 innerHTML", () => {
  assert.doesNotMatch(sources.get("src/popup/popup.js"), /\.innerHTML\s*=/);
});
