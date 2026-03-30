import Testing
import Foundation
@testable import Modern_IDE

// MARK: - MockCLIRunner

/// @unchecked Sendable is acceptable here: each test creates its own instance,
/// and Swift Testing serializes setup → await → assertions within a single test.
final class MockCLIRunner: CLIRunning, @unchecked Sendable {
    var capturedArguments: [String] = []
    var capturedDirectory: URL?
    var stubbedResult: CLIResult = CLIResult(exitCode: 0, stdout: "{}", stderr: "")

    func run(arguments: [String], currentDirectory: URL) async throws -> CLIResult {
        capturedArguments = arguments
        capturedDirectory = currentDirectory
        return stubbedResult
    }
}

// MARK: - JSON Fixtures

private let ticketJSON = """
{"version":1,"data":{"id":"T-001","title":"Test ticket","type":"task","status":"open",
"phase":"dogfood","order":10,"description":"A test.","createdDate":"2026-03-23",
"completedDate":null,"blockedBy":[]}}
"""

private let issueJSON = """
{"version":1,"data":{"id":"ISS-001","title":"Test issue","status":"open","severity":"high",
"components":[],"impact":"Something broke.","resolution":null,"location":[],
"discoveredDate":"2026-03-23","resolvedDate":null,"relatedTickets":[],"order":0,"phase":null}}
"""

private let noteJSON = """
{"version":1,"data":{"id":"N-001","title":null,"content":"A thought.",
"tags":["idea"],"status":"active","createdDate":"2026-03-23","updatedDate":"2026-03-23"}}
"""

private let phaseJSON = """
{"version":1,"data":{"id":"test-phase","label":"P0","name":"Test Phase","description":"A phase."}}
"""

private let deleteJSON = """
{"version":1,"data":{"id":"T-001","deleted":true}}
"""

private let handoverJSON = """
{"version":1,"data":{"filename":"2026-03-23-01-session.md"}}
"""

private let errorJSON = """
{"version":1,"error":{"code":"not_found","message":"Ticket T-999 not found"}}
"""

private let tmpURL = FileManager.default.temporaryDirectory

// MARK: - Response Parsing Tests

struct CLIResponseParserTests {
    @Test func parsesSuccessEnvelope() throws {
        let result = CLIResult(exitCode: 0, stdout: ticketJSON, stderr: "")
        let ticket = try CLIResponseParser.parse(Ticket.self, from: result)
        #expect(ticket.id == "T-001")
        #expect(ticket.title == "Test ticket")
    }

    @Test func parsesErrorEnvelope() throws {
        let result = CLIResult(exitCode: 1, stdout: errorJSON, stderr: "")
        #expect(throws: StoryWriterError.self) {
            try CLIResponseParser.parse(Ticket.self, from: result)
        }
    }

    @Test func parseErrorExtractsCodeAndMessage() {
        let result = CLIResult(exitCode: 1, stdout: errorJSON, stderr: "")
        do {
            _ = try CLIResponseParser.parse(Ticket.self, from: result)
            Testing.Issue.record("Should have thrown")
        } catch let error as StoryWriterError {
            if case .cliError(let code, let message) = error {
                #expect(code == "not_found")
                #expect(message == "Ticket T-999 not found")
            } else {
                Testing.Issue.record("Expected cliError, got \(error)")
            }
        } catch {
            Testing.Issue.record("Unexpected error type: \(error)")
        }
    }

    @Test func parsesProcessFailure() {
        let result = CLIResult(exitCode: 2, stdout: "not json", stderr: "crash info")
        do {
            _ = try CLIResponseParser.parse(Ticket.self, from: result)
            Testing.Issue.record("Should have thrown")
        } catch let error as StoryWriterError {
            if case .processFailure(let code, let stderr) = error {
                #expect(code == 2)
                #expect(stderr == "crash info")
            } else {
                Testing.Issue.record("Expected processFailure, got \(error)")
            }
        } catch {
            Testing.Issue.record("Unexpected error type: \(error)")
        }
    }

    @Test func parsesEmptyStdout() {
        let result = CLIResult(exitCode: 0, stdout: "", stderr: "")
        #expect(throws: StoryWriterError.self) {
            try CLIResponseParser.parse(Ticket.self, from: result)
        }
    }

    @Test func parsesDeleteConfirmation() throws {
        let result = CLIResult(exitCode: 0, stdout: deleteJSON, stderr: "")
        try CLIResponseParser.parseDeleteConfirmation(from: result)
    }

    @Test func deleteConfirmationRejectsEmptyStdout() {
        let result = CLIResult(exitCode: 0, stdout: "", stderr: "")
        #expect(throws: StoryWriterError.self) {
            try CLIResponseParser.parseDeleteConfirmation(from: result)
        }
    }

    @Test func deleteConfirmationRejectsMalformedJSON() {
        let result = CLIResult(exitCode: 0, stdout: "not json", stderr: "")
        #expect(throws: (any Error).self) {
            try CLIResponseParser.parseDeleteConfirmation(from: result)
        }
    }
}

