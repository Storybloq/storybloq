# Settings (/story settings)

Full `/story settings` flow: read `.story/config.json`, present current settings, walk the user through changes via `AskUserQuestion`, apply via `storybloq config set-overrides`, and the complete config schema reference. Loaded on demand from SKILL.md; not part of every `/story` session.

**Step 1: Read and display current config.** Read `.story/config.json` directly. Show a clean table:

```
## Current Settings

| Setting | Value |
|---------|-------|
| Max tickets per session | 5 |
| Review backends | codex, agent |
| Code review round cap | 12 (minimum still follows ticket risk) |
| Handover interval | every 3 tickets |
| Compact threshold | high (default) |
| TDD (WRITE_TESTS) | enabled |
| Run tests (TEST) | enabled, command: npm test |
| Smoke test (VERIFY) | disabled |
| Build validation (BUILD) | disabled |
```

**Step 2: Ask what to change.** Use `AskUserQuestion`:
- question: "What would you like to change?"
- header: "Settings"
- options:
  - "Quality pipeline" -- TDD, tests, endpoint checks, build validation
  - "Session limits" -- tickets per session, context compaction
  - "Review backends" -- which reviewers to use
  - "Handover frequency" -- how often to write session handovers

**Step 3: Focused follow-up for each category:**

**Quality pipeline:**
```
AskUserQuestion: "Quality pipeline settings"
header: "Quality"
options:
- "Full pipeline" -- TDD + tests + endpoint checks + build
- "Tests only" -- run tests after building
- "Minimal" -- no automated checks
- "Custom" -- pick individual stages
```

If "Custom", show each stage as a separate AskUserQuestion.

**Session limits:**
```
AskUserQuestion: "Max tickets per autonomous session?"
header: "Limit"
options: "3 (conservative)", "5 (default)", "10 (aggressive)", "Unlimited"
```

**Review backends:**
```
AskUserQuestion: "Which reviewers for code and plan review?"
header: "Review"
options:
- "Codex + Claude agent (Recommended)" -- alternate between both
- "Codex only" -- OpenAI Codex reviews
- "Claude agent only" -- independent Claude agent reviews
- "None" -- skip automated review
```

Note: this sets the top-level `reviewBackends`. If the config has per-stage overrides in `stages.PLAN_REVIEW.backends` or `stages.CODE_REVIEW.backends`, those take precedence. `stages.CODE_REVIEW.maxReviewRounds` defaults to 12 and is clamped upward to the ticket-risk minimum; `0` explicitly disables the cap. When displaying settings, show both per-stage backends and this cap when present.

**Handover frequency:**
```
AskUserQuestion: "Write a handover after every N tickets?"
header: "Handover"
options: "Every ticket", "Every 3 tickets (default)", "Every 5 tickets", "Manual only"
```

**Step 4: Apply changes.** Run via Bash:
```
storybloq config set-overrides --json '<constructed JSON>'
```

**IMPORTANT:** The `--json` argument takes only the `recipeOverrides` object, NOT the full config. Top-level fields (version, project, type, language) are NOT settable via this command.
```
# Correct:
storybloq config set-overrides --json '{"maxTicketsPerSession": 10}'

# Correct (stages):
storybloq config set-overrides --json '{"stages": {"VERIFY": {"enabled": true}}}'

# WRONG -- do not include top-level fields:
storybloq config set-overrides --json '{"version": 2, "project": "foo"}'
```

Show a confirmation of what changed, then ask if the user wants to change anything else or is done. If done, return to normal session.

### Config Schema Reference

Do NOT search source code for this. The full config.json schema is shown below. Only the `recipeOverrides` section is settable via `config set-overrides`.

