# Local Storybloq plugin

This integration keeps `.story/` in your project as the source of truth. The Mac app is optional. The local board uses the installed Storybloq runtime directly; it does not need an OpenAI API key, a Storybloq account, or a tunnel.

## Availability

This implementation is under verification and has not been published. The currently published package must not be assumed to contain `storybloq-codex`. Use the tested package artifact provided with this implementation for local evaluation.

The verified host so far is Codex CLI 0.153.4's app-server. Native Codex board rendering, automatic opening, and ChatGPT Work's local desktop experience have not yet been verified. Retrieving the board's HTML resource is not a rendering test.

## Installation and updates

Requires Node 20 or newer and a Codex CLI with the `codex plugin` commands. Install the supplied Storybloq npm package using your normal npm installation method, then run:

```sh
storybloq-codex install
```

This registers the owned `storybloq-local` marketplace and installs `storybloq@storybloq-local`. It captures the installation's actual Node executable and Storybloq CLI entry, so later board launches do not depend on finding `storybloq` on the desktop app's PATH. Those paths identify the installed software, not a particular project.

Open a new local Codex task in your project and ask:

```text
Open Storybloq for this project
```

The dedicated Storybloq skill loads the current task's board and context. If `.story/` is missing, it offers setup. Setup uses the same canonical initializer as the CLI and cannot overwrite an existing ledger. The connected board recognizes completed setup without selecting another task's project.

After installing a newer Storybloq package, rerun `storybloq-codex install`. Restart existing tasks to use the refreshed runtime. Keep the captured Node and Storybloq installation available. Moving or deleting either installation requires reinstalling the package and rerunning this command.

The installer does not alter Claude Code skills, hooks, or MCP settings. It uses Codex's own plugin commands rather than editing its configuration directly. It refuses storage or marketplace names owned by a different installation. If installation fails, fix the reported cause and rerun the command; its generated source remains available for retry.

## Project behavior

Each MCP connection captures its task's directory and stays bound to that project. Within a Git repository it searches up to that checkout's root, including a worktree's own root. Outside Git it checks the task directory. Inherited project-root overrides do not select a different project. An incomplete or unreadable ledger is an error requiring repair, rather than permission to initialize over it or load an ancestor.

Edits use existing canonical handlers with revision checks. If another client changes the record, reread it and review your draft before retrying. The board must not overwrite the newer record using a stale revision.

## Support evidence and remaining checks

| Capability | Codex app-server | Native Codex desktop | ChatGPT Work |
| --- | --- | --- | --- |
| Task directory and local MCP | Verified | Separate verification pending | Separate verification pending |
| Two projects and canonical edits | Verified | Separate verification pending | Separate verification pending |
| Fresh Git worktree, stale conflict, restart | Verified using installed stdio runtime | Separate verification pending | Separate verification pending |
| HTML board resource | Verified | Rendering pending | Rendering pending |
| Automatic board opening | Unverified | Unverified | Unverified |
| Installer and update | Verified against the real Codex CLI, including a changed artifact with the same version | Desktop UI integration pending | Separate verification pending |

OpenAI documents local marketplaces as a desktop authoring and testing path, including Work mode. Local Work depends on the desktop app and the relevant account/device permissions. Web installation does not deploy local command scripts. These documented capabilities do not establish that this plugin has passed a separate Work test. See [building plugins](https://developers.openai.com/plugins/build/plugins) and [Work local security](https://learn.chatgpt.com/docs/enterprise/chatgpt-work-local-security).

The optional hosted connector is deferred. A developer tunnel is not part of this customer workflow. Distribution readiness remains false until actual host UI and the remaining support matrix checks are complete.
