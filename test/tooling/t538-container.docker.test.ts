// T-538 S5b-0 commit 2: section 5's egress battery and section 4's isolation tests, through amendment
// A1's transport, on real containers. A plain run skips this with a named reason; the shipping gate
// sets STORYBLOQ_REQUIRE_DOCKER=1, and then a missing engine or image fails. Always under box run.
// Stub-free: no model and no credential of any kind. The only peer that answers is an echo sink.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  attemptRunArgs, compactProfile, containerNames, profileBytes, proxyRunArgs, SECCOMP_COMPACT_SHA256, securityOptProblems, volumeInitArgs, type ProxyEnv,
} from "../../scripts/onboarding-eval-container.js";

const IMAGE = process.env.T538_IMAGE ?? "";
const PROXY_IMAGE = process.env.T538_PROXY_IMAGE ?? "";
const REQUIRED = process.env.STORYBLOQ_REQUIRE_DOCKER === "1";
const CLIENT = readFileSync(join(import.meta.dirname, "..", "fixtures", "t538-container", "client.mjs"), "utf8");
const docker = (args: readonly string[], input?: string, timeout = 120_000): { status: number | null; stdout: string; stderr: string } => {
  const r = spawnSync("docker", args, { encoding: "utf8", input, timeout, maxBuffer: 64 * 1048576 });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
};
const usable = docker(["version", "--format", "{{.Server.Version}}"], undefined, 15_000).status === 0 && IMAGE !== "" && PROXY_IMAGE !== "";
const skipReason = "docker tests skipped: no usable engine, or T538_IMAGE and T538_PROXY_IMAGE are not set";
if (!usable && !REQUIRED) console.log(skipReason);

describe.runIf(REQUIRED && !usable)("the docker gate", () => {
  it("fails when the shipping gate requires docker and it is not usable", () => {
    expect.fail(skipReason);
  });
});

const SUITE = `c2${process.pid}`;
const stacks: string[] = [];
const sink = `t538-sink-${SUITE}`;
const must = (args: readonly string[], input?: string): string => {
  const r = docker(args, input);
  if (r.status !== 0) throw new Error(`docker ${args[0]} failed: ${r.stderr.slice(0, 400)}`);
  return r.stdout.trim();
};
interface Stack { readonly id: string; readonly attempt: string; readonly proxy: string; readonly plog: () => string; readonly plines: () => Record<string, unknown>[]; }

