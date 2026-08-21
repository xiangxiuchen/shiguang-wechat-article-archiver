// SPDX-License-Identifier: MPL-2.0

import test from "node:test";
import assert from "node:assert/strict";
import { readFile, access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const manifest = JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8"));

test("Manifest V3 使用最小权限", () => {
  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual(manifest.permissions, ["activeTab", "scripting", "downloads", "downloads.open", "offscreen"]);
  assert.equal(manifest.minimum_chrome_version, "123");
  assert.equal(manifest.homepage_url, "https://github.com/xiangxiuchen/shiguang-wechat-article-archiver");
  assert.deepEqual(manifest.optional_host_permissions, ["https://mmbiz.qpic.cn/*"]);
  for (const forbidden of ["tabs", "cookies", "history", "webRequest", "nativeMessaging", "unlimitedStorage", "<all_urls>"]) {
    assert.ok(!JSON.stringify(manifest).includes(`"${forbidden}"`), `不应包含 ${forbidden}`);
  }
  assert.equal(manifest.content_scripts, undefined);
  assert.equal(manifest.externally_connectable, undefined);
});

test("扩展 CSP 只允许微信图片 CDN 外联", () => {
  const csp = manifest.content_security_policy.extension_pages;
  assert.match(csp, /connect-src https:\/\/mmbiz\.qpic\.cn/);
  assert.match(csp, /object-src 'none'/);
  assert.doesNotMatch(csp, /https:\/\/\*/);
});

test("Manifest 引用的运行文件都存在", async () => {
  const files = [
    manifest.action.default_popup,
    manifest.background.service_worker,
    ...Object.values(manifest.icons),
    "src/offscreen/offscreen.html"
  ];
  await Promise.all(files.map((relative) => access(path.join(root, relative))));
});
