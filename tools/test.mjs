// SPDX-License-Identifier: MPL-2.0

import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const input = process.argv.slice(2);
let concurrency;
const directories = [];

for (const argument of input) {
  if (argument.startsWith("--concurrency=")) {
    concurrency = argument.slice("--concurrency=".length);
  } else {
    directories.push(argument);
  }
}

if (!directories.length || directories.some((directory) => !/^[a-z0-9-]+$/i.test(directory))) {
  throw new Error("Usage: node tools/test.mjs [--concurrency=N] <test-directory> [...]");
}
if (concurrency && !/^\d+$/.test(concurrency)) {
  throw new Error("--concurrency must be a positive integer");
}

const files = [];
for (const directory of directories) {
  const testDirectory = path.join(root, "tests", directory);
  const names = await readdir(testDirectory);
  files.push(...names
    .filter((name) => name.endsWith(".test.mjs"))
    .sort()
    .map((name) => path.join(testDirectory, name)));
}

if (!files.length) throw new Error("No test files found");

const argumentsForNode = ["--test"];
if (concurrency) argumentsForNode.push(`--test-concurrency=${concurrency}`);
argumentsForNode.push(...files);

const child = spawn(process.execPath, argumentsForNode, {
  cwd: root,
  env: process.env,
  stdio: "inherit"
});

child.on("error", (error) => {
  throw error;
});

const result = await new Promise((resolve) => {
  child.on("exit", (code, signal) => resolve({ code, signal }));
});

if (result.code !== 0) {
  process.exitCode = result.code || 1;
}