function stack(name: string, env: Partial<ProxyEnv> = {}, deadline = 900): Stack {
  const id = `${SUITE}${name}`;
  const n = containerNames(id);
  stacks.push(id);
  const label = ["--label", `cpm-t538-attempt=${id}`];
  for (const v of [n.attemptVolume, n.socketVolume, n.proxyVolume]) must(["volume", "create", ...label, v]);
  must(["network", "create", ...label, n.external]);
  must(["network", "connect", "--alias", "sink", n.external, sink]);
  must(volumeInitArgs(id, PROXY_IMAGE));
  must(proxyRunArgs(id, PROXY_IMAGE, { ALLOW: "sink:8080", EXPIRY_MS: "1800000", ALLOW_PRIVATE: "1", ...env }));
  for (let i = 0; i < 50; i++) {
    if (docker(["exec", n.proxy, "test", "-S", "/vol/sock/proxy.sock"]).status === 0) break;
    spawnSync("sleep", ["0.2"]);
  }
  must(attemptRunArgs(id, IMAGE, deadline));
  spawnSync("sleep", ["1"]);
  const plog = (): string => docker(["run", "--rm", "--network", "none", "--user", "0", "--cap-drop", "ALL", "--cap-add", "DAC_READ_SEARCH", ...label, "--mount", `type=volume,source=${n.proxyVolume},target=/l,readonly`, "--entrypoint", "cat", PROXY_IMAGE, "/l/log/proxy.log"]).stdout;
  return { id, attempt: n.attempt, proxy: n.proxy, plog, plines: () => plog().trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>) };
}
/** Runs the client's rows inside a container and returns each row's value. */
function rows(s: Stack, mode: "relay" | "unix", names: string, env: readonly string[] = [], user?: string): Record<string, any> {
  const r = docker(["exec", "-i", ...(user ? ["-u", user] : []), "-e", "GOOD=sink:8080", "-e", `MODE=${mode}`, "-e", `ROWS=${names}`, ...env.flatMap((e) => ["-e", e]), s.attempt, "node", "--input-type=module", "-"], CLIENT, 150_000);
  const out: Record<string, unknown> = {};
  for (const line of r.stdout.trim().split("\n").filter(Boolean)) { const o = JSON.parse(line) as { row: string; value: unknown }; out[o.row] = o.value; }
  if (Object.keys(out).length === 0) throw new Error(`client gave nothing: ${r.stderr.slice(0, 400)}`);
  return out;
}
const sh = (s: Stack, script: string, user?: string): { status: number | null; stdout: string; stderr: string } => docker(["exec", ...(user ? ["-u", user] : []), s.attempt, "bash", "-c", script]);
const inspect = (name: string): any => (JSON.parse(must(["inspect", name])) as unknown[])[0];
const refused = (s: Stack): string[] => s.plines().flatMap((l) => ("refuse" in l ? [l.refuse as string] : []));
const removeLabelled = (id: string): void => {
  const f = `label=cpm-t538-attempt=${id}`;
  for (const [kind, q] of [["rm", ["ps", "-aq", "--filter", f]], ["volume", ["volume", "ls", "-q", "--filter", f]], ["network", ["network", "ls", "-q", "--filter", f]]] as const) {
    const ids = docker(q).stdout.trim().split("\n").filter(Boolean);
    if (ids.length === 0) continue;
    docker(kind === "rm" ? ["rm", "-fv", ...ids] : [kind, "rm", ...ids]);
  }
};

