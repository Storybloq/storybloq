import Foundation
import Testing
@testable import Modern_IDE

// MARK: - Terminal Crash-Loop Orchestration Tests

/// Tests for ProjectViewModel's crash-loop detection and auto-restart logic.
/// Drives the TerminalSession state machine directly (pure state machine, no mocks needed)
/// and calls ProjectViewModel methods to test orchestration.

private struct StubLoader: ProjectLoading, @unchecked Sendable {
    nonisolated func load(from projectRoot: URL) async throws -> LoadResult {
        let roadmap = Roadmap(title: "test", date: "2026-03-15", phases: [], blockers: [])
        let config = Config(version: 2, project: "test", type: "macapp", language: "swift",
                            features: Config.Features(tickets: true, issues: true, handovers: true, roadmap: true, reviews: true))
        let state = ProjectState(tickets: [], issues: [], roadmap: roadmap, config: config, handoverFilenames: [])
        return LoadResult(state: state, warnings: [])
    }
}

private final class StubWatcher: FileWatching {
    var isWatching: Bool = false
    var watchedURL: URL?
    func start(watching url: URL, onChange: @escaping () -> Void) {
        isWatching = true
        watchedURL = url
    }
    func stop() {
        isWatching = false
        watchedURL = nil
    }
}

private func makeViewModel() -> ProjectViewModel {
    ProjectViewModel(loader: StubLoader(), fileWatcher: StubWatcher())
}

/// Simulates a rapid exit cycle on the active tab: launch → run → exit.
/// Handles the case where the session is already in .launching (from showTerminal()).
/// Calls handleProcessExit(forTabID:exitCode:) as TerminalPaneView's onProcessExit would.
private func simulateExitCycle(_ vm: ProjectViewModel, code: Int32 = 1) {
    guard let tab = vm.terminalTabManager.activeTab,
          let url = vm.projectURL else { return }
    let session = tab.session

    // Start a new launch if in a launchable state
    if session.processState.canLaunch {
        session.requestLaunch(projectRoot: url)
    }

    // Complete the launch and immediately exit
    guard session.processState == .launching else { return }
    let gen = session.generation
    session.didLaunch()
    session.didExit(code, forGeneration: gen)
    vm.handleProcessExit(forTabID: tab.id, exitCode: code)
}

// MARK: - Tests

struct TerminalCrashLoopTests {

    @Test func crashLoopBreakerTriggersAfterRapidExits() async throws {
        let vm = makeViewModel()
        let fakeURL = URL(fileURLWithPath: "/tmp/test-crash-loop")
        vm.openProject(at: fakeURL)
        try await Task.sleep(for: .milliseconds(100))

        vm.showTerminal()
        #expect(vm.terminalTabManager.isVisible == true)

        let session = try #require(vm.terminalTabManager.activeSession)

        // showTerminal() already called requestLaunch → state is .launching.
        // First simulateExitCycle picks up the .launching state.
        // Simulate 5 exit cycles — counter goes 0,1,2,3,4 (all pass guard < 5)
        for _ in 1...5 {
            simulateExitCycle(vm)
        }

        // After 5 exits, state should still be .exited (not .failed)
        if case .failed = session.processState {
            Issue.record("Should not be failed after only 5 exits")
        }

        // 6th rapid exit should trigger .failed (counter reaches 5, fails guard < 5)
        simulateExitCycle(vm)

        if case .failed(let msg) = session.processState {
            #expect(msg.contains("exited repeatedly"))
        } else {
            Issue.record("Expected .failed after 6 rapid exits, got \(session.processState)")
        }
    }

    @Test func crashLoopCounterResetsOnSlowExit() async throws {
        let vm = makeViewModel()
        let fakeURL = URL(fileURLWithPath: "/tmp/test-slow-exit")
        vm.openProject(at: fakeURL)
        try await Task.sleep(for: .milliseconds(100))
        vm.showTerminal()

        // Simulate 4 rapid exits (counter reaches 3)
        for _ in 1...4 {
            simulateExitCycle(vm)
        }

        // Wait >2s so the next exit is "slow" and resets the counter
        try await Task.sleep(for: .seconds(2.1))

        // This exit should reset the counter (>2s gap)
        simulateExitCycle(vm)

        // Now do 4 more rapid exits — should still be fine (counter: 0,1,2,3)
        for _ in 1...4 {
            simulateExitCycle(vm)
        }

        let session = try #require(vm.terminalTabManager.activeSession)
        // Should NOT be failed — only 5 rapid exits since the reset
        if case .failed = session.processState {
            Issue.record("Counter should have reset after slow exit")
        }
    }

    @Test func crashLoopCounterResetsOnShowTerminal() async throws {
        let vm = makeViewModel()
        let fakeURL = URL(fileURLWithPath: "/tmp/test-show-reset")
        vm.openProject(at: fakeURL)
        try await Task.sleep(for: .milliseconds(100))
        vm.showTerminal()

        // Simulate 4 rapid exits (counter at 3)
        for _ in 1...4 {
            simulateExitCycle(vm)
        }

        // Hide and re-show terminal — should reset counter
        vm.hideTerminal()
        vm.showTerminal()

        // Now 5 more exit cycles should NOT trigger failure (counter was reset)
        for _ in 1...5 {
            simulateExitCycle(vm)
        }

        let session = try #require(vm.terminalTabManager.activeSession)
        if case .failed = session.processState {
            Issue.record("Counter should have reset after showTerminal()")
        }
    }

    @Test func autoRestartNotTriggeredWhenHidden() async throws {
        let vm = makeViewModel()
        let fakeURL = URL(fileURLWithPath: "/tmp/test-hidden")
        vm.openProject(at: fakeURL)
        try await Task.sleep(for: .milliseconds(100))

        // Show terminal — creates a tab and launches
        vm.showTerminal()
        let tab = try #require(vm.terminalTabManager.activeTab)
        let session = tab.session

        // Complete the launch that showTerminal() started
        let gen = session.generation
        session.didLaunch()
        #expect(session.processState == .running)

        // Hide terminal, then simulate exit
        vm.hideTerminal()
        #expect(vm.terminalTabManager.isVisible == false)

        session.didExit(0, forGeneration: gen)
        vm.handleProcessExit(forTabID: tab.id, exitCode: 0)

        // Should stay in .exited — no auto-restart when hidden
        #expect(session.processState == .exited(0))

        // Wait past the 500ms auto-restart delay
        try await Task.sleep(for: .milliseconds(700))

        // Still .exited — no restart happened
        #expect(session.processState == .exited(0))
    }
}
