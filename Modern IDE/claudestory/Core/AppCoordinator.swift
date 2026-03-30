import SwiftUI

// MARK: - Project Lifecycle

enum ProjectLifecycle: Equatable {
    case opening
    case open
}

// MARK: - App Coordinator

/// App-level registry tracking which projects are open and mediating
/// between project windows and the welcome window.
///
/// Each project window registers/deregisters with the coordinator.
/// The coordinator does NOT own ProjectViewModels — each window
/// owns its own via @State.
///
/// Implicitly `@MainActor` (project setting). All methods are serialized
/// on the main actor — no concurrency races.
@Observable
final class AppCoordinator {

    // MARK: - Init

    private let scanner: any DependencyScanning

    init(scanner: any DependencyScanning = DependencyScanner()) {
        self.scanner = scanner
        bookmarkStore.migrateFromUserDefaults()
    }

    // MARK: - Dependency State

    /// Current dependency scan status.
    private(set) var dependencyStatus: DependencyStatus = {
        var status = DependencyStatus.empty
        status.limitedModeAcknowledged = AppSettings.limitedModeAcknowledged
        status.lastAcknowledgedMissingHash = AppSettings.lastAcknowledgedMissingHash
        return status
    }()

    /// Lifecycle of the dependency scan.
    private(set) var dependencyScanState: DependencyScanState = .idle

    /// One-shot guard — only the first caller runs the scan.
    @ObservationIgnored private var hasPerformedInitialScan = false

    /// Generation counter — incremented on each new scan to discard stale results.
    @ObservationIgnored private var scanGeneration = 0

    /// Number of scans currently in flight. When a stale scan is discarded and this
    /// reaches 0, dependencyScanState is reset to .ready to avoid stuck .scanning state.
    @ObservationIgnored private var scansInFlight = 0

    /// Run the initial dependency scan. Safe to call multiple times — only first executes.
    func performInitialScan() async {
        guard !hasPerformedInitialScan else { return }
        hasPerformedInitialScan = true
        Log.info("initial dependency scan starting", tag: "Coordinator")
        let gen = scanGeneration
        scansInFlight += 1
        dependencyScanState = .scanning
        var status = await scanner.scanWithVersions()
        scansInFlight -= 1
        guard gen == scanGeneration else {
            Log.debug("initial scan stale (gen \(gen) != \(scanGeneration)), discarding", tag: "Coordinator")
            if scansInFlight == 0 { dependencyScanState = .ready }
            return
        }
        status.limitedModeAcknowledged = AppSettings.limitedModeAcknowledged
        status.lastAcknowledgedMissingHash = AppSettings.lastAcknowledgedMissingHash
        dependencyStatus = status
        dependencyScanState = .ready
        let found = status.results.filter(\.isFound).count
        Log.info("initial scan complete: \(found)/\(status.results.count) tools found, needsWizard=\(status.needsWizard)", tag: "Coordinator")
    }

    /// Explicit re-scan (e.g., from Settings "Re-check" button). No one-shot guard.
    /// Increments scan generation so any in-flight scan discards its stale results.
    func recheckDependencies() async {
        scanGeneration += 1
        let gen = scanGeneration
        scansInFlight += 1
        Log.debug("recheck dependencies (gen \(gen))", tag: "Coordinator")
        dependencyScanState = .scanning
        var status = await scanner.scanWithVersions()
        scansInFlight -= 1
        guard gen == scanGeneration else {
            Log.debug("recheck stale (gen \(gen) != \(scanGeneration)), discarding", tag: "Coordinator")
            if scansInFlight == 0 { dependencyScanState = .ready }
            return
        }
        status.limitedModeAcknowledged = dependencyStatus.limitedModeAcknowledged
        status.lastAcknowledgedMissingHash = dependencyStatus.lastAcknowledgedMissingHash
        dependencyStatus = status
        dependencyScanState = .ready
    }

    /// Acknowledge limited mode — persist to UserDefaults.
    func acknowledgeLimitedMode() {
        Log.info("limited mode acknowledged", tag: "Coordinator")
        dependencyStatus.limitedModeAcknowledged = true
        dependencyStatus.lastAcknowledgedMissingHash = dependencyStatus.missingRequiredHash
        AppSettings.limitedModeAcknowledged = true
        AppSettings.lastAcknowledgedMissingHash = dependencyStatus.missingRequiredHash
    }

    // MARK: - State

