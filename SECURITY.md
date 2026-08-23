# Security Policy

## Reporting a vulnerability

Email **shayegh@me.com** with the details. Please do not open a public issue
for an unpatched vulnerability.

Include what you need to make the report actionable: affected package and
version, what an attacker can do, and a reproduction if you have one. You will
get an acknowledgement, and we will tell you whether we consider it in scope
under the threat model below.

## Supported versions

Fixes land on the latest published release of each package. There are no
long-term support branches.

| Package | Source |
|---------|--------|
| `@storybloq/storybloq` | [Storybloq/storybloq](https://github.com/Storybloq/storybloq) |
| `@storybloq/lenses` | [Storybloq/lenses](https://github.com/Storybloq/lenses) |

## Threat model

Both packages run as **local, stdio-only MCP servers**. They are launched as a
subprocess by an AI client on a developer's own machine, speak JSON-RPC over
stdin and stdout, and read and write files under the project's `.story/`
directory. They open no listening socket, bind no port, and accept no network
connections.

This matters when reading an automated dependency scan. Both packages depend on
`@modelcontextprotocol/sdk`, which declares an HTTP transport stack (`express`,
`hono`, `cors`, `ajv`) so that consumers who want a remote transport have one.
We import `StdioServerTransport` only, so that code is never loaded. Advisories
whose attack requires an HTTP request reaching a listening server are therefore
not reachable through our usage.

Not reachable is not the same as not real. We still track and clear these
advisories, because a dependency that is unreachable today can become reachable
after a refactor, and because a clean audit is easier to reason about than a
list of remembered exceptions. If you believe one of them IS reachable through
a path we have missed, that is exactly the kind of report we want.

In scope:

- Reading or writing files outside the project root
- Executing arbitrary code from ledger content, a review diff, or MCP tool input
- Leaking credentials, tokens, or file contents to a third party
- Privilege or ownership bypass in session guards, claims, or team-mode merges

Out of scope:

- Advisories in the SDK's HTTP transport stack, absent a demonstrated path from
  our stdio entry points
- Anything requiring an attacker who already has local code execution as the
  user, since that attacker already has everything the tool has
- Vulnerabilities in the AI client hosting the MCP server

## Disclosure

Tell us before you tell everyone else, and give us a reasonable window to ship
a fix. We will credit you in the release notes unless you would rather we did
not.
