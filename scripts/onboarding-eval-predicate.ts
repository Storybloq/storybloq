// T-538 S5b-0: the launch-shape predicate (plan section 4, amendment A1). Compares `docker inspect`
// to three tables: what this plan sets, what the pinned engine and image populate, and the volatile
// fields checked for form. A key in none of the three refuses, so a later field cannot pass unnoticed.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ATTEMPT_UID_GID, containerNames, PROXY_UID_GID, type SandboxRole, securityOptProblems } from "./onboarding-eval-container.js";

export type Role = SandboxRole | "proxy" | "pack";
export interface ShapeContext {
  readonly role: Role;
  readonly id: string;
  readonly attemptId: string;
  readonly image: string;
  /** Sandbox roles: the supervisor's deadline. */
  readonly deadlineSeconds?: number;
  /** Proxy: its --env entries. */
  readonly proxyEnv?: Readonly<Record<string, string>>;
  /** Which sandbox role this proxy serves; attempt by default. */
  readonly servesRole?: SandboxRole;
  /** Pack: what it reads and how. */
  readonly pack?: { readonly volume: string; readonly target: string; readonly profile: string };
}

export const ENGINE_TABLE_PATH = join(dirname(fileURLToPath(import.meta.url)), "eval-container", "predicate-engine.json");
const engine = JSON.parse(readFileSync(ENGINE_TABLE_PATH, "utf8")) as Record<"attempt" | "proxy" | "pack", Record<string, unknown>>;

const sorted = (v: unknown): unknown => {
  if (Array.isArray(v)) return v.map(sorted);
  if (v !== null && typeof v === "object") return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sorted((v as Record<string, unknown>)[k])]));
  return v;
};
const same = (a: unknown, b: unknown): boolean => JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));
const isEmpty = (v: unknown): boolean => v === null || v === "" || (Array.isArray(v) && v.length === 0) || (typeof v === "object" && v !== null && Object.keys(v).length === 0);
const EMPTY = Symbol("empty");
/** The engine omits this key when it is unset, so being there at all is the difference. */
const ABSENT = Symbol("absent");
const IPV6 = { "net.ipv6.conf.all.disable_ipv6": "1" };
const SANDBOX_ROLES: readonly Role[] = ["attempt", "probe", "judge"];

interface MountRow { readonly Type: string; readonly Source: string; readonly Target: string; readonly ReadOnly?: boolean; readonly VolumeOptions?: { readonly DriverConfig: Record<string, never>; readonly NoCopy: boolean } }
function expectedMounts(c: ShapeContext): readonly MountRow[] {
  if (SANDBOX_ROLES.includes(c.role)) {
    const n = containerNames(c.attemptId, c.role as SandboxRole);
    return [{ Type: "volume", Source: n.attemptVolume, Target: "/vol/att" }, { Type: "volume", Source: n.socketVolume, Target: "/vol/sock", ReadOnly: true }];
  }
  if (c.role === "proxy") {
    const n = containerNames(c.attemptId, c.servesRole ?? "attempt");
    return [{ Type: "volume", Source: n.socketVolume, Target: "/vol/sock" }, { Type: "volume", Source: n.proxyVolume, Target: "/vol/proxy", VolumeOptions: { DriverConfig: {}, NoCopy: true } }];
  }
  return [{ Type: "volume", Source: c.pack!.volume, Target: c.pack!.target, ReadOnly: true }];
}
const name = (c: ShapeContext): string => {
  if (SANDBOX_ROLES.includes(c.role)) return containerNames(c.attemptId, c.role as SandboxRole).attempt;
  if (c.role === "proxy") return containerNames(c.attemptId, c.servesRole ?? "attempt").proxy;
  return containerNames(c.attemptId).pack;
};

