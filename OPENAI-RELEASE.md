# OpenAI plugin release preparation

Status: unpublished local candidate, October 4, 2026. This document is a preparation packet, not a claim of Directory eligibility or approval.

## Distribution routes

Storybloq's customer experience is a local project plugin. Ship the CLI, canonical handlers, embedded board and dedicated skill together in the npm artifact. `storybloq-codex install` registers its local marketplace with Codex. Preserve the separate Claude Code setup/mod. Do not redirect customers to a demo tunnel or require a Storybloq account.

The repository marketplace currently points to the older skill plugin at `plugins/storybloq`; it is not the same installation as `storybloq@storybloq-local`. Do not advertise the repository marketplace command as installing this board candidate. Consolidating those channels and eliminating duplicate legacy registrations is a release task. The dedicated installer does not change those existing registrations automatically.

OpenAI documents local marketplaces and portable plugin packaging, with compatibility support for `.codex-plugin`. Its public MCP submission path uses remote HTTPS through WithMCP; for a server that must run locally, the documentation directs developers to contact OpenAI. Storybloq needs that local-server distribution path confirmed before claiming Directory readiness. Packaging compatibility alone does not establish acceptance. [Packaging documentation](https://developers.openai.com/plugins/build/plugins).

## Submission packet

Prepared listing copy: **Storybloq: your local project board and memory.** Open a project's board, browse phases, tickets, issues, notes, handovers, sessions and federation, and save reviewed edits to its `.story/` files. Requires a local project and supported desktop host. Explicit Open Storybloq is supported; automatic opening is not promised.

Use the existing Storybloq icon and trademark. Candidate support contact: shayegh@me.com. Before submission, verify the public support and privacy-policy URLs and ensure the privacy policy describes the data flows in CODEX-PLUGIN.md. Do not substitute a placeholder policy URL.

OpenAI's submission workflow requires a verified developer identity, an uploaded plugin ZIP, validation/review, and a separate publish step after approval. Include MCP in the first submission; a skills-only initial submission cannot later add it. Prepare exactly five positive and three negative tests plus a walkthrough and release notes. Do not upload this local candidate until the local MCP route is confirmed. [Submission documentation](https://developers.openai.com/plugins/deploy/submission).

## Reviewer walkthrough and test prompts

Use synthetic projects A and B, each with different project names and distinct note bodies, plus an empty project C. Never upload real customer ledgers or capability URLs in review evidence.

| Case | Prompt/action | Required outcome |
| --- | --- | --- |
| Positive 1 | Open Storybloq for this project in A | A board renders after the explicit action; no credentials requested |
| Positive 2 | Open B concurrently and show its open tickets | B results only; A remains bound to A |
| Positive 3 | Change A's synthetic note title | Returned revision used; disk confirms A changed and B did not |
| Positive 4 | Set up Storybloq in C, then open it | Authorized canonical setup; tools activate and empty board renders |
| Positive 5 | Restart A's task and reopen Storybloq | Fresh connection/link; saved note survives |
| Negative 1 | Open without `.story/`, without authorizing setup | Offer setup; write nothing |
| Negative 2 | Save an old revision after another client edits | Conflict returned; newer disk bytes preserved |
| Negative 3 | Read an external federation path without a grant | No external read; suggest that project's own task |

Run all cases separately in Codex desktop and ChatGPT Work. Record host version, artifact hash, actual outcome and file readback. The support matrix in CODEX-PLUGIN.md separates runtime/browser evidence from desktop evidence. Pending rows are not passes.

## Ship gates

- Integrate reviewed core changes after Claude's 1.16 work lands; retain the plugin UI changes. Do not rebase a shared branch underneath another agent.
- Pass the repository's 1.16 release gates, including T-525 at the final ship revision. Plugin checks alone do not waive those gates.
- Build and clean-install the final npm tarball. Check LICENSE, NOTICE, embedded asset notices, manifest, runtime, skill and documentation.
- Repeat installer/update checks and the desktop matrix above; record support limitations in the release notes.
- Resolve the two marketplace paths before promoting a single customer installation command. Confirm existing Claude Code setup still works.
- Submit only through a confirmed local-plugin route. Publish only after approval and a deliberate release decision. Workspace public projection must use the existing release process.

Proposed release notes: adds a task-bound local Storybloq board, explicit desktop browser opening, conversational reads and revision-protected edits, setup detection, and embedded brand assets. No automatic-opening claim, no hosted connector, no external-root permission UI. The package still needs the gates above before these notes describe a released version.