// MARK: - Ticket Operation Tests

struct CLIStoryWriterTicketTests {
    @Test func createTicketBuildsCorrectArgs() async throws {
        let mock = MockCLIRunner()
        mock.stubbedResult = CLIResult(exitCode: 0, stdout: ticketJSON, stderr: "")
        let writer = CLIStoryWriter(runner: mock, projectRoot: tmpURL)

        _ = try await writer.createTicket(
            title: "My ticket", type: .task, phase: .dogfood,
            description: "Desc", blockedBy: ["T-002"], parentTicket: "T-010"
        )

        #expect(mock.capturedArguments.contains("ticket"))
        #expect(mock.capturedArguments.contains("create"))
        #expect(mock.capturedArguments.contains("--title"))
        #expect(mock.capturedArguments.contains("My ticket"))
        #expect(mock.capturedArguments.contains("--type"))
        #expect(mock.capturedArguments.contains("task"))
        #expect(mock.capturedArguments.contains("--phase"))
        #expect(mock.capturedArguments.contains("dogfood"))
        #expect(mock.capturedArguments.contains("--description"))
        #expect(mock.capturedArguments.contains("--blocked-by"))
        #expect(mock.capturedArguments.contains("T-002"))
        #expect(mock.capturedArguments.contains("--parent-ticket"))
        #expect(mock.capturedArguments.contains("T-010"))
        // --format json is appended by ProcessCLIRunner, not CLIStoryWriter
        #expect(mock.capturedDirectory == tmpURL)
    }

    @Test func createTicketOmitsOptionalFields() async throws {
        let mock = MockCLIRunner()
        mock.stubbedResult = CLIResult(exitCode: 0, stdout: ticketJSON, stderr: "")
        let writer = CLIStoryWriter(runner: mock, projectRoot: tmpURL)

        _ = try await writer.createTicket(
            title: "Simple", type: .chore, phase: nil,
            description: "", blockedBy: [], parentTicket: nil
        )

        #expect(!mock.capturedArguments.contains("--phase"))
        #expect(!mock.capturedArguments.contains("--description"))
        #expect(!mock.capturedArguments.contains("--blocked-by"))
        #expect(!mock.capturedArguments.contains("--parent-ticket"))
    }

    @Test func createTicketParsesResponse() async throws {
        let mock = MockCLIRunner()
        mock.stubbedResult = CLIResult(exitCode: 0, stdout: ticketJSON, stderr: "")
        let writer = CLIStoryWriter(runner: mock, projectRoot: tmpURL)

        let ticket = try await writer.createTicket(
            title: "Test", type: .task, phase: nil,
            description: "", blockedBy: [], parentTicket: nil
        )

        #expect(ticket.id == "T-001")
        #expect(ticket.status == .open)
    }

    @Test func updateTicketPartialArgs() async throws {
        let mock = MockCLIRunner()
        mock.stubbedResult = CLIResult(exitCode: 0, stdout: ticketJSON, stderr: "")
        let writer = CLIStoryWriter(runner: mock, projectRoot: tmpURL)

        _ = try await writer.updateTicket(
            "T-001", status: .complete, title: nil, type: nil,
            phase: nil, order: nil, description: nil, blockedBy: nil, parentTicket: nil
        )

        #expect(mock.capturedArguments.contains("--status"))
        #expect(mock.capturedArguments.contains("complete"))
        #expect(!mock.capturedArguments.contains("--title"))
        #expect(!mock.capturedArguments.contains("--type"))
        #expect(!mock.capturedArguments.contains("--phase"))
        #expect(!mock.capturedArguments.contains("--order"))
    }

