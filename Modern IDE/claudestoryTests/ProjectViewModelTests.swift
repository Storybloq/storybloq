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

// MARK: - Mock Loader

/// Deterministic loader for unit tests. Returns a controlled result or throws.
/// @unchecked Sendable: safe because mock is constructed once and never mutated during tests.
private struct MockProjectLoader: ProjectLoading, @unchecked Sendable {
    let result: Result<LoadResult, any Error>

    nonisolated func load(from projectRoot: URL) async throws -> LoadResult {
        try result.get()
    }
}

private enum MockError: Error, LocalizedError {
    case simulatedFailure

    var errorDescription: String? { "Simulated failure" }
}

// MARK: - Mock File Watcher

/// Deterministic file watcher for unit tests. Captures onChange closure for manual triggering.
private final class MockFileWatcher: FileWatching {
    private(set) var isWatching: Bool = false
    private(set) var watchedURL: URL?
    private var onChange: (() -> Void)?

    func start(watching url: URL, onChange: @escaping () -> Void) {
        self.watchedURL = url
        self.onChange = onChange
        isWatching = true
    }

    func stop() {
        isWatching = false
        watchedURL = nil
        onChange = nil
    }

    /// Triggers the captured onChange closure, simulating a filesystem change.
    func simulateChange() {
        onChange?()
    }
}

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

private func makeTicketJSON(id: String, order: Int) -> String {
    """
    {
      "id": "\(id)",
      "title": "Ticket \(id)",
      "type": "task",
      "status": "open",
      "phase": "dogfood",
      "order": \(order),
      "description": "Test ticket.",
      "createdDate": "2026-03-11",
      "completedDate": null,
      "blockedBy": []
    }
    """
}

/// Creates a fixture LoadResult with a specified number of tickets.
private func makeLoadResult(ticketCount: Int = 0, warnings: [LoadWarning] = []) -> LoadResult {
    var tickets: [Ticket] = []
    let decoder = JSONDecoder()
    for i in 1...max(1, ticketCount) {
        let json = makeTicketJSON(id: "T-\(String(format: "%03d", i))", order: i * 10)
        if ticketCount > 0, let ticket = try? decoder.decode(Ticket.self, from: Data(json.utf8)) {
            tickets.append(ticket)
        }
    }

    let roadmap = try! decoder.decode(Roadmap.self, from: Data(validRoadmapJSON.utf8))
    let config = try! decoder.decode(Config.self, from: Data(validConfigJSON.utf8))

    let state = ProjectState(
        tickets: tickets,
        issues: [],
        roadmap: roadmap,
        config: config,
        handoverFilenames: []
    )
    return LoadResult(state: state, warnings: warnings)
}

/// Creates a real temp .story/ fixture on disk.
@discardableResult
private func createDiskFixture(
    tickets: [String: String] = [:]
) throws -> URL {
    let fm = FileManager.default
    let root = fm.temporaryDirectory
        .appendingPathComponent("vm-test-\(UUID().uuidString)")
    let wrapDir = root.appendingPathComponent(".story")
    try fm.createDirectory(at: wrapDir, withIntermediateDirectories: true)

    try validConfigJSON.write(to: wrapDir.appendingPathComponent("config.json"), atomically: true, encoding: .utf8)
    try validRoadmapJSON.write(to: wrapDir.appendingPathComponent("roadmap.json"), atomically: true, encoding: .utf8)

    let ticketsDir = wrapDir.appendingPathComponent("tickets")
    if !tickets.isEmpty {
        try fm.createDirectory(at: ticketsDir, withIntermediateDirectories: true)
        for (name, content) in tickets {
            try content.write(to: ticketsDir.appendingPathComponent(name), atomically: true, encoding: .utf8)
        }
    }

    return root
}

// MARK: - Mock Loader Tests (Deterministic)

struct ProjectViewModelMockTests {
    @Test func openProjectLoadsState() async throws {
        let mockLoader = MockProjectLoader(result: .success(makeLoadResult(ticketCount: 3)))
        let mockWatcher = MockFileWatcher()
        let vm = ProjectViewModel(loader: mockLoader, fileWatcher: mockWatcher)

        let fakeURL = URL(fileURLWithPath: "/tmp/test-project")
        vm.openProject(at: fakeURL)

        try await waitUntil { vm.state.tickets.count == 3 }
        #expect(vm.state.tickets.count == 3)
        #expect(vm.isLoading == false)
        #expect(vm.loadError == nil)
    }

    @Test func openProjectSetsProjectURL() async throws {
        let mockLoader = MockProjectLoader(result: .success(makeLoadResult()))
        let mockWatcher = MockFileWatcher()
        let vm = ProjectViewModel(loader: mockLoader, fileWatcher: mockWatcher)

        let fakeURL = URL(fileURLWithPath: "/tmp/test-project")
        vm.openProject(at: fakeURL)

        try await waitUntil { !vm.isLoading }
        #expect(vm.projectURL == fakeURL)
    }

