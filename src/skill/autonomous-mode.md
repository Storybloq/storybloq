# Autonomous & Tiered Modes

This file is referenced from SKILL.md for `/story auto`, `/story review`, `/story plan`, and `/story guided` commands.

## Autonomous Mode

`/story auto` starts an autonomous coding session. The guide picks tickets, plans, reviews, implements, and commits -- looping until all tickets are done or the session limit is reached.

**How it works:**

1. Call `claudestory_autonomous_guide` with `{ "sessionId": null, "action": "start" }`
2. The guide returns an instruction with ticket candidates and exact JSON for the next call
3. Follow every instruction exactly. Call the guide back after each step.
4. The guide advances through: PICK_TICKET -> PLAN -> PLAN_REVIEW -> IMPLEMENT -> CODE_REVIEW -> FINALIZE -> COMPLETE -> loop
5. Continue until the guide returns SESSION_END

**Critical rules for autonomous mode:**
- Do NOT use Claude Code's plan mode -- write plans as markdown files
- Do NOT ask the user for confirmation or approval
- Do NOT stop or summarize between tickets -- call the guide IMMEDIATELY
- Follow the guide's instructions exactly -- it specifies which tools to call, what parameters to use
- After each step completes, call `claudestory_autonomous_guide` with `action: "report"` and the results

**Recommended setup for long sessions:**

Run Claude Code with: `claude --model claude-opus-4-6 --dangerously-skip-permissions`

- **Skip-permissions** enables unattended execution -- no approval prompts consuming context
- **Claude Story handles compaction automatically** -- context preserved across compactions, do not cancel because context feels large
- Use only in **trusted repositories** -- skip-permissions disables safety prompts for all tool use

**If the guide says to compact:** Call `claudestory_autonomous_guide` with `action: "pre_compact"`, then run `/compact`, then call with `action: "resume"`.

**If something goes wrong:**
- Context feels large -- do nothing, compaction is automatic via hooks
- Compaction happened -- call with `action: "resume"` to continue
- Session stuck after compact -- run `claudestory session clear-compact` in terminal, then `action: "resume"`
- Unrecoverable error -- run `claudestory session stop` in terminal (admin escape hatch)

## Tiered Access -- Review, Plan, Guided Modes

The autonomous guide supports four execution tiers. Same guide, same handlers, different entry/exit points.

### `/story review T-XXX`

"I wrote code for T-XXX, review it." Enters at CODE_REVIEW, loops review rounds, exits on approval.

1. Call `claudestory_autonomous_guide` with `{ "sessionId": null, "action": "start", "mode": "review", "ticketId": "T-XXX" }`
2. The guide enters CODE_REVIEW -- follow its diff capture and review instructions
3. On approve: session ends automatically. On revise/reject: fix code, re-review
4. After approval, you can proceed to commit -- the guide does NOT auto-commit in review mode

**Note:** Review mode relaxes git constraints -- dirty working tree is allowed since the user has code ready for review.

### `/story plan T-XXX`

"Help me plan T-XXX." Enters at PLAN, runs PLAN_REVIEW rounds, exits on approval.

1. Call `claudestory_autonomous_guide` with `{ "sessionId": null, "action": "start", "mode": "plan", "ticketId": "T-XXX" }`
2. The guide enters PLAN -- write the implementation plan as a markdown file
3. On plan review approve: session ends automatically. On revise/reject: revise plan, re-review
4. The approved plan is saved in `.story/sessions/<id>/plan.md`

### `/story guided T-XXX`

"Do T-XXX end to end with review." Full pipeline for a single ticket: PLAN -> PLAN_REVIEW -> IMPLEMENT -> CODE_REVIEW -> FINALIZE -> COMPLETE -> HANDOVER -> SESSION_END.

1. Call `claudestory_autonomous_guide` with `{ "sessionId": null, "action": "start", "mode": "guided", "ticketId": "T-XXX" }`
2. Follow every instruction exactly, calling the guide back after each step
3. Session ends automatically after the single ticket is complete

**Guided vs Auto:** Guided mode forces `maxTicketsPerSession: 1` and exits after the ticket. Auto mode loops until all tickets are done or the session limit is reached.

### All tiered modes:
- Require a `ticketId` -- no ad-hoc review without a ticket in V1
- Use the same review process as auto mode (same backends, same adaptive depth)
- Can be cancelled with `action: "cancel"` at any point
