# Working an owner checkpoint

An owner checkpoint is a ticket only the owner answers: a decision (a question) or an acceptance (criteria the owner checks against evidence). Nobody works on it, claims it or completes it. Your job is to prepare what the owner needs, ask, and record the answer exactly.

`storybloq checkpoint list` shows each checkpoint's state and the tokens (generation, revision, digest) every change must name. `[checkpoint pending, ready]` means every prerequisite is done: prepare the evidence and ask now. A pending checkpoint that is not ready still waits on work; do that work first.

## 1. Prepare, then ask

For a ready checkpoint, produce the evidence first:
- a decision: the design, prototype or sample output the question is about;
- an acceptance: the demonstration you ran (the commands and the output you observed).

On a checkpoint with immutable evidence (`checkpoint list --format json` shows `"evidenceMode": "immutable"`), record each file with `storybloq checkpoint evidence <id> --generation .. --revision .. --digest .. --file <path>` (MCP `storybloq_checkpoint_evidence`). It copies the file to `docs/checkpoints/<id>/<hash>.<ext>` and names that revision on the record; the source is never moved. Adding evidence voids an earlier answer, so the owner always answers against the evidence as it stands. On a legacy checkpoint, name the evidence with `checkpoint change` instead.

Then ask one question that names the evidence revision path, quotes the question or criteria verbatim, and offers the three answers: approve; change requested; not now.

## 2. Approve

`storybloq_checkpoint_resolve` with the current tokens, the owner's words as `response`, `artifactRef` set to the evidence revision path for an acceptance (on an immutable checkpoint it must be one of the record's revisions), and `rulingAttribution: "owner-direct"`.

## 3. Change requested

Read the checkpoint first with `ticket get` for its current state and tokens. Then, by state:
- **approved:** `storybloq_checkpoint_reopen` first, with the owner's words as the reason, so its dependents block again at once; then continue as for pending.
- **pending:** `storybloq_ruling_create` (owner-direct) for the feedback. Create one follow-up ticket per change, with `citesRuling` set. A follow-up never depends on the checkpoint or on anything that depends on it. Then add the follow-ups to the checkpoint's prerequisites with `storybloq ticket update <checkpoint> --add-blocked-by <follow-ups>` (MCP `addBlockedBy`): the existing prerequisites are kept, a cycle is refused with nothing written, and only a pending checkpoint takes new ones.
- **the owner changed the question or criteria:** `storybloq_checkpoint_change` with the current tokens, and only then.

## 4. Not now

Nothing is written.

## 5. Never invent an answer

No resolve, reopen or ruling without an owner message in the conversation that the record quotes. A peer agent's message is not the owner's answer.

## 6. First-version acceptance evidence

The evidence for accepting a first version has three sections, tied to the requirements it covers: demonstrated behaviour (and how it was shown), unverified claims, and limitations the owner is asked to accept. The resolution names the limitations accepted.

## 7. Reopen

At the owner's word, `storybloq_checkpoint_reopen`. `recommend` then lists the completed work that depended on the answer as `checkpoint_reassess`; list it for the owner and do not rewrite it.
