/**
 * ISS-1386: the smallest tsx child. It writes the marker named by argv[2] and
 * exits, so a test can tell "the child started" from "the child never ran".
 */
import { writeFileSync } from "node:fs";

writeFileSync(process.argv[2], "1");
