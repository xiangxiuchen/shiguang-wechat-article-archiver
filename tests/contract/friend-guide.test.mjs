// SPDX-License-Identifier: MPL-2.0

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertFriendInstallGuide,
  friendGuideFilename,
  renderFriendInstallGuide
} from "../../tools/build.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const manifest = JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8"));
const source = await readFile(path.join(root, "friend", friendGuideFilename), "utf8");
const rendered = renderFriendInstallGuide(source, manifest.version);

test("朋友安装导航是自包含离线 HTML，并注入当前版本", () => {
  assert.match(rendered, /^<!doctype html>/i);
  assert.match(rendered, /Content-Security-Policy/i);
  assert.match(rendered, new RegExp(`v${manifest.version.replaceAll(".", "\\.")}`));
  assert.ok(!rendered.includes("__SHIGUANG_VERSION__"));
  assert.doesNotThrow(() => assertFriendInstallGuide(rendered, manifest.version));
  assert.doesNotMatch(rendered, /<script\b[^>]*\bsrc\s*=/i);
  assert.doesNotMatch(rendered, /<link\b[^>]*\bhref\s*=/i);
  assert.doesNotMatch(rendered, /https?:\/\//i);
  assert.doesNotMatch(rendered, /\b(?:fetch|sendBeacon|XMLHttpRequest|WebSocket|EventSource)\s*\(/i);
  assert.doesNotMatch(rendered, /<iframe\b/i);
});

test("导航覆盖 Chrome、Edge、Mac、Windows 和完整朋友使用流程", () => {
  for (const expected of [
    "chrome://extensions/",
    "edge://extensions/",
    "Windows",
    "Mac",
    "shiguang-archive-extension",
    "manifest.json",
    "固定“拾光存档”图标",
    "第一次出现“允许读取微信图片”怎么办",
    "打开已保存文章",
    "收到新版本，怎么更新",
    "怎么卸载",
    "复制安全反馈",
    "0 Token"
  ]) {
    assert.ok(rendered.includes(expected), `导航缺少：${expected}`);
  }
});

test("构建器拒绝导航页中的远程脚本或联网请求", () => {
  assert.throws(
    () => renderFriendInstallGuide(
      source.replace("</body>", '<script src="https://example.invalid/tracker.js"></script></body>'),
      manifest.version
    ),
    /不得包含远程资源/
  );
  assert.throws(
    () => renderFriendInstallGuide(
      source.replace("</body>", "<script>fetch('https://example.invalid')</script></body>"),
      manifest.version
    ),
    /不得包含远程资源/
  );
});
