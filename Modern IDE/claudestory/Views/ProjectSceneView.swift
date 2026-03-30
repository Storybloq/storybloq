import SwiftUI
import Fabric

// MARK: - Project Scene View

/// Two-phase router: shows either ProjectWindowView (valid project) or
/// ProjectPickerView (blank/empty path). Owns the single WindowLifecycleBridge
/// per window and manages close handler lifecycle.
///
/// Close handler pattern:
/// - ProjectWindowView registers its viewModel.closeProject() via onRegisterCloseProject callback
/// - The close handler ALWAYS includes coordinator cleanup
/// - When activeCloseProject is set (viewModel registered), it's called too
/// - This eliminates the timing gap where a fallback handler could skip PTY cleanup
struct ProjectSceneView: View {
    @Binding var canonicalPath: String
    @Environment(AppCoordinator.self) private var coordinator
    @Environment(\.openWindow) private var openWindow

    /// Closure that calls viewModel.closeProject(). Set by ProjectWindowView via callback.
    /// When set, the close handler includes explicit PTY shutdown.
    @State private var activeCloseProject: (() -> Void)?

    /// ObjectIdentifier of the NSWindow hosting this scene. Used for transient tracking.
    @State private var currentWindowID: ObjectIdentifier?

    /// Reference to the bridge coordinator for closing the specific window.
    @State private var bridgeCoordinator: WindowLifecycleBridge.Coordinator?

    /// Set when cancelPicker() is called before bridgeCoordinator is available.
    @State private var pendingCancel = false

    /// Project display name from config.json, set by ProjectWindowView callback.
    /// When nil, windowTitle falls back to directory name.
    @State private var projectDisplayName: String?

    /// Set to true after restoration remap completes. Prevents ProjectWindowView
    /// from loading with a stale path before remap finishes.
    @State private var restorationResolved = false

    @State private var showError = false
    @State private var errorMessage = ""

    /// URL for a directory that needs .story/ setup. Set when pickProject encounters .uninitialized.
    @State private var setupURL: URL?
    @State private var showSetupSheet = false

    private var hasValidPath: Bool { !canonicalPath.isEmpty }
    /// Only show ProjectWindowView after restoration remap has completed.
    private var readyForProject: Bool { hasValidPath && restorationResolved }

    var body: some View {
        ZStack {
            WindowLifecycleBridge(
                windowTitle: windowTitle,
                onWindowClose: { handleWindowClose() },
                onWindowAvailable: { window in
                    handleWindowChange(newWindow: window)
                },
                onCoordinatorReady: { coord in
                    bridgeCoordinator = coord
                    if pendingCancel {
                        pendingCancel = false
                        coord.closeWindow()
                    }
                }
            )

            if readyForProject {
                ProjectWindowView(
                    canonicalPath: canonicalPath,
                    onRegisterCloseProject: { closeProjectFn in
                        activeCloseProject = closeProjectFn
                    },
                    onProjectNameChanged: { path, name in
                        guard path == canonicalPath else { return }
                        projectDisplayName = name
                    }
                )
                .id(canonicalPath)
            } else if hasValidPath && !restorationResolved {
                ProgressView()
                    .controlSize(.large)
            } else {
                ProjectPickerView(
                    onPick: { url in pickProject(url) },
                    onCancel: { cancelPicker() }
                )
            }
        }
        .frame(minWidth: 600, minHeight: 400)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .fabricSurface(StoryTheme.base)
        .toolbarBackground(StoryTheme.base, for: .windowToolbar)
        .toolbarBackgroundVisibility(.visible, for: .windowToolbar)
        .task {
            // 1. Mark app restoration complete (same position as original code).
            //    Workspace restore is gated by its own workspaceRestoreExecuted flag.
            if !coordinator.restorationComplete {
                coordinator.restorationComplete = true
            }

            // 2. Resolve SwiftUI-restored path (bookmark remap for moved dirs)
            if hasValidPath && !restorationResolved {
                resolveRestoredPath()
            } else {
                restorationResolved = true
            }

            // 3. Workspace restoration — opens projects SwiftUI failed to restore.
            //    Guarded: only the first scene to reach this point executes.
            //    Race note: if this scene's .task fires before other SwiftUI-restored
            //    scenes register, restoreWorkspace may call openWindow for paths SwiftUI
            //    already restored. This is SAFE: WindowGroup(for:String.self) enforces
            //    one-window-per-value, so duplicate openWindow brings to front (no-op).
            //    resolveRestoredPath ignores registerOpening's return value (@discardableResult).
            let pathsToRestore = coordinator.restoreWorkspace()
            for path in pathsToRestore {
                openWindow(id: "project", value: path)
            }

            // 4. Merge restored windows into native macOS tab group, then close
            //    the empty-path tab. Order matters: merge first so all windows are
            //    in one group, then close the unnecessary empty tab.
            //    openWindow() creates independent windows; macOS automatic tabbing
            //    doesn't apply to programmatic calls. Merge explicitly after a brief
            //    delay to let windows materialize.
            //
            //    IMPORTANT: Only close empty tabs that were created AS PART OF restoration.
            //    User-initiated new tabs (Cmd+T / "+" button) also start with empty path
            //    but must NOT be auto-closed. We detect restoration-phase tabs by checking
            //    if pathsToRestore is non-empty (this .task is closing itself to make room
            //    for the restored windows it just opened).
            let shouldCloseEmpty = canonicalPath.isEmpty && !pathsToRestore.isEmpty

            if !pathsToRestore.isEmpty {
                try? await Task.sleep(for: .milliseconds(500))
                coordinator.mergeRestoredWindowsIntoTabs()
            }

            // 5. Close this empty-path tab AFTER merge completes.
            if shouldCloseEmpty {
                // Brief delay to let the merge settle before closing a tab
                if !pathsToRestore.isEmpty {
                    try? await Task.sleep(for: .milliseconds(200))
                }
                closeThisWindow()
            }
        }
        .task {
            // T-152: Trigger dependency scan — structured, lifecycle-tied, separate from restoration.
            await coordinator.performInitialScan()
        }
        .onChange(of: canonicalPath) { old, new in
            handlePathTransition(old: old, new: new)
        }
        .alert("Error", isPresented: $showError) {
            Button("OK") { }
        } message: {
            Text(errorMessage)
        }
        .sheet(isPresented: $showSetupSheet) {
            if let url = setupURL {
                ProjectSetupSheet(
                    viewModel: ProjectSetupViewModel(projectURL: url),
                    onComplete: {
                        // Re-classify — should now be .ready after CLI init
                        pickProject(url)
                    }
                )
            }
        }
    }

