import Foundation
import Testing
@testable import Modern_IDE

// MARK: - Terminal Tab Manager Tests

struct TerminalTabManagerTests {

    // MARK: - Tab Creation

    @Test func addTabCreatesWithCorrectLabel() {
        let manager = TerminalTabManager()
        let tab = manager.addTab()
        #expect(tab.label == "Terminal 1")
        #expect(manager.tabs.count == 1)
        #expect(manager.activeTabID == tab.id)
    }

    @Test func addTabIncrementsLabelCounter() {
        let manager = TerminalTabManager()
        let tab1 = manager.addTab()
        let tab2 = manager.addTab()
        let tab3 = manager.addTab()
        #expect(tab1.label == "Terminal 1")
        #expect(tab2.label == "Terminal 2")
        #expect(tab3.label == "Terminal 3")
    }

    @Test func addTabSetsNewTabAsActive() {
        let manager = TerminalTabManager()
        let tab1 = manager.addTab()
        #expect(manager.activeTabID == tab1.id)
        let tab2 = manager.addTab()
        #expect(manager.activeTabID == tab2.id)
    }

    @Test func canAddTabReturnsFalseAtLimit() {
        let manager = TerminalTabManager()
        for _ in 0..<TerminalTabManager.maxTabs {
            manager.addTab()
        }
        #expect(manager.canAddTab == false)
        #expect(manager.tabs.count == TerminalTabManager.maxTabs)
    }

    @Test func addTabAtLimitReturnsExistingTab() {
        let manager = TerminalTabManager()
        for _ in 0..<TerminalTabManager.maxTabs {
            manager.addTab()
        }
        let activeTab = manager.activeTab
        let countBefore = manager.tabs.count
        let returned = manager.addTab()
        #expect(returned.id == activeTab?.id)
        #expect(manager.tabs.count == countBefore)
    }

    // MARK: - Tab Close

    @Test func closeTabRemovesFromArray() {
        let manager = TerminalTabManager()
        let tab = manager.addTab()
        manager.closeTab(tab.id)
        #expect(manager.tabs.isEmpty)
    }

    @Test func closeActiveTabSelectsNextRight() {
        let manager = TerminalTabManager()
        let tab1 = manager.addTab()
        let tab2 = manager.addTab()
        let tab3 = manager.addTab()
        // Active is tab3, switch to tab1
        manager.selectTab(tab1.id)
        #expect(manager.activeTabID == tab1.id)

        // Close tab1 (index 0) → should select tab2 (next right, new index 0)
        manager.closeTab(tab1.id)
        #expect(manager.activeTabID == tab2.id)
        #expect(manager.tabs.count == 2)
    }

    @Test func closeActiveTabLastInListSelectsLeftNeighbor() {
        let manager = TerminalTabManager()
        let tab1 = manager.addTab()
        let tab2 = manager.addTab()
        let tab3 = manager.addTab()
        // Active is tab3 (last)
        #expect(manager.activeTabID == tab3.id)

        // Close tab3 (last) → should select tab2 (left neighbor)
        manager.closeTab(tab3.id)
        #expect(manager.activeTabID == tab2.id)
        #expect(manager.tabs.count == 2)
    }

    @Test func closeLastRemainingTabHidesTerminal() {
        let manager = TerminalTabManager()
        manager.isVisible = true
        let tab = manager.addTab()
        manager.closeTab(tab.id)
        #expect(manager.activeTabID == nil)
        #expect(manager.isVisible == false)
    }

    @Test func closeInactiveTabDoesNotChangeActiveTab() {
        let manager = TerminalTabManager()
        let tab1 = manager.addTab()
        let tab2 = manager.addTab()
        // Active is tab2
        #expect(manager.activeTabID == tab2.id)

        // Close tab1 (inactive)
        manager.closeTab(tab1.id)
        #expect(manager.activeTabID == tab2.id)
        #expect(manager.tabs.count == 1)
    }

    @Test func closeTabIncrementsRestartEpoch() {
        let manager = TerminalTabManager()
        let tab = manager.addTab()
        #expect(tab.restartEpoch == 0)
        // Keep a strong reference to verify epoch after close
        let tabRef = tab
        manager.closeTab(tab.id)
        // closeTab increments restartEpoch to invalidate in-flight delayed tasks
        #expect(tabRef.restartEpoch == 1)
    }

    // MARK: - Tab Selection

    @Test func selectTabChangesActiveTabID() {
        let manager = TerminalTabManager()
        let tab1 = manager.addTab()
        let tab2 = manager.addTab()
        #expect(manager.activeTabID == tab2.id)

        manager.selectTab(tab1.id)
        #expect(manager.activeTabID == tab1.id)
    }

    @Test func selectTabReturnsNilForInvalidID() {
        let manager = TerminalTabManager()
        manager.addTab()
        let result = manager.selectTab(UUID())
        #expect(result == nil)
    }

    // MARK: - Close All

