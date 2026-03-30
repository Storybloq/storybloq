import Foundation
import Testing
@testable import Modern_IDE

// MARK: - Test Fixtures

private let validConfigJSON = """
{
  "version": 2,
  "project": "test-project",
  "type": "macapp",
  "language": "swift",
  "features": {
    "tickets": true,
    "issues": true,
    "handovers": true,
    "roadmap": true,
    "reviews": true
  }
}
"""

private let validRoadmapJSON = """
{
  "title": "test-project",
  "date": "2026-03-11",
  "phases": [
    { "id": "dogfood", "label": "PHASE 0", "name": "Setup", "description": "Initial setup." }
  ],
  "blockers": []
}
"""

private let ticketJSON = """
{
  "id": "T-001",
  "title": "Test ticket",
  "type": "task",
  "status": "complete",
  "phase": "dogfood",
  "order": 10,
  "description": "A test ticket.",
  "createdDate": "2026-03-11",
  "completedDate": "2026-03-11",
  "blockedBy": []
}
"""

private let ticketWithParentJSON = """
{
  "id": "T-030",
  "title": "Child ticket",
  "type": "task",
  "status": "open",
  "phase": "viewer",
  "order": 20,
  "description": "A child ticket.",
  "createdDate": "2026-03-11",
  "completedDate": null,
  "blockedBy": ["T-001"],
  "parentTicket": "T-008"
}
"""

private let issueJSON = """
{
  "id": "ISS-001",
  "title": "Test issue",
  "status": "open",
  "severity": "medium",
  "components": ["core"],
  "impact": "Test impact.",
  "resolution": null,
  "location": ["file.swift:10"],
  "discoveredDate": "2026-03-11",
  "resolvedDate": null,
  "relatedTickets": ["T-001"]
}
"""

// MARK: - Fixture Helper

/// Creates a temp .story/ directory structure with specified files.
/// Returns the project root URL. Caller cleans up with `defer { try? fm.removeItem(at: root) }`.
@discardableResult
private func createFixture(
    config: String? = validConfigJSON,
    roadmap: String? = validRoadmapJSON,
    tickets: [String: String] = [:],
    issues: [String: String] = [:],
    handovers: [String] = [],
    extraTicketDirFiles: [String: Data] = [:],
    skipIssuesDir: Bool = false
) throws -> URL {
    let fm = FileManager.default
    let root = fm.temporaryDirectory
        .appendingPathComponent("claudestory-test-\(UUID().uuidString)")
    let wrapDir = root.appendingPathComponent(".story")
    try fm.createDirectory(at: wrapDir, withIntermediateDirectories: true)

    if let config {
        try config.write(to: wrapDir.appendingPathComponent("config.json"), atomically: true, encoding: .utf8)
    }
    if let roadmap {
        try roadmap.write(to: wrapDir.appendingPathComponent("roadmap.json"), atomically: true, encoding: .utf8)
    }

    let ticketsDir = wrapDir.appendingPathComponent("tickets")
    if !tickets.isEmpty || !extraTicketDirFiles.isEmpty {
        try fm.createDirectory(at: ticketsDir, withIntermediateDirectories: true)
        for (name, content) in tickets {
            try content.write(to: ticketsDir.appendingPathComponent(name), atomically: true, encoding: .utf8)
        }
        for (name, data) in extraTicketDirFiles {
            try data.write(to: ticketsDir.appendingPathComponent(name))
        }
    }

    if !skipIssuesDir {
        let issuesDir = wrapDir.appendingPathComponent("issues")
        if !issues.isEmpty {
            try fm.createDirectory(at: issuesDir, withIntermediateDirectories: true)
            for (name, content) in issues {
                try content.write(to: issuesDir.appendingPathComponent(name), atomically: true, encoding: .utf8)
            }
        }
        // If issues is empty and skipIssuesDir is false, don't create the dir
        // (tests that want an empty dir should add an empty issues dict with the dir created)
    }

    let handoversDir = wrapDir.appendingPathComponent("handovers")
    if !handovers.isEmpty {
        try fm.createDirectory(at: handoversDir, withIntermediateDirectories: true)
        for name in handovers {
            try "".write(to: handoversDir.appendingPathComponent(name), atomically: true, encoding: .utf8)
        }
    }

    return root
}

// MARK: - Happy Path

