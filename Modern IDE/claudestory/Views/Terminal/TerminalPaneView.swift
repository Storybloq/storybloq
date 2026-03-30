import SwiftUI
import SwiftTerm

// MARK: - Terminal Colors

private enum TerminalColors {
    // Terminal-specific colors — higher contrast than StoryTheme for text readability.
    // Dark values inspired by StoryTheme.base (linen), light values by .surface (canvas).
    static let darkBackground = NSColor(red: 0.08, green: 0.07, blue: 0.06, alpha: 1.0)
    static let darkForeground = NSColor(red: 0.87, green: 0.85, blue: 0.82, alpha: 1.0)
    static let lightBackground = NSColor(red: 0.97, green: 0.96, blue: 0.94, alpha: 1.0)
    static let lightForeground = NSColor(red: 0.13, green: 0.12, blue: 0.11, alpha: 1.0)
}

// MARK: - Terminal Pane View

/// NSViewRepresentable wrapping SwiftTerm's LocalProcessTerminalView.
///
/// The Coordinator owns the terminal view for its entire lifetime, keeping the PTY session
/// alive across SwiftUI view updates. Process lifecycle is driven by TerminalSession state
/// changes observed via `updateNSView`.
struct TerminalPaneView: NSViewRepresentable {
    typealias NSViewType = LocalProcessTerminalView

    let session: TerminalSession
    var isActive: Bool = true
    var onProcessExit: ((Int32) -> Void)?
    @Environment(\.colorScheme) var colorScheme

    func makeCoordinator() -> Coordinator {
        Coordinator(session: session)
    }

    func makeNSView(context: Context) -> LocalProcessTerminalView {
        let view = context.coordinator.terminalView
        applyTheme(to: view, colorScheme: colorScheme)
        return view
    }

    func updateNSView(_ view: LocalProcessTerminalView, context: Context) {
        // Update onProcessExit callback on Coordinator so it stays current
        context.coordinator.onProcessExit = onProcessExit

        // Visibility via NSView.isHidden — only reliable way to prevent inactive
        // AppKit views from intercepting keyboard input via the responder chain.
        let shouldBeHidden = !isActive
        let becameActive = isActive && !context.coordinator.wasActive
        // Only record wasActive once the view is attached to a window.
        // If isActive is true but window is nil (first render, not yet mounted),
        // keep wasActive=false so we retry on the next updateNSView call.
        if view.window != nil || !isActive {
            context.coordinator.wasActive = isActive
        }

        if view.isHidden != shouldBeHidden {
            view.isHidden = shouldBeHidden
            if shouldBeHidden {
                // Resign first responder when deactivating
                if view.window?.firstResponder === view {
                    view.window?.makeFirstResponder(nil)
                }
            }
        }
        // Only claim first responder on inactive→active transition,
        // NOT on every render — otherwise the terminal steals focus
        // from text fields elsewhere in the app.
        if becameActive, view.window != nil {
            view.window?.makeFirstResponder(view)
        }

        // Process lifecycle — guard on state to skip during resize/layout updates
        if session.processState == .launching {
            context.coordinator.launchIfNeeded()
        } else if session.processState == .terminating {
            context.coordinator.terminateIfNeeded()
        }
        if session.resetRequested {
            context.coordinator.resetIfRequested()
        }
        context.coordinator.sendPendingCommandIfReady()

        // Theme (only when changed)
        if context.coordinator.lastAppliedColorScheme != colorScheme {
            applyTheme(to: view, colorScheme: colorScheme)
            context.coordinator.lastAppliedColorScheme = colorScheme
        }
    }

    static func dismantleNSView(_ view: LocalProcessTerminalView, coordinator: Coordinator) {
        coordinator.cleanup()
    }

    private func applyTheme(to view: LocalProcessTerminalView, colorScheme: ColorScheme) {
        if colorScheme == .dark {
            view.nativeBackgroundColor = TerminalColors.darkBackground
            view.nativeForegroundColor = TerminalColors.darkForeground
        } else {
            view.nativeBackgroundColor = TerminalColors.lightBackground
            view.nativeForegroundColor = TerminalColors.lightForeground
        }
    }

    // MARK: - Coordinator

    class Coordinator: NSObject, LocalProcessTerminalViewDelegate {
        let terminalView: LocalProcessTerminalView
        let session: TerminalSession
        /// Generation of the currently active process. Set only after startProcess confirms
        /// the process is running. Cleared to 0 when processTerminated fires. This ensures
        /// stale callbacks from old processes cannot be attributed to newer launches.
        private var activeProcessGeneration: Int = 0
        private var isTerminationInFlight = false
        private var escalationTask: Task<Void, Never>?
        var lastAppliedColorScheme: ColorScheme?
        /// Tracks previous isActive value to detect transitions.
        /// Only claim first responder on false→true, not every render.
        var wasActive: Bool = false
        /// Callback fired from processTerminated delegate (not from cleanup/reset).
        /// Captures tab.id (value type) in ProjectWindowView, not the tab reference.
        var onProcessExit: ((Int32) -> Void)?

        init(session: TerminalSession) {
            self.session = session
            self.terminalView = LocalProcessTerminalView(frame: NSRect(x: 0, y: 0, width: 600, height: 300))
            super.init()
            self.terminalView.processDelegate = self

            // Hide SwiftTerm's built-in NSScroller (always-visible legacy style).
            // The terminal supports scroll-wheel/trackpad without the visual scroller.
            for subview in terminalView.subviews where subview is NSScroller {
                subview.isHidden = true
            }
        }

