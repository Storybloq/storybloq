import AppKit

// MARK: - App Delegate

/// Minimal NSApplicationDelegate for AppKit bridging that SwiftUI
/// doesn't expose:
/// - Enable automatic window tabbing (tabbingMode = .preferred)
/// - Keep app alive when all windows close (for welcome window)
/// - Set isTerminating flag before quit (T-072: prevents workspace emptying)
final class AppDelegate: NSObject, NSApplicationDelegate {

    /// Set to true in applicationShouldTerminate, BEFORE windows start closing.
    /// Read by AppCoordinator.persistWorkspace() to skip saves during quit.
    /// Without this, each window close → projectDidClose → persistWorkspace
    /// would progressively empty workspace.json.
    @MainActor static var isTerminating = false

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSWindow.allowsAutomaticWindowTabbing = true
        #if DEBUG
        Log.level = .debug
        #endif
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        Self.isTerminating = true
        return .terminateNow
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        false
    }
}