    /// Canonical path → lifecycle phase. Tracks projects that are loading (.opening)
    /// or fully loaded (.open).
    private(set) var projectStates: [String: ProjectLifecycle] = [:]

    /// Tracks blank picker/error windows that have no valid project yet.
    /// Using Set<ObjectIdentifier> is self-healing — no counter drift.
    private var transientWindowIDs: Set<ObjectIdentifier> = []

    /// Set to true after app launch restoration is complete (or after a timeout).
    /// Prevents the welcome window from flashing during app startup.
    var restorationComplete: Bool = false

    /// Persistent recent projects store. Provides bookmark-based directory
    /// rename resilience and recent project tracking.
    let bookmarkStore = ProjectBookmarkStore()

    /// Persistent workspace store. Saves/loads the set of currently open projects
    /// for restoration on relaunch (T-072).
    let workspacePersistence = WorkspacePersistence()

    /// Metadata for pending opens — URL + display name captured at registerOpening time.
    /// Used by projectDidOpen to persist the correct bookmark entry.
    @ObservationIgnored private var pendingOpenMetadata: [String: (url: URL, displayName: String)] = [:]

    /// One-shot guard: restoreWorkspace() executes only once per app launch.
    @ObservationIgnored private var workspaceRestoreExecuted = false

    /// True after restoreWorkspace() has executed. Read by empty-path scenes
    /// to decide whether to close themselves (they're unnecessary if projects exist).
    var workspaceRestoreComplete: Bool { workspaceRestoreExecuted }

    // MARK: - Computed

    var shouldShowWelcome: Bool {
        projectStates.isEmpty && transientWindowIDs.isEmpty && restorationComplete
    }

    var openProjectCount: Int { projectStates.count }
    var transientSceneCount: Int { transientWindowIDs.count }

    // MARK: - Project Lifecycle

    /// Register a project as `.opening`. Returns false if the path is already
    /// `.opening` or `.open` (duplicate detection). Caller should bring the
    /// existing window to front instead.
    @discardableResult
    func registerOpening(url: URL, displayName: String? = nil) -> Bool {
        let path = ProjectIdentityService.canonicalize(url: url)
        guard projectStates[path] == nil else { return false }
        projectStates[path] = .opening
        pendingOpenMetadata[path] = (url: url, displayName: displayName ?? url.lastPathComponent)
        return true
    }

    /// Rollback a failed open — removes only if still in `.opening` state.
    /// Does not remove `.open` entries (those require `projectDidClose`).
    func unregisterOpening(url: URL) {
        let path = ProjectIdentityService.canonicalize(url: url)
        if projectStates[path] == .opening {
            projectStates.removeValue(forKey: path)
            pendingOpenMetadata.removeValue(forKey: path)
        }
    }

    /// Transition `.opening` → `.open`. No-op if path is not in `.opening` state,
    /// which prevents reinsertion after `projectDidClose` has already removed it
    /// (close-during-loading race). Also persists the project to the bookmark store.
    func projectDidOpen(canonicalPath: String, displayName: String? = nil) {
        guard projectStates[canonicalPath] == .opening else { return }
        projectStates[canonicalPath] = .open

        // Persist to bookmark store using metadata captured at registerOpening time.
        // When displayName is provided (from config.json), prefer it over the directory name
        // stored in pendingOpenMetadata.
        if let metadata = pendingOpenMetadata.removeValue(forKey: canonicalPath) {
            let name = displayName ?? metadata.displayName
            bookmarkStore.addRecent(url: metadata.url, displayName: name)
        }

        persistWorkspace()
    }

    /// Remove a project from tracking. Handles both `.opening` and `.open` states,
    /// covering close-during-loading scenarios.
    func projectDidClose(canonicalPath: String) {
        projectStates.removeValue(forKey: canonicalPath)
        pendingOpenMetadata.removeValue(forKey: canonicalPath)
        persistWorkspace()
    }

    /// Returns true only if the path is currently in `.opening` state.
    /// Used as a guard before calling `projectDidOpen` to prevent reinsertion.
    func isStillOpening(canonicalPath: String) -> Bool {
        projectStates[canonicalPath] == .opening
    }

    // MARK: - Transient Window Tracking

    func transientSceneAppeared(windowID: ObjectIdentifier) {
        transientWindowIDs.insert(windowID)
    }

    func transientSceneGone(windowID: ObjectIdentifier) {
        transientWindowIDs.remove(windowID)
    }

