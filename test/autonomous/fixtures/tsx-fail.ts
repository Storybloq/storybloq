/**
 * ISS-1386: a tsx child that fails before writing any marker, so a test can
 * prove the failure message carries the child's stderr.
 */
process.stderr.write("t450-stderr-sentinel\n");
process.exit(1);