struct ProjectLoaderHappyPathTests {
    @Test func loadsCompleteProject() throws {
        let fm = FileManager.default
        let root = try createFixture(
            tickets: [
                "T-001.json": ticketJSON,
                "T-030.json": ticketWithParentJSON
            ],
            issues: ["ISS-001.json": issueJSON],
            handovers: [
                "2026-03-10-initial.md",
                "2026-03-11-batch2.md"
            ]
        )
        defer { try? fm.removeItem(at: root) }

        let loader = ProjectLoader()
        let result = try loader.loadSync(from: root)

        #expect(result.state.tickets.count == 2)
        #expect(result.state.issues.count == 1)
        #expect(result.state.handoverFilenames.count == 2)
        #expect(result.state.roadmap.phases.count == 1)
        #expect(result.state.config.project == "test-project")
        #expect(result.warnings.isEmpty)
    }

    @Test func loadsProjectWithNoTickets() throws {
        let fm = FileManager.default
        let root = try createFixture()
        defer { try? fm.removeItem(at: root) }

        let loader = ProjectLoader()
        let result = try loader.loadSync(from: root)

        #expect(result.state.tickets.isEmpty)
        #expect(result.state.totalTicketCount == 0)
        #expect(result.warnings.isEmpty)
    }

    @Test func loadsProjectWithNoIssues() throws {
        let fm = FileManager.default
        let root = try createFixture(
            tickets: ["T-001.json": ticketJSON]
        )
        defer { try? fm.removeItem(at: root) }

        let loader = ProjectLoader()
        let result = try loader.loadSync(from: root)

        #expect(result.state.tickets.count == 1)
        #expect(result.state.issues.isEmpty)
        #expect(result.warnings.isEmpty)
    }
}

// MARK: - Critical Failures

struct ProjectLoaderCriticalFailureTests {
    @Test func throwsWhenStoryDirMissing() throws {
        let fm = FileManager.default
        let root = fm.temporaryDirectory
            .appendingPathComponent("claudestory-test-\(UUID().uuidString)")
        try fm.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? fm.removeItem(at: root) }

        let loader = ProjectLoader()
        #expect(throws: ProjectLoaderError.self) {
            try loader.loadSync(from: root)
        }
    }

    @Test func throwsWhenConfigMissing() throws {
        let fm = FileManager.default
        let root = try createFixture(config: nil)
        defer { try? fm.removeItem(at: root) }

        let loader = ProjectLoader()
        #expect(throws: ProjectLoaderError.self) {
            try loader.loadSync(from: root)
        }
    }

    @Test func throwsWhenRoadmapMissing() throws {
        let fm = FileManager.default
        let root = try createFixture(roadmap: nil)
        defer { try? fm.removeItem(at: root) }

        let loader = ProjectLoader()
        #expect(throws: ProjectLoaderError.self) {
            try loader.loadSync(from: root)
        }
    }
}

// MARK: - Graceful Degradation

struct ProjectLoaderGracefulDegradationTests {
    @Test func skipsCorruptTicketFile() throws {
        let fm = FileManager.default
        let root = try createFixture(
            tickets: [
                "T-001.json": ticketJSON,
                "T-002.json": "{ this is not valid json",
                "T-030.json": ticketWithParentJSON
            ]
        )
        defer { try? fm.removeItem(at: root) }

        let loader = ProjectLoader()
        let result = try loader.loadSync(from: root)

        #expect(result.state.tickets.count == 2)
        #expect(result.warnings.count == 1)
        #expect(result.warnings.first?.file == ".story/tickets/T-002.json")
    }

    @Test func skipsHiddenAndNonJsonFiles() throws {
        let fm = FileManager.default
        let root = try createFixture(
            tickets: ["T-001.json": ticketJSON],
            extraTicketDirFiles: [
                ".gitkeep": Data(),
                ".DS_Store": Data([0x00, 0x00, 0x00, 0x01]),
                "README.txt": Data("hello".utf8)
            ]
        )
        defer { try? fm.removeItem(at: root) }

        let loader = ProjectLoader()
        let result = try loader.loadSync(from: root)

        // .gitkeep and .DS_Store skipped by .skipsHiddenFiles
        // README.txt skipped by .json extension filter
        #expect(result.state.tickets.count == 1)
        #expect(result.warnings.isEmpty)
    }

