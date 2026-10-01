# Shelfmate

Shelfmate is a school book-room catalogue operated by one teacher. Pupils do not use the app. The first version lets the teacher find a physical book copy, lend it to a pupil, record its return, and retain records across restarts.

## Scope and current evidence

The existing source implements only in-memory list/add operations in `src/books.js` and GET/POST `/books` in `src/server.js`. `test/books.test.js` contains one addition test. These files were inspected during setup; tests were not run. The README overstates existing search/lending functionality; the owner confirmed those features must be planned.

Overdue listing is explicitly deferred until AFTER first-version acceptance. T-010 is blocked by T-009. Do not add overdue queries, views, filters, highlighting, or acceptance checks to first-version work. Ordinary due-date entry and display remain in lending. Reservations, fines, reminders, reports, pupil accounts, multiuser access and cloud deployment are outside this setup scope.

## Technology and architecture

Keep dependency-free Node.js and JavaScript ES modules. The planned UI is plain HTML/CSS/JavaScript served by the existing HTTP server. Use built-in filesystem JSON persistence under `data/`, a single local process, and loopback access. These are approved implementation choices, not descriptions of features already built.

Keep storage transactions, loan rules, HTTP handling and browser presentation in clear boundaries. T-002 establishes serialized durable storage, operation-id retries and recovery from uncertain saves; T-005 extends that shared mechanism for loans. Do not create a second persistence path for lending.

## Approved defaults

- Each book record represents one physical copy, with at most one active loan.
- Teacher enters a minimal pupil label and an editable due date, defaulting to 14 calendar days.
- Remove pupil labels on successful return while preserving book/loan identifiers, dates and return timestamp. Retry records must not retain labels. Old backups require separate deletion/rotation guidance.
- Future overdue semantics: outstanding loan due before the current local calendar date; due today is not overdue. Implement only in T-010.
- Local HTTP protections include Host/Origin validation and a same-origin mutation policy; loopback alone is insufficient.

## Work and acceptance

The approved roadmap is in `.story/`. Start with T-002. Catalogue work T-003 and lending API T-005 can follow independently. Owner checkpoints are T-004 (catalogue), T-007 (circulation), T-009 (first-version acceptance). These are ordinary tickets: the tool does not enforce owner signoff, so record actual owner feedback before closing them.

Read `RULES.md` for persistence, privacy and business invariants. Keep ticket status current. Handovers are append-only; create a new handover for corrections. Setup approval covers tracking/configuration only and does not start autonomous feature implementation.

## Verification

Quality level: Full pipeline. Use TDD for functional business logic, storage/state transitions and validation. Established test command: `npm test` (`node --test`). Planned recipe stages WRITE_TESTS and TEST use it. BUILD is disabled because direct Node/plain assets need no build. VERIFY uses `npm start`, readiness `http://localhost:3000/books`; the server defaults to port 3000. No verification commands are pending establishment.

During implementation use isolated temporary data and fictional pupil labels, fault-injection and restart tests, plus browser/keyboard journeys. The initial setup ran no installation, tests, build or server. The setup handover records coverage, approval and independent plan review.