    @Test func updateTicketClearsPhase() async throws {
        let mock = MockCLIRunner()
        mock.stubbedResult = CLIResult(exitCode: 0, stdout: ticketJSON, stderr: "")
        let writer = CLIStoryWriter(runner: mock, projectRoot: tmpURL)

        _ = try await writer.updateTicket(
            "T-001", status: nil, title: nil, type: nil,
            phase: .some(nil), order: nil, description: nil, blockedBy: nil, parentTicket: nil
        )

        let phaseIdx = try #require(mock.capturedArguments.firstIndex(of: "--phase"))
        #expect(mock.capturedArguments[phaseIdx + 1] == "")
    }

    @Test func updateTicketSetsType() async throws {
        let mock = MockCLIRunner()
        mock.stubbedResult = CLIResult(exitCode: 0, stdout: ticketJSON, stderr: "")
        let writer = CLIStoryWriter(runner: mock, projectRoot: tmpURL)

        _ = try await writer.updateTicket(
            "T-001", status: nil, title: nil, type: .feature,
            phase: nil, order: nil, description: nil, blockedBy: nil, parentTicket: nil
        )

        #expect(mock.capturedArguments.contains("--type"))
        #expect(mock.capturedArguments.contains("feature"))
    }

    @Test func updateTicketThrowsOnError() async {
        let mock = MockCLIRunner()
        mock.stubbedResult = CLIResult(exitCode: 1, stdout: errorJSON, stderr: "")
        let writer = CLIStoryWriter(runner: mock, projectRoot: tmpURL)

        do {
            _ = try await writer.updateTicket(
                "T-999", status: nil, title: nil, type: nil,
                phase: nil, order: nil, description: nil, blockedBy: nil, parentTicket: nil
            )
            Testing.Issue.record("Should have thrown")
        } catch {
            #expect(error is StoryWriterError)
        }
    }

    @Test func deleteTicketWithForce() async throws {
        let mock = MockCLIRunner()
        mock.stubbedResult = CLIResult(exitCode: 0, stdout: deleteJSON, stderr: "")
        let writer = CLIStoryWriter(runner: mock, projectRoot: tmpURL)

        try await writer.deleteTicket("T-001", force: true)

        #expect(mock.capturedArguments.contains("delete"))
        #expect(mock.capturedArguments.contains("--force"))
        #expect(mock.capturedArguments.contains("T-001"))
    }

    @Test func deleteTicketWithoutForce() async throws {
        let mock = MockCLIRunner()
        mock.stubbedResult = CLIResult(exitCode: 0, stdout: deleteJSON, stderr: "")
        let writer = CLIStoryWriter(runner: mock, projectRoot: tmpURL)

        try await writer.deleteTicket("T-001", force: false)

        #expect(!mock.capturedArguments.contains("--force"))
    }

    @Test func convenienceUpdateTicketPassesAllFields() async throws {
        let mock = MockCLIRunner()
        mock.stubbedResult = CLIResult(exitCode: 0, stdout: ticketJSON, stderr: "")
        let writer = CLIStoryWriter(runner: mock, projectRoot: tmpURL)

        let ticket = Ticket(
            id: "T-005", title: "Full", type: .feature, status: .inprogress,
            phase: .viewer, order: 50, description: "All fields.",
            createdDate: "2026-03-23", blockedBy: ["T-001"], parentTicket: "T-002"
        )

        _ = try await writer.updateTicket(ticket)

        #expect(mock.capturedArguments.contains("--status"))
        #expect(mock.capturedArguments.contains("inprogress"))
        #expect(mock.capturedArguments.contains("--type"))
        #expect(mock.capturedArguments.contains("feature"))
        #expect(mock.capturedArguments.contains("--phase"))
        #expect(mock.capturedArguments.contains("viewer"))
        #expect(mock.capturedArguments.contains("--order"))
        #expect(mock.capturedArguments.contains("50"))
        #expect(mock.capturedArguments.contains("--blocked-by"))
        #expect(mock.capturedArguments.contains("T-001"))
        #expect(mock.capturedArguments.contains("--parent-ticket"))
        #expect(mock.capturedArguments.contains("T-002"))
    }
}

// MARK: - Issue Operation Tests

