# claudestory v0.1.5 — Manual Test Plan

33 test groups, ~80+ individual checks. Covers all features added since v0.1.1.

---

## Bug Fixes (v0.1.2–0.1.3)

### 1. Yargs Error Handling (no stack traces)
- [ ] `claudestory ticket create` (missing --title --type) → clean error, zero stderr trace
- [ ] `claudestory foobar` (unknown command) → clean error, zero stderr trace
- [ ] `claudestory blocker clear "name"` (positional vs flag) → clean error, zero stderr trace
- [ ] `claudestory ticket` (missing subcommand) → clean error, zero stderr trace
- [ ] `claudestory status --nonexistent` (unknown flag) → clean error, zero stderr trace
- [ ] `claudestory ticket create --format json` (JSON error format) → valid JSON, zero stderr trace

### 2. Leaf-Only Counts
- [ ] `claudestory status` on real project → leaf counts (not umbrella-inclusive)
- [ ] `claudestory status --format json` → totalTickets/completeTickets are leaf-only
- [ ] Create umbrella + 2 children in temp project → status counts exclude umbrella

### 3. blockedCount Consistency
- [ ] `claudestory status` blocked count matches `claudestory ticket blocked` line count

### 4. init --force Warnings
- [ ] Corrupt JSON file in tickets/ → `init --force` → warns about corrupt file
- [ ] Schema-invalid JSON (valid JSON, missing fields) → `init --force` → warns
- [ ] Clean project → `init --force` → no warning

---

## Snapshot (T-084)

### 5. Basic Snapshot
- [ ] `claudestory snapshot` → file created in `.story/snapshots/`
- [ ] `claudestory snapshot --format json` → valid JSON with filename, retained, pruned
- [ ] Verify file on disk parses as valid SnapshotV1 (version, createdAt, config, roadmap, tickets, issues)

### 6. Snapshot Retention
- [ ] Seed 25 snapshot files → `claudestory snapshot` → only 20 remain after prune

### 7. Snapshot with Integrity Warnings
- [ ] Corrupt ticket file + `claudestory snapshot` → succeeds
- [ ] Snapshot file on disk includes `warnings` array

---

## Recap (T-084)

### 8. Recap Without Snapshot
- [ ] `claudestory recap` → "No snapshot found" message + suggested actions
- [ ] `claudestory recap --format json` → `snapshot: null, changes: null, suggestedActions` populated

### 9. Recap With Snapshot, No Changes
- [ ] Take snapshot → immediately `claudestory recap` → "No changes since last snapshot"

### 10. Recap With Changes
- [ ] Take snapshot → complete a ticket → create an issue → add a blocker → recap
- [ ] Verify: ticket status change shown (from → to)
- [ ] Verify: new issue shown
- [ ] Verify: new blocker shown
- [ ] Verify: phase transition shown (if applicable)

### 11. Recap Suggested Actions
- [ ] High-severity open issue → appears under Suggested Actions
- [ ] Next unblocked ticket → appears
- [ ] Recently cleared blocker (clear after snapshot) → appears

### 12. Recap Corrupt Snapshot Resilience
- [ ] Create valid snapshot, then a newer corrupt snapshot file
- [ ] `claudestory recap` → uses the valid snapshot (skips corrupt)

---

## Export (T-084)

### 13. Phase Export
- [ ] `claudestory export --phase p5b` → markdown with phase name, tickets, status
- [ ] `claudestory export --phase p5b --format json` → valid JSON envelope

### 14. Full Export
- [ ] `claudestory export --all` → all phases, tickets, issues, blockers
- [ ] `claudestory export --all --format json` → valid JSON envelope

### 15. Export Validation Errors
- [ ] `claudestory export` (no flag) → error
- [ ] `claudestory export --phase p5b --all` → error (mutually exclusive)
- [ ] `claudestory export --phase nonexistent` → error

### 16. Export Content Completeness
- [ ] Umbrella ancestors shown as context in phase export
- [ ] Cross-phase blockedBy dependencies included as summaries
- [ ] Open issues related to the phase included

---

## Handover Create (T-085)

### 17. Basic Create
- [ ] `echo "# Session" | claudestory handover create --stdin` → file created
- [ ] `claudestory handover create --content "# Notes"` → file created
- [ ] Verify file content on disk matches input