```json
{
  "version": 2,
  "schemaVersion": 1,
  "project": "string",
  "type": "string (npm, cargo, pip, orchestrator, etc.)",
  "language": "string",
  "features": {
    "tickets": true, "issues": true, "handovers": true,
    "roadmap": true, "reviews": true
  },
  "recipe": "string (default: coding)",
  "statusWriter": {
    "stopHook": "boolean (default true). false stops the turn-end Stop hook from doing ANY status work (no session scan, no payload build, no gitignore heal, no write) for projects whose test harness fails on writes during a run. Autonomous sessions still refresh status on their own MCP transitions."
  },
  "sessionIntel": {
    "enabled": "boolean (default true). false disables sampling, banners, the prompt-hook line, the guide directive and the status projection for this project; `session intel` still answers read-only",
    "advisoryPct": "number 0.5-0.95 (default 0.70) of the expected auto-compact ceiling",
    "imperativePct": "number 0.6-0.99 (default 0.95), must exceed advisoryPct; imperative here or at imperativeHeadroomTokens, whichever first",
    "imperativeHeadroomTokens": "integer 10000-500000 (default 60000) headroom, or the jump allowance if larger",
    "compactNeededPct": "number 0.85-1.0 (default 0.98), must exceed imperativePct; past it every surface says /compact, not a handover; nothing suppresses it",
    "ceilingFraction": "number 0.8-1.0 (default 0.925; measured fire point over autoCompactWindow)",
    "boundarySampleCount": "integer 1-50 (default 20) recent auto-compaction boundaries used for the measured ceiling",
    "jumpAllowanceFloorTokens": "integer (default 25000) <= jumpAllowanceCapTokens (default 150000); bounds the p90 per-turn growth reserved before imperative",
    "maxSampleAgeMs": "integer 0-600000 (default 30000); an older stored sample is refreshed by one bound tail read before a banner",
    "compactPendingTtlMs": "integer 10000-3600000 (default 300000); a PreCompact event with no boundary seen within this window is treated as an assumed compaction",
    "stepPct": "number 0.01-0.5 (default 0.05); context growth after a handover that re-arms imperative",
    "handoverRearmStepCapTokens": "integer 1000-1000000 (default 25000); the growth step is min(stepPct x ceiling, this)",
    "handoverRearmIntervalMs": "integer 0-3600000 (default 600000); wall time from the handover or the last imperative line until imperative re-arms or repeats",
    "handoverRearmPrompts": "integer 0-50 (default 3); prompt-hook samples since the handover before imperative can re-arm; skipped when promptHook is false. All three gates must clear",
    "recommendedWindowMax": "integer 0 or 100000-1000000 (default 450000); the auto-compact window at or below which no usage advisory is shown. A threshold, not a sentinel: a 2000000 window against a 1000000 max still fires. 0 disables the advisory entirely",
    "banner": "boolean (default true) MCP/CLI response banner",
    "promptHook": "boolean (default true) UserPromptSubmit additionalContext at imperative",
    "guideDirective": "boolean (default true) autonomous guide directive at imperative"
  },
  "recipeOverrides": {
    "maxTicketsPerSession": "number (0 = unlimited, default: 0)",
    "compactThreshold": "string (medium/high/critical; selects pressure limits and rotation trigger; default: high)",
    "reviewBackends": ["codex", "agent"],
    "handoverInterval": "number (default: 3)",
    "reviewEffort": "off | light | standard | thorough | size-mapped (default: size-mapped; one dial for how hard review works; standard is today's behavior exactly; see Review effort below)",
    "stages": {
      "WRITE_TESTS": {
        "enabled": "boolean",
        "command": "string (test command)",
        "onExhaustion": "plan | advance (default: plan)"
      },
      "TEST": {
        "enabled": "boolean",
        "testTimeoutMs": "1-3600000 ms, default 120000; both stages on: max",
        "command": "string (default: npm test)"
      },
      "VERIFY": {
        "enabled": "boolean",
        "startCommand": "string (e.g., npm run dev)",
        "readinessUrl": "string (e.g., http://localhost:3000)",
        "endpoints": ["GET /api/health", "POST /api/users"]
      },
      "BUILD": {
        "enabled": "boolean",
        "command": "string (default: npm run build)"
      },
      "PLAN_REVIEW": {
        "backends": ["codex", "agent"],
        "confidenceFloor": "number 0-1 (default: 0.6; minimum lens confidence for a finding to count)"
      },
      "CODE_REVIEW": {
        "backends": ["codex", "agent"],
        "maxReviewRounds": "number (default: 12; 0 disables; otherwise effective cap is max(value, required risk rounds); setting it explicitly beats reviewEffort)",
        "confidenceFloor": "number 0-1 (default: 0.6; minimum lens confidence for a finding to count)"
      },
      "LESSON_CAPTURE": { "enabled": "boolean" },
      "ISSUE_SWEEP": { "enabled": "boolean" }
    },
    "lensConfig": {
      "lenses": "\"auto\" | string[] (default: \"auto\"; restricts activation to the named lenses. A set that matches no active lens is treated as a mistake and ignored, so a typo cannot turn lens review off)",
      "maxLenses": "number (1-8, default: uncapped; keeps the first N activated lenses. Out-of-range values are ignored)"
    },
    "blockingPolicy": {
      "neverBlock": "string[] (lens names that never produce blocking findings, default: [])",
      "alwaysBlock": "string[] (categories that always block, default: [injection, auth-bypass, hardcoded-secrets])",
      "planReviewBlockingLenses": "string[] (default: [security, error-handling])"
    },
    "requireSecretsGate": "boolean (default: false, require detect-secrets for lens reviews)",
    "requireAccessibility": "boolean (default: false, make accessibility findings blocking)"
  },
  "nodes": {
    "<name (lowercase, alphanumeric, hyphens, underscores)>": {
      "path": "string (required, existing directory -- absolute or ~/relative)",
      "stack": "string (optional, max 40 chars, e.g. npm, swift-spm)",
      "role": "string (optional, max 120 chars, human-readable purpose)",
      "summary": "string (optional, max 200 chars, status snapshot)",
      "health": "green | yellow | red | grey (default: grey)",
      "dependsOn": "string[] (node names, build-order deps, validated for cycles)",
      "kind": "string (optional, max 32 chars, e.g. library, service, app)",
      "links": [{"to": "node-name", "via": "string (optional, max 60 chars, integration description)"}]
    }
  },
  "federation": {
    "allowNodeWrites": "boolean (default: false, permits orchestrator MCP tools to write to node .story/ dirs)"
  }
}
```

