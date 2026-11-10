// T-538 S5b-0 commit 3: the launch-shape predicate against fixtures taken from real containers started
// by the shipped launch functions (plan section 4, amendment A1). Each dangerous change must refuse;
// the unchanged fixture of every role must pass. Real containers are in t538-transport.docker.test.ts.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ENGINE_TABLE_PATH, engineTableHash, inspectHash, type Role, shapeProblems, type ShapeContext } from "../../scripts/onboarding-eval-predicate.js";

const ROLES: readonly Role[] = ["attempt", "probe", "judge", "proxy", "pack"];
const fixture = (role: Role): any => JSON.parse(readFileSync(join(import.meta.dirname, "..", "fixtures", "t538-container", `inspect-${role}.json`), "utf8"));
const ctx = (role: Role, doc: any): ShapeContext => ({
  role, id: doc.Id, attemptId: "c3cap", image: doc.Image, deadlineSeconds: 600,
  ...(role === "proxy" ? { proxyEnv: { ALLOW: "sink:8080", EXPIRY_MS: "600000" } } : {}),
  ...(role === "pack" ? { pack: { volume: "t538-att-c3cap", target: "/vol/att", profile: "project" } } : {}),
});
const problemsAfter = (role: Role, change: (d: any) => void): readonly string[] => {
  const doc = fixture(role);
  const c = ctx(role, doc);
  change(doc);
  return shapeProblems(doc, c);
};

