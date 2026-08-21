// SPDX-License-Identifier: MPL-2.0

import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { deflateRawSync, inflateRawSync } from "node:zlib";

const CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return value >>> 0;
});

function crc32(content) {
  let crc = 0xffffffff;
  for (const byte of content) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

async function collectFiles(root, relative = "") {
  const entries = await readdir(path.join(root, relative), { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name, "en"))) {
    const next = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...await collectFiles(root, next));
    else if (entry.isFile()) files.push(next);
    else throw new Error(`发布目录不允许符号链接或特殊文件：${next}`);
  }
  return files;
}

function localHeader(name, crc, compressedSize, size) {
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(0x0800, 6);
  header.writeUInt16LE(8, 8);
  header.writeUInt16LE(0, 10);
  header.writeUInt16LE(0x0021, 12);
  header.writeUInt32LE(crc, 14);
  header.writeUInt32LE(compressedSize, 18);
  header.writeUInt32LE(size, 22);
  header.writeUInt16LE(name.length, 26);
  header.writeUInt16LE(0, 28);
  return header;
}

function centralHeader(name, crc, compressedSize, size, offset) {
  const header = Buffer.alloc(46);
  header.writeUInt32LE(0x02014b50, 0);
  header.writeUInt16LE(0x0314, 4);
  header.writeUInt16LE(20, 6);
  header.writeUInt16LE(0x0800, 8);
  header.writeUInt16LE(8, 10);
  header.writeUInt16LE(0, 12);
  header.writeUInt16LE(0x0021, 14);
  header.writeUInt32LE(crc, 16);
  header.writeUInt32LE(compressedSize, 20);
  header.writeUInt32LE(size, 24);
  header.writeUInt16LE(name.length, 28);
  header.writeUInt16LE(0, 30);
  header.writeUInt16LE(0, 32);
  header.writeUInt16LE(0, 34);
  header.writeUInt16LE(0, 36);
  header.writeUInt32LE((0o100644 * 0x10000) >>> 0, 38);
  header.writeUInt32LE(offset, 42);
  return header;
}

function endOfCentralDirectory(count, centralSize, centralOffset) {
  const record = Buffer.alloc(22);
  record.writeUInt32LE(0x06054b50, 0);
  record.writeUInt16LE(0, 4);
  record.writeUInt16LE(0, 6);
  record.writeUInt16LE(count, 8);
  record.writeUInt16LE(count, 10);
  record.writeUInt32LE(centralSize, 12);
  record.writeUInt32LE(centralOffset, 16);
  record.writeUInt16LE(0, 20);
  return record;
}

export async function createDeterministicZip({ sourceDir, destination, prefix = "" }) {
  const files = await collectFiles(sourceDir);
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const relative of files) {
    const content = await readFile(path.join(sourceDir, relative));
    const compressed = deflateRawSync(content, { level: 9 });
    const archiveName = `${prefix}${relative}`.replaceAll(path.sep, "/");
    const name = Buffer.from(archiveName, "utf8");
    const crc = crc32(content);
    const header = localHeader(name, crc, compressed.length, content.length);
    localParts.push(header, name, compressed);
    centralParts.push(centralHeader(name, crc, compressed.length, content.length, offset), name);
    offset += header.length + name.length + compressed.length;
  }

  const central = Buffer.concat(centralParts);
  const archive = Buffer.concat([
    ...localParts,
    central,
    endOfCentralDirectory(files.length, central.length, offset)
  ]);
  await writeFile(destination, archive);
  return { files, sha256: createHash("sha256").update(archive).digest("hex") };
}

function assertSafeEntryName(name) {
  if (!name || name.startsWith("/") || name.includes("\\")) {
    throw new Error(`ZIP 包含不安全路径：${name}`);
  }
  const segments = name.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error(`ZIP 包含不安全路径：${name}`);
  }
}

export async function readDeterministicZip(target) {
  const archive = await readFile(target);
  const files = new Map();
  let offset = 0;
  while (offset + 4 <= archive.length && archive.readUInt32LE(offset) === 0x04034b50) {
    const flags = archive.readUInt16LE(offset + 6);
    const method = archive.readUInt16LE(offset + 8);
    const expectedCrc = archive.readUInt32LE(offset + 14);
    const compressedSize = archive.readUInt32LE(offset + 18);
    const size = archive.readUInt32LE(offset + 22);
    const nameLength = archive.readUInt16LE(offset + 26);
    const extraLength = archive.readUInt16LE(offset + 28);
    if (flags !== 0x0800 || method !== 8) throw new Error("ZIP 格式不符合拾光可重复发布规范");
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    const name = archive.subarray(nameStart, nameStart + nameLength).toString("utf8");
    assertSafeEntryName(name);
    if (files.has(name)) throw new Error(`ZIP 包含重复文件：${name}`);
    const compressed = archive.subarray(dataStart, dataStart + compressedSize);
    const content = inflateRawSync(compressed);
    if (content.length !== size || crc32(content) !== expectedCrc) {
      throw new Error(`ZIP 文件校验失败：${name}`);
    }
    files.set(name, content);
    offset = dataStart + compressedSize;
  }
  if (!files.size || archive.readUInt32LE(offset) !== 0x02014b50) {
    throw new Error("ZIP 中央目录缺失或包为空");
  }
  return files;
}

export async function extractDeterministicZip(target, destination) {
  const files = await readDeterministicZip(target);
  for (const [name, content] of files) {
    const output = path.join(destination, ...name.split("/"));
    await mkdir(path.dirname(output), { recursive: true });
    await writeFile(output, content);
  }
  return files;
}