        deinit {
            escalationTask?.cancel()
        }

        func launchIfNeeded() {
            guard let config = session.pendingLaunchConfig,
                  session.processState == .launching else { return }

            isTerminationInFlight = false
            escalationTask?.cancel()
            escalationTask = nil
            terminalView.startProcess(
                executable: config.executable,
                args: config.args,
                environment: config.environment,
                execName: nil,
                currentDirectory: config.workingDirectory
            )

            if terminalView.process.running {
                activeProcessGeneration = session.generation
                session.didLaunch()
            } else {
                activeProcessGeneration = 0
                session.markFailed("Failed to start shell process")
            }
        }

        func terminateIfNeeded() {
            guard session.processState == .terminating, !isTerminationInFlight else { return }
            isTerminationInFlight = true

            let exitCmd: [UInt8] = Array("exit\n".utf8)
            terminalView.send(exitCmd)

            // Capture process group BEFORE terminate() clears childfd.
            let capturedPgrp: pid_t
            let childFd = terminalView.process.childfd
            if childFd >= 0 {
                let pg = tcgetpgrp(childFd)
                capturedPgrp = pg > 0 ? pg : 0
            } else {
                capturedPgrp = 0
            }

            terminalView.process.terminate()

            if capturedPgrp > 0 {
                kill(-capturedPgrp, SIGHUP)
                kill(-capturedPgrp, SIGTERM)
            }

            // Escalation: SIGKILL after 3s, force state transition after 5s
            // only if the process is confirmed dead or we have no way to check.
            let gen = session.generation
            escalationTask?.cancel()
            escalationTask = Task { [weak self] in
                try? await Task.sleep(for: .seconds(3))
                guard let self, session.processState == .terminating, session.generation == gen else { return }

                if capturedPgrp > 0 {
                    // Liveness check before SIGKILL. kill(-pgrp, 0) confirms a living
                    // process in this group on Darwin (zombies are not group members).
                    // A small PGID-reuse window exists (~5s) but is acceptable for
                    // escalation; the generation guard already prevents state corruption.
                    if kill(-capturedPgrp, 0) == 0 {
                        kill(-capturedPgrp, SIGKILL)
                    }
                }

                try? await Task.sleep(for: .seconds(2))
                guard session.processState == .terminating, session.generation == gen else { return }

                // Only force state transition if process is confirmed dead or unreachable
                let processStillAlive = capturedPgrp > 0 && kill(-capturedPgrp, 0) == 0
                if processStillAlive {
                    session.markFailed("Process did not respond to termination signals")
                } else {
                    session.didTerminate(forGeneration: gen)
                }
            }
        }

        func resetIfRequested() {
            guard session.resetRequested else { return }
            session.resetRequested = false
            guard session.processState == .running else { return }
            let resetSequence: [UInt8] = [0x1B, 0x63]
            terminalView.send(resetSequence)
        }

        func sendPendingCommandIfReady() {
            guard session.processState == .running,
                  let command = session.pendingCommand else { return }
            session.pendingCommand = nil
            terminalView.send(txt: command)
        }

        func cleanup() {
            escalationTask?.cancel()
            escalationTask = nil
            activeProcessGeneration = 0

            let childFd = terminalView.process.childfd
            var pgrp: pid_t = 0
            if childFd >= 0 {
                let pg = tcgetpgrp(childFd)
                if pg > 0 { pgrp = pg }
            }

            if terminalView.process.running {
                terminalView.process.terminate()
                if pgrp > 0 {
                    kill(-pgrp, SIGHUP)
                    kill(-pgrp, SIGTERM)
                    kill(-pgrp, SIGKILL)
                }
            }
            // No detached SIGKILL — synchronous SIGKILL above is sufficient.
            // Detached tasks on raw PGIDs risk killing reused process groups.
            terminalView.processDelegate = nil
            session.reset()
            isTerminationInFlight = false
        }

        // MARK: - LocalProcessTerminalViewDelegate

        nonisolated func processTerminated(source: TerminalView, exitCode: Int32?) {
            Task { @MainActor [weak self] in
                guard let self else { return }
                escalationTask?.cancel()
                escalationTask = nil
                let gen = activeProcessGeneration
                activeProcessGeneration = 0
                isTerminationInFlight = false
                let code = exitCode ?? -1
                if session.processState == .terminating {
                    // Intentional termination — do NOT call onProcessExit.
                    // Restart logic is handled by the caller that requested
                    // termination (sendPromptToTerminal, restartTerminal, etc.)
                    session.didTerminate(forGeneration: gen)
                } else if gen == session.generation {
                    // Unexpected exit — notify parent for auto-restart/crash-loop.
                    // Guard on generation match: stale callbacks from old processes
                    // must not trigger crash-loop counting on the current session.
                    session.didExit(code, forGeneration: gen)
                    onProcessExit?(code)
                }
                // else: stale generation — ignored (didExit would also ignore)
            }
        }

        nonisolated func sizeChanged(source: LocalProcessTerminalView, newCols: Int, newRows: Int) {
            // SwiftTerm handles PTY resize internally
        }

        nonisolated func setTerminalTitle(source: LocalProcessTerminalView, title: String) {
            // Could update window title if desired
        }

        nonisolated func hostCurrentDirectoryUpdate(source: TerminalView, directory: String?) {
            // Could track current directory if desired
        }
    }
}
