import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import type { Argv, Options } from "yargs";
import { registerAllTools } from "../../../src/mcp/tools.js";
import { initProject } from "../../../src/core/init.js";
import { loadProject, writeConfig } from "../../../src/core/project-loader.js";
import { COMMANDS, MCP_TOOLS } from "../../../src/cli/commands/reference.js";
import { HIDDEN_LEGACY_TOOLS } from "../../../src/core/write-families.js";
import * as registrations from "../../../src/cli/register.js";
import { toolSchema } from "../../mcp/tool-schema-helpers.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe("reference registration parity", () => {
  it.each(["npm", "orchestrator", "bus"])("documents every full-project tool and schema argument (%s)", async mode => {
    const root = await mkdtemp(join(tmpdir(), "story-reference-"));
    roots.push(root);
    await initProject(root, { name: "Reference", type: mode === "orchestrator" ? mode : "npm" });
    if (mode === "bus") {
      const project = await loadProject(root);
      await writeConfig({ ...project.state.config, features: { ...project.state.config.features, bus: true } }, root);
    }
    const actual: Array<{ name: string; params: string[] }> = [];
    const server = {
      registerTool(name: string, config: { inputSchema?: unknown }) {
        let schema = toolSchema(config.inputSchema);
        while (schema instanceof z.ZodOptional) schema = schema.unwrap();
        expect(schema, `${name}: schema must expose its argument object`).toBeInstanceOf(z.ZodObject);
        const shape = (schema as z.ZodObject<z.ZodRawShape>).shape;
        actual.push({ name, params: Object.entries(shape).map(([key, value]) => key + (value.isOptional() ? "?" : "")) });
        return { remove() {} };
      },
    } as unknown as Parameters<typeof registerAllTools>[0];
    registerAllTools(server, root);
    // 1.20 commit 0: the former write tool names stay registered but are not
    // listed, so reference documents their write families instead.
    for (const hidden of HIDDEN_LEGACY_TOOLS) expect(actual.map(tool => tool.name), `${hidden} stays registered`).toContain(hidden);
    const listed = actual.filter(tool => !HIDDEN_LEGACY_TOOLS.has(tool.name));
    const registeredNames = listed.map(tool => tool.name);
    const documentedNames = MCP_TOOLS.map(tool => tool.name);
    expect(new Set(registeredNames).size).toBe(registeredNames.length);
    expect(new Set(documentedNames).size).toBe(documentedNames.length);
    expect([...documentedNames].sort()).toEqual([...registeredNames].sort());
    for (const hidden of HIDDEN_LEGACY_TOOLS) expect(documentedNames, `${hidden} is not documented as listed`).not.toContain(hidden);
    for (const tool of listed) {
      const documented = MCP_TOOLS.find(entry => entry.name === tool.name)!;
      expect([...(documented.params ?? [])].sort(), tool.name).toEqual([...tool.params].sort());
      expect(new Set(documented.params).size, `${tool.name}: duplicate argument`).toBe(documented.params?.length ?? 0);
    }
  });

  it("documents public CLI leaves and their registered flags", async () => {
    // Run builders without handlers: no argv parsing, hooks, or global setup.
    const actual: Array<{ name: string; flags: string[] }> = [];
    function collector(prefix = "") {
      const flags: string[] = [];
      let hasChildren = false;
      const proxy = new Proxy({}, {
        get(_target, key) {
          if (key === "command") return (spec: string | string[], description: string | false, builder?: (args: Argv) => unknown) => {
            const command = (Array.isArray(spec) ? spec[0]! : spec).split(" ")[0]!;
            const name = [prefix, command].filter(Boolean).join(" ");
            const child = collector(name);
            builder?.(child.proxy);
            if (!child.hasChildren() && description !== false) actual.push({ name, flags: child.flags });
            hasChildren = true;
            return proxy;
          };
          if (key === "option") return (name: string, _options: Options) => { flags.push(`--${name}`); return proxy; };
          if (key === "options") return (options: Record<string, Options>) => { flags.push(...Object.keys(options).map(name => `--${name}`)); return proxy; };
          return () => proxy;
        },
      }) as Argv;
      return { proxy, flags, hasChildren: () => hasChildren };
    }
    const index = await readFile(new URL("../../../src/cli/index.ts", import.meta.url), "utf8");
    const names = [...index.matchAll(/cli = (register\w+Command)\(cli\)/g)].map(match => match[1]!);
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      const register = registrations[name as keyof typeof registrations];
      expect(typeof register, name).toBe("function");
      (register as (args: Argv) => Argv)(collector().proxy);
    }
    expect(new Set(COMMANDS.map(command => command.name)).size).toBe(COMMANDS.length);
    expect(COMMANDS.map(command => command.name).sort()).toEqual(actual.map(command => command.name).sort());
    for (const command of COMMANDS) {
      const registered = actual.find(entry => entry.name === command.name)!;
      const documentedFlags = [...command.usage.matchAll(/--[a-z][a-z-]*/g)].map(match => match[0]);
      expect([...(command.flags ?? [])].sort(), `${command.name}: omitted or extra flags`).toEqual(registered.flags.filter(flag => flag !== "--raw").sort());
      for (const flag of [...documentedFlags, ...(command.flags ?? [])]) {
        expect(registered.flags, `${command.name}: ${flag}`).toContain(flag);
      }
    }
  });
});