/** Table 1: what this plan sets, by role. A symbol means "empty in whatever form the engine shows". */
function roleValues(c: ShapeContext): Record<string, unknown> {
  const box = SANDBOX_ROLES.includes(c.role);
  const shared: Record<string, unknown> = {};
  for (const k of ["Privileged", "PublishAllPorts", "AutoRemove"]) shared[`HostConfig.${k}`] = false;
  for (const k of ["PidMode", "UTSMode", "UsernsMode", "Cgroup", "Binds", "VolumesFrom", "Devices", "DeviceCgroupRules", "PortBindings", "ExtraHosts", "Links", "Dns"]) shared[`HostConfig.${k}`] = EMPTY;
  const table: Record<string, unknown> = {
    ...shared,
    "HostConfig.IpcMode": "private",
    "HostConfig.CgroupnsMode": "private",
    "HostConfig.CapDrop": ["ALL"],
    "HostConfig.CapAdd": c.role === "pack" ? ["DAC_READ_SEARCH"] : EMPTY,
    "HostConfig.ReadonlyRootfs": true,
    "HostConfig.Init": true,
    "HostConfig.Memory": (box ? 2048 : c.role === "proxy" ? 128 : 512) * 1048576,
    "HostConfig.MemorySwap": (box ? 2048 : c.role === "proxy" ? 128 : 512) * 1048576,
    "HostConfig.PidsLimit": box ? 512 : c.role === "proxy" ? 64 : 32,
    "HostConfig.NanoCpus": box ? 2e9 : 1e9,
    "HostConfig.Tmpfs": box ? { "/tmp": "rw,noexec,nosuid,nodev,size=256m" } : c.role === "pack" ? { "/tmp": "rw,noexec,nosuid,nodev,size=16m" } : ABSENT,
    "HostConfig.RestartPolicy": { Name: "no", MaximumRetryCount: 0 },
    "HostConfig.NetworkMode": c.role === "proxy" ? containerNames(c.attemptId, c.servesRole ?? "attempt").external : "none",
    "Config.User": box ? ATTEMPT_UID_GID : c.role === "proxy" ? PROXY_UID_GID : "0",
    "Config.Tty": false,
    "Config.Image": c.image,
    Image: c.image,
    Path: c.role === "pack" ? "sh" : "node",
    Args: box ? ["/opt/eval/sup.mjs", String(c.deadlineSeconds)] : c.role === "proxy" ? ["/opt/proxy.mjs"] : ["/opt/eval/pack.sh", c.pack?.profile],
    "Config.Entrypoint": [c.role === "pack" ? "sh" : "node"],
    "Config.Cmd": box ? ["/opt/eval/sup.mjs", String(c.deadlineSeconds)] : c.role === "proxy" ? ["/opt/proxy.mjs"] : ["/opt/eval/pack.sh", c.pack?.profile],
    "Config.WorkingDir": box ? "/vol/att/project" : "",
  };
  if (c.role !== "pack") table["HostConfig.Sysctls"] = IPV6;
  const running = c.role !== "pack";
  Object.assign(table, { "State.Status": running ? "running" : "created", "State.Running": running, "State.Paused": false, "State.Restarting": false, "State.OOMKilled": false, "State.Dead": false, "State.ExitCode": 0, "State.Error": "" });
  return table;
}