    @Test func handoversSortedNewestFirst() throws {
        let fm = FileManager.default
        let root = try createFixture(
            handovers: [
                "2026-03-09-first.md",
                "2026-03-11-third.md",
                "2026-03-10-second.md"
            ]
        )
        defer { try? fm.removeItem(at: root) }

        let loader = ProjectLoader()
        let result = try loader.loadSync(from: root)

        #expect(result.state.handoverFilenames == [
            "2026-03-11-third.md",
            "2026-03-10-second.md",
            "2026-03-09-first.md"
        ])
        #expect(result.warnings.isEmpty)
    }

    @Test func missingIssuesDirReturnsEmpty() throws {
        let fm = FileManager.default
        let root = try createFixture(
            tickets: ["T-001.json": ticketJSON],
            skipIssuesDir: true
        )
        defer { try? fm.removeItem(at: root) }

        let loader = ProjectLoader()
        let result = try loader.loadSync(from: root)

        #expect(result.state.issues.isEmpty)
        #expect(result.warnings.isEmpty)
    }
}

// MARK: - Config Validation

struct ProjectLoaderConfigValidationTests {
    @Test func throwsWhenConfigInvalid() throws {
        let invalidConfig = """
        {
          "version": 0,
          "project": "test",
          "type": "macapp",
          "language": "swift",
          "features": {
            "tickets": true, "issues": true, "handovers": true, "roadmap": true, "reviews": true
          }
        }
        """
        let fm = FileManager.default
        let root = try createFixture(config: invalidConfig)
        defer { try? fm.removeItem(at: root) }

        let loader = ProjectLoader()
        #expect(throws: ProjectLoaderError.self) {
            try loader.loadSync(from: root)
        }
    }
}

// MARK: - Critical Decode Failures

struct ProjectLoaderCriticalDecodeTests {
    @Test func throwsWhenRoadmapCorrupt() throws {
        let corruptRoadmap = """
        { "title": 123 }
        """
        let fm = FileManager.default
        let root = try createFixture(roadmap: corruptRoadmap)
        defer { try? fm.removeItem(at: root) }

        let loader = ProjectLoader()
        #expect(throws: ProjectLoaderError.self) {
            try loader.loadSync(from: root)
        }
    }
}

// MARK: - Graceful Degradation (Issues)

struct ProjectLoaderIssueDegradationTests {
    @Test func skipsCorruptIssueFile() throws {
        let fm = FileManager.default
        // Create issues dir with one valid and one corrupt issue
        let root = try createFixture(
            issues: [
                "ISS-001.json": issueJSON,
                "ISS-002.json": "not json at all"
            ]
        )
        defer { try? fm.removeItem(at: root) }

        let loader = ProjectLoader()
        let result = try loader.loadSync(from: root)

        #expect(result.state.issues.count == 1)
        #expect(result.warnings.count == 1)
        #expect(result.warnings.first?.file == ".story/issues/ISS-002.json")
    }
}

// MARK: - Decode Correctness

struct ProjectLoaderDecodeCorrectnessTests {
    @Test func decodesRealTicketFormat() throws {
        let fm = FileManager.default
        let root = try createFixture(
            tickets: ["T-001.json": ticketJSON]
        )
        defer { try? fm.removeItem(at: root) }

        let loader = ProjectLoader()
        let result = try loader.loadSync(from: root)

        let ticket = try #require(result.state.tickets.first)
        #expect(ticket.id == "T-001")
        #expect(ticket.title == "Test ticket")
        #expect(ticket.type == .task)
        #expect(ticket.status == .complete)
        #expect(ticket.phase == .dogfood)
        #expect(ticket.order == 10)
        #expect(ticket.completedDate == "2026-03-11")
        #expect(ticket.blockedBy.isEmpty)
        #expect(ticket.parentTicket == nil)
    }

    @Test func decodesTicketWithParentTicket() throws {
        let fm = FileManager.default
        let root = try createFixture(
            tickets: ["T-030.json": ticketWithParentJSON]
        )
        defer { try? fm.removeItem(at: root) }

        let loader = ProjectLoader()
        let result = try loader.loadSync(from: root)

        let ticket = try #require(result.state.tickets.first)
        #expect(ticket.id == "T-030")
        #expect(ticket.parentTicket == "T-008")
        #expect(ticket.blockedBy == ["T-001"])
    }
}

// MARK: - Handover Edge Cases

struct ProjectLoaderHandoverTests {
    @Test func nonConformingHandoverAppendsWithWarning() throws {
        let fm = FileManager.default
        let root = try createFixture(
            handovers: [
                "2026-03-11-proper.md",
                "random-notes.md"
            ]
        )
        defer { try? fm.removeItem(at: root) }

        let loader = ProjectLoader()
        let result = try loader.loadSync(from: root)

        // Conforming first (sorted reverse), non-conforming appended last
        #expect(result.state.handoverFilenames == [
            "2026-03-11-proper.md",
            "random-notes.md"
        ])
        #expect(result.warnings.count == 1)
        #expect(result.warnings.first?.file == ".story/handovers/random-notes.md")
    }
}

