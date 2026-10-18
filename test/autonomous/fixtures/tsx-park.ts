/**
 * ISS-1386: a tsx child that parks forever and ignores SIGTERM, so only a
 * SIGKILL escalation from the test file's teardown stops it. It writes its own
 * pid to the marker named by argv[2] once it is parked.
 */
import { writeFileSync } from "node:fs";

process.on("SIGTERM", () => {});
setInterval(() => {}, 1_000);
writeFileSync(process.argv[2], String(process.pid));