struct CLIStoryWriterIssueTests {
    @Test func createIssueBuildsCorrectArgs() async throws {
        let mock = MockCLIRunner()
        mock.stubbedResult = CLIResult(exitCode: 0, stdout: issueJSON, stderr: "")
        let writer = CLIStoryWriter(runner: mock, projectRoot: tmpURL)

        _ = try await writer.createIssue(
            title: "Bug", severity: .high, impact: "Crash",
            components: ["core", "ui"], relatedTickets: ["T-001"], location: ["file.swift:10"],
            phase: .viewer
        )

        #expect(mock.capturedArguments.contains("issue"))
        #expect(mock.capturedArguments.contains("create"))
        #expect(mock.capturedArguments.contains("--severity"))
        #expect(mock.capturedArguments.contains("high"))
        #expect(mock.capturedArguments.contains("--components"))
        #expect(mock.capturedArguments.contains("core"))
        #expect(mock.capturedArguments.contains("ui"))
        #expect(mock.capturedArguments.contains("--related-tickets"))
        #expect(mock.capturedArguments.contains("--location"))
        #expect(mock.capturedArguments.contains("--phase"))
    }

    @Test func updateIssueSetsOrderAndPhase() async throws {
        let mock = MockCLIRunner()
        mock.stubbedResult = CLIResult(exitCode: 0, stdout: issueJSON, stderr: "")
        let writer = CLIStoryWriter(runner: mock, projectRoot: tmpURL)

        _ = try await writer.updateIssue(
            "ISS-001", status: nil, title: nil, severity: nil,
            impact: nil, resolution: nil, components: nil,
            relatedTickets: nil, location: nil,
            order: 42, phase: .some(PhaseID("cli-mcp"))
        )

        #expect(mock.capturedArguments.contains("--order"))
        #expect(mock.capturedArguments.contains("42"))
        #expect(mock.capturedArguments.contains("--phase"))
        #expect(mock.capturedArguments.contains("cli-mcp"))
    }

    @Test func updateIssueClearsResolution() async throws {
        let mock = MockCLIRunner()
        mock.stubbedResult = CLIResult(exitCode: 0, stdout: issueJSON, stderr: "")
        let writer = CLIStoryWriter(runner: mock, projectRoot: tmpURL)

        _ = try await writer.updateIssue(
            "ISS-001", status: nil, title: nil, severity: nil,
            impact: nil, resolution: .some(nil), components: nil,
            relatedTickets: nil, location: nil, order: nil, phase: nil
        )

        let resIdx = try #require(mock.capturedArguments.firstIndex(of: "--resolution"))
        #expect(mock.capturedArguments[resIdx + 1] == "")
    }

    @Test func deleteIssueBuildsArgs() async throws {
        let mock = MockCLIRunner()
        mock.stubbedResult = CLIResult(exitCode: 0, stdout: deleteJSON, stderr: "")
        let writer = CLIStoryWriter(runner: mock, projectRoot: tmpURL)

        try await writer.deleteIssue("ISS-001")

        #expect(mock.capturedArguments.contains("issue"))
        #expect(mock.capturedArguments.contains("delete"))
        #expect(mock.capturedArguments.contains("ISS-001"))
    }
}

// MARK: - Note Operation Tests

struct CLIStoryWriterNoteTests {
    @Test func createNoteBuildsArgs() async throws {
        let mock = MockCLIRunner()
        mock.stubbedResult = CLIResult(exitCode: 0, stdout: noteJSON, stderr: "")
        let writer = CLIStoryWriter(runner: mock, projectRoot: tmpURL)

        _ = try await writer.createNote(content: "A thought.", title: "Ideas", tags: ["brainstorm", "ui"])

        #expect(mock.capturedArguments.contains("note"))
        #expect(mock.capturedArguments.contains("create"))
        #expect(mock.capturedArguments.contains("--content"))
        #expect(mock.capturedArguments.contains("--title"))
        #expect(mock.capturedArguments.contains("Ideas"))
        #expect(mock.capturedArguments.contains("--tags"))
        #expect(mock.capturedArguments.contains("brainstorm"))
        #expect(mock.capturedArguments.contains("ui"))
    }

    @Test func createNoteOmitsOptionalFields() async throws {
        let mock = MockCLIRunner()
        mock.stubbedResult = CLIResult(exitCode: 0, stdout: noteJSON, stderr: "")
        let writer = CLIStoryWriter(runner: mock, projectRoot: tmpURL)

        _ = try await writer.createNote(content: "Just a thought.", title: nil, tags: [])

        #expect(mock.capturedArguments.contains("--content"))
        #expect(!mock.capturedArguments.contains("--title"))
        #expect(!mock.capturedArguments.contains("--tags"))
    }

