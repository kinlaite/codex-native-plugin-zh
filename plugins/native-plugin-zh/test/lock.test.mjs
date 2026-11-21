import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const pathsUrl = pathToFileURL(
  fileURLToPath(new URL("../lib/paths.mjs", import.meta.url)),
).href;

const childCode = `
import fs from "node:fs";
import { withLock } from ${JSON.stringify(pathsUrl)};

const output = process.env.NATIVE_ZH_LOCK_TEST_OUTPUT;
const holdMs = Number(process.env.NATIVE_ZH_LOCK_TEST_HOLD_MS || 500);
const result = await withLock(async () => {
  fs.appendFileSync(output, "E " + process.pid + " " + Date.now() + "\\n");
  await new Promise((resolve) => setTimeout(resolve, holdMs));
  fs.appendFileSync(output, "X " + process.pid + " " + Date.now() + "\\n");
});
if (result?.skipped && result.reason !== "locked") process.exit(2);
`;

function runChild(dataDir, output, holdMs = 500) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", childCode], {
      env: {
        ...process.env,
        CODEX_PLUGIN_ZH_DATA_DIR: dataDir,
        NATIVE_ZH_LOCK_TEST_OUTPUT: output,
        NATIVE_ZH_LOCK_TEST_HOLD_MS: String(holdMs),
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`lock child exited ${code}: ${stderr.slice(-2000)}`));
    });
  });
}

function readEvents(file) {
  return fs
    .readFileSync(file, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const [kind, pid, time] = line.split(" ");
      return { kind, pid, time: Number(time) };
    })
    .sort((left, right) => left.time - right.time || (left.kind === "X" ? -1 : 1));
}

function maxConcurrent(events) {
  const active = new Set();
  let maximum = 0;
  for (const event of events) {
    if (event.kind === "E") active.add(event.pid);
    else active.delete(event.pid);
    maximum = Math.max(maximum, active.size);
  }
  return maximum;
}

async function waitUntil(check, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("等待锁测试条件超时");
}

test("serializes simultaneous lock acquisition", { timeout: 30000 }, async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "native-zh-lock-race-"));
  const output = path.join(dataDir, "entrants.txt");
  fs.writeFileSync(output, "");
  try {
    await Promise.all(Array.from({ length: 12 }, () => runChild(dataDir, output)));
    const events = readEvents(output);
    assert.ok(events.some((event) => event.kind === "E"));
    assert.equal(maxConcurrent(events), 1);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("ignores a stale diagnostic lock file", { timeout: 30000 }, async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "native-zh-lock-stale-"));
  const output = path.join(dataDir, "entrants.txt");
  fs.writeFileSync(output, "");
  fs.writeFileSync(
    path.join(dataDir, "sync.lock"),
    `${JSON.stringify({
      pid: 987654,
      startedAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
    })}\n`,
    "utf8",
  );
  try {
    await runChild(dataDir, output, 20);
    const events = readEvents(output);
    assert.equal(events.filter((event) => event.kind === "E").length, 1);
    assert.equal(fs.existsSync(path.join(dataDir, "sync.lock")), false);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("releases the system lock after the holder is killed", { timeout: 30000 }, async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "native-zh-lock-killed-"));
  const holderOutput = path.join(dataDir, "holder.txt");
  const nextOutput = path.join(dataDir, "next.txt");
  fs.writeFileSync(holderOutput, "");
  fs.writeFileSync(nextOutput, "");
  const holder = spawn(process.execPath, ["--input-type=module", "-e", childCode], {
    env: {
      ...process.env,
      CODEX_PLUGIN_ZH_DATA_DIR: dataDir,
      NATIVE_ZH_LOCK_TEST_OUTPUT: holderOutput,
      NATIVE_ZH_LOCK_TEST_HOLD_MS: "60000",
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let stderr = "";
  holder.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  try {
    await waitUntil(() => readEvents(holderOutput).some((event) => event.kind === "E"));
    const exited = new Promise((resolve, reject) => {
      holder.once("exit", resolve);
      holder.once("error", reject);
    });
    holder.kill();
    await exited;
    await runChild(dataDir, nextOutput, 20);
    const events = readEvents(nextOutput);
    assert.equal(events.filter((event) => event.kind === "E").length, 1);
    assert.equal(fs.existsSync(path.join(dataDir, "sync.lock")), false);
  } catch (error) {
    throw new Error(`${error.message}: ${stderr.slice(-2000)}`);
  } finally {
    if (holder.exitCode === null && holder.signalCode === null) holder.kill();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
