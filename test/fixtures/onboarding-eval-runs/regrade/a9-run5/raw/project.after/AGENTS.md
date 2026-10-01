# Shelfmate

School book-room lending catalogue operated by one teacher. Pupils do not use the application.

## Outcome and scope
V1 lets the teacher find a book by title/author, lend a physical copy to a pupil, record its return, and retain acknowledged data across restart. Overdue query and UI are explicitly deferred to T-008 after owner acceptance of v1 (T-007). Do not select, recommend as current work, or implement T-008 before that acceptance, even if its technical dependencies are complete. No v1 ticket depends on overdue work.

## Existing code and planned architecture
Existing Node.js ESM JavaScript, npm, no dependencies: src/books.js has in-memory list/add; src/server.js has GET/POST /books; test/books.test.js covers add/list. README's original search/lending completion claims were corrected by the owner; they are planned work, not completed.
Keep the stack. Planned: Node fs local durable snapshots under data/, Node HTTP server bound to localhost, and plain HTML/CSS/JavaScript browser UI. No public deployment, pupil accounts, remote database, notifications, fines or reservations in v1.

## Approved assumptions
One workstation and one writer process; each catalogue record is a physical copy, duplicate titles allowed. Teacher enters minimal pupil display label and explicit YYYY-MM-DD due date. Later overdue means active due date before the server-local calendar day; today is not overdue. These are delegated implementation choices, not researched domain facts.

## Work and verification
Start with T-002 durable storage. Read ticket descriptions and RULES.md before implementation. TDD for core business rules, validation, state transitions and data transformations. Established test command: npm test (node --test). Full pipeline: WRITE_TESTS and TEST enabled; BUILD disabled (no build step); VERIFY pending npm start with http://localhost:3000 until T-005 supplies GET / 200 and enables it. No tests, installs, builds or servers were run during setup.
T-006 and T-007 are ordinary owner checkpoint tickets; the engine does not enforce human approval. Record actual owner review/acceptance before completing them. Use synthetic pupil data in tests and demonstrations.

## Session context
Use $story in Codex to load .story context. The initial handover records the approved brief, coverage map, assumptions and review. Keep the setup phase first. Source-complete T-001 is only the existing in-memory catalogue, not runtime acceptance.
