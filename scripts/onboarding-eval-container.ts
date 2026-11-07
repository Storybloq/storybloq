// T-538 S5b-0: the container's shape as code: launch argv for each role (plan section 4, amendment
// A1), the seccomp profile's identity and the proxy's section 12 numbers. Nothing in the runner
// calls this yet; the conversion commit does.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const BASE_IMAGE = "node@sha256:752ea8a2f758c34002a0461bd9f1cee4f9a3c36d48494586f60ffce1fc708e0e";
export const SECCOMP_PROFILE_PATH = join(dirname(fileURLToPath(import.meta.url)), "eval-container", "seccomp-attempt.json");
/** The checked-in file's bytes, as the launch hands them to Docker. */
export const SECCOMP_FILE_SHA256 = "2cb512e0b6c5062bb05e0975de5aed06ffd4e010dcb8bce2ecb064072ffb1698";
/** The compacted form `docker inspect` shows in HostConfig.SecurityOpt. */
export const SECCOMP_COMPACT_SHA256 = "9c0f88a604fb362190d287b001f8140305cd3a5321a9628383fa97e21e42b864";
export const PROXY_UID_GID = "10001:1001";

const sha256 = (data: string | Buffer): string => createHash("sha256").update(data).digest("hex");

export const compactProfile = (bytes: string): string => JSON.stringify(JSON.parse(bytes));

/**
 * What is wrong with an inspected SecurityOpt for a role: the attempt carries exactly
 * no-new-privileges and the narrow profile, identified by the hash of the compacted string; every
 * other role carries no-new-privileges and the engine's default, so no seccomp entry at all.
 */
export function securityOptProblems(role: "attempt" | "other", securityOpt: readonly string[]): readonly string[] {
  const problems: string[] = [];
  const seccomp = securityOpt.filter((o) => o.startsWith("seccomp="));
  if (!securityOpt.includes("no-new-privileges")) problems.push("no-new-privileges is missing");
  const known = securityOpt.filter((o) => o !== "no-new-privileges" && !o.startsWith("seccomp="));
  if (known.length > 0 || securityOpt.filter((o) => o === "no-new-privileges").length > 1) problems.push("SecurityOpt carries an entry this plan does not set");
  if (role === "other") {
    if (seccomp.length > 0) problems.push("a seccomp entry on a role that runs the engine's default");
  } else if (seccomp.length !== 1 || sha256(seccomp[0]!.slice("seccomp=".length)) !== SECCOMP_COMPACT_SHA256) {
    problems.push("the seccomp entry is not the manifest's profile");
  }
  return problems;
}

/** Section 4's objects for one attempt. */
export const containerNames = (id: string) => ({
  attempt: `t538-att-${id}`,
  proxy: `t538-proxy-${id}`,
  attemptVolume: `t538-att-${id}`,
  socketVolume: `t538-sock-${id}`,
  proxyVolume: `t538-plog-${id}`,
  external: `t538-ext-${id}`,
});

const labels = (id: string, role: string): string[] => ["--label", `cpm-t538-attempt=${id}`, "--label", `cpm-t538-role=${role}`];

/** A1 point 1: deterministic ownership on a fresh socket volume and proxy-log volume, before any launch. */
export function volumeInitArgs(id: string, proxyImage: string): readonly string[] {
  const n = containerNames(id);
  return ["run", "--rm", ...labels(id, "init"), "--network", "none", "--user", "0", "--read-only", "--cap-drop", "ALL", "--cap-add", "CHOWN", "--cap-add", "FOWNER",
    "--mount", `type=volume,source=${n.socketVolume},target=/vol/sock`,
    "--mount", `type=volume,source=${n.proxyVolume},target=/vol/proxy,volume-nocopy=true`,
    "--entrypoint", "sh", proxyImage, "-c", `chown ${PROXY_UID_GID} /vol/sock /vol/proxy && chmod 750 /vol/sock && chmod 700 /vol/proxy`];
}

export interface ProxyEnv {
  readonly ALLOW: string;
  readonly EXPIRY_MS: string;
  readonly PLAIN?: string;
  readonly LIMITS?: string;
  readonly ALLOW_PRIVATE?: string;
  readonly CREDENTIAL?: string;
}

/** Section 4's proxy column as A1 changes it: its external network, its log and socket mounts, nothing else. */
export function proxyRunArgs(id: string, proxyImage: string, env: ProxyEnv): readonly string[] {
  const n = containerNames(id);
  return ["run", "-d", "--init", "--name", n.proxy, ...labels(id, "proxy"),
    "--user", PROXY_UID_GID, "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
    "--memory", "128m", "--memory-swap", "128m", "--pids-limit", "64", "--cpus", "1",
    "--network", n.external, "--sysctl", "net.ipv6.conf.all.disable_ipv6=1", "--restart", "no",
    "--mount", `type=volume,source=${n.socketVolume},target=/vol/sock`,
    "--mount", `type=volume,source=${n.proxyVolume},target=/vol/proxy,volume-nocopy=true`,
    ...Object.entries(env).flatMap(([k, v]) => ["--env", `${k}=${v as string}`]),
    "--entrypoint", "node", proxyImage, "/opt/proxy.mjs"];
}

/** Section 4's attempt launch as A1 changes it: no network interface, the project and socket mounts only. */
export function attemptRunArgs(id: string, image: string, deadlineSeconds: number, profilePath = SECCOMP_PROFILE_PATH): readonly string[] {
  const n = containerNames(id);
  return ["run", "-d", "--init", "--name", n.attempt, ...labels(id, "attempt"),
    "--user", "eval", "--read-only", "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges", "--security-opt", `seccomp=${profilePath}`,
    "--memory", "2g", "--memory-swap", "2g", "--pids-limit", "512", "--cpus", "2",
    "--tmpfs", "/tmp:rw,noexec,nosuid,nodev,size=256m",
    "--network", "none", "--sysctl", "net.ipv6.conf.all.disable_ipv6=1", "--restart", "no", "--workdir", "/vol/att/project",
    "--mount", `type=volume,source=${n.attemptVolume},target=/vol/att`,
    "--mount", `type=volume,source=${n.socketVolume},target=/vol/sock,readonly`,
    "--entrypoint", "node", image, "/opt/eval/sup.mjs", String(deadlineSeconds)];
}

export const profileBytes = (): string => readFileSync(SECCOMP_PROFILE_PATH, "utf8");
