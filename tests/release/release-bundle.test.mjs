import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDeterministicZip, readDeterministicZip } from "../../tools/zip.mjs";
import {
  assertFriendInstallGuide,
  friendGuideFilename,
  friendGuideOutput
} from "../../tools/build.mjs";
import { friendExtensionDirectory, stageFriendPackage } from "../../tools/friend-package.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const bundle = path.join(root, "dist", "shiguang-archive-extension");
const releaseDir = path.join(root, "release");

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

async function collectFiles(directory, relative = "") {
  const entries = await readdir(path.join(directory, relative), { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name, "en"))) {
    const next = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...await collectFiles(directory, next));
    else if (entry.isFile()) files.push(next);
  }
  return files;
}

const manifest = JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8"));
const releaseManifest = JSON.parse(
  await readFile(path.join(releaseDir, "RELEASE-MANIFEST.json"), "utf8")
);

test("发布目录完整、哈希匹配且不夹带开发文件", async () => {
  const integrity = JSON.parse(await readFile(path.join(bundle, "BUILD-INTEGRITY.json"), "utf8"));
  assert.equal(integrity.product, "拾光存档");
  assert.equal(integrity.version, manifest.version);
  assert.equal(integrity.modelCalls, 0);
  assert.deepEqual(integrity.telemetryEndpoints, []);

  for (const [relative, expected] of Object.entries(integrity.files)) {
    assert.equal(sha256(await readFile(path.join(bundle, relative))), expected, relative);
  }

  for (const required of [
    "manifest.json",
    "README.md",
    "INSTALL-FIRST.md",
    "PERMISSIONS.md",
    "KNOWN-LIMITATIONS.md",
    "SUPPORT.md",
    "LICENSE.md",
    "NOTICE.md",
    "TRADEMARKS.md",
    "CONTRIBUTING.md",
    "SECURITY.md"
  ]) {
    assert.ok((await collectFiles(bundle)).includes(required), required);
  }

  for (const excluded of ["dev", "tests", "tools", "package.json", "RELEASE-CHECKLIST.md"]) {
    assert.ok(!(await collectFiles(bundle)).some((item) => item === excluded || item.startsWith(`${excluded}/`)), excluded);
  }
});

test("朋友版根目录只有安装导航和扩展文件夹，商店版仍与 dist 精确一致", async () => {
  assert.equal(releaseManifest.version, manifest.version);
  const expectedFiles = await collectFiles(bundle);
  const friendPackage = releaseManifest.packages.friend;
  const storePackage = releaseManifest.packages.chromeWebStore;
  const friendPath = path.join(releaseDir, friendPackage.file);
  const storePath = path.join(releaseDir, storePackage.file);
  const [friendFiles, storeFiles, friendBytes, storeBytes] = await Promise.all([
    readDeterministicZip(friendPath),
    readDeterministicZip(storePath),
    readFile(friendPath),
    readFile(storePath)
  ]);

  assert.equal(sha256(friendBytes), friendPackage.sha256);
  assert.equal(sha256(storeBytes), storePackage.sha256);
  assert.equal(friendPackage.guidePath, friendGuideFilename);
  assert.ok(friendFiles.has(friendGuideFilename));
  assert.ok(friendFiles.has(`${friendExtensionDirectory}/manifest.json`));
  assert.ok(!friendFiles.has("manifest.json"));
  assert.ok(storeFiles.has("manifest.json"));
  assert.ok(!storeFiles.has(`${friendExtensionDirectory}/manifest.json`));
  assert.ok(!storeFiles.has(friendGuideFilename));
  assert.deepEqual(
    [...friendFiles.keys()].sort(),
    [
      friendGuideFilename,
      ...expectedFiles.map((file) => `${friendExtensionDirectory}/${file}`)
    ].sort()
  );
  assert.deepEqual([...storeFiles.keys()].sort(), expectedFiles.sort());
  const builtGuide = await readFile(friendGuideOutput);
  const packagedGuide = friendFiles.get(friendGuideFilename);
  assert.equal(sha256(packagedGuide), sha256(builtGuide));
  assertFriendInstallGuide(packagedGuide.toString("utf8"), manifest.version);
  for (const relative of expectedFiles) {
    const distContent = await readFile(path.join(bundle, relative));
    if (relative !== "BUILD-INTEGRITY.json") {
      assert.equal(
        sha256(distContent),
        sha256(await readFile(path.join(root, relative))),
        `dist 必须与发布源一致：${relative}`
      );
    }
    assert.equal(
      sha256(friendFiles.get(`${friendExtensionDirectory}/${relative}`)),
      sha256(distContent),
      `朋友版内容必须与 dist 一致：${relative}`
    );
    assert.equal(
      sha256(storeFiles.get(relative)),
      sha256(distContent),
      `商店版内容必须与 dist 一致：${relative}`
    );
  }
});

test("相同 dist 重复打包得到完全相同的 ZIP 与 SHA-256", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "shiguang-reproducible-release-"));
  try {
    const friendInfo = releaseManifest.packages.friend;
    const friendStage = path.join(temporary, "friend-stage");
    await stageFriendPackage({
      extensionDir: bundle,
      guidePath: friendGuideOutput,
      destination: friendStage
    });
    const recreatedFriend = await createDeterministicZip({
      sourceDir: friendStage,
      destination: path.join(temporary, friendInfo.file)
    });
    assert.equal(recreatedFriend.sha256, friendInfo.sha256, "friend 必须可重复构建");

    const storeInfo = releaseManifest.packages.chromeWebStore;
    const recreatedStore = await createDeterministicZip({
      sourceDir: bundle,
      destination: path.join(temporary, storeInfo.file)
    });
    assert.equal(recreatedStore.sha256, storeInfo.sha256, "chromeWebStore 必须可重复构建");
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("SHA256.txt 同时列出两种发布包且与机器清单一致", async () => {
  const checksumText = await readFile(path.join(releaseDir, "SHA256.txt"), "utf8");
  for (const packageInfo of Object.values(releaseManifest.packages)) {
    assert.match(checksumText, new RegExp(`${packageInfo.sha256}\\s+${packageInfo.file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  }
});

test("发布根目录只保留当前版本的两个 ZIP", async () => {
  const zipEntries = (await readdir(releaseDir))
    .filter((name) => name.endsWith(".zip"))
    .sort();
  const currentPackages = Object.values(releaseManifest.packages)
    .map((packageInfo) => packageInfo.file)
    .sort();
  assert.deepEqual(zipEntries, currentPackages);
});

test("已撤回版本不得混入当前发布根目录，干净克隆不依赖历史 ZIP", async () => {
  const rootEntries = await readdir(releaseDir);
  for (const withdrawn of ["v0.1.0", "v0.2.0", "v0.2.1"]) {
    assert.ok(!rootEntries.some((name) => name.endsWith(".zip") && name.includes(withdrawn)));
  }
});