describe("the launch-shape predicate", () => {
  it.each(ROLES)("%s: the fixture from the shipped launch passes unchanged", (role) => {
    expect(problemsAfter(role, () => {})).toEqual([]);
  });

  const DANGEROUS: readonly (readonly [string, (d: any) => void])[] = [
    ["Privileged", (d) => { d.HostConfig.Privileged = true; }],
    ["a capability added", (d) => { d.HostConfig.CapAdd = ["SYS_ADMIN"]; }],
    ["capabilities not dropped", (d) => { d.HostConfig.CapDrop = null; }],
    ["a bind", (d) => { d.HostConfig.Binds = ["/:/host"]; }],
    ["a device", (d) => { d.HostConfig.Devices = [{ PathOnHost: "/dev/kvm", PathInContainer: "/dev/kvm", CgroupPermissions: "rwm" }]; }],
    ["a device rule", (d) => { d.HostConfig.DeviceCgroupRules = ["a *:* rwm"]; }],
    ["host pid", (d) => { d.HostConfig.PidMode = "host"; }],
    ["host ipc", (d) => { d.HostConfig.IpcMode = "host"; }],
    ["host uts", (d) => { d.HostConfig.UTSMode = "host"; }],
    ["host network", (d) => { d.HostConfig.NetworkMode = "host"; }],
    ["host user namespace", (d) => { d.HostConfig.UsernsMode = "host"; }],
    ["host cgroup namespace", (d) => { d.HostConfig.CgroupnsMode = "host"; }],
    ["seccomp off", (d) => { d.HostConfig.SecurityOpt = ["no-new-privileges", "seccomp=unconfined"]; }],
    ["apparmor off", (d) => { d.HostConfig.SecurityOpt = [...d.HostConfig.SecurityOpt, "apparmor=unconfined"]; }],
    ["privileges not held down", (d) => { d.HostConfig.SecurityOpt = d.HostConfig.SecurityOpt.filter((o: string) => o !== "no-new-privileges"); }],
    ["empty MaskedPaths", (d) => { d.HostConfig.MaskedPaths = []; }],
    ["empty ReadonlyPaths", (d) => { d.HostConfig.ReadonlyPaths = []; }],
    ["an extra host", (d) => { d.HostConfig.ExtraHosts = ["evil:1.2.3.4"]; }],
    ["VolumesFrom", (d) => { d.HostConfig.VolumesFrom = ["other"]; }],
    ["a different runtime", (d) => { d.HostConfig.Runtime = "other"; }],
    ["an extra sysctl", (d) => { d.HostConfig.Sysctls = { ...d.HostConfig.Sysctls, "net.ipv4.ip_forward": "1" }; }],
    ["an extra env entry", (d) => { d.Config.Env = [...d.Config.Env, "EXTRA=1"]; }],
    ["a different entrypoint", (d) => { d.Config.Entrypoint = ["other"]; }],
    ["a different command", (d) => { d.Args = ["/other.mjs"]; }],
    ["an unknown HostConfig key", (d) => { d.HostConfig.NewKnob = 1; }],
    ["an unknown Config key", (d) => { d.Config.NewKnob = 1; }],
    ["an unknown top key", (d) => { d.NewKnob = 1; }],
    ["an unknown state key", (d) => { d.State.NewKnob = 1; }],
    ["a known key gone", (d) => { delete d.HostConfig.LogConfig; }],
    ["root filesystem writable", (d) => { d.HostConfig.ReadonlyRootfs = false; }],
    ["no init", (d) => { d.HostConfig.Init = false; }],
    ["a different memory ceiling", (d) => { d.HostConfig.Memory *= 2; }],
    ["swap beyond memory", (d) => { d.HostConfig.MemorySwap = -1; }],
    ["a different pid ceiling", (d) => { d.HostConfig.PidsLimit += 1; }],
    ["a different cpu ceiling", (d) => { d.HostConfig.NanoCpus += 1; }],
    ["a different user", (d) => { d.Config.User = "2000:2000"; }],
    ["a restart policy", (d) => { d.HostConfig.RestartPolicy = { Name: "always", MaximumRetryCount: 0 }; }],
    ["an extra mount", (d) => { const m = { Type: "volume", Source: "x", Target: "/x" }; d.HostConfig.Mounts = [...d.HostConfig.Mounts, m]; }],
    ["a mount the config does not show", (d) => { d.Mounts = [...d.Mounts, { Type: "volume", Name: "x", Destination: "/x", RW: true }]; }],
    ["a published port", (d) => { d.HostConfig.PortBindings = { "80/tcp": [{ HostIp: "", HostPort: "80" }] }; }],
    ["a port in the network state", (d) => { d.NetworkSettings.Ports = { "80/tcp": null }; }],
    ["a second network", (d) => { d.NetworkSettings.Networks = { ...d.NetworkSettings.Networks, bridge: {} }; }],
    ["a DNS override", (d) => { d.HostConfig.Dns = ["8.8.8.8"]; }],
    ["a different image", (d) => { d.Image = "sha256:other"; }],
    ["a different configured image", (d) => { d.Config.Image = "other"; }],
    ["another attempt's label", (d) => { d.Config.Labels["cpm-t538-attempt"] = "other"; }],
    ["another role's label", (d) => { d.Config.Labels["cpm-t538-role"] = "other"; }],
    ["an extra label", (d) => { d.Config.Labels.extra = "1"; }],
    ["another container's id", (d) => { d.Id = "0".repeat(64); }],
    ["another container's name", (d) => { d.Name = "/other"; }],
    ["a hostname that is not the id's", (d) => { d.Config.Hostname = "other"; }],
    ["paused", (d) => { d.State.Paused = true; }],
    ["restarting", (d) => { d.State.Restarting = true; }],
    ["a tty", (d) => { d.Config.Tty = true; }],
  ];
  describe.each(ROLES)("%s", (role) => {
    it.each(DANGEROUS)("refuses %s", (_name, change) => {
      expect(problemsAfter(role, change).length).toBeGreaterThan(0);
    });
  });

  describe.each(ROLES)("%s: every field is required", (role) => {
    const doc = fixture(role);
    const paths: string[] = [];
    for (const [k, v] of Object.entries(doc)) {
      paths.push(k);
      if (["HostConfig", "Config", "NetworkSettings", "State"].includes(k)) for (const kk of Object.keys(v as object)) paths.push(`${k}.${kk}`);
    }
    it.each(paths)("refuses %s gone", (path) => {
      const [a, b] = path.split(".");
      expect(problemsAfter(role, (d) => { if (b === undefined) delete d[a!]; else delete d[a!][b]; }).join()).toContain(path);
    });
    const net = Object.keys(doc.NetworkSettings.Networks)[0]!;
    it.each(Object.keys(doc.NetworkSettings.Networks[net]))("refuses endpoint key %s gone", (key) => {
      expect(problemsAfter(role, (d) => { delete d.NetworkSettings.Networks[net][key]; }).join()).toContain(key);
    });
    it.each<[number, string]>(doc.HostConfig.Mounts.flatMap((m: object, i: number) => Object.keys(m).map((k): [number, string] => [i, k])))("refuses mount %i key %s gone", (i, key) => {
      expect(problemsAfter(role, (d) => { delete d.HostConfig.Mounts[i][key]; }).join()).toContain("HostConfig.Mounts");
    });
    it.each<[number, string]>(doc.Mounts.flatMap((m: object, i: number) => Object.keys(m).map((k): [number, string] => [i, k])))("refuses shown mount %i key %s gone", (i, key) => {
      expect(problemsAfter(role, (d) => { delete d.Mounts[i][key]; }).join()).toContain("Mounts");
    });
    it.each([["a word", "x"], ["a fraction", 1.5], ["null", null], ["a negative", -1]])("refuses State.Pid as %s", (_n, v) => {
      expect(problemsAfter(role, (d) => { d.State.Pid = v; }).join()).toContain("State.Pid");
    });
    it.each(["State.StartedAt", "State.FinishedAt", "Created"])("refuses %s of the wrong type", (path) => {
      for (const v of ["yesterday", 5, null, ""]) {
        const [a, b] = path.split(".");
        expect(problemsAfter(role, (d) => { if (b === undefined) d[a!] = v; else d[a!][b] = v; }).join()).toContain(path);
      }
    });
    it.each([["OOMKilled", true], ["Dead", true], ["ExitCode", 1], ["Error", "boom"]])("refuses State.%s as %j", (k, v) => {
      expect(problemsAfter(role, (d) => { d.State[k as string] = v; }).join()).toContain(`State.${k}`);
    });
    it("refuses an extra mount option and an extra endpoint property", () => {
      expect(problemsAfter(role, (d) => { d.HostConfig.Mounts[0].BindOptions = { Propagation: "shared" }; }).join()).toContain("HostConfig.Mounts");
      expect(problemsAfter(role, (d) => { d.HostConfig.Mounts[0].Consistency = "cached"; }).join()).toContain("HostConfig.Mounts");
      expect(problemsAfter(role, (d) => { d.Mounts[0].Extra = 1; }).join()).toContain("Mounts");
      expect(problemsAfter(role, (d) => { d.Mounts[0].Propagation = "shared"; }).join()).toContain("Mounts");
      expect(problemsAfter(role, (d) => { d.Mounts[0].Mode = "rw"; }).join()).toContain("Mounts");
      expect(problemsAfter(role, (d) => { d.NetworkSettings.Networks[net].DNSNames = ["x"]; }).join()).toContain("DNSNames: an unknown key");
      expect(problemsAfter(role, (d) => { d.NetworkSettings.Networks[net].DriverOpts = { a: "b" }; }).join()).toContain("DriverOpts");
      expect(problemsAfter(role, (d) => { d.NetworkSettings.Networks[net].IPAMConfig = { IPv4Address: "1.2.3.4" }; }).join()).toContain("IPAMConfig");
      expect(problemsAfter(role, (d) => { d.NetworkSettings.Networks[net].Aliases = ["evil"]; }).join()).toContain("Aliases");
      expect(problemsAfter(role, (d) => { d.NetworkSettings.Networks[net].NetworkID = "other"; }).join()).toContain("NetworkID");
      expect(problemsAfter(role, (d) => { d.NetworkSettings.Networks[net].EndpointID = "other"; }).join()).toContain("EndpointID");
    });
  });
  it("a sandbox with a process id of 0 refuses, and a helper with one refuses", () => {
    expect(problemsAfter("attempt", (d) => { d.State.Pid = 0; }).join()).toContain("State.Pid");
    expect(problemsAfter("pack", (d) => { d.State.Pid = 5; }).join()).toContain("State.Pid");
  });
  it("the proxy refuses a tmpfs by being there at all, and its endpoint address must be an address", () => {
    expect(problemsAfter("proxy", (d) => { d.HostConfig.Tmpfs = {}; }).join()).toContain("Tmpfs");
    const net = Object.keys(fixture("proxy").NetworkSettings.Networks)[0]!;
    expect(problemsAfter("proxy", (d) => { d.NetworkSettings.Networks[net].IPAddress = "here"; }).join()).toContain("IPAddress");
    expect(problemsAfter("proxy", (d) => { d.NetworkSettings.Networks[net].Gateway = 5; }).join()).toContain("Gateway");
    expect(problemsAfter("proxy", (d) => { d.NetworkSettings.Networks[net].IPPrefixLen = "16"; }).join()).toContain("IPPrefixLen");
    expect(problemsAfter("proxy", (d) => { d.NetworkSettings.Networks[net].MacAddress = 5; }).join()).toContain("MacAddress");
  });
  it.each(["attempt", "probe", "judge", "proxy"] as const)("%s refuses a stopped container", (role) => {
    expect(problemsAfter(role, (d) => { d.State.Status = "exited"; d.State.Running = false; }).join()).toContain("State.Status");
  });
  it("the helper is judged before it starts, so a running one refuses", () => {
    expect(problemsAfter("pack", (d) => { d.State.Status = "running"; d.State.Running = true; }).join()).toContain("State.Status");
  });

  it.each(["attempt", "probe", "judge"] as const)("%s holds A1's shape", (role) => {
    expect(problemsAfter(role, (d) => { d.HostConfig.NetworkMode = "bridge"; }).join()).toContain("NetworkMode");
    expect(problemsAfter(role, (d) => { d.NetworkSettings.Networks.none.IPAddress = "172.17.0.2"; }).join()).toContain("IPAddress");
    expect(problemsAfter(role, (d) => { d.NetworkSettings.Gateway = "172.17.0.1"; }).join()).toContain("Gateway");
    expect(problemsAfter(role, (d) => { delete d.HostConfig.Mounts[1].ReadOnly; }).join()).toContain("HostConfig.Mounts");
    expect(problemsAfter(role, (d) => { d.Mounts.find((m: any) => m.Destination === "/vol/sock").RW = true; }).join()).toContain("Mounts");
    expect(problemsAfter(role, (d) => { d.HostConfig.SecurityOpt = ["no-new-privileges"]; }).join()).toContain("seccomp");
    expect(problemsAfter(role, (d) => { d.HostConfig.Tmpfs["/tmp"] = "rw,size=256m"; }).join()).toContain("Tmpfs");
    expect(problemsAfter(role, (d) => { d.Config.WorkingDir = "/"; }).join()).toContain("WorkingDir");
  });
  it("the sandbox numbers are the ruled ones, by value", () => {
    const d = fixture("attempt");
    expect([d.HostConfig.Memory, d.HostConfig.MemorySwap, d.HostConfig.PidsLimit, d.HostConfig.NanoCpus, d.Config.User]).toEqual([2147483648, 2147483648, 512, 2e9, "1001:1001"]);
  });
  it("holds the proxy's own shape", () => {
    const d = fixture("proxy");
    expect([d.HostConfig.Memory, d.HostConfig.PidsLimit, d.HostConfig.NanoCpus, d.Config.User]).toEqual([134217728, 64, 1e9, "10001:1001"]);
    expect(problemsAfter("proxy", (x) => { delete x.HostConfig.Mounts[1].VolumeOptions; }).join()).toContain("HostConfig.Mounts");
    expect(problemsAfter("proxy", (x) => { x.HostConfig.Tmpfs = { "/tmp": "" }; }).join()).toContain("Tmpfs");
    expect(problemsAfter("proxy", (x) => { x.NetworkSettings.Networks = { none: {} }; }).join()).toContain("Networks");
    expect(problemsAfter("proxy", (x) => { x.Config.Env = x.Config.Env.filter((e: string) => !e.startsWith("ALLOW=")); }).join()).toContain("Env");
  });
  it("holds the helper's own shape", () => {
    const d = fixture("pack");
    expect([d.HostConfig.Memory, d.HostConfig.MemorySwap, d.HostConfig.PidsLimit, d.HostConfig.CapAdd, d.Config.User]).toEqual([536870912, 536870912, 32, ["DAC_READ_SEARCH"], "0"]);
    expect(problemsAfter("pack", (x) => { x.HostConfig.CapAdd = null; }).join()).toContain("CapAdd");
    expect(problemsAfter("pack", (x) => { x.HostConfig.Mounts[0].ReadOnly = false; }).join()).toContain("HostConfig.Mounts");
    expect(problemsAfter("pack", (x) => { x.Args = ["/opt/eval/pack.sh", "other"]; }).join()).toContain("Args");
  });
  it("names the hashes the manifest and the record carry", () => {
    expect(engineTableHash()).toBe(createHash("sha256").update(readFileSync(ENGINE_TABLE_PATH)).digest("hex"));
    const a = fixture("attempt");
    const b = fixture("attempt");
    expect(inspectHash(a)).toBe(inspectHash(b));
    b.HostConfig.Privileged = true;
    expect(inspectHash(a)).not.toBe(inspectHash(b));
  });
  it("carries no credential in a fixture", () => {
    for (const role of ROLES) expect(JSON.stringify(fixture(role))).not.toMatch(/CREDENTIAL|API_KEY|TOKEN|auth\.json|\.credentials/i);
  });
});
