# Capabilities (5 of 5, pending: 1)

_Freshness was not checked (--skip-check): statuses below include structural findings, not freshness._

- **Gamma** (cap-gamma) [review]
  Deferred work.
  src/core/a.ts
  review: owe a regression test

- **Alpha** (cap-alpha) [current]
  Current and clean.
  src/core/a.ts

- **Beta** (cap-beta) [review]
  Stored review.
  src/core/b.ts

- **Delta** (cap-delta) [review]
  Dangling item.
  src/core/b.ts
    - [structural] unknown item: T-999

- **Epsilon** (cap-eps) [review]
  Missing entry point.
  src/core/missing.ts
    - [structural] entry point does not exist: src/core/missing.ts