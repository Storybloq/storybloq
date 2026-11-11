/**
 * T-538 commit 3, pen ruling on finding 4 (option b): the harness's hand copy of the skill gets the version marker
 * the product writes when it installs a skill, written by the product's own writer (skill-version-marker.ts), so
 * the CLI's housekeeping reads the copy as current and never takes the stale-skill path (an npm ownership probe on
 * every call, and a "not the global install" line to the model). Run as a child with the arm's environment: the
 * writer resolves each target's folder from HOME, CLAUDE_CONFIG_DIR and CODEX_HOME.
 *
 * Usage: onboarding-eval-skill-marker.ts <version> <skill source folder> <target>...
 */
import { isSkillStale, skillSourceFingerprint, writeSkillMarker, type SkillInstallTarget } from "../src/core/skill-version-marker.js";

const [version, source, ...targets] = process.argv.slice(2);
if (!version || !source || targets.length === 0) throw new Error("onboarding-eval-skill-marker: <version> <source> <target>... is required");
const fingerprint = skillSourceFingerprint(source);
if (fingerprint === null) throw new Error(`onboarding-eval-skill-marker: no fingerprint for ${source}`);
for (const t of targets) {
  if (t !== "claude" && t !== "codex" && t !== "codexCompat") throw new Error(`onboarding-eval-skill-marker: ${t} is not a skill target`);
  writeSkillMarker(version, t as SkillInstallTarget, fingerprint);
  if (isSkillStale(version, t as SkillInstallTarget, fingerprint)) throw new Error(`onboarding-eval-skill-marker: the ${t} copy still reads stale after its marker was written`);
}
