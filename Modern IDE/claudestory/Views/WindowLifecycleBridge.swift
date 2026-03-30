import SwiftUI

// MARK: - Window Lifecycle Bridge

/// NSViewRepresentable that bridges AppKit window lifecycle events to SwiftUI.
///
/// Inserted once per project scene (in ProjectSceneView). Provides:
/// - Reliable window close detection via `NSWindow.willCloseNotification`
///   (replaces `.onDisappear` which fires on transient SwiftUI hierarchy changes)
/// - Window title management for native tab bar display
/// - Per-window `tabbingMode = .preferred` configuration
/// - Window identity tracking via `onWindowAvailable` callback
struct WindowLifecycleBridge: NSViewRepresentable {
    var windowTitle: String?
    var onWindowClose: (() -> Void)?
    var onWindowAvailable: ((NSWindow) -> Void)?
    /// Callback to expose the coordinator's closeWindow capability to the parent view.
    var onCoordinatorReady: ((Coordinator) -> Void)?

    func makeNSView(context: Context) -> BridgeView {
        let view = BridgeView()
        view.coordinator = context.coordinator
        onCoordinatorReady?(context.coordinator)
        return view
    }

    func updateNSView(_ nsView: BridgeView, context: Context) {
        let coordinator = context.coordinator
        coordinator.onWindowClose = onWindowClose
        coordinator.onWindowAvailable = onWindowAvailable
        coordinator.desiredTitle = windowTitle
        // NOTE: onCoordinatorReady is NOT called here — it fires once from makeNSView.
        // Calling it on every update would mutate @State during view evaluation,
        // which is undefined behavior and corrupts SwiftUI's window/scene mapping.

        // Update title on the already-bound window if it changed
        if let title = windowTitle, let window = coordinator.currentWindow {
            window.title = title
            window.tab.title = title
        }
    }

    static func dismantleNSView(_ nsView: BridgeView, coordinator: Coordinator) {
        coordinator.unsubscribe()
    }

    func makeCoordinator() -> Coordinator {
        Coordinator()
    }

    // MARK: - Coordinator

    class Coordinator {
        weak var currentWindow: NSWindow?
        var onWindowClose: (() -> Void)?
        var onWindowAvailable: ((NSWindow) -> Void)?
        var desiredTitle: String?
        private var closeObserver: NSObjectProtocol?
        /// Flag to close window immediately when it becomes available.
        /// Set when closeWindow() is called before the view is attached to a window.
        var pendingClose = false

        func windowDidChange(_ window: NSWindow?) {
            guard window !== currentWindow else { return }

            // Unsubscribe from old window
            if currentWindow != nil {
                unsubscribe()
            }

            currentWindow = window

            guard let window else { return }

            // Configure window
            window.tabbingMode = .preferred
            window.titleVisibility = .hidden
            window.backgroundColor = NSColor(name: nil) { appearance in
                if appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua {
                    NSColor(hue: 25/360, saturation: 0.15, brightness: 0.13, alpha: 1.0)
                } else {
                    NSColor(hue: 36/360, saturation: 0.18, brightness: 0.92, alpha: 1.0)
                }
            }
            if let title = desiredTitle {
                window.title = title
                window.tab.title = title
            }

            // Subscribe to close notification for THIS specific window
            closeObserver = NotificationCenter.default.addObserver(
                forName: NSWindow.willCloseNotification,
                object: window,
                queue: .main
            ) { [weak self] _ in
                self?.onWindowClose?()
                self?.unsubscribe()
            }

            // Notify parent
            onWindowAvailable?(window)

            // Handle pending close
            if pendingClose {
                pendingClose = false
                window.close()
            }
        }

        /// Close the specific NSWindow this bridge is attached to.
        /// If not yet attached, sets pendingClose so the window is closed immediately on attach.
        func closeWindow() {
            if let window = currentWindow {
                window.close()
            } else {
                pendingClose = true
            }
        }

        func unsubscribe() {
            if let observer = closeObserver {
                NotificationCenter.default.removeObserver(observer)
                closeObserver = nil
            }
            currentWindow = nil
        }

        deinit {
            if let observer = closeObserver {
                NotificationCenter.default.removeObserver(observer)
            }
        }
    }

    // MARK: - Bridge View

    /// Custom NSView that reports window changes to the coordinator.
    class BridgeView: NSView {
        weak var coordinator: Coordinator?

        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            coordinator?.windowDidChange(window)
        }
    }
}