const HEX64 = /^[0-9a-f]{64}$/;
const isText = (v: unknown): boolean => typeof v === "string";
const isTime = (v: unknown): boolean => typeof v === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(v);
const isIpv4 = (v: unknown): boolean => typeof v === "string" && /^\d{1,3}(\.\d{1,3}){3}$/.test(v);
/** Table 3: per container, carrying no authority, checked for form. */
function volatileForms(c: ShapeContext): Record<string, (v: unknown) => boolean> {
  return {
    Id: (v) => v === c.id && HEX64.test(c.id),
    Created: isTime,
    Name: (v) => v === `/${name(c)}`,
    "Config.Hostname": (v) => v === c.id.slice(0, 12),
    LogPath: isText, HostnamePath: isText, HostsPath: isText, ResolvConfPath: isText,
    GraphDriver: (v) => v !== null && typeof v === "object",
    ExecIDs: (v) => v === null || Array.isArray(v),
    // A helper that has not started has no process; anything running has one.
    "State.Pid": (v) => Number.isInteger(v) && (c.role === "pack" ? v === 0 : (v as number) > 0),
    "State.StartedAt": isTime, "State.FinishedAt": isTime,
    "NetworkSettings.SandboxID": isText, "NetworkSettings.SandboxKey": isText,
    "NetworkSettings.EndpointID": isText,
    // Only the proxy has a network, so only its addresses are volatile; everyone else's stay table values.
    ...(c.role === "proxy" ? { "NetworkSettings.Gateway": isText, "NetworkSettings.IPAddress": isText, "NetworkSettings.IPPrefixLen": Number.isInteger, "NetworkSettings.MacAddress": isText } : {}),
  };
}

const SECTIONS = ["HostConfig", "Config", "NetworkSettings", "State"];

/** Every endpoint key is fixed, or volatile with a form; any other key refuses. */
function endpointProblems(c: ShapeContext, network: string, ep: Record<string, unknown>): string[] {
  const proxy = c.role === "proxy";
  const fixed: Record<string, unknown> = { Aliases: proxy ? [c.id.slice(0, 12)] : null, DriverOpts: null, GlobalIPv6Address: "", GlobalIPv6PrefixLen: 0, IPAMConfig: null, IPv6Gateway: "", Links: null };
  if (!proxy) Object.assign(fixed, { Gateway: "", IPAddress: "", IPPrefixLen: 0, MacAddress: "" });
  const networkId = (v: unknown): boolean => (c.role === "pack" ? v === "" : typeof v === "string" && HEX64.test(v));
  const forms: Record<string, (v: unknown) => boolean> = { EndpointID: networkId, NetworkID: networkId };
  if (proxy) Object.assign(forms, { Gateway: isIpv4, IPAddress: isIpv4, IPPrefixLen: Number.isInteger, MacAddress: isText });
  const out: string[] = [];
  const at = `NetworkSettings.Networks.${network}`;
  for (const [k, v] of Object.entries(ep)) {
    if (Object.hasOwn(forms, k)) { if (!forms[k]!(v)) out.push(`${at}.${k}: the wrong form`); }
    else if (!Object.hasOwn(fixed, k)) out.push(`${at}.${k}: an unknown key`);
    else if (!same(v, fixed[k])) out.push(`${at}.${k}: differs from the manifest`);
  }
  for (const k of [...Object.keys(fixed), ...Object.keys(forms)]) if (!Object.hasOwn(ep, k)) out.push(`${at}.${k}: missing`);
  return out;
}

function networkProblems(c: ShapeContext, ns: Record<string, unknown>): string[] {
  const nets = (ns.Networks ?? {}) as Record<string, Record<string, unknown>>;
  const wanted = c.role === "proxy" ? containerNames(c.attemptId, c.servesRole ?? "attempt").external : "none";
  const out: string[] = [];
  if (!same(Object.keys(nets), [wanted])) out.push("NetworkSettings.Networks: not exactly this role's network");
  else if (nets[wanted] === null || typeof nets[wanted] !== "object") out.push(`NetworkSettings.Networks.${wanted}: not an endpoint`);
  else out.push(...endpointProblems(c, wanted, nets[wanted]));
  if (!isEmpty(ns.Ports)) out.push("NetworkSettings.Ports: a published port");
  return out;
}

const byKey = (rows: unknown, key: string): unknown[] => (Array.isArray(rows) ? [...rows].sort((a, b) => String(a?.[key]).localeCompare(String(b?.[key]))) : []);

