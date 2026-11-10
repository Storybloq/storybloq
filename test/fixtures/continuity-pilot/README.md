# continuity-pilot

ISS-1486 G4: one passing pilot exactly as `runPilot` published it (`pilot.json` and its four evidence files), from the
conforming row of `test/tooling/iss1486-continuity-launch.test.ts` with the stand-in client. `readPilot` recomputes the
verdict from these files, so a hand-written pilot no longer verifies. `test/tooling/continuity-pilot-fixture.ts` copies
them into an experiment folder, naming the experiment and arm a test wants and rehashing the facts file.

Regenerate it when the pilot's evidence format changes: run that row with the folder copied out of its experiment folder.
All five files come from one run; never edit one by hand. The current copy (ISS-1486 J4) launches the server through
the shared launcher under codex sandbox with the permitted inventory, carries the outside-the-sandbox network check
(J1), and holds every server env value as a per-run opaque form (J3).