    @Test func openProjectStartsFileWatcher() async throws {
        let mockLoader = MockProjectLoader(result: .success(makeLoadResult()))
        let mockWatcher = MockFileWatcher()
        let vm = ProjectViewModel(loader: mockLoader, fileWatcher: mockWatcher)

        let fakeURL = URL(fileURLWithPath: "/tmp/test-project")
        vm.openProject(at: fakeURL)

        try await waitUntil { !vm.isLoading }
        #expect(mockWatcher.isWatching)
        #expect(mockWatcher.watchedURL == fakeURL.appendingPathComponent(".story"))
    }

    @Test func closeProjectResetsState() async throws {
        let mockLoader = MockProjectLoader(result: .success(makeLoadResult(ticketCount: 2)))
        let mockWatcher = MockFileWatcher()
        let vm = ProjectViewModel(loader: mockLoader, fileWatcher: mockWatcher)

        let fakeURL = URL(fileURLWithPath: "/tmp/test-project")
        vm.openProject(at: fakeURL)
        try await waitUntil { vm.state.tickets.count == 2 }

        vm.closeProject()

        #expect(vm.state == .placeholder)
        #expect(vm.projectURL == nil)
        #expect(vm.isLoading == false)
        #expect(vm.loadError == nil)
        #expect(vm.warnings.isEmpty)
        #expect(!mockWatcher.isWatching)
    }

    @Test func openProjectWithErrorSetsLoadError() async throws {
        let mockLoader = MockProjectLoader(result: .failure(MockError.simulatedFailure))
        let mockWatcher = MockFileWatcher()
        let vm = ProjectViewModel(loader: mockLoader, fileWatcher: mockWatcher)

        let fakeURL = URL(fileURLWithPath: "/tmp/test-project")
        vm.openProject(at: fakeURL)

        try await waitUntil { vm.loadError != nil }
        #expect(vm.loadError == "Simulated failure")
        #expect(vm.isLoading == false)
    }

    @Test func corruptFileProducesWarning() async throws {
        let warning = LoadWarning(file: ".story/tickets/T-002.json", message: "decode error")
        let mockLoader = MockProjectLoader(result: .success(makeLoadResult(ticketCount: 1, warnings: [warning])))
        let mockWatcher = MockFileWatcher()
        let vm = ProjectViewModel(loader: mockLoader, fileWatcher: mockWatcher)

        let fakeURL = URL(fileURLWithPath: "/tmp/test-project")
        vm.openProject(at: fakeURL)

        try await waitUntil { !vm.warnings.isEmpty }
        #expect(vm.warnings.count == 1)
        #expect(vm.warnings.first?.file == ".story/tickets/T-002.json")
    }
}

// MARK: - Integration Tests (Real Filesystem + FileWatcher)

struct ProjectViewModelIntegrationTests {
    @Test func loadsRealProject() async throws {
        let root = try createDiskFixture(tickets: [
            "T-001.json": makeTicketJSON(id: "T-001", order: 10),
            "T-002.json": makeTicketJSON(id: "T-002", order: 20)
        ])
        defer { try? FileManager.default.removeItem(at: root) }

        let vm = ProjectViewModel()
        vm.openProject(at: root)

        try await waitUntil { vm.state.tickets.count == 2 }
        #expect(vm.state.tickets.count == 2)
        #expect(vm.state.config.project == "test-project")
        #expect(vm.isLoading == false)
    }

    @Test func reloadsOnFileChange() async throws {
        let root = try createDiskFixture(tickets: [
            "T-001.json": makeTicketJSON(id: "T-001", order: 10)
        ])
        defer { try? FileManager.default.removeItem(at: root) }

        let vm = ProjectViewModel(fileWatcher: FileWatcher(debounceInterval: 0.05))
        vm.openProject(at: root)

        try await waitUntil { vm.state.tickets.count == 1 }

        // Write a second ticket to trigger FileWatcher reload
        let ticketsDir = root.appendingPathComponent(".story/tickets")
        try makeTicketJSON(id: "T-002", order: 20).write(
            to: ticketsDir.appendingPathComponent("T-002.json"),
            atomically: true, encoding: .utf8
        )

        try await waitUntil(timeout: 3.0) { vm.state.tickets.count == 2 }
        #expect(vm.state.tickets.count == 2)
    }

    @Test func closeStopsReloading() async throws {
        let root = try createDiskFixture(tickets: [
            "T-001.json": makeTicketJSON(id: "T-001", order: 10)
        ])
        defer { try? FileManager.default.removeItem(at: root) }

        let vm = ProjectViewModel(fileWatcher: FileWatcher(debounceInterval: 0.05))
        vm.openProject(at: root)

        try await waitUntil { vm.state.tickets.count == 1 }

        vm.closeProject()

        // Write a second ticket after close — should NOT reload
        let ticketsDir = root.appendingPathComponent(".story/tickets")
        try makeTicketJSON(id: "T-002", order: 20).write(
            to: ticketsDir.appendingPathComponent("T-002.json"),
            atomically: true, encoding: .utf8
        )

        // Wait 500ms (10x debounce). State should stay placeholder.
        try await Task.sleep(for: .milliseconds(500))
        #expect(vm.state == .placeholder)
    }
}
