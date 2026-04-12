import { spawn } from "node:child_process";
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  statSync,
  renameSync,
  unlinkSync,
  existsSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export function telemetryDirPath(sessionDir: string): string {
  return join(sessionDir, "telemetry");
}

export function spawnAliveSidecar(tDir: string, intervalMs = 10_000): number | null {
  mkdirSync(tDir, { recursive: true });
  try { unlinkSync(join(tDir, "shutdown")); } catch { /* may not exist */ }
  const script = [
    'const fs=require("fs"),path=require("path");',
    "const dir=process.argv[1],ms=+process.argv[2],ppid=process.ppid;",
    'const alive=path.join(dir,"alive"),shut=path.join(dir,"shutdown");',
    "const tick=()=>{",
    "  if(process.ppid!==ppid){try{fs.writeFileSync(alive,\"0\")}catch{}process.exit(0)}",
    "  if(fs.existsSync(shut)){try{fs.writeFileSync(alive,\"0\")}catch{}process.exit(0)}",
    "  try{fs.writeFileSync(alive,String(Date.now()))}catch{}",
    "};",
    "tick();setInterval(tick,ms);",
  ].join("");
  const child = spawn(process.execPath, ["-e", script, tDir, String(intervalMs)], {
    stdio: "ignore",
  });
  child.unref();
  return child.pid ?? null;
}

export function killSidecar(pid: number | undefined | null): void {
  if (!pid) return;
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // ESRCH or similar - process already dead
  }
}

export function writeShutdownMarker(sessionDir: string): void {
  const tDir = telemetryDirPath(sessionDir);
  try {
    mkdirSync(tDir, { recursive: true });
    writeFileSync(join(tDir, "shutdown"), "1");
    writeFileSync(join(tDir, "alive"), "0");
  } catch {
    // best-effort
  }
}

// ISS-407: Cache known telemetry dirs to skip redundant mkdirSync on hot path.
const _knownTelemetryDirs = new Set<string>();

export function touchLastMcpCallFile(sessionDir: string): void {
  const tDir = telemetryDirPath(sessionDir);
  const target = join(tDir, "lastMcpCall");
  const tmp = `${target}.${process.pid}.tmp`;
  try {
    if (!_knownTelemetryDirs.has(tDir)) {
      mkdirSync(tDir, { recursive: true });
      _knownTelemetryDirs.add(tDir);
    }
    writeFileSync(tmp, new Date().toISOString());
    renameSync(tmp, target);
  } catch {
    try {
      unlinkSync(tmp);
    } catch {
      // ignore cleanup errors
    }
  }
}

export function readLastMcpCall(sessionDir: string): string | null {
  try {
    return (
      readFileSync(join(telemetryDirPath(sessionDir), "lastMcpCall"), "utf-8").trim() || null
    );
  } catch {
    return null;
  }
}

export function readAliveTimestamp(sessionDir: string): number | null {
  const tDir = telemetryDirPath(sessionDir);
  if (existsSync(join(tDir, "shutdown"))) return null;
  try {
    const val = readFileSync(join(tDir, "alive"), "utf-8").trim();
    const n = Number(val);
    return n > 0 ? n : null;
  } catch {
    return null;
  }
}

export function computeBinaryFingerprint(): {
  mtime: string;
  sha256: string;
} | null {
  try {
    const thisFile = fileURLToPath(import.meta.url);
    const parentDir = dirname(dirname(thisFile));
    const candidates = [
      join(parentDir, "mcp.js"),
      join(parentDir, "dist", "mcp.js"),
    ];
    for (const p of candidates) {
      try {
        const stat = statSync(p);
        const buf = readFileSync(p);
        const sha256 = createHash("sha256").update(buf).digest("hex");
        return { mtime: stat.mtime.toISOString(), sha256 };
      } catch {
        continue;
      }
    }
    return null;
  } catch {
    return null;
  }
}

export function captureClaudeCodeSessionId(): string | null {
  return process.env.CLAUDE_CODE_SESSION_ID ?? null;
}