describe.runIf(usable)("the container, through amendment A1's transport", { timeout: 180_000 }, () => {
  let main: Stack;
  beforeAll(() => {
    must(["run", "-d", "--name", sink, "--label", `cpm-t538-attempt=${SUITE}`, "--network", "bridge", "--read-only", "--cap-drop", "ALL", "--memory", "512m", "--entrypoint", "node", PROXY_IMAGE, "-e", 'require("net").createServer({allowHalfOpen:true},c=>{c.on("error",()=>{});c.pipe(c)}).listen(8080)']);
    must(["network", "disconnect", "bridge", sink]);
    main = stack("m");
    sh(main, "mkdir -p /vol/att/project /vol/att/home/.codex /vol/att/tmp; printf 'sentinel-read\\n' > /vol/att/project/readme.txt");
  }, 180_000);
  afterAll(() => {
    docker(["rm", "-fv", sink]);
    for (const id of stacks) removeLabelled(id);
    removeLabelled(SUITE);
  }, 180_000);

  describe("the image", () => {
    it("--init is PID 1, the supervisor its child as eval, and procps is present to read it", () => {
      const r = sh(main, "ps -eo pid,ppid,user,comm --no-headers");
      expect(r.status).toBe(0);
      const procs = r.stdout.trim().split("\n").map((l) => l.trim().split(/\s+/));
      const one = procs.find((p) => p[0] === "1")!;
      expect(one[3]).toBe("docker-init");
      const child = procs.find((p) => p[1] === "1" && p[3] === "node")!;
      expect(child[2]).toBe("eval");
      expect(inspect(main.attempt).HostConfig.Init).toBe(true);
      expect(sh(main, "tr '\\0' ' ' < /proc/$(pgrep -o -P 1 node)/cmdline").stdout).toContain("/opt/eval/sup.mjs 900");
    });
    it("carries the pinned client and tools, read-only /opt, and no socket or proxy folder of its own", () => {
      const r = sh(main, "/opt/codex/bin/codex --version; command -v git lsof python3 bash ps; touch /opt/x 2>&1; test -w /opt/eval/relay.mjs && echo WRITABLE; id -u; id -g");
      expect(r.stdout).toContain("0.163.0");
      expect(r.stdout.match(/^\//gm)).toHaveLength(5);
      expect(r.stdout + r.stderr).toContain("Read-only file system");
      expect(r.stdout).not.toContain("WRITABLE");
      expect(r.stdout.trim().split("\n").slice(-2)).toEqual(["1001", "1001"]);
      const img = (JSON.parse(must(["run", "--rm", "--network", "none", "--entrypoint", "node", ...["--label", `cpm-t538-attempt=${SUITE}`], IMAGE, "-e", 'console.log(JSON.stringify(require("fs").readdirSync("/vol")))'])) as string[]);
      expect(img).toEqual(["att"]);
    });
    it("the CLI launcher runs the evaluation bundle, which refuses without its events variable", () => {
      expect(sh(main, "/opt/eval/bin/storybloq --version").status).not.toBe(0);
      const r = sh(main, "STORYBLOQ_EVAL_EVENTS=/vol/att/tmp/ev.jsonl /opt/eval/bin/storybloq --version");
      expect(r.status).toBe(0);
    });
  });

  describe("the inspected shape", () => {
    it("the attempt's SecurityOpt holds the manifest's compacted profile, and the hash pins it", () => {
      const opts = inspect(main.attempt).HostConfig.SecurityOpt as string[];
      expect(securityOptProblems("attempt", opts)).toEqual([]);
      const entry = opts.find((o) => o.startsWith("seccomp="))!.slice("seccomp=".length);
      expect(entry).toBe(compactProfile(profileBytes()));
      expect(createHash("sha256").update(entry).digest("hex")).toBe(SECCOMP_COMPACT_SHA256);
      expect(securityOptProblems("other", inspect(main.proxy).HostConfig.SecurityOpt as string[])).toEqual([]);
    });
    it("the attempt has network none, no gateway, no address, no port, and exactly its two mounts", () => {
      const a = inspect(main.attempt);
      expect(a.HostConfig.NetworkMode).toBe("none");
      expect(a.NetworkSettings.IPAddress).toBe("");
      expect(a.NetworkSettings.Gateway).toBe("");
      expect(a.NetworkSettings.Ports).toEqual({});
      expect(a.HostConfig.PortBindings).toEqual({});
      expect(a.HostConfig.ExtraHosts).toBeNull();
      expect(a.HostConfig.Dns).toEqual([]);
      expect(Object.keys(a.NetworkSettings.Networks)).toEqual(["none"]);
      const mounts = (a.Mounts as { Name: string; Destination: string; RW: boolean }[]).map((m) => [m.Destination, m.RW]).sort();
      expect(mounts).toEqual([["/vol/att", true], ["/vol/sock", false]]);
      expect(a.Config.WorkingDir).toBe("/vol/att/project");
      expect(sh(main, "stat -c '%U %a' /vol/att/project; touch /vol/att/project/.w && rm /vol/att/project/.w; echo $?").stdout.trim().split("\n")).toEqual(["eval 755", "0"]);
    });
    it("the proxy has its external network only, and the log volume is not copied up", () => {
      const p = inspect(main.proxy);
      expect(Object.keys(p.NetworkSettings.Networks)).toEqual([containerNames(main.id).external]);
      expect(p.NetworkSettings.Ports).toEqual({});
      const log = (p.HostConfig.Mounts as { Target: string; VolumeOptions?: { NoCopy?: boolean } }[]).find((m) => m.Target === "/vol/proxy")!;
      expect(log.VolumeOptions?.NoCopy).toBe(true);
    });
  });

  describe("the socket boundary", () => {
    it("the socket works from a named volume, with the fixed owner and modes", () => {
      expect(sh(main, "stat -c '%a %u:%g %F' /vol/sock /vol/sock/proxy.sock").stdout.trim().split("\n")).toEqual(["750 10001:1001 directory", "660 10001:1001 socket"]);
      expect(sh(main, "ls -A /vol/sock").stdout.trim()).toBe("proxy.sock");
    });
    it("the attempt can neither replace nor add to it, as eval or as root", () => {
      for (const user of ["eval", "0"]) {
        sh(main, 'cd /vol/sock; rm -f proxy.sock; mv proxy.sock p2; ln -s /tmp/x evil; touch f; chmod 777 proxy.sock; python3 -c "import socket;s=socket.socket(socket.AF_UNIX);s.bind(\\"/vol/sock/x\\")"', user);
        expect(sh(main, "ls -A /vol/sock; stat -c %a /vol/sock/proxy.sock").stdout.trim().split("\n"), user).toEqual(["proxy.sock", "660"]);
      }
      expect(sh(main, "ls /vol/sock", "0").status, "root with no capabilities cannot even list it").not.toBe(0);
      expect(rows(main, "relay", "connect").connect).toBe("HTTP/1.1 200 OK");
    });
    it("a process outside the group cannot connect", () => {
      expect(rows(main, "unix", "connect", [], "1234:1234").connect).toContain("error EACCES");
    });
    it("another attempt's socket is another volume, with its own proxy and log", () => {
      const b = stack("b");
      const before = main.plines().filter((l) => "allow" in l).length;
      expect(rows(b, "relay", "connect").connect).toBe("HTTP/1.1 200 OK");
      expect(main.plines().filter((l) => "allow" in l)).toHaveLength(before);
      expect(b.plines().filter((l) => "allow" in l)).toHaveLength(1);
      expect(sh(main, "stat -c %i /vol/sock/proxy.sock").stdout).not.toBe("");
      const flag = sh(b, "echo SIBLING-SENTINEL > /vol/att/sibling; sleep 987 >/dev/null 2>&1 & disown; echo done");
      expect(flag.status).toBe(0);
      const look = sh(main, "cat /vol/att/sibling 2>&1; grep -rl SIBLING-SENTINEL /vol /tmp 2>/dev/null | wc -l; ps -eo args --no-headers | grep -c 'sleep 98[7]'");
      expect(look.stdout.trim().split("\n").slice(-2)).toEqual(["0", "0"]);
    });
    it("the proxy's only TCP listener is the engine's resolver, and the relay's is loopback 3128", () => {
      expect(docker(["exec", main.proxy, "awk", '$4=="0A"{print substr($2,1,8)}', "/proc/net/tcp", "/proc/net/tcp6"]).stdout.trim().split("\n")).toEqual(["0B00007F"]);
      expect(rows(main, "relay", "listeners").listeners).toEqual(["0100007F:0C38"]);
    });
  });

  describe("egress from the attempt", () => {
    it("has loopback only: the exact interface set, no routes, and no way to raise one", () => {
      const v = rows(main, "relay", "interfaces").interfaces as { dev: string[]; routes: number };
      expect(v.dev).toEqual(["ip6tnl0", "lo", "tunl0"]);
      expect(v.routes).toBe(0);
      const py = 'import socket,fcntl,struct\nfor n in (b"tunl0",b"ip6tnl0"):\n    s=socket.socket()\n    try:\n        fcntl.ioctl(s,0x8914,struct.pack("16sh",n,1)); print("ALLOWED")\n    except OSError as e: print(e.strerror)\n';
      const r = docker(["exec", "-i", main.attempt, "python3", "-"], py);
      expect(r.stdout).not.toContain("ALLOWED");
    });
    it("reaches nothing directly: TCP, UDP, IPv6, DNS, the gateway, the VM, the host, the sibling proxy and sink", () => {
      const p = inspect(main.proxy);
      const net = Object.values(p.NetworkSettings.Networks)[0] as { IPAddress: string; Gateway: string };
      const sinkIp = (Object.values(inspect(sink).NetworkSettings.Networks) as { IPAddress: string }[]).find((x) => x.IPAddress !== "")!.IPAddress;
      const targets = [["8.8.8.8", 53], ["1.1.1.1", 443], [net.Gateway, 111], [net.Gateway, 2375], [net.IPAddress, 3128], [sinkIp, 8080], ["172.17.0.1", 111], ["172.17.0.1", 2375], ["192.168.65.1", 80], ["192.168.65.2", 80], ["192.168.65.5", 80], ["192.168.65.7", 80], ["192.168.65.254", 80], ["host.docker.internal", 80], ["gateway.docker.internal", 80]];
      const v = rows(main, "relay", "direct", [`TARGETS=${JSON.stringify(targets)}`, `GW=${net.Gateway}`]).direct as Record<string, string>;
      expect(Object.keys(v).length).toBeGreaterThan(20);
      for (const [k, code] of Object.entries(v)) {
        expect(code, k).not.toBe("OPEN");
        expect(code, k).not.toBe("SENT");
        expect(code, k).not.toBe("ANSWERED");
      }
    });
    it.each(["relay", "unix"] as const)("through the %s: an allowed connect works, every refused form is refused, a smuggled request reaches only the sink", (mode) => {
      const v = rows(main, mode, "connect,denied,echo,smuggle");
      expect(v.connect).toBe("HTTP/1.1 200 OK");
      for (const [a, reply] of Object.entries(v.denied as Record<string, string>)) expect(reply, a).toBe("HTTP/1.1 403 Forbidden");
      expect(v.echo).toBe("half-close-row");
      expect(v.smuggle).toBe(true);
    });
    it("no token reaches the log, and every refused line is a known code", () => {
      for (const mode of ["relay", "unix"] as const) for (const reply of rows(main, mode, "token").token as string[]) expect(reply).toBe("HTTP/1.1 403 Forbidden");
      const log = main.plog();
      expect(log).not.toContain("FAKETOKEN123");
      expect(new Set(refused(main))).toEqual(new Set(["method", "malformed", "not-listed"]));
    });
    it("an allowed name that resolves to a private address is refused", () => {
      const s = stack("pr", { ALLOW_PRIVATE: "" });
      expect(rows(s, "relay", "connect").connect).toBe("HTTP/1.1 403 Forbidden");
      expect(refused(s)).toEqual(["private-address"]);
    });
    it("the stub route forwards absolute form for its list only, and the proxy refuses to start with a list beside a credential", () => {
      const s = stack("pl", { ALLOW: "", PLAIN: "sink:8080", ALLOW_PRIVATE: "" });
      expect(rows(s, "relay", "plainget").plainget).toBe("GET http://sink:8080/v1 HTTP/1.1");
      expect(rows(s, "relay", "connect").connect).toBe("HTTP/1.1 403 Forbidden");
      const n = containerNames(`${SUITE}cr`);
      stacks.push(`${SUITE}cr`);
      const label = ["--label", `cpm-t538-attempt=${SUITE}cr`];
      for (const v of [n.socketVolume, n.proxyVolume]) must(["volume", "create", ...label, v]);
      must(["network", "create", ...label, n.external]);
      must(volumeInitArgs(`${SUITE}cr`, PROXY_IMAGE));
      must(proxyRunArgs(`${SUITE}cr`, PROXY_IMAGE, { ALLOW: "sink:8080", EXPIRY_MS: "60000", PLAIN: "sink:8080", CREDENTIAL: "1" }));
      expect(must(["wait", n.proxy])).toBe("4");
    });
  });

  describe("limits through the transport", () => {
    it.each(["relay", "unix"] as const)("through the %s: slow headers, oversize, concurrent streams and idle sockets", (mode) => {
      const s = stack(`l${mode[0]}`);
      const v = rows(s, mode, "slow,big,concurrent,sockets");
      expect(v.slow.reply).toBe("HTTP/1.1 408 Request Timeout");
      expect(v.slow.ms).toBeGreaterThan(9000);
      expect(v.slow.ms).toBeLessThan(13000);
      expect(v.big).toBe("HTTP/1.1 403 Forbidden");
      expect(v.concurrent).toBe(20);
      expect(refused(s)).toContain("too-many-sockets");
    });
    it("backpressure holds a paused reader, at the proxy's own memory limit (one sample, no claim)", () => {
      const v = rows(main, "relay", "backpressure").backpressure as { pausedAt: number; got: number; sz: number };
      expect(v.pausedAt).toBeLessThan(v.sz);
      expect(v.got).toBe(v.sz);
    });
    it("the byte ceiling closes a tunnel while it sends and refuses what follows", () => {
      const s = stack("by", { LIMITS: `{"bytes":${16 * 1048576}}` });
      const v = rows(s, "relay", "ceiling").ceiling as { after: string };
      expect(v.after).toBe("HTTP/1.1 403 Forbidden");
      const hit = s.plines().find((l) => l["ceiling-hit"] === "upstream-bytes")!;
      expect(hit.forwarded as number).toBeLessThanOrEqual(16 * 1048576);
    });
    it("the connection ceiling refuses new ones while an open tunnel still echoes", () => {
      const s = stack("co", { LIMITS: '{"conns":4}' });
      const v = rows(s, "relay", "conntunnel").conntunnel as { rest: string[]; echoed: string };
      expect(v.rest).toEqual(["HTTP/1.1 200 OK", "HTTP/1.1 200 OK", "HTTP/1.1 200 OK", "HTTP/1.1 403 Forbidden", "HTTP/1.1 403 Forbidden"]);
      expect(v.echoed).toBe("still-open");
    });
    it("the connection lifetime closes the tunnel", () => {
      const s = stack("li", { LIMITS: '{"lifeMs":3000}' });
      const ms = rows(s, "relay", "hold").hold as number;
      expect(ms).toBeGreaterThan(2000);
      expect(ms).toBeLessThan(10000);
    });
    it("expiry closes the tunnel and ends the proxy on its own", () => {
      const s = stack("ex", { EXPIRY_MS: "8000" });
      expect(rows(s, "relay", "hold").hold as number).toBeLessThan(15000);
      expect(must(["wait", s.proxy])).toBe("0");
      expect(s.plines().some((l) => l["ceiling-hit"] === "expiry")).toBe(true);
    });
  });

  describe("transport loss", () => {
    it("a tool killing the relay ends the attempt with the supervisor's code, with no restart", () => {
      const s = stack("rd");
      sh(s, "pkill -KILL -f /opt/eval/relay.mjs");
      expect(must(["wait", s.attempt])).toBe("70");
    });
    it("proxy death closes the open tunnel, later connections fail, and a new proxy refuses the used volume", () => {
      const s = stack("pd");
      sh(s, "mkdir -p /vol/att/tmp");
      docker(["exec", "-i", s.attempt, "bash", "-c", "cat > /vol/att/tmp/c.mjs"], CLIENT);
      must(["exec", "-d", "-e", "MODE=relay", "-e", "GOOD=sink:8080", "-e", "ROWS=deathwatch", "-e", "MARK=/vol/att/tmp/up", s.attempt, "bash", "-c", "node /vol/att/tmp/c.mjs > /vol/att/tmp/out 2>&1"]);
      for (let i = 0; i < 50 && sh(s, "test -e /vol/att/tmp/up").status !== 0; i++) spawnSync("sleep", ["0.2"]);
      docker(["kill", s.proxy]);
      let out = "";
      for (let i = 0; i < 40 && out === ""; i++) { out = sh(s, "cat /vol/att/tmp/out").stdout.trim(); if (out === "") spawnSync("sleep", ["0.5"]); }
      const watch = (JSON.parse(out) as { value: { echoed: string; closedMs: number | null } }).value;
      expect(watch.echoed).toBe("alive");
      expect(watch.closedMs, "the existing client socket closes within the bound").not.toBeNull();
      expect(watch.closedMs!).toBeLessThan(10_000);
      expect(rows(s, "relay", "connect").connect).not.toBe("HTTP/1.1 200 OK");
      expect(rows(s, "unix", "connect").connect).not.toBe("HTTP/1.1 200 OK");
      expect(inspect(s.attempt).State.Running).toBe(true);
      docker(["rm", "-fv", s.proxy]);
      must(proxyRunArgs(s.id, PROXY_IMAGE, { ALLOW: "sink:8080", EXPIRY_MS: "60000" }));
      expect(must(["wait", s.proxy])).toBe("3");
    });
    it("the supervisor's own deadline ends the attempt, and its output is in no exec's capture", () => {
      const s = stack("dl", {}, 4);
      expect(sh(s, "echo only-this").stdout.trim()).toBe("only-this");
      expect(must(["wait", s.attempt])).toBe("71");
    });
  });

  describe("isolation from the host and the VM", () => {
    it("the host's files, a VM sentinel and the engine's socket are out of reach", () => {
      const label = ["--label", `cpm-t538-attempt=${SUITE}`];
      const marker = `T538-VM-${SUITE}`;
      must(["run", "--rm", ...label, "--network", "none", "--user", "0", "-v", "/:/vm", "--entrypoint", "sh", PROXY_IMAGE, "-c", `echo ${marker} > /vm/tmp/t538-${SUITE}-sentinel`]);
      try {
        const r = sh(main, `ls /Users 2>&1; ls /private 2>&1; ls /var/lib/docker 2>&1; cat /tmp/t538-${SUITE}-sentinel 2>&1; find / -xdev -name 't538-${SUITE}-sentinel' 2>/dev/null | wc -l; ls /var/run/docker.sock ~/.docker /run/docker.sock 2>&1 | grep -vc 'No such'`);
        const lines = r.stdout.trim().split("\n");
        expect(lines.slice(-2)).toEqual(["0", "0"]);
        expect(r.stdout).not.toContain(marker);
        expect(lines.filter((l) => l.includes("No such file")).length).toBeGreaterThanOrEqual(4);
      } finally {
        must(["run", "--rm", ...label, "--network", "none", "--user", "0", "-v", "/:/vm", "--entrypoint", "rm", PROXY_IMAGE, "-f", `/vm/tmp/t538-${SUITE}-sentinel`]);
      }
    });
    it("no capability, no new privileges, seccomp filtering on, and /proc shows only this container", () => {
      const r = sh(main, "grep -E '^(CapEff|CapBnd|NoNewPrivs|Seccomp):' /proc/self/status | tr -s '\\t' ' '; cat /proc/[0-9]*/comm 2>/dev/null | sort -u");
      expect(r.stdout).toContain("CapEff: 0000000000000000");
      expect(r.stdout).toContain("CapBnd: 0000000000000000");
      expect(r.stdout).toContain("NoNewPrivs: 1");
      expect(r.stdout).toContain("Seccomp: 2");
      expect(r.stdout).not.toMatch(/dockerd|containerd|kthreadd/);
    });
    it("namespace entry fails; a user namespace is permitted, and proc, sysfs and a real file system cannot be mounted in it", () => {
      expect(sh(main, "nsenter -t 1 -m true").status).not.toBe(0);
      expect(sh(main, "unshare -Ur id -u").stdout.trim()).toBe("0");
      const r = sh(main, 'mkdir -p /tmp/mm; unshare -Urm bash -c "mount -t tmpfs none /tmp/mm; echo tmpfs=\\$?; umount /tmp/mm; mount -t proc none /tmp/mm 2>/dev/null; echo proc=\\$?; mount -t sysfs none /tmp/mm 2>/dev/null; echo sysfs=\\$?; mount -t ext4 /dev/vda1 /tmp/mm 2>/dev/null; echo ext4=\\$?"');
      const got = Object.fromEntries(r.stdout.trim().split("\n").map((l) => l.split("=")));
      expect(got.tmpfs).toBe("0");
      for (const fs of ["proc", "sysfs", "ext4"]) expect(got[fs], fs).not.toBe("0");
    });
    it("the client's read-only sandbox reads, refuses the write, and bwrap does not fail under the profile", () => {
      const r = sh(main, `cd /vol/att/project; HOME=/vol/att/home CODEX_HOME=/vol/att/home/.codex TMPDIR=/vol/att/tmp /opt/codex/bin/codex sandbox -c 'sandbox_mode="read-only"' -- sh -c 'cat readme.txt; touch readme.txt; echo rc=$?' 2>&1`);
      expect(r.stdout).toContain("sentinel-read");
      expect(r.stdout).toMatch(/rc=[1-9]/);
      expect(r.stdout).not.toContain("bwrap:");
    });
  });
});
