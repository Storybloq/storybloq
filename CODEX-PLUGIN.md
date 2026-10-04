# Local Storybloq plugin

This integration keeps `.story/` in your project as the source of truth. The Mac app is optional. The local board uses the installed Storybloq runtime directly; it does not need an OpenAI API key, a Storybloq account, or a tunnel.

## Availability

This implementation is under verification and has not been published. The currently published package must not be assumed to contain `storybloq-codex`. Use the tested package artifact provided with this implementation for local evaluation.

The verified integration host is Codex CLI 0.153.4's app-server. The installed plugin also renders the existing board in a local browser through its explicit Open Storybloq link. User-assisted acceptance on October 3, 2026 verified the explicit Open Storybloq action rendering the CPM board in browser panels in both Codex desktop and ChatGPT Work. Native MCP App rendering and automatic opening remain unverified. These runs did not establish fresh installation or full editing acceptance in each desktop mode. Retrieving an HTML resource alone is not a rendering test.

## Installation and updates

Requires Node 20 or newer and a Codex CLI with the `codex plugin` commands. Install the supplied Storybloq npm package using your normal npm installation method, then run:

```sh
npm install -g ./storybloq-storybloq-1.16.0.tgz
storybloq-codex install
```

This registers the owned `storybloq-local` marketplace and installs `storybloq@storybloq-local`. It captures the installation's actual Node executable and Storybloq CLI entry, so later board launches do not depend on finding `storybloq` on the desktop app's PATH. Those paths identify the installed software, not a particular project.

Open a new local Codex task in your project and ask:

```text
Open Storybloq for this project
```

The dedicated Storybloq skill loads the current task's board and context. If `.story/` is missing, it offers setup. Setup uses the same canonical initializer as the CLI and cannot overwrite an existing ledger. The connected board recognizes completed setup without selecting another task's project.

If a native board is not displayed, use the **Open Storybloq** link returned by the tool. This opens the same board in a local browser, served by this task's plugin process. There is no separate server command or developer tunnel. Keep the link in its own task; it grants access to that task's local board. The link stops working when the connection ends. After a restart, ask to open Storybloq again for a fresh link.

After installing a newer Storybloq package, rerun `storybloq-codex install`. Restart existing tasks to use the refreshed runtime. Keep the captured Node and Storybloq installation available. Moving or deleting either installation requires reinstalling the package and rerunning this command.

The installer does not alter Claude Code skills, hooks, or MCP settings. It uses Codex's own plugin commands rather than editing its configuration directly. It refuses storage or marketplace names owned by a different installation. If installation fails, fix the reported cause and rerun the command; its generated source remains available for retry.

## Project behavior

Each MCP connection captures its task's directory and stays bound to that project. Within a Git repository it searches up to that checkout's root, including a worktree's own root. Outside Git it checks the task directory. Inherited project-root overrides do not select a different project. An incomplete or unreadable ledger is an error requiring repair, rather than permission to initialize over it or load an ancestor.

Edits use existing canonical handlers with revision checks. If another client changes the record, reread it and review your draft before retrying. The board must not overwrite the newer record using a stale revision. Browser write requests additionally reject duplicate request identifiers before invoking a save handler. A lost response can still follow a committed save: the draft remains visible and the board asks you to reload before retrying. The browser endpoint admits at most 10,000 write requests during one connection; restart the task connection if it reaches that limit.

## Federation

The Nodes view displays configured relationships and cached progress. Live node details are supported for real directories inside the current project root. The local plugin does not inherit environment-based access grants to directories outside that root. For an external node, open a separate local task in that node's project and open its own Storybloq board. Configured external paths and cached graph data do not grant filesystem access. A customer-facing external-root approval flow is deferred.

## Support evidence and remaining checks

| Capability | Codex app-server | Native Codex desktop | ChatGPT Work |
| --- | --- | --- | --- |
| Task directory and local MCP | Verified | CPM explicit-open observed | CPM explicit-open observed |
| Two projects and canonical edits | Verified | Separate verification pending | Separate verification pending |
| Fresh Git worktree, stale conflict, restart | Verified using installed stdio runtime | Separate verification pending | Separate verification pending |
| HTML board resource | Verified | Native panel pending | Native panel pending |
| Explicit local browser board | Verified from installed package with real browser edits | Rendered in desktop browser panel | Rendered in Work browser panel |
| Automatic board opening | Unverified | Unverified | Unverified |
| Installer and update | Verified against the real Codex CLI, including a changed artifact with the same version | Desktop UI integration pending | Separate verification pending |

OpenAI documents local marketplaces as a desktop authoring and testing path, including Work mode. Local Work depends on the desktop app and the relevant account/device permissions. Web installation does not deploy local command scripts. The observed Work explicit-open test is narrower than the remaining clean-install, editing and restart acceptance matrix. See [building plugins](https://developers.openai.com/plugins/build/plugins) and [Work local security](https://learn.chatgpt.com/docs/enterprise/chatgpt-work-local-security).

The optional hosted connector is deferred. A developer tunnel is not part of this customer workflow. The browser checks cover both themes, phases, ticket and issue editing, note preview/editing, chronological handovers, recorded sessions, federation links and in-root node details. Two simultaneous project connections were edited independently, with disk readback confirming isolation. Conflict and committed-save response-loss checks preserved drafts. Installed Node 20 tests cover worktrees, setup activation, restart, connection-owned endpoint shutdown, and missing optional browser assets.

Distribution readiness remains false. The explicit browser-panel action is observed in both desktop modes, but fresh desktop installation, two simultaneous native projects, missing-ledger setup, restart and file-confirmed edits still need separate acceptance in each mode. Native self-control is denied to the verification agent by the host; enabling Computer Use does not remove that restriction. Existing user-assisted evidence remains valid. Automatic opening is unverified.

## Data shared with the host

The local plugin exposes bounded board, notes, handover, federation and session projections to both the assistant and the UI. Selected results enter the host conversation context, including results requested by the app. They can include authored bodies, cached federation metadata, branch names, milestone notes and session tool targets containing paths. Allowlisting is not secret redaction. Unknown record extensions, raw session logs and transcripts are excluded. The older private connector keeps its UI-only result contract.

Local storage means `.story/` stays authoritative on disk; it does not mean selected tool results stay off the AI host. The board starts only a task-owned loopback listener, uses embedded assets and has no Storybloq cloud storage service.

## Release and Directory preparation

See [OpenAI release preparation](OPENAI-RELEASE.md) for the local marketplace route, acceptance checklist and separate public Directory requirements. This candidate has not been submitted or published. Core 1.16 release gates and integration with the reviewed main branch must pass before release.