    @Test func updateNoteClearTags() async throws {
        let mock = MockCLIRunner()
        mock.stubbedResult = CLIResult(exitCode: 0, stdout: noteJSON, stderr: "")
        let writer = CLIStoryWriter(runner: mock, projectRoot: tmpURL)

        _ = try await writer.updateNote("N-001", content: nil, title: nil, tags: nil, clearTags: true, status: nil)

        #expect(mock.capturedArguments.contains("--clear-tags"))
        #expect(!mock.capturedArguments.contains("--tags"))
    }

    @Test func updateNoteStatus() async throws {
        let mock = MockCLIRunner()
        mock.stubbedResult = CLIResult(exitCode: 0, stdout: noteJSON, stderr: "")
        let writer = CLIStoryWriter(runner: mock, projectRoot: tmpURL)

        _ = try await writer.updateNote("N-001", content: nil, title: nil, tags: nil, clearTags: false, status: .archived)

        #expect(mock.capturedArguments.contains("--status"))
        #expect(mock.capturedArguments.contains("archived"))
    }

    @Test func deleteNoteBuildsArgs() async throws {
        let mock = MockCLIRunner()
        mock.stubbedResult = CLIResult(exitCode: 0, stdout: deleteJSON, stderr: "")
        let writer = CLIStoryWriter(runner: mock, projectRoot: tmpURL)

        try await writer.deleteNote("N-001")

        #expect(mock.capturedArguments.contains("note"))
        #expect(mock.capturedArguments.contains("delete"))
        #expect(mock.capturedArguments.contains("N-001"))
    }
}

// MARK: - Phase Operation Tests

struct CLIStoryWriterPhaseTests {
    @Test func createPhaseWithAfter() async throws {
        let mock = MockCLIRunner()
        mock.stubbedResult = CLIResult(exitCode: 0, stdout: phaseJSON, stderr: "")
        let writer = CLIStoryWriter(runner: mock, projectRoot: tmpURL)

        _ = try await writer.createPhase(
            id: "test-phase", name: "Test Phase", label: "P0",
            description: "A phase.", summary: "Short", after: "dogfood", atStart: false
        )

        #expect(mock.capturedArguments.contains("--after"))
        #expect(mock.capturedArguments.contains("dogfood"))
        #expect(mock.capturedArguments.contains("--summary"))
        #expect(!mock.capturedArguments.contains("--at-start"))
    }

    @Test func createPhaseAtStart() async throws {
        let mock = MockCLIRunner()
        mock.stubbedResult = CLIResult(exitCode: 0, stdout: phaseJSON, stderr: "")
        let writer = CLIStoryWriter(runner: mock, projectRoot: tmpURL)

        _ = try await writer.createPhase(
            id: "first", name: "First", label: "P0",
            description: "First phase.", summary: nil, after: nil, atStart: true
        )

        #expect(mock.capturedArguments.contains("--at-start"))
        #expect(!mock.capturedArguments.contains("--after"))
        #expect(!mock.capturedArguments.contains("--summary"))
    }

    @Test func renamePhasePartialFields() async throws {
        let mock = MockCLIRunner()
        mock.stubbedResult = CLIResult(exitCode: 0, stdout: phaseJSON, stderr: "")
        let writer = CLIStoryWriter(runner: mock, projectRoot: tmpURL)

        _ = try await writer.renamePhase("test-phase", name: "New Name", label: nil, description: nil, summary: nil)

        #expect(mock.capturedArguments.contains("rename"))
        #expect(mock.capturedArguments.contains("--name"))
        #expect(mock.capturedArguments.contains("New Name"))
        #expect(!mock.capturedArguments.contains("--label"))
        #expect(!mock.capturedArguments.contains("--description"))
    }

    @Test func movePhaseAfter() async throws {
        let mock = MockCLIRunner()
        mock.stubbedResult = CLIResult(exitCode: 0, stdout: phaseJSON, stderr: "")
        let writer = CLIStoryWriter(runner: mock, projectRoot: tmpURL)

        _ = try await writer.movePhase("test-phase", after: "dogfood", atStart: false)

        #expect(mock.capturedArguments.contains("move"))
        #expect(mock.capturedArguments.contains("--after"))
        #expect(mock.capturedArguments.contains("dogfood"))
    }