    @Test func closeAllTabsClearsEverything() {
        let manager = TerminalTabManager()
        manager.isVisible = true
        manager.addTab()
        manager.addTab()
        manager.addTab()

        manager.closeAllTabs()
        #expect(manager.tabs.isEmpty)
        #expect(manager.activeTabID == nil)
        #expect(manager.isVisible == false)
    }

    @Test func closeAllTabsResetsLabelCounter() {
        let manager = TerminalTabManager()
        manager.addTab()
        manager.addTab()
        manager.closeAllTabs()

        // New tab should start from "Terminal 1" again
        let tab = manager.addTab()
        #expect(tab.label == "Terminal 1")
    }

    // MARK: - Computed Properties

    @Test func activeSessionReturnsCorrectSession() {
        let manager = TerminalTabManager()
        let tab = manager.addTab()
        #expect(manager.activeSession === tab.session)
    }

    @Test func activeTabIsNilWhenNoTabs() {
        let manager = TerminalTabManager()
        #expect(manager.activeTab == nil)
        #expect(manager.activeSession == nil)
    }

    @Test func isActiveTabTransitionalReflectsSessionState() throws {
        let manager = TerminalTabManager()
        let tab = manager.addTab()

        // Idle — not transitional
        #expect(manager.isActiveTabTransitional == false)

        // Launch
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("test-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }

        tab.session.requestLaunch(projectRoot: root)
        #expect(manager.isActiveTabTransitional == true)

        tab.session.didLaunch()
        #expect(manager.isActiveTabTransitional == false)

        // Terminate
        tab.session.requestTerminate()
        #expect(manager.isActiveTabTransitional == true)
    }

    // MARK: - Tab Lookup

    @Test func tabForIDReturnsCorrectTab() {
        let manager = TerminalTabManager()
        let tab1 = manager.addTab()
        let tab2 = manager.addTab()
        #expect(manager.tab(for: tab1.id)?.id == tab1.id)
        #expect(manager.tab(for: tab2.id)?.id == tab2.id)
        #expect(manager.tab(for: UUID()) == nil)
    }
}

// MARK: - Process Exit Handling Tests (via ProjectViewModel)

struct TerminalTabProcessExitTests {

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

    @Test func inactiveTabExitDoesNotAutoRestart() async throws {
        let vm = makeViewModel()
        let fakeURL = URL(fileURLWithPath: "/tmp/test-inactive-exit")
        vm.openProject(at: fakeURL)
        try await Task.sleep(for: .milliseconds(100))

        vm.showTerminal()
        let tab1 = try #require(vm.terminalTabManager.activeTab)

        // Complete launch for tab1
        let root = try #require(vm.projectURL)
        let gen = tab1.session.generation
        tab1.session.didLaunch()
        #expect(tab1.session.processState == .running)

        // Add a second tab and switch to it
        vm.addTerminalTab()
        let tab2 = try #require(vm.terminalTabManager.activeTab)
        #expect(tab2.id != tab1.id)

        // Tab1 is now inactive. Simulate its exit.
        tab1.session.didExit(0, forGeneration: gen)
        vm.handleProcessExit(forTabID: tab1.id, exitCode: 0)

        // Tab1 should stay exited — no auto-restart for inactive tabs
        #expect(tab1.session.processState == .exited(0))

        // Wait past the 500ms restart delay
        try await Task.sleep(for: .milliseconds(700))
        #expect(tab1.session.processState == .exited(0))
    }

    @Test func handleProcessExitIgnoresRemovedTab() async throws {
        let vm = makeViewModel()
        let fakeURL = URL(fileURLWithPath: "/tmp/test-removed-exit")
        vm.openProject(at: fakeURL)
        try await Task.sleep(for: .milliseconds(100))

        vm.showTerminal()
        let tab = try #require(vm.terminalTabManager.activeTab)
        let tabID = tab.id

        // Close the tab
        vm.closeTerminalTab(tabID)

        // handleProcessExit for removed tab should be a no-op
        vm.handleProcessExit(forTabID: tabID, exitCode: 0)
        // No crash = success
    }

    @Test func switchToExitedTabTriggersRestart() async throws {
        let vm = makeViewModel()
        let fakeURL = URL(fileURLWithPath: "/tmp/test-switch-exited")
        vm.openProject(at: fakeURL)
        try await Task.sleep(for: .milliseconds(100))

        vm.showTerminal()
        let tab1 = try #require(vm.terminalTabManager.activeTab)

        // Complete launch and exit for tab1
        let gen1 = tab1.session.generation
        tab1.session.didLaunch()
        tab1.session.didExit(0, forGeneration: gen1)

        // Add tab2 (becomes active, tab1 stays .exited)
        vm.addTerminalTab()
        #expect(tab1.session.processState == .exited(0))

        // Switch back to tab1 — should trigger relaunch
        vm.switchToTab(tab1.id)
        #expect(tab1.session.processState == .launching)
    }
}
