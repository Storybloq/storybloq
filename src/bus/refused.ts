// ISS-953: refused (parked-and-dropped) message artifacts. A standalone module,
// not part of store.ts or fold.ts, so BOTH can import it without creating a
// circular dependency -- store.ts writes here on park, fold.ts's resolveRefusals
// reads here to resolve a thread's refusal history.

import { lstat, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { canonicalHash } from "./canonical.js";
import { BusError } from "./errors.js";
import { durableCreate, readJsonNoFollow, syncDirectory } from "./io.js";
import { openDirNoFollow, type BusPaths } from "./paths.js";
import { evidenceKeys } from "./security.js";
import {
  BUS_MAX_REFUSED_PAYLOAD_BYTES,
  BusRefusedArtifactSchema,
  type BusDroppedMessage,
  type BusMessagePayload,
  type BusRefusedArtifact,
} from "./schemas.js";

function serialize(value: unknown): string {
  return JSON.stringify(value, null, 2) + "\n";
}

// Resolve the refused-artifact directory, mirroring validatedAutoAttachDir's
// symlink-safe, leaf-only-under-an-already-existing-busRoot contract (auto-attach-
// outcome.ts). Lazily created on first write so an existing v2 runtime that predates
// this feature is never required to have it, matching paths.ts's non-layout-required
// treatment of BusPaths.refused.
export async function validatedRefusedDir(
  paths: BusPaths,
  opts: { create: boolean; afterProbe?: () => Promise<void> },
): Promise<string | null> {
  // ISS-953 Codex round 3 finding #4: validate busRoot on EVERY call, not
  // only the create-and-not-yet-existing branch below. lstat only guards the
  // path's FINAL component, so checking just `dir` (refused) without first
  // validating its parent silently follows an intermediate symlink if
  // busRoot were ever replaced with one after Bus's own genuinely-safe
  // original creation -- a TOCTOU the fast path (refused already exists, the
  // common case on every call after the first) previously skipped entirely,
  // contradicting the comment above claiming this function "validates its
  // own parent (paths.busRoot) the same way" as validatedRedeliverMarkerDir.
  //
  // ISS-953 Codex round 4 finding #4: round 3 gave busRoot and this fast path
  // a bare lstat, never the atomic open+fstat-identity check paths.ts's
  // validatedRedeliverMarkerDir already uses (openDirNoFollow) -- this module
  // never received that hardening even though round 3's own finding #3/#4
  // pairing named it as the same architectural gap at a sibling validator.
  // openDirNoFollow closes the check-to-open race for THIS function's OWN
  // validation of each path (same scope limit as paths.ts -- it does not make
  // a later, separately-resolved child path durably safe; see openDirNoFollow's
  // own comment).
  const rootMissing = await lstat(paths.busRoot).then(
    () => false,
    (err) => {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return true;
      throw err;
    },
  );
  if (rootMissing) {
    throw new BusError("corrupt", ".story/bus is missing");
  }
  await openDirNoFollow(paths.busRoot, ".story/bus");
  const dir = paths.refused;
  const dirMissing = await lstat(dir).then(
    () => false,
    (err) => {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return true;
      throw err;
    },
  );
  // ISS-953 Codex round 4 finding #9: test-only barrier seam, same posture
  // and same placement (immediately after the ENOENT probe, before branching
  // on it) as validatedRedeliverMarkerDir's own afterProbe (paths.ts). Two
  // concurrent calls whose lstat both observe ENOENT before either commits
  // via mkdir is the only interleaving that exercises the EEXIST-recovery
  // branch below; relying on Promise.all alone to land that way is a
  // scheduling assumption, not a guarantee -- the same flaw round 3 finding
  // #18 fixed for the marker-dir sibling. Never passed in production.
  if (opts.afterProbe) await opts.afterProbe();
  if (!dirMissing) {
    await openDirNoFollow(dir, ".story/bus/refused");
    return dir;
  }
  if (!opts.create) return null;
  try {
    await mkdir(dir, { mode: 0o700 });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
  }
  // Replaces a separate post-mkdir lstat with the atomic open+fstat-identity
  // check: mkdir's own EEXIST recovery and a LATER, separate lstat re-verify
  // is itself a two-syscall gap another process could land a symlink swap
  // inside, the exact shape openDirNoFollow closes for this function's own
  // check.
  await openDirNoFollow(dir, ".story/bus/refused");
  // ISS-953 Codex round 3 finding #5: fsync the parent (busRoot) so the
  // "refused" directory entry itself survives a crash -- durableCreate's own
  // sync (in writeRefusedArtifact, right after this returns) only covers the
  // artifact FILE's containing directory, which is this one, but only once it
  // exists. Without this, a crash between mkdir and this sync can lose the
  // directory entry while the park entry referencing its artifact still
  // lands, leaving a committed park entry whose artifact directory vanished.
  // Unconditional on which branch created the directory, matching paths.ts's
  // validatedRedeliverMarkerDir (fix step 2/finding #2): a retry hitting
  // EEXIST because a prior call already created it has no way to know
  // whether that prior call crashed before reaching its own sync.
  await syncDirectory(paths.busRoot);
  return dir;
}

// ISS-953 fix step 4: preallocate-then-bind write of the dropped message's full
// content, content-addressed by the canonical hash of the artifact shape itself so
// byte-identical drops (even across different threads/triggers) share one file. On
// EEXIST, hash-verify the existing content rather than trusting presence alone -- a
// name collision can only arise from a genuine hash collision or a corrupted/hand-
// edited file, and both must surface as `corrupt`, never be silently accepted.
export async function writeRefusedArtifact(paths: BusPaths, message: BusMessagePayload): Promise<BusDroppedMessage> {
  const artifact: BusRefusedArtifact = {
    schema: "storybloq-bus-refused-artifact/v1",
    messageKind: message.kind,
    severity: message.severity,
    body: message.body,
    refs: message.refs,
  };
  const refusedPayloadHash = canonicalHash(artifact);
  const dir = (await validatedRefusedDir(paths, { create: true }))!;
  const target = join(dir, `${refusedPayloadHash}.json`);
  try {
    await durableCreate(target, serialize(artifact));
  } catch (err) {
    // durableCreate wraps a raw EEXIST as BusError("conflict", ...), never leaves
    // the raw NodeJS.ErrnoException code on the thrown value -- check the BusError
    // code, not a raw errno code that durableCreate's own error never carries.
    if (!(err instanceof BusError) || err.code !== "conflict") throw err;
    // ISS-953 Codex round 4 finding #5 (downgraded MAJOR->LOW maintenance on
    // review: readJsonNoFollow already bounds this read against its OWN opened
    // handle's stat with a fixed-size buffer, so no memory-exhaustion race
    // existed here regardless). What's real: omitting maxBytes let this call
    // silently inherit io.ts's DEFAULT_MAX_BYTES instead of this module's own
    // BUS_MAX_REFUSED_PAYLOAD_BYTES -- the two happen to be numerically equal
    // today, but nothing ties them together. Pass it explicitly.
    const existing = await readJsonNoFollow(target, BusRefusedArtifactSchema, BUS_MAX_REFUSED_PAYLOAD_BYTES).catch(() => null);
    if (!existing || canonicalHash(existing) !== refusedPayloadHash) {
      throw new BusError("corrupt", `Refused artifact ${refusedPayloadHash} exists but does not match its own hash`);
    }
  }
  // ISS-953 Codex round 4 finding #4 (order item 5): mirrors ISS-999's
  // post-write verification (store.ts's createHopCapSuccessorThread marker
  // write) -- durableCreate's own path resolution re-resolves target from
  // the root, so a directory or file swap landing after validatedRefusedDir
  // returned but before this write completed would otherwise report success
  // while the artifact lands somewhere else. This does NOT close that race
  // (accepted by design, same doctrine as ISS-999 and openDirNoFollow's own
  // residual note -- Node has no path-relative-to-fd operation to close it
  // with). It closes the SILENCE: a swap that persists past this check is
  // caught deterministically, on every call, rather than reported as a
  // clean success.
  //
  // ISS-953 Codex round 5 finding #6: this used to sit INSIDE the try block,
  // after a fresh durableCreate SUCCESS only. A directory swap landing right
  // before the write, with the escape target pre-populated with a hash-valid
  // artifact, made durableCreate throw "conflict" instead; the catch branch's
  // content-hash check then passed on the redirected content without ever
  // reaching this check, silently committing a park whose artifact exists
  // only behind the swapped directory. Moved to run after BOTH the
  // create-success and EEXIST-recovery paths converge, so neither branch --
  // and no future third branch added upstream of it -- can skip it.
  const dirCheck = await lstat(dir).catch(() => null);
  if (!dirCheck || dirCheck.isSymbolicLink() || !dirCheck.isDirectory()) {
    throw new BusError("corrupt", `Refused-artifact directory was replaced during the write -- the artifact for ${refusedPayloadHash} cannot be trusted`);
  }
  // Not independently exercised by the finding-#4 fix's own test (a
  // directory-level swap already resolves through `dir` to the escape
  // target, so lstat on `target` finds a genuine, non-symlink regular file
  // there -- confirmed by reverting this check alone: no test flip on that
  // scenario). Kept for a DIFFERENT attack shape that dirCheck cannot see:
  // the directory stays genuine but the leaf file itself is swapped for a
  // symlink or removed. Same "redundant for this shape, load-bearing for
  // another" pattern as the ISS-999 marker fix's own file check. ISS-953
  // byte-review correction: a prior version of this comment claimed the
  // round-5 finding #6 EEXIST test below independently exercises this check.
  // Verified false by reverting this check alone with the full suite
  // running: every test still passed, including finding #6's, whose own
  // assertion is on dirCheck's error message ("was replaced during the
  // write"), not this check's -- dirCheck's directory-level swap already
  // covers that test's scenario before this check is ever reached. That gap
  // is now closed by the leaf-swap-only test in store.test.ts (directory
  // left alone, only `target` swapped for a symlink after the write),
  // RED-proofed by reverting this check alone: the new test genuinely fails
  // with the write reported as resolved instead of rejected.
  const fileCheck = await lstat(target).catch(() => null);
  if (!fileCheck || fileCheck.isSymbolicLink() || !fileCheck.isFile()) {
    throw new BusError("corrupt", `Refused artifact ${refusedPayloadHash} did not land at its validated path after being written`);
  }
  // ISS-953 Codex round 4 finding #7 gave store.ts's redeliver marker a
  // read-back-and-compare upgrade over this same lstat-only shape; this
  // check deliberately does NOT get that upgrade, and the reason is what
  // the filename encodes rather than a lower priority. store.ts's marker
  // is named after a FOREIGN key (`${refusedEntryHash}.json`, the hash of
  // the refused ENTRY it points at) -- the marker's own content
  // (successorThreadId) is unconstrained by that name, so a same-shape
  // swap after the write is invisible to a check that only confirms a
  // file exists at the path. This artifact's filename IS
  // `canonicalHash(artifact)` -- content-addressed -- so every subsequent
  // read (readRefusedArtifact) re-hashes the content and compares it
  // against the name it was found under. ISS-953 byte-review correction:
  // this previously called that guarantee "strictly stronger" than a
  // one-time post-write compare -- checked rather than assumed, and false:
  // they are DIFFERENT guarantees, not one dominating the other. The
  // one-time compare catches a swap landing in the narrow write-to-readback
  // window, guaranteed, exactly once, and is permanently blind after that
  // single check completes. The re-hash-on-every-read approach instead
  // catches a swap at whatever point some future call actually reads this
  // artifact, however much later that is -- but only if a read happens
  // while the corrupted content is still in place; a swap-then-revert that
  // never coincides with a read goes uncaught either way. The upgrade earns
  // its cost where the filename cannot already prove the content; here it
  // can, on every read, for free -- that is why it is skipped, not because
  // the resulting guarantee is provably broader.
  // ISS-953 fix step 16 (revised): evidence keys known right now, before the
  // message is even dropped -- persisted onto the park entry itself so fold's
  // seen-set does not depend on the artifact still existing later. See the
  // BusDroppedMessageSchema comment (schemas.ts) for the full rationale and the
  // documented residual (entries written before this field existed keep the old
  // artifact-read-dependent behavior).
  const keys = evidenceKeys(message.refs);
  return {
    messageKind: message.kind,
    severity: message.severity,
    refusedPayloadHash,
    ...(keys.length > 0 ? { evidenceKeys: keys } : {}),
  };
}

// ISS-953 fix step 8: read the artifact back with a size-capped read (independent of
// the write-time cap, so a corrupted/oversized file on disk fails this read cleanly
// rather than exhausting memory), hash-verified against its own filename.
export async function readRefusedArtifact(
  paths: BusPaths,
  refusedPayloadHash: string,
): Promise<{ status: "resolved"; artifact: BusRefusedArtifact } | { status: "missing" | "corrupt" }> {
  const dir = await validatedRefusedDir(paths, { create: false });
  if (!dir) return { status: "missing" };
  const target = join(dir, `${refusedPayloadHash}.json`);
  let stat;
  try {
    stat = await lstat(target);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { status: "missing" };
    throw err;
  }
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size > BUS_MAX_REFUSED_PAYLOAD_BYTES) {
    return { status: "corrupt" };
  }
  // Same explicit-maxBytes correction as writeRefusedArtifact's EEXIST-recovery
  // read above -- io.ts's readJsonNoFollow already bounds its own read safely
  // regardless (see that comment), this just stops the two constants from
  // agreeing only by coincidence.
  const parsed = await readJsonNoFollow(target, BusRefusedArtifactSchema, BUS_MAX_REFUSED_PAYLOAD_BYTES).catch(() => null);
  if (!parsed || canonicalHash(parsed) !== refusedPayloadHash) {
    return { status: "corrupt" };
  }
  return { status: "resolved", artifact: parsed };
}

