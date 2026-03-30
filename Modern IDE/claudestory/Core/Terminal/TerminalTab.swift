import Foundation

// MARK: - Terminal Tab

/// A single terminal tab. Identifiable wrapper around TerminalSession
/// with per-tab metadata, crash-loop detection, and restart orchestration.
///
/// Reference type (class) because it owns mutable async state (restartTask,
/// crash-loop counters) that must survive array mutations. @Observable for
/// SwiftUI tab bar status indicators.
@Observable
final class TerminalTab: Identifiable {

    let id: UUID
    let session: TerminalSession
    var label: String

    // MARK: - Per-Tab Crash-Loop State (moved from ProjectViewModel)

    @ObservationIgnored var consecutiveRapidExits: Int = 0
    @ObservationIgnored var lastExitTime: Date?
    @ObservationIgnored var restartTask: Task<Void, Never>?

    /// Incremented on every launch, exit, close, manual restart, and project
    /// teardown. Delayed tasks capture this value at creation time and abort
    /// if it no longer matches — prevents stale restarts from firing after
    /// the tab's state has moved on.
    @ObservationIgnored var restartEpoch: Int = 0

    // MARK: - Init

    init(label: String) {
        self.id = UUID()
        self.session = TerminalSession()
        self.label = label
    }

    deinit {
        restartTask?.cancel()
    }
}
