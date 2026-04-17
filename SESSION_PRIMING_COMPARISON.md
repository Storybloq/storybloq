# Session Priming Comparison: MCP vs Manual File Reading

**Date:** 2026-03-21
**Project:** storybloq (82 leaf tickets, 20 handovers, 9 issues, 10 phases)
**Claude Code:** v2.1.81, Opus 4.6 (1M context)

---

## Setup

Two fresh Claude Code sessions on the same project, same branch, same state. Goal: get full project context to start working.

### Session 1 — MCP Tools
User prompt: "use our mcp to get project context" (after initial "read claude.md")

### Session 2 — Manual File Reading
User prompt: "please review claude.md handovers, rules.md, work strategies, then read .story files: tickets, roadmap and other documents to get project context, whats been done and whats next. read last 3 handovers please also read the last 20 commits"

---

## Results

| Metric | Session 1 (MCP) | Session 2 (Manual) |
|--------|-----------------|-------------------|
| **Time to context** | ~3 seconds | 1 min 41 sec |
| **Tokens consumed** | ~32,400 | ~46,500 |
| **Tool calls** | 3 MCP calls | 100+ (reads, globs, explores, git) |
| **User messages** | 2 ("read claude.md" + "use our mcp") | 1 (long prompt) |
| **Context accuracy** | Accurate — correct counts, next ticket, latest handover | Accurate — correct counts, phase status, full history |

### Token Savings
- **14,100 tokens saved** per session with MCP (30% reduction)
- Over 20 sessions: **~282,000 tokens saved** on context loading alone

### Speed
- MCP: **34x faster** (3s vs 101s)

---

## What Each Session Captured

### Session 1 (MCP) got:
- Project name, ticket counts (62/82 complete, 9 blocked)
- All 10 phases with status indicators
- Next ticket (T-074) with full description + what it unblocks
- Latest handover (full session summary with commits, decisions, what's next)
- Issue count (3 open)
- Handover count (20)

### Session 2 (Manual) got everything above PLUS:
- RULES.md content (development constraints)
- WORK_STRATEGIES.md content (6 lessons learned)
- All 90 ticket files read individually (via Explore agent)
- All 9 issue files read individually
- Last 3 handovers (not just latest)
- Last 20 git commits
- Config.json details
- Roadmap.json raw structure
- Per-phase ticket counts with more granular status

### What Session 2 captured that Session 1 missed:
- Development rules and process constraints (RULES.md)
- Accumulated lessons and anti-patterns (WORK_STRATEGIES.md)
- Historical context from older handovers (not just latest)
- Git commit history
- Individual ticket details for all 90 tickets

---

## UX Observations

### Session 1 (MCP) — Strengths
- Extremely fast — context in 3 seconds
- Token efficient — pre-computed summaries instead of raw file parsing
- Structured output — phases with status, next ticket with unblock impact

### Session 1 (MCP) — Weaknesses
- **Not intuitive** — user had to know to say "use our mcp" after reading CLAUDE.md
- **Two messages** — couldn't get context in one prompt
- **Shallow context** — only 3 tools called; didn't read RULES.md, WORK_STRATEGIES.md, or commit history
- **No process knowledge** — the AI didn't learn development rules or review process requirements

### Session 2 (Manual) — Strengths
- **One prompt** — user's established "read everything" prompt gets full context in one shot
- **Deep context** — RULES.md, WORK_STRATEGIES.md, commit history all loaded
- **Process-aware** — AI knows review requirements, anti-patterns, development rules
- **Historical depth** — 3 handovers give trend understanding, not just current state

### Session 2 (Manual) — Weaknesses
- Slow (1:41) and token-heavy (46.5k)
- 100+ tool calls create visual noise
- User must remember/type the long startup prompt every session
- Reads raw JSON for all 90 tickets instead of using pre-computed summaries

---

## Key Insight

**Neither approach alone is optimal.** The ideal session start combines:
1. MCP tools for **structured project state** (fast, token-efficient)
2. File reads for **process knowledge** (RULES.md, WORK_STRATEGIES.md)
3. Multiple handovers for **historical context** (not just latest)
4. Git log for **recent activity**

The gap isn't in the tools — it's in the **orchestration**. A Claude Code skill could combine both approaches into a single, automatic session start.

---

## Proposed Solution: Claude Code Skill

A `/prime` skill that:
1. Calls `storybloq_status` (MCP) — project overview
2. Calls `storybloq_recap` (MCP) — session diff + suggested actions
3. Calls `storybloq_handover_latest` (MCP) — latest session context
4. Reads RULES.md — development constraints
5. Reads WORK_STRATEGIES.md — lessons learned
6. Runs `git log --oneline -10` — recent commits

One command, full context, best of both worlds.
