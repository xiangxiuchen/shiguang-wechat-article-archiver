// SPDX-License-Identifier: MPL-2.0

import test from "node:test";
import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

test("开源许可证、治理文件与品牌边界完整", async () => {
  const required = [
    "LICENSE.md",
    "NOTICE.md",
    "TRADEMARKS.md",
    "CONTRIBUTING.md",
    "SECURITY.md",
    ".gitignore",
    ".gitattributes",
    ".github/workflows/ci.yml",
    ".github/ISSUE_TEMPLATE/bug.yml",
    ".github/ISSUE_TEMPLATE/feature.yml"
  ];
  await Promise.all(required.map((relative) => access(path.join(root, relative))));

  const [license, notice, trademarks] = await Promise.all([
    readFile(path.join(root, "LICENSE.md"), "utf8"),
    readFile(path.join(root, "NOTICE.md"), "utf8"),
    readFile(path.join(root, "TRADEMARKS.md"), "utf8")
  ]);
  assert.match(license, /^Mozilla Public License Version 2\.0/);
  assert.match(notice, /不适用于用户通过工具访问、保存或导出的公众号文章/);
  assert.match(trademarks, /不是拾光存档官方版本/);
});

test("开发依赖有精确锁定且不进入运行时依赖", async () => {
  const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  const lock = JSON.parse(await readFile(path.join(root, "package-lock.json"), "utf8"));
  assert.equal(packageJson.license, "MPL-2.0");
  assert.equal(packageJson.private, true, "防止误发 npm；不影响 GitHub 开源");
  assert.equal(packageJson.repository.url, "git+https://github.com/xiangxiuchen/shiguang-wechat-article-archiver.git");
  assert.equal(packageJson.dependencies, undefined);
  assert.equal(packageJson.devDependencies.playwright, "1.62.1");
  assert.equal(lock.packages["node_modules/playwright"].version, "1.62.1");
  assert.equal(lock.packages["node_modules/playwright"].dev, true);
});

test("源码仓库排除生成包、历史 ZIP 与本机缓存", async () => {
  const ignore = await readFile(path.join(root, ".gitignore"), "utf8");
  for (const entry of [".DS_Store", "/node_modules/", "/dist/", "/release/"]) {
    assert.match(ignore, new RegExp(`^${entry.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}$`, "m"));
  }
});
