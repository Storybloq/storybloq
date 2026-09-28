# Recipe precedence fixtures (T-536, check set 2)

Static repositories for the command-evidence contract in setup-flow.md (1e): an explicit repository command outranks a configured runner, which outranks a runner convention, and a component is established only when its runner would collect at least one test file. Each case's `expected.json` states the check set 2 recipe expectation for its `project/`, a correct recipe config and a wrong one, and the finding the wrong one produces. `test/tooling/onboarding-eval-checkset2.test.ts` feeds both through the harness.

Nothing here is run; the files are evidence only.
