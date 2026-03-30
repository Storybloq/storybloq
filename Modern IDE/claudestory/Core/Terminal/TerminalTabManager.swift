import Foundation

// MARK: - Terminal Tab Manager

/// Manages multiple terminal tabs for a project. Owns the tab array,
/// active tab selection, area visibility, and tab lifecycle operations.
///
/// Invariant: if `isVisible == true`, at least one tab exists.
/// Enforced by `showTerminal()` in ProjectViewModel.
@Observable
final class TerminalTabManager {

    static let maxTabs = 8

    // MARK: - Observable State

    private(set) var tabs: [TerminalTab] = []
    var activeTabID: UUID?
    var isVisible: Bool = false

    // MARK: - Internal

    @ObservationIgnored private var nextTabNumber: Int = 1

    // MARK: - Computed Properties

    var activeTab: TerminalTab? {
        guard let id = activeTabID else { return nil }
        return tabs.first { $0.id == id }
    }

    var activeSession: TerminalSession? {
        activeTab?.session
    }

    /// Whether the active tab's session is in a transitional state.
    var isActiveTabTransitional: Bool {
        guard let session = activeSession else { return false }
        return session.processState == .launching ||
               session.processState == .terminating
    }

    var canAddTab: Bool {
        tabs.count < Self.maxTabs
    }

    // MARK: - Tab Lifecycle

    /// Create a new tab with an auto-incremented label. Sets it as active.
    @discardableResult
    func addTab() -> TerminalTab {
        guard canAddTab else {
            // At limit — return the active tab or last tab
            return activeTab ?? tabs[tabs.count - 1]
        }
        // Cancel old active tab's restart work before switching (same as selectTab)
        if let oldTab = activeTab {
            oldTab.restartTask?.cancel()
            oldTab.restartTask = nil
            oldTab.restartEpoch += 1
            oldTab.session.clearPendingAutoPrompt()
        }
        let tab = TerminalTab(label: "Terminal \(nextTabNumber)")
        nextTabNumber += 1
        tabs.append(tab)
        activeTabID = tab.id
        return tab
    }

    /// Close a specific tab. Terminates its process, updates active selection,
    /// removes from array, and hides terminal if last tab.
    func closeTab(_ tabID: UUID) {
        guard let index = tabs.firstIndex(where: { $0.id == tabID }) else { return }
        let tab = tabs[index]

        // Cancel any pending restart
        tab.restartTask?.cancel()
        tab.restartTask = nil

        // Clear pending state
        tab.session.pendingCommand = nil
        tab.session.clearPendingAutoPrompt()

        // Begin termination immediately (Coordinator starts SIGTERM/SIGKILL escalation).
        // dismantleNSView → cleanup() is the backup path.
        if tab.session.processState == .running ||
           tab.session.processState == .launching {
            tab.session.requestTerminate()
        }

        // Invalidate any in-flight delayed tasks
        tab.restartEpoch += 1

        // Compute new active tab BEFORE removal (for clean first responder transfer)
        if activeTabID == tabID {
            let remaining = tabs.count - 1  // count after removal
            if remaining > 0 {
                // Prefer the tab to the right (index+1), else left neighbor (index-1).
                // We compute the candidate in the current (pre-removal) array.
                let candidateIndex = index < remaining ? index + 1 : index - 1
                activeTabID = tabs[candidateIndex].id
            } else {
                activeTabID = nil
            }
        }

        tabs.remove(at: index)

        if tabs.isEmpty {
            isVisible = false
        }
    }

    /// Switch to a specific tab. Cancels the previous active tab's restartTask,
    /// and triggers auto-restart if the new tab is in `.exited` state.
    /// Returns the newly selected tab (or nil if not found).
    @discardableResult
    func selectTab(_ tabID: UUID) -> TerminalTab? {
        guard tabs.contains(where: { $0.id == tabID }) else { return nil }

        // Cancel previous active tab's restart work and clear stale auto-prompt
        if let oldTab = activeTab, oldTab.id != tabID {
            oldTab.restartTask?.cancel()
            oldTab.restartTask = nil
            oldTab.restartEpoch += 1
            oldTab.session.clearPendingAutoPrompt()
        }

        activeTabID = tabID
        return tab(for: tabID)
    }

    /// Remove all tabs and reset state. Does NOT terminate running processes —
    /// callers must request termination first (see closeProject, terminateAllAndAwait).
    /// Removing tabs triggers SwiftUI's dismantleNSView → cleanup() as a backstop.
    func closeAllTabs() {
        for tab in tabs {
            tab.restartTask?.cancel()
            tab.restartTask = nil
            tab.session.pendingCommand = nil
            tab.session.clearPendingAutoPrompt()
            tab.restartEpoch += 1
        }
        tabs.removeAll()
        activeTabID = nil
        isVisible = false
        nextTabNumber = 1
    }

    /// Async: terminate all running sessions and await completion (bounded).
    /// Used by openProject() to ensure PTY processes are dead before project
    /// state changes. Does NOT rely on SwiftUI view dismantle timing.
    func terminateAllAndAwait() async {
        // Cancel all restart tasks and begin termination
        for tab in tabs {
            tab.restartTask?.cancel()
            tab.restartTask = nil
            tab.restartEpoch += 1
            if tab.session.processState == .running ||
               tab.session.processState == .launching {
                tab.session.requestTerminate()
            }
        }

        // Bounded poll until no tabs are in .terminating
        var attempts = 0
        while tabs.contains(where: { $0.session.processState == .terminating }),
              attempts < 50 {
            do { try await Task.sleep(for: .milliseconds(100)) }
            catch { return }  // cancelled
            attempts += 1
        }

        // Force-reset any stuck or failed sessions
        for tab in tabs {
            switch tab.session.processState {
            case .terminating, .failed:
                tab.session.reset()
            default:
                break
            }
        }

        closeAllTabs()
    }

    /// Lookup a tab by ID.
    func tab(for id: UUID) -> TerminalTab? {
        tabs.first { $0.id == id }
    }
}
