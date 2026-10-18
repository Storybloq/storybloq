import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  presenceActivity,
  sessionStatus,
  queueProgress,
} from "../src/session-projection.ts";

// Build this test when T-547 starts. These vectors are also consumed by Swift.
const fixture = JSON.parse(
  await readFile(
    "../test/fixtures/plugin-session-parity.json",
    "utf8",
  ),
);
const now = Date.parse(fixture.now);
for (const vector of fixture.presence)
  test("Mac presence parity: " + vector.name, () => {
    assert.deepEqual(presenceActivity(vector.record, now), vector.expected);
  });
for (const vector of fixture.status)
  test("Mac session status parity: " + vector.name, () => {
    assert.equal(sessionStatus(vector.signals, now), vector.expected);
  });
for (const vector of fixture.queue)
  test("Mac queue parity: " + vector.name, () => {
    assert.deepEqual(queueProgress(vector.input), vector.expected);
  });
