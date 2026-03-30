import Foundation
import Testing
@testable import Modern_IDE

// MARK: - Test Helpers

private struct TimeoutError: Error {}

/// Polls a condition every 20ms until true or timeout (default 2s).
private func waitUntil(
    timeout: TimeInterval = 2.0,
    condition: @escaping @MainActor () -> Bool
) async throws {
    let deadline = Date().addingTimeInterval(timeout)
    while await !condition() {
        guard Date() < deadline else {
            throw TimeoutError()
        }
        try await Task.sleep(for: .milliseconds(20))
    }
}

// MARK: - Fixture Builders

private func makeTicketJSON(
    id: String,
    title: String? = nil,
    phase: String = "dogfood",
    status: String = "open",
    order: Int = 10,
    blockedBy: [String] = [],
    parentTicket: String? = nil
) -> String {
    let blockedByJSON = blockedBy.map { "\"\($0)\"" }.joined(separator: ", ")
    let parentJSON = parentTicket.map { "\"\($0)\"" } ?? "null"
    return """
    {
      "id": "\(id)",
      "title": "\(title ?? "Ticket \(id)")",
      "type": "task",
      "status": "\(status)",
      "phase": "\(phase)",
      "order": \(order),
      "description": "Test ticket.",
      "createdDate": "2026-03-14",
      "completedDate": null,
      "blockedBy": [\(blockedByJSON)],
      "parentTicket": \(parentJSON)
    }
    """
}

private func makeIssueJSON(
    id: String,
    title: String? = nil,
    status: String = "open",
    severity: String = "medium"
) -> String {
    """
    {
      "id": "\(id)",
      "title": "\(title ?? "Issue \(id)")",
      "status": "\(status)",
      "severity": "\(severity)",
      "components": [],
      "impact": "Test impact.",
      "resolution": null,
      "location": [],
      "discoveredDate": "2026-03-14",
      "resolvedDate": null,
      "relatedTickets": []
    }
    """
}