### Auto-compact window and usage (T-501)

`autoCompactWindow` is a CLAUDE CODE setting, not a Storybloq one: it decides how large the context grows before Claude Code compacts it. Every turn re-sends the whole context, so allowing larger contexts can increase per-turn usage as the context grows. Storybloq recommends a ceiling of 450,000 tokens.

Claude Code merges it from three files, last DEFINED wins:

| Layer | File |
|-------|------|
| user | `~/.claude/settings.json` |
| project | `.claude/settings.json` |
| project-local | `.claude/settings.local.json` |

Set it as a plain number, for example `{"autoCompactWindow": 450000}`. Claude Code reads the value at PROCESS start, so an edit takes effect on the next Claude Code start, not in the running session. A value set only by managed (policy) settings is out of the user's reach and Storybloq reports it as not observed rather than guessing.

Codex has no equivalent setting, so the advisory never appears there.

Storybloq only ADVISES: it reads the value, never writes it. `storybloq status` (and `storybloq_status`) carries the advisory once per session when the observed window is above `sessionIntel.recommendedWindowMax`, or when the session runs a 1M-context model with no window observed at all. `storybloq session intel` reports it on every call. Set `sessionIntel.recommendedWindowMax` to `0` to turn the advisory off.

### Review effort

`reviewEffort` is one dial for how hard review works. `standard` is today's
behavior exactly, so a project that never sets it does not move. `size-mapped`
(the default) derives it per item: risk `high` -> `thorough`, `chore` at risk
`low` -> `light`, else `standard`; issues map severity `low`/`medium` ->
`light`, else `standard`.

Precedence, highest first: an explicit `stages.*` knob, then ticket/issue
`reviewEffort` metadata, then the start call's `reviewEffort`, then this
project default, then size mapping. **The dial never overrides an explicit
`stages.*` knob**, never adds a backend you did not configure, and fails
closed to `standard` on an unrecognized value, so a typo cannot buy less
review than you have today. Every level is disclosed on the review
instruction, in a `review_effort_resolved` event, on the round record, and in
`storybloq session-report`.

Full level table, the `off` semantics, and the `light` landing rule are in
`autonomous-mode.md`.

### Health checks (/story health, T-502)

`storybloq health` (MCP tool `storybloq_health`, skill route `/story health`) checks the tooling AROUND the project, not the ledger. It never edits a settings or config file, though a registry lookup may update the shared version cache; `--refresh` forces that lookup even when the cache is fresh. Every check is `ok`, `advise`, `skip`, or `error`, the run works to a 5 second soft budget, and a completed report exits 0 even when a check reports an error; only invalid arguments exit nonzero.