/** Both views compared whole, so a mount option or a key the plan does not set cannot pass. */
function mountProblems(c: ShapeContext, hc: Record<string, unknown>, top: unknown): string[] {
  const want = expectedMounts(c);
  const out: string[] = [];
  if (!same(hc.Mounts, want)) out.push("HostConfig.Mounts: not exactly this role's mounts");
  const seen = want.map((m) => ({ Destination: m.Target, Driver: "local", Mode: "z", Name: m.Source, Propagation: "", RW: m.ReadOnly !== true, Source: `/var/lib/docker/volumes/${m.Source}/_data`, Type: m.Type }));
  if (!same(byKey(top, "Destination"), byKey(seen, "Destination"))) out.push("Mounts: not exactly this role's mounts");
  return out;
}

const CUSTOM = new Set(["HostConfig.SecurityOpt", "HostConfig.Mounts", "Mounts", "Config.Env", "Config.Labels", "NetworkSettings.Networks", "NetworkSettings.Ports"]);

/** Every difference from the manifest's shape; empty means it holds. */
export function shapeProblems(doc: unknown, c: ShapeContext): readonly string[] {
  const d = doc as Record<string, Record<string, unknown>>;
  if (d === null || typeof d !== "object") return ["no inspect document"];
  const table = engine[SANDBOX_ROLES.includes(c.role) ? "attempt" : (c.role as "proxy" | "pack")];
  const expected: Record<string, unknown> = { ...table, ...roleValues(c) };
  const forms = volatileForms(c);
  const problems: string[] = [];
  const seen = new Set<string>();
  const check = (path: string, value: unknown): void => {
    seen.add(path);
    if (CUSTOM.has(path)) return;
    if (Object.hasOwn(forms, path)) { if (!forms[path]!(value)) problems.push(`${path}: the wrong form`); return; }
    if (!Object.hasOwn(expected, path)) { problems.push(`${path}: an unknown key`); return; }
    const want = expected[path];
    if (want === ABSENT) { problems.push(`${path}: present, and this role leaves it unset`); return; }
    if (want === EMPTY ? !isEmpty(value) : !same(value, want)) problems.push(`${path}: differs from the manifest`);
  };
  for (const [k, v] of Object.entries(d)) {
    if (SECTIONS.includes(k)) {
      if (v === null || typeof v !== "object") problems.push(`${k}: not a section`);
      else for (const [kk, vv] of Object.entries(v)) check(`${k}.${kk}`, vv);
    } else check(k, v);
  }
  for (const path of new Set([...Object.keys(expected), ...Object.keys(forms), ...CUSTOM])) if (!seen.has(path) && expected[path] !== ABSENT) problems.push(`${path}: missing`);
  const hc = d.HostConfig ?? {};
  const cfg = d.Config ?? {};
  problems.push(...securityOptProblems(SANDBOX_ROLES.includes(c.role) ? "attempt" : "other", (Array.isArray(hc.SecurityOpt) ? hc.SecurityOpt : []) as string[]));
  problems.push(...mountProblems(c, hc, d.Mounts));
  problems.push(...networkProblems(c, d.NetworkSettings ?? {}));
  const wantEnv = [...(table["Config.Env"] as string[]), ...Object.entries(c.proxyEnv ?? {}).map(([k, v]) => `${k}=${v}`)].sort();
  if (!same([...((Array.isArray(cfg.Env) ? cfg.Env : []) as string[])].sort(), wantEnv)) problems.push("Config.Env: not exactly the image's and this role's");
  const wantLabels = { ...(table["Config.Labels"] as object), "cpm-t538-attempt": c.attemptId, "cpm-t538-role": c.role };
  if (!same(cfg.Labels, wantLabels)) problems.push("Config.Labels: not this attempt's and role's");
  return problems;
}

/** Goes in the manifest: table 2 is a fact about one pinned engine and image. */
export const engineTableHash = (): string => createHash("sha256").update(readFileSync(ENGINE_TABLE_PATH)).digest("hex");

/** Goes in the attempt's record. */
export const inspectHash = (doc: unknown): string => createHash("sha256").update(JSON.stringify(doc)).digest("hex");
