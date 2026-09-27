# Onboarding fixtures (T-536)

Synthetic, sanitized projects for the setup-flow evaluations. Each fixture is:

- `project/` -- the folder the client is started in. The harness copies it to a
  standalone scratch directory, drops `.gitkeep` placeholders, and (for
  `empty-scaffold`) creates the empty `.story/` subdirectories git cannot track.
- `opening-prompt.txt` -- the owner's first message.
- `owner-answers.md` -- scripted owner turns: answers to discovery questions,
  the adjustment turn, and the approval turn.
- `rubric.json` -- what the transcript and the resulting files are checked
  against: requirements for the coverage map, the gaps a question may cover,
  the topics already answered in the material (asking them fails), the expected
  recipe resolution, and fixture-specific rules.

Nothing here is a real person, organisation or customer.