Two roots matter. Config comes from the `.story/` root (may be absent). Settings and MCP registrations come from the INVOCATION directory: the CLI's working directory, or the directory the MCP server was launched in. That directory is always reported as `projectDir` in the JSON result and in the header line of the text report.

A layer Storybloq cannot READ is never reported as absent. Where the unreadable layer could change the verdict, the check returns `skip` with `unreadable: <path>` instead, so a permission error can never be dressed up as advice. `cross-session-inbound` is the strictest case: all four of its layers must be determinate.

The six checks, with the advice each one pins:

| Check | When it advises | What it tells you to do |
|-------|-----------------|-------------------------|
| `usage-window` | Claude Code's `autoCompactWindow` is above `sessionIntel.recommendedWindowMax`, or a 1M-context model is running with no window observed | The same advisory `storybloq status` carries; see the auto-compact section above |
| `cli-version` | A newer `@storybloq/storybloq` is published | "Update with `storybloq update` (installs it and re-runs setup)." |
| `codex-bridge` | Codex is installed and the registered bridge does not answer an MCP `initialize`, or none is registered while the bundled copy is installed or unusable | Not registered, bundle installed: "Run `storybloq setup-skill`". Bundle unusable: reinstall with `npm install -g @storybloq/storybloq@latest`. Bundle absent: the check skips. Not answering: the advice names the failing registration by scope and name with the fix: the rebuild command for a native-module failure, a registered command not found, or the remove-and-setup steps |
| `skill-version` | An installed `/story` skill is older than the running CLI | "Run `storybloq setup --client <claude\|codex\|all>` to refresh it." |
| `cross-session-inbound` | Claude Code's `crossSessionInbound` is unset, or resolves to `hold` or `refuse` | Set it to `accept` in `~/.claude/settings.json`; remove it from, or set it to `accept` in, any repository file that tightens it; if managed settings set it, ask your admin |
| `hook-duplicates` | `~/.claude/settings.json` registers the same storybloq hook more than once for one event and source (two launcher paths, or two overlapping matcher groups) | "Run `storybloq setup-skill` to keep the global binary's row and drop the rest." |

`cross-session-inbound` is a Claude Code setting, so it is skipped under Codex. It merges four layers (managed, user, project, project-local); every layer must be readable or the check skips. When unset, a session running without permission prompts holds messages from your other sessions for manual review, which stalls pen/worker messaging. A session started with a `--settings` flag can replace the user value but not a managed one, and repository files only ever tighten.

`hook-duplicates` reads only `~/.claude/settings.json` (project, local and managed layers are not inspected) and identifies a row by its semantic command, the storybloq binary basename plus subcommand, never by the full path. Two rows collide when their matcher groups can fire for the same source; the deliberate `compact` plus `resume` pair does not. The check reports and picks no keeper: `storybloq setup-skill` keeps the row of the global launcher (the one `npm root -g` and `which storybloq` agree on) and prints each row it removed. It is skipped under Codex.

`codex-bridge` resolves the registration by name across local, project, and user scope, highest precedence first, and only trusts a winner when no higher scope was unreadable. A server whose name looks like the bridge but whose launch command Storybloq does not recognise produces a `skip`, not a false `ok`.

Turn checks off in `.story/config.json`. Omitted keys default to on; a non-boolean value falls back for that key alone rather than rejecting the file:

```json
{
  "healthCheck": {
    "enabled": true,
    "checks": {
      "usageWindow": true,
      "cliVersion": true,
      "codexBridge": true,
      "skillVersion": true,
      "crossSessionInbound": true
    }
  }
}
```

Setting `enabled` to `false` skips every check with reason `disabled in .story/config.json`. There is also a global off switch in `~/.claude/storybloq/config.json` (`healthCheck.enabled = false`) for machines where the command should stay quiet everywhere.

When the skill runs `/story health`: relay each `advise` message and its fix verbatim, list the `skip` reasons in one line, and then stop. Do not offer to make the changes; they are the user's files.

`/story` priming runs this once per session, relaying only `advise` lines; the registry lookup is cached six hours (ISS-1237).