// ISS-953: readRefusedArtifact plus a cross-check against the park entry's OWN
// droppedMessage.{messageKind,severity} -- two independently-stored copies of
// the same fact. The artifact's content-hash filename already guards against
// tampering the ARTIFACT itself (a changed messageKind/severity there no
// longer matches refusedPayloadHash, caught above as corrupt). It does NOT
// guard the ENTRY's own droppedMessage fields, which live inside the
// hash-chained entry log and would only be caught by THIS check, not by the
// artifact's own hash. The ship gate reads droppedMessage.severity directly
// (never touching the artifact); successor verification reads the artifact's
// severity. A divergence between them -- entry says "medium", artifact says
// "critical", or vice versa -- must never resolve as trustworthy, since either
// reader alone would be silently wrong about content severity.
export async function readConsistentRefusedArtifact(
  paths: BusPaths,
  droppedMessage: BusDroppedMessage,
): Promise<{ status: "resolved"; artifact: BusRefusedArtifact } | { status: "missing" | "corrupt" }> {
  const result = await readRefusedArtifact(paths, droppedMessage.refusedPayloadHash);
  if (result.status !== "resolved") return result;
  if (result.artifact.messageKind !== droppedMessage.messageKind || result.artifact.severity !== droppedMessage.severity) {
    return { status: "corrupt" };
  }
  return result;
}