    // MARK: - Computed

    private var windowTitle: String? {
        guard hasValidPath else { return "claudestory" }
        return projectDisplayName ?? URL(fileURLWithPath: canonicalPath).lastPathComponent
    }

    // MARK: - Close Handler

    /// Single close handler for all scenarios. Called by WindowLifecycleBridge
    /// on NSWindow.willCloseNotification.
    private func handleWindowClose() {
        if hasValidPath {
            // Project phase: clean up viewModel (PTY processes) + coordinator
            activeCloseProject?()
            coordinator.projectDidClose(canonicalPath: canonicalPath)
        } else {
            // Transient phase: just clean up coordinator tracking
            if let id = currentWindowID {
                coordinator.transientSceneGone(windowID: id)
            }
        }
    }

    // MARK: - Window Management

    private func handleWindowChange(newWindow: NSWindow) {
        let newID = ObjectIdentifier(newWindow)

        // Reconcile old/new IDs for tear-off/merge
        if let oldID = currentWindowID, oldID != newID {
            coordinator.transientSceneGone(windowID: oldID)
        }

        currentWindowID = newID

        // Register as transient if still in picker phase
        if !hasValidPath {
            coordinator.transientSceneAppeared(windowID: newID)
        }
    }

    private func handlePathTransition(old: String, new: String) {
        projectDisplayName = nil  // Always reset — prevents stale title during remap or switch
        if old.isEmpty && !new.isEmpty {
            // Transition transient → project
            if let id = currentWindowID {
                coordinator.transientSceneGone(windowID: id)
            }
            // Pre-install a defensive close callback. If the window closes between
            // this onChange and ProjectWindowView.onAppear, the viewModel's .task
            // hasn't fired yet — no FileWatcher, no terminals, no resources to clean.
            // This no-op closure prevents handleWindowClose from having a nil path.
            // ProjectWindowView.onAppear will overwrite it with the real closeProject().
            activeCloseProject = { /* viewModel not yet loaded — nothing to close */ }
        } else if !old.isEmpty && new.isEmpty {
            // Transition project → transient (e.g., restored project lost .story/)
            coordinator.projectDidClose(canonicalPath: old)
            activeCloseProject = nil
            if let id = currentWindowID {
                coordinator.transientSceneAppeared(windowID: id)
            }
        }
    }

    // MARK: - Restoration

    /// Resolve a restored canonical path via bookmark store, handling moved/renamed dirs.
    /// Falls back to direct path validation. Clears to picker on failure.
    private func resolveRestoredPath() {
        // Try bookmark-based resolution (handles renames/moves)
        if let resolvedURL = coordinator.bookmarkStore.resolveBookmark(for: canonicalPath) {
            let newCanonical = ProjectIdentityService.canonicalize(url: resolvedURL)
            if newCanonical != canonicalPath {
                // Directory was moved — update the scene's path binding
                canonicalPath = newCanonical
            }
            // Register with coordinator
            coordinator.registerOpening(url: resolvedURL)
            restorationResolved = true
            return
        }

        // Fallback: try the path directly
        let directURL = URL(fileURLWithPath: canonicalPath)
        switch ProjectIdentityService.classifyProject(at: directURL) {
        case .ready:
            coordinator.registerOpening(url: directURL)
            restorationResolved = true
        case .uninitialized:
            // Restored project lost its .story/ — offer setup
            setupURL = directURL
            showSetupSheet = true
            canonicalPath = ""
            restorationResolved = true
        case .broken:
            // Invalid restored path — clear to picker state
            canonicalPath = ""
            restorationResolved = true
        }
    }

    // MARK: - Actions

    private func pickProject(_ url: URL) {
        switch ProjectIdentityService.classifyProject(at: url) {
        case .uninitialized:
            setupURL = url
            showSetupSheet = true
        case .ready:
            guard coordinator.registerOpening(url: url) else {
                // Already open — SwiftUI's one-window-per-value will bring to front
                return
            }
            canonicalPath = ProjectIdentityService.canonicalize(url: url)
        case .broken(let message):
            errorMessage = message
            showError = true
        }
    }

    /// Close this window: deregister transient tracking, close via bridge.
    /// Uses pendingCancel if bridge isn't ready yet (same pattern for picker cancel
    /// and workspace-restore empty-window dismissal).
    private func closeThisWindow() {
        if let id = currentWindowID {
            coordinator.transientSceneGone(windowID: id)
        }
        if let coord = bridgeCoordinator {
            coord.closeWindow()
        } else {
            // Bridge not yet ready — set flag so onCoordinatorReady closes the window
            pendingCancel = true
        }
    }

    private func cancelPicker() {
        closeThisWindow()
    }
}