// MARK: - Format Compatibility (T-082)

struct ProjectLoaderCompatTests {
    @Test func loadsRoadmapWithLegacyBlocker() throws {
        let fm = FileManager.default
        let roadmap = """
        {
          "title": "test", "date": "2026-03-11",
          "phases": [{"id": "dogfood", "label": "P0", "name": "Setup", "description": "Init."}],
          "blockers": [{"name": "npm reserved", "cleared": true, "note": "Done."}]
        }
        """
        let root = try createFixture(roadmap: roadmap)
        defer { try? fm.removeItem(at: root) }

        let loader = ProjectLoader()
        let result = try loader.loadSync(from: root)

        #expect(result.state.roadmap.blockers.count == 1)
        #expect(result.state.roadmap.blockers[0].cleared == true)
        #expect(result.warnings.isEmpty)
    }

    @Test func loadsRoadmapWithNewBlocker() throws {
        let fm = FileManager.default
        let roadmap = """
        {
          "title": "test", "date": "2026-03-11",
          "phases": [{"id": "dogfood", "label": "P0", "name": "Setup", "description": "Init."}],
          "blockers": [{"name": "npm reserved", "createdDate": "2026-03-10", "clearedDate": "2026-03-10", "note": "Done."}]
        }
        """
        let root = try createFixture(roadmap: roadmap)
        defer { try? fm.removeItem(at: root) }

        let loader = ProjectLoader()
        let result = try loader.loadSync(from: root)

        let blocker = result.state.roadmap.blockers[0]
        #expect(blocker.cleared == true)
        #expect(blocker.createdDate == "2026-03-10")
        #expect(blocker.clearedDate == "2026-03-10")
        #expect(result.warnings.isEmpty)
    }

    @Test func loadsRoadmapWithMinimalBlocker() throws {
        let fm = FileManager.default
        let roadmap = """
        {
          "title": "test", "date": "2026-03-11",
          "phases": [{"id": "dogfood", "label": "P0", "name": "Setup", "description": "Init."}],
          "blockers": [{"name": "Waiting"}]
        }
        """
        let root = try createFixture(roadmap: roadmap)
        defer { try? fm.removeItem(at: root) }

        let loader = ProjectLoader()
        let result = try loader.loadSync(from: root)

        let blocker = result.state.roadmap.blockers[0]
        #expect(blocker.cleared == false)
        #expect(blocker.createdDate == nil)
        #expect(blocker.clearedDate == nil)
        #expect(result.warnings.isEmpty)
    }

    @Test func loadsConfigWithSchemaVersion() throws {
        let fm = FileManager.default
        let config = """
        {
          "version": 2, "schemaVersion": 1,
          "project": "test", "type": "macapp", "language": "swift",
          "features": {"tickets": true, "issues": true, "handovers": true, "roadmap": true, "reviews": true}
        }
        """
        let root = try createFixture(config: config)
        defer { try? fm.removeItem(at: root) }

        let loader = ProjectLoader()
        let result = try loader.loadSync(from: root)

        #expect(result.state.config.schemaVersion == 1)
    }

    @Test func loadsConfigWithoutSchemaVersion() throws {
        let fm = FileManager.default
        let root = try createFixture() // validConfigJSON has no schemaVersion
        defer { try? fm.removeItem(at: root) }

        let loader = ProjectLoader()
        let result = try loader.loadSync(from: root)

        #expect(result.state.config.schemaVersion == nil)
    }

    @Test func loadsPhaseWithSummary() throws {
        let fm = FileManager.default
        let roadmap = """
        {
          "title": "test", "date": "2026-03-11",
          "phases": [{"id": "dogfood", "label": "P0", "name": "Setup", "description": "Init.", "summary": "Bootstrap infra"}],
          "blockers": []
        }
        """
        let root = try createFixture(roadmap: roadmap)
        defer { try? fm.removeItem(at: root) }

        let loader = ProjectLoader()
        let result = try loader.loadSync(from: root)

        #expect(result.state.roadmap.phases[0].summary == "Bootstrap infra")
    }

    @Test func loadsPhaseWithoutSummary() throws {
        let fm = FileManager.default
        let root = try createFixture() // validRoadmapJSON has no summary
        defer { try? fm.removeItem(at: root) }

        let loader = ProjectLoader()
        let result = try loader.loadSync(from: root)

        #expect(result.state.roadmap.phases[0].summary == nil)
    }
}