    @Test func deletePhaseWithReassign() async throws {
        let mock = MockCLIRunner()
        mock.stubbedResult = CLIResult(exitCode: 0, stdout: deleteJSON, stderr: "")
        let writer = CLIStoryWriter(runner: mock, projectRoot: tmpURL)

        try await writer.deletePhase("old-phase", reassign: "new-phase")

        #expect(mock.capturedArguments.contains("delete"))
        #expect(mock.capturedArguments.contains("--reassign"))
        #expect(mock.capturedArguments.contains("new-phase"))
    }
}

// MARK: - Blocker Operation Tests

struct CLIStoryWriterBlockerTests {
    @Test func addBlockerBuildsArgs() async throws {
        let mock = MockCLIRunner()
        mock.stubbedResult = CLIResult(exitCode: 0, stdout: """
        {"version":1,"data":{"name":"test blocker","cleared":false,"createdDate":"2026-03-23","clearedDate":null,"note":"A note."}}
        """, stderr: "")
        let writer = CLIStoryWriter(runner: mock, projectRoot: tmpURL)

        try await writer.addBlocker(name: "test blocker", note: "A note.")

        #expect(mock.capturedArguments.contains("blocker"))
        #expect(mock.capturedArguments.contains("add"))
        #expect(mock.capturedArguments.contains("--name"))
        #expect(mock.capturedArguments.contains("test blocker"))
        #expect(mock.capturedArguments.contains("--note"))
        #expect(mock.capturedArguments.contains("A note."))
    }

    @Test func addBlockerOmitsNote() async throws {
        let mock = MockCLIRunner()
        mock.stubbedResult = CLIResult(exitCode: 0, stdout: """
        {"version":1,"data":{"name":"blocker","cleared":false,"createdDate":"2026-03-23","clearedDate":null,"note":null}}
        """, stderr: "")
        let writer = CLIStoryWriter(runner: mock, projectRoot: tmpURL)

        try await writer.addBlocker(name: "blocker", note: nil)

        #expect(!mock.capturedArguments.contains("--note"))
    }

    @Test func clearBlockerBuildsArgs() async throws {
        let mock = MockCLIRunner()
        mock.stubbedResult = CLIResult(exitCode: 0, stdout: """
        {"version":1,"data":{"name":"blocker","cleared":true,"createdDate":"2026-03-20","clearedDate":"2026-03-23","note":null}}
        """, stderr: "")
        let writer = CLIStoryWriter(runner: mock, projectRoot: tmpURL)

        try await writer.clearBlocker(name: "blocker", note: nil)

        #expect(mock.capturedArguments.contains("clear"))
        #expect(mock.capturedArguments.contains("--name"))
        #expect(mock.capturedArguments.contains("blocker"))
    }

    @Test func clearBlockerThrowsOnNotFound() async {
        let mock = MockCLIRunner()
        mock.stubbedResult = CLIResult(exitCode: 1, stdout: errorJSON, stderr: "")
        let writer = CLIStoryWriter(runner: mock, projectRoot: tmpURL)

        do {
            try await writer.clearBlocker(name: "nonexistent", note: nil)
            Testing.Issue.record("Should have thrown")
        } catch {
            #expect(error is StoryWriterError)
        }
    }
}

// MARK: - Handover + Snapshot Tests

struct CLIStoryWriterHandoverTests {
    @Test func createHandoverBuildsArgs() async throws {
        let mock = MockCLIRunner()
        mock.stubbedResult = CLIResult(exitCode: 0, stdout: handoverJSON, stderr: "")
        let writer = CLIStoryWriter(runner: mock, projectRoot: tmpURL)

        let filename = try await writer.createHandover(content: "Session notes.", slug: "session")

        #expect(filename == "2026-03-23-01-session.md")
        #expect(mock.capturedArguments.contains("handover"))
        #expect(mock.capturedArguments.contains("create"))
        #expect(mock.capturedArguments.contains("--content"))
        #expect(mock.capturedArguments.contains("--slug"))
        #expect(mock.capturedArguments.contains("session"))
    }

    @Test func snapshotBuildsArgs() async throws {
        let mock = MockCLIRunner()
        // Realistic fixture: parseSuccess only checks exit code, but fixture should match CLI output
        mock.stubbedResult = CLIResult(exitCode: 0, stdout: """
        {"version":1,"data":{"filename":"2026-03-23T12-00-00-000.json","retained":1,"pruned":0}}
        """, stderr: "")
        let writer = CLIStoryWriter(runner: mock, projectRoot: tmpURL)

        try await writer.snapshot()

        #expect(mock.capturedArguments.contains("snapshot"))
    }
}