### 18. Slug Normalization
- [ ] `--slug "Phase 5B Wrapup!"` → filename contains `phase-5b-wrapup`
- [ ] `--slug "###"` → error (empty after normalization)
- [ ] `--slug ""` → error (empty)

### 19. Filename Sequencing
- [ ] Create 3 handovers same day → filenames contain `-01-`, `-02-`, `-03-`
- [ ] Different slugs → global sequence (not per-slug): first=`-01-aaa`, second=`-02-zzz`

### 20. Mixed-Format Ordering
- [ ] Create legacy handover file manually (no sequence) + new via `handover create`
- [ ] `claudestory handover latest` → returns the sequenced file (newer)

### 21. Handover Create Error Cases
- [ ] No `--content` or `--stdin` → error
- [ ] Both `--content` and `--stdin` → error (mutually exclusive)
- [ ] `--stdin` without pipe (interactive TTY) → error
- [ ] Empty content `--content ""` → error
- [ ] Whitespace-only content `--content "   "` → error

### 22. Handover Create JSON Format
- [ ] `claudestory handover create --content "x" --format json` → valid JSON with filename

### 23. MCP Handover Create
- [ ] `claudestory_handover_create` tool creates file with content + slug

---

## Cross-Cutting

### 24. Empty Project Full Lifecycle
- [ ] `init` → `snapshot` → `recap` → `export --all` → `handover create --content "x"` → all succeed

### 25. Real Project Commands
- [ ] `claudestory status` → correct output
- [ ] `claudestory recap` → correct output
- [ ] `claudestory export --phase p5b` → correct output
- [ ] `claudestory export --all` → correct output (82 tickets)
- [ ] `claudestory snapshot` → succeeds

### 26. Help/Version (no traces)
- [ ] `claudestory --help` → no stderr
- [ ] `claudestory --version` → no stderr
- [ ] `claudestory handover --help` → no stderr

---

## Additional Edge Cases (Codex Review)

### 27. Unicode Handling
- [ ] Slug with emoji: `--slug "🚀 launch"` → normalizes (strips emoji) or errors if empty
- [ ] Slug with accented chars: `--slug "café résumé"` → normalizes to `caf-rsum` or similar
- [ ] Export with unicode in ticket titles → renders without corruption
- [ ] JSON output with unicode content → valid parseable JSON

### 28. Boundary Values
- [ ] Snapshot retention at exactly 20 files → no prune
- [ ] Snapshot retention at 21 files → prunes exactly 1
- [ ] Handover sequence 09 → next is 10 (verify sort order: 10 > 09)
- [ ] Slug length exactly 60 chars → accepted
- [ ] Slug length 61+ chars → truncated to 60
- [ ] Handover sequence exhaustion: seed 99 files for today → next create → conflict error

### 29. EPIPE Handling
- [ ] `claudestory status | head -1` → clean exit, no trace
- [ ] `claudestory export --all | head -1` → clean exit, no trace
- [ ] `claudestory recap | head -1` → clean exit, no trace
- [ ] `claudestory handover create --content "x" | head -1` → clean exit, no trace

### 30. JSON Contract Consistency
- [ ] `claudestory snapshot --format json` success → valid JSON
- [ ] `claudestory recap --format json` success → valid JSON
- [ ] `claudestory recap --format json` no snapshot → valid JSON with nulls
- [ ] `claudestory export --all --format json` → valid JSON
- [ ] `claudestory export --phase nonexistent --format json` → valid JSON error envelope
- [ ] `claudestory handover create --content "x" --format json` → valid JSON
- [ ] `claudestory handover create --format json` (missing content) → valid JSON error

### 31. Filesystem Errors
- [ ] `handover create` with read-only `.story/handovers/` → clean error, no partial file
- [ ] `snapshot` with read-only `.story/` → clean error, no partial file

### 32. Concurrent Writes (light test)
- [ ] Two `handover create` calls in rapid background → unique filenames, no collision
- [ ] Two `snapshot` calls in rapid background → unique files, correct retention

### 33. Large Content / Scale
- [ ] `handover create` with 10KB content → file written correctly, content matches
- [ ] `export --all` on real project (82 tickets, 9 issues) → completes without error or truncation
- [ ] `recap` on real project → completes within reasonable time