    // MARK: - Workspace Persistence (T-072)

    /// Save the current set of tracked projects to workspace.json.
    /// Skipped during app quit (isTerminating flag) to prevent workspace emptying
    /// as windows close one by one. Saves both .opening and .open entries —
    /// .opening represents committed intent and prevents data loss on crash.
    private func persistWorkspace() {
        guard !AppDelegate.isTerminating else { return }

        var entries: [WorkspacePersistence.WorkspaceEntry] = []
        for (path, _) in projectStates {
            // Prefer bookmark from bookmarkStore (freshest), fallback to creating from path
            let bookmarkData: Data
            if let recent = bookmarkStore.recents.first(where: { $0.canonicalPath == path }) {
                bookmarkData = recent.bookmarkData
            } else if let created = try? URL(fileURLWithPath: path).bookmarkData(
                options: [],
                includingResourceValuesForKeys: nil,
                relativeTo: nil
            ) {
                bookmarkData = created
            } else {
                continue // Skip entries where bookmark creation fails
            }
            entries.append(.init(canonicalPath: path, bookmarkData: bookmarkData))
        }

        workspacePersistence.saveWorkspace(entries)
    }

    /// Restore workspace entries that SwiftUI failed to restore on relaunch.
    /// One-shot: only the first call executes; subsequent calls return [].
    /// Returns canonical paths that should be opened via openWindow.
    ///
    /// Race note: if called before all SwiftUI-restored scenes register in
    /// projectStates, this may return paths for windows SwiftUI already restored.
    /// This is safe: WindowGroup(for:String.self) enforces one-window-per-value,
    /// so duplicate openWindow brings the existing window to front (no-op).
    func restoreWorkspace() -> [String] {
        guard !workspaceRestoreExecuted else { return [] }
        workspaceRestoreExecuted = true

        guard AppSettings.restoreOnLaunch else { return [] }

        let entries = workspacePersistence.loadWorkspace()
        var pathsToOpen: [String] = []

        for entry in entries {
            // Resolve bookmark — validates .story/ exists, handles moved dirs
            guard let resolvedURL = workspacePersistence.resolveEntry(entry) else {
                continue // Stale/missing — skip silently
            }

            let canonical = ProjectIdentityService.canonicalize(url: resolvedURL)

            // Skip if SwiftUI already restored this project (any lifecycle state)
            guard projectStates[canonical] == nil else { continue }

            // Register and collect for opening
            registerOpening(url: resolvedURL)
            pathsToOpen.append(canonical)
        }

        return pathsToOpen
    }

    /// Merge all project windows into a single tab group.
    /// Called after workspace restoration opens multiple windows as separate NSWindows.
    /// macOS automatic tabbing doesn't apply to programmatic openWindow() calls,
    /// so we merge explicitly using NSWindow.addTabbedWindow(_:ordered:).
    func mergeRestoredWindowsIntoTabs() {
        let projectWindows = NSApplication.shared.windows.filter { window in
            // Project windows have tabbingMode .preferred (set by WindowLifecycleBridge).
            // Welcome window and other system windows don't.
            window.tabbingMode == .preferred && window.isVisible
        }
        guard projectWindows.count > 1 else { return }

        let anchor = projectWindows[0]
        for window in projectWindows.dropFirst() {
            // Only merge if the window isn't already in the anchor's tab group
            if window.tabGroup !== anchor.tabGroup {
                anchor.addTabbedWindow(window, ordered: .above)
            }
        }
        // Select the first tab
        anchor.makeKeyAndOrderFront(nil)
    }

    // MARK: - Shared Open Flow

    /// Shared open-project-from-picker flow used by both Cmd+N and WelcomeView.
    /// Shows directory picker, registers with coordinator, returns canonical path.
    /// Returns nil if user cancelled or project has a broken .story/.
    /// Uninitialized projects (no .story/) are allowed through without registration —
    /// ProjectSceneView will offer a setup sheet and register after init succeeds.
    func openProjectFromPicker() async -> String? {
        do {
            let url = try await ProjectIdentityService.showDirectoryPicker()
            let canonical = ProjectIdentityService.canonicalize(url: url)
            switch ProjectIdentityService.classifyProject(at: url) {
            case .ready:
                registerOpening(url: url)
                return canonical
            case .uninitialized:
                // Don't register — ProjectSceneView handles setup + registration after init
                return canonical
            case .broken:
                return nil
            }
        } catch {
            return nil
        }
    }
}