private let smokeConfigJSON = """
{
  "version": 2,
  "project": "smoke-test",
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

private let smokeRoadmapJSON = """
{
  "title": "smoke-test",
  "date": "2026-03-14",
  "phases": [
    { "id": "dogfood", "label": "PHASE 0", "name": "Foundation", "description": "Base setup." },
    { "id": "viewer", "label": "PHASE 1", "name": "Core", "description": "Main features." },
    { "id": "detail", "label": "PHASE 2", "name": "Polish", "description": "Refinement." }
  ],
  "blockers": [
    { "name": "Test blocker", "cleared": true, "note": "Cleared for testing." }
  ]
}
"""

/// Creates the full smoke fixture: 10 tickets, 3 issues, 2 handovers.
///
/// Ticket layout:
/// - dogfood: T-001 (complete), T-002 (complete) — 2 leaves
/// - viewer: T-U01 (umbrella, open), T-C01 (complete, child), T-C02 (inprogress, child),
///        T-C03 (open, child), T-S01 (complete, standalone), T-BLK (open, blockedBy T-C03)
/// - detail: T-P01 (open), T-P02 (open) — 2 leaves
///
/// Expected derived values:
/// - phaseStatus(.dogfood) == .complete, .viewer == .inprogress, .detail == .notstarted
/// - umbrellaStatus("T-U01") == .inprogress
/// - blockedCount == 1 (T-BLK)
/// - totalTicketCount == 10, completeTicketCount == 4
/// - phaseTickets(.viewer).count == 5 (excludes umbrella T-U01)
/// - activeIssueCount == 2, issuesBySeverity: [.critical: 1, .medium: 1]
private func createSmokeFixture() throws -> URL {
    let fm = FileManager.default
    let root = fm.temporaryDirectory.appendingPathComponent("smoke-\(UUID().uuidString)")
    let wrapDir = root.appendingPathComponent(".story")
    let ticketsDir = wrapDir.appendingPathComponent("tickets")
    let issuesDir = wrapDir.appendingPathComponent("issues")
    let handoversDir = wrapDir.appendingPathComponent("handovers")

    try fm.createDirectory(at: ticketsDir, withIntermediateDirectories: true)
    try fm.createDirectory(at: issuesDir, withIntermediateDirectories: true)
    try fm.createDirectory(at: handoversDir, withIntermediateDirectories: true)

    // Config + Roadmap
    try smokeConfigJSON.write(to: wrapDir.appendingPathComponent("config.json"), atomically: true, encoding: .utf8)
    try smokeRoadmapJSON.write(to: wrapDir.appendingPathComponent("roadmap.json"), atomically: true, encoding: .utf8)

    // Tickets (10)
    let tickets: [(String, String)] = [
        ("T-001.json", makeTicketJSON(id: "T-001", phase: "dogfood", status: "complete", order: 10)),
        ("T-002.json", makeTicketJSON(id: "T-002", phase: "dogfood", status: "complete", order: 20)),
        ("T-U01.json", makeTicketJSON(id: "T-U01", phase: "viewer", status: "open", order: 10)),
        ("T-C01.json", makeTicketJSON(id: "T-C01", phase: "viewer", status: "complete", order: 20, parentTicket: "T-U01")),
        ("T-C02.json", makeTicketJSON(id: "T-C02", phase: "viewer", status: "inprogress", order: 30, parentTicket: "T-U01")),
        ("T-C03.json", makeTicketJSON(id: "T-C03", phase: "viewer", status: "open", order: 40, parentTicket: "T-U01")),
        ("T-S01.json", makeTicketJSON(id: "T-S01", phase: "viewer", status: "complete", order: 50)),
        ("T-BLK.json", makeTicketJSON(id: "T-BLK", phase: "viewer", status: "open", order: 60, blockedBy: ["T-C03"])),
        ("T-P01.json", makeTicketJSON(id: "T-P01", phase: "detail", status: "open", order: 10)),
        ("T-P02.json", makeTicketJSON(id: "T-P02", phase: "detail", status: "open", order: 20)),
    ]
    for (name, json) in tickets {
        try json.write(to: ticketsDir.appendingPathComponent(name), atomically: true, encoding: .utf8)
    }

    // Issues (3)
    let issues: [(String, String)] = [
        ("ISS-001.json", makeIssueJSON(id: "ISS-001", status: "open", severity: "critical")),
        ("ISS-002.json", makeIssueJSON(id: "ISS-002", status: "open", severity: "medium")),
        ("ISS-003.json", makeIssueJSON(id: "ISS-003", status: "resolved", severity: "low")),
    ]
    for (name, json) in issues {
        try json.write(to: issuesDir.appendingPathComponent(name), atomically: true, encoding: .utf8)
    }

    // Handovers (2)
    try "Session one content.".write(to: handoversDir.appendingPathComponent("2026-03-11-session-one.md"), atomically: true, encoding: .utf8)
    try "Random notes.".write(to: handoversDir.appendingPathComponent("random-notes.md"), atomically: true, encoding: .utf8)

    return root
}

/// Creates a fixture with missing config.json (for error path testing).
private func createErrorFixture() throws -> URL {
    let fm = FileManager.default
    let root = fm.temporaryDirectory.appendingPathComponent("smoke-err-\(UUID().uuidString)")
    let wrapDir = root.appendingPathComponent(".story")
    try fm.createDirectory(at: wrapDir, withIntermediateDirectories: true)

    // Only roadmap — config.json intentionally missing
    try smokeRoadmapJSON.write(to: wrapDir.appendingPathComponent("roadmap.json"), atomically: true, encoding: .utf8)

    return root
}

// MARK: - Load Tests

struct IntegrationSmokeLoadTests {

    // Test 1: Full pipeline loads all data types from disk
    @Test func fullPipelineLoadsAllData() async throws {
        let root = try createSmokeFixture()
        let vm = ProjectViewModel()
        defer { vm.closeProject(); try? FileManager.default.removeItem(at: root) }

        vm.openProject(at: root)

        try await waitUntil { !vm.isLoading }

        // Core counts
        #expect(vm.state.tickets.count == 10)
        #expect(vm.state.issues.count == 3)
        #expect(vm.state.handoverFilenames.count == 2)
        #expect(vm.state.roadmap.phases.count == 3)
        #expect(vm.state.config.project == "smoke-test")

        // ViewModel state
        #expect(vm.isLoading == false)
        #expect(vm.loadError == nil)

        // Handover ordering: conforming first (newest), non-conforming appended
        #expect(vm.state.handoverFilenames[0] == "2026-03-11-session-one.md")
        #expect(vm.state.handoverFilenames[1] == "random-notes.md")

        // Non-conforming handover produces exactly 1 warning tied to the correct file
        let handoverWarnings = vm.warnings.filter { $0.message.contains("YYYY-MM-DD") }
        #expect(handoverWarnings.count == 1)
        #expect(handoverWarnings.first?.file.contains("random-notes.md") == true)
    }

    // Test 2: Phase status derivation from disk-loaded data
    @Test func derivedPhaseStatusCorrectAfterLoad() async throws {
        let root = try createSmokeFixture()
        let vm = ProjectViewModel()
        defer { vm.closeProject(); try? FileManager.default.removeItem(at: root) }

        vm.openProject(at: root)

        try await waitUntil { !vm.isLoading }

        #expect(vm.state.phaseStatus(.dogfood) == .complete)
        #expect(vm.state.phaseStatus(.viewer) == .inprogress)
        #expect(vm.state.phaseStatus(.detail) == .notstarted)
    }

    // Test 3: Umbrella detection and status derivation
    @Test func derivedUmbrellaStatusCorrect() async throws {
        let root = try createSmokeFixture()
        let vm = ProjectViewModel()
        defer { vm.closeProject(); try? FileManager.default.removeItem(at: root) }

        vm.openProject(at: root)

        try await waitUntil { !vm.isLoading }

        // T-U01 is an umbrella (referenced as parentTicket by T-C01, T-C02, T-C03)
        #expect(vm.state.umbrellaIDs.contains("T-U01"))
        #expect(vm.state.umbrellaChildren("T-U01").count == 3)
        #expect(vm.state.umbrellaStatus("T-U01") == .inprogress)

        // phaseTickets excludes umbrellas — only 5 leaves in p1
        #expect(vm.state.phaseTickets(.viewer).count == 5)
        #expect(!vm.state.phaseTickets(.viewer).contains { $0.id == "T-U01" })
    }

    // Test 4: Aggregate counts match fixture data
    @Test func derivedCountsMatchExpected() async throws {
        let root = try createSmokeFixture()
        let vm = ProjectViewModel()
        defer { vm.closeProject(); try? FileManager.default.removeItem(at: root) }

        vm.openProject(at: root)

        try await waitUntil { !vm.isLoading }

        // Ticket counts (include umbrella in raw count)
        #expect(vm.state.totalTicketCount == 10)
        #expect(vm.state.completeTicketCount == 4) // T-001, T-002, T-C01, T-S01
        #expect(vm.state.openTicketCount == 6)

        // Issue counts (only open issues in severity map)
        #expect(vm.state.activeIssueCount == 2)
        #expect(vm.state.issuesBySeverity[.critical] == 1)
        #expect(vm.state.issuesBySeverity[.medium] == 1)
        #expect(vm.state.issuesBySeverity[.low] == nil) // Resolved ISS-003 excluded
    }

    // Test 5: Blocked ticket detection
    @Test func derivedBlockedCountCorrect() async throws {
        let root = try createSmokeFixture()
        let vm = ProjectViewModel()
        defer { vm.closeProject(); try? FileManager.default.removeItem(at: root) }

        vm.openProject(at: root)

        try await waitUntil { !vm.isLoading }

        #expect(vm.state.blockedCount == 1)

        // T-BLK is blocked by T-C03 (which is open)
        let blockedTicket = try #require(vm.state.tickets.first { $0.id == "T-BLK" })
        #expect(vm.state.isBlocked(blockedTicket) == true)

        // T-S01 has no blockers
        let freeTicket = try #require(vm.state.tickets.first { $0.id == "T-S01" })
        #expect(vm.state.isBlocked(freeTicket) == false)
    }

    // Test 6: Corrupt ticket file is skipped with warning
    @Test func corruptTicketSkippedWithWarning() async throws {
        let root = try createSmokeFixture()
        defer { try? FileManager.default.removeItem(at: root) }

        // Add a corrupt ticket file
        let ticketsDir = root.appendingPathComponent(".story/tickets")
        try "{ not valid json".write(
            to: ticketsDir.appendingPathComponent("T-BAD.json"),
            atomically: true, encoding: .utf8
        )

        let vm = ProjectViewModel()
        vm.openProject(at: root)

        try await waitUntil { !vm.isLoading }

        // Still loads 10 valid tickets — corrupt file skipped
        #expect(vm.state.tickets.count == 10)

        // Warning references the corrupt file
        #expect(vm.warnings.contains { $0.file.contains("T-BAD.json") })
    }

    // Test 7: Missing critical file (config.json) produces error
    @Test func criticalFileFailureReportsError() async throws {
        let root = try createErrorFixture()
        let vm = ProjectViewModel()
        defer { vm.closeProject(); try? FileManager.default.removeItem(at: root) }

        vm.openProject(at: root)

        try await waitUntil { vm.loadError != nil }

        #expect(vm.loadError != nil)
        #expect(vm.isLoading == false)

        // State unchanged from default — reload() error path never touches state
        #expect(vm.state == .placeholder)
    }
}

// MARK: - Reload Tests

struct IntegrationSmokeReloadTests {

    // Test 8: Adding an issue file triggers reload and updates counts
    @Test func fileWatcherTriggersReloadOnNewIssue() async throws {
        let root = try createSmokeFixture()
        let vm = ProjectViewModel(fileWatcher: FileWatcher(debounceInterval: 0.05))
        defer { vm.closeProject(); try? FileManager.default.removeItem(at: root) }

        vm.openProject(at: root)

        try await waitUntil { vm.state.issues.count == 3 }
        #expect(vm.state.activeIssueCount == 2)

        // Write a new issue file
        let issuesDir = root.appendingPathComponent(".story/issues")
        try makeIssueJSON(id: "ISS-NEW", status: "open", severity: "high").write(
            to: issuesDir.appendingPathComponent("ISS-NEW.json"),
            atomically: true, encoding: .utf8
        )

        try await waitUntil(timeout: 3.0) { vm.state.issues.count == 4 }
        #expect(vm.state.issues.count == 4)
        #expect(vm.state.activeIssueCount == 3)
    }

    // Test 9: Modifying a ticket's status triggers reload and updates derived phase status
    @Test func fileWatcherTriggersReloadOnModifiedTicket() async throws {
        let root = try createSmokeFixture()
        let vm = ProjectViewModel(fileWatcher: FileWatcher(debounceInterval: 0.05))
        defer { vm.closeProject(); try? FileManager.default.removeItem(at: root) }

        vm.openProject(at: root)

        try await waitUntil { vm.state.phaseStatus(.detail) == .notstarted }

        // Change T-P01 from open to inprogress
        let ticketsDir = root.appendingPathComponent(".story/tickets")
        try makeTicketJSON(id: "T-P01", phase: "detail", status: "inprogress", order: 10).write(
            to: ticketsDir.appendingPathComponent("T-P01.json"),
            atomically: true, encoding: .utf8
        )

        try await waitUntil(timeout: 3.0) { vm.state.phaseStatus(.detail) == .inprogress }
        #expect(vm.state.phaseStatus(.detail) == .inprogress)
    }

    // Test 10: Reload failure after successful load preserves previous state
    @Test func reloadFailurePreservesLastGoodState() async throws {
        let root = try createSmokeFixture()
        let vm = ProjectViewModel(fileWatcher: FileWatcher(debounceInterval: 0.05))
        defer { vm.closeProject(); try? FileManager.default.removeItem(at: root) }

        vm.openProject(at: root)

        try await waitUntil { vm.state.tickets.count == 10 }

        // Capture the good state
        let goodState = vm.state
        let goodWarnings = vm.warnings

        // Delete config.json — next reload will fail
        try FileManager.default.removeItem(
            at: root.appendingPathComponent(".story/config.json")
        )

        // Wait for FileWatcher to detect deletion and trigger failed reload
        try await waitUntil(timeout: 3.0) { vm.loadError != nil }

        // Error surfaced
        #expect(vm.loadError != nil)
        #expect(vm.isLoading == false)

        // Previous good state preserved — reload() error path never touches state or warnings
        #expect(vm.state == goodState)
        #expect(vm.warnings == goodWarnings)
    }
}
