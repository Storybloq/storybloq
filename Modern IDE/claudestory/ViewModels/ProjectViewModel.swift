import Foundation

// MARK: - ProjectViewModel

/// Central coordinator connecting the data layer (ProjectLoader, FileWatcher) to the UI.
///
/// Owns loader + file watcher. Exposes `ProjectState` to views. Handles project open/close
/// lifecycle, reload on file change, error state propagation.
///
/// **Thread safety:** Implicitly `@MainActor` (project setting). All property access and
/// methods are MainActor-isolated. `loadTask` provides cooperative cancellation to prevent
/// overlapping loads and stale writes after `closeProject()`.
@Observable
final class ProjectViewModel {

    // MARK: - Observable State (drives UI)

    private(set) var state: ProjectState = .placeholder
    private(set) var warnings: [LoadWarning] = []
    private(set) var isLoading: Bool = false
    private(set) var loadError: String?

    /// True when the load error is specifically "Missing .story/ directory."
    var isMissingStoryDir: Bool {
        loadError == ProjectLoaderError.missingStoryDir.errorDescription
    }

    // MARK: - Reorder (Optimistic Update)

    /// Reorder board items with optimistic state update for smooth animation.
    /// Builds a new ProjectState synchronously (drives SwiftUI animation),
    /// then persists each change to disk. FileWatcher reload reconciles.
    func reorderItems(
        _ changes: [(id: String, newOrder: Int, isTicket: Bool)],
        statusChange: (id: String, newTicketStatus: TicketStatus?,
                       newIssueStatus: IssueStatus?,
                       completedDate: String??, resolvedDate: String??)? = nil
    ) {
        let changeMap = Dictionary(changes.map { ($0.id, $0.newOrder) }, uniquingKeysWith: { _, b in b })

        // 1. Optimistic state update (immediate — drives animation)
        let updatedTickets = state.tickets.map { ticket -> Ticket in
            var t = ticket
            if let newOrder = changeMap[ticket.id] {
                t = t.with(order: newOrder)
            }
            if let sc = statusChange, sc.id == ticket.id, let newStatus = sc.newTicketStatus {
                t = t.with(status: newStatus, completedDate: sc.completedDate)
            }
            return t
        }
        let updatedIssues = state.issues.map { issue -> Issue in
            var i = issue
            if let newOrder = changeMap[issue.id] {
                i = i.with(order: newOrder)
            }
            if let sc = statusChange, sc.id == issue.id, let newStatus = sc.newIssueStatus {
                i = i.with(status: newStatus, resolvedDate: sc.resolvedDate)
            }
            return i
        }
        state = ProjectState(
            tickets: updatedTickets, issues: updatedIssues,
            roadmap: state.roadmap, config: state.config,
            handoverFilenames: state.handoverFilenames
        )

        // 2. Persist via CLI in background
        // Optimistic update is already applied above. CLI calls run async.
        // FileWatcher debounce (0.25s) ensures exactly ONE reload after the batch.
        guard let writer = storyWriter else { return }

        // Snapshot the items to write (from the already-updated optimistic state)
        var itemsToWrite: [(id: String, isTicket: Bool)] = changes.map { ($0.id, $0.isTicket) }
        if let sc = statusChange, !changeMap.keys.contains(sc.id) {
            let isTicket = state.ticket(byID: sc.id) != nil
            itemsToWrite.append((sc.id, isTicket))
        }

        Task { [weak self, state] in
            var hadFailure = false
            for item in itemsToWrite {
                do {
                    if item.isTicket, let ticket = state.ticket(byID: item.id) {
                        _ = try await writer.updateTicket(ticket)
                    } else if !item.isTicket, let issue = state.issue(byID: item.id) {
                        _ = try await writer.updateIssue(issue)
                    }
                } catch {
                    self?.loadError = "Failed to save \(item.id): \(error.localizedDescription)"
                    hadFailure = true
                }
            }
            if hadFailure { self?.reload() }
        }
    }

    // MARK: - Terminal

    let terminalTabManager = TerminalTabManager()

    // MARK: - Dependencies (not observed)

    @ObservationIgnored private let loader: any ProjectLoading
    @ObservationIgnored private let fileWatcher: any FileWatching
    @ObservationIgnored private var storyWriter: (any StoryWriting)?
    /// Test override: if set, used instead of auto-creating CLIStoryWriter in performOpenProject.
    @ObservationIgnored private let storyWriterOverride: (any StoryWriting)?
    private(set) var projectURL: URL?
    @ObservationIgnored private var loadTask: Task<Void, Never>?

    // MARK: - Init

    init(
        loader: any ProjectLoading = ProjectLoader(),
        fileWatcher: any FileWatching = FileWatcher(),
        storyWriter: (any StoryWriting)? = nil
    ) {
        self.loader = loader
        self.fileWatcher = fileWatcher
        self.storyWriterOverride = storyWriter
    }

    /// Safety net: cancel in-flight async work on dealloc.
    /// Task.cancel() is safe from nonisolated context (Sendable).
    /// FileWatcher is NOT stopped here — it handles its own cleanup in its deinit.
    deinit {
        loadTask?.cancel()
        openProjectTask?.cancel()
    }

    // MARK: - Public API

    /// Begin loading a project from `url`. Starts FileWatcher on `.story/` subdirectory.
    ///
    /// If already watching a project, stops the previous watcher first. Safe to call multiple times.
    /// Awaits all terminal tab termination before proceeding to prevent process overlap.
    func openProject(at url: URL) {
        // Always cancel any in-flight project switch first
        openProjectTask?.cancel()
        openProjectTask = nil

        // Any tab not definitively dead needs coordinated shutdown.
        // .failed is included because it means the process didn't respond to
        // termination signals and may still be alive (markFailed is set when
        // SIGKILL escalation times out with process still running).
        let hasLiveTabs = terminalTabManager.tabs.contains {
            switch $0.session.processState {
            case .idle, .exited: false
            default: true  // .running, .launching, .terminating, .failed
            }
        }
        if hasLiveTabs {
            openProjectTask = Task { [weak self] in
                await self?.terminalTabManager.terminateAllAndAwait()
                guard !Task.isCancelled, let self else { return }
                performOpenProject(at: url)
            }
        } else {
            terminalTabManager.closeAllTabs()
            performOpenProject(at: url)
        }
    }

    @ObservationIgnored private var openProjectTask: Task<Void, Never>?

    private func performOpenProject(at url: URL) {
        loadTask?.cancel()
        fileWatcher.stop()

        projectURL = url
        storyWriter = storyWriterOverride ?? CLIStoryWriter(projectRoot: url)
        Log.info("storyWriter created for: \(url.path)", tag: "ViewModel")
        isLoading = true
        loadError = nil

        reload()

        fileWatcher.start(watching: url.appendingPathComponent(".story")) { [weak self] in
            self?.reload()
        }
    }

    /// Write an updated ticket via CLI. FileWatcher will trigger reload automatically.
    func updateTicket(_ ticket: Ticket) {
        guard let writer = storyWriter else { return }
        Task {
            do {
                _ = try await writer.updateTicket(ticket)
            } catch {
                loadError = "Failed to save ticket \(ticket.id): \(error.localizedDescription)"
            }
        }
    }

    // MARK: - Config Updates

    @ObservationIgnored private var configSaveTask: Task<Void, Never>?
    var configSaveError: String?

    /// Update recipe overrides with debounce. nil = clear (reset to defaults).
    func updateRecipeOverrides(_ overrides: Config.RecipeOverrides?) {
        configSaveTask?.cancel()
        guard let writer = storyWriter, let root = projectURL else { return }

        configSaveTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(1))
            guard !Task.isCancelled else { return }

            do {
                try await writer.setRecipeOverrides(overrides)
                self?.configSaveError = nil
            } catch {
                self?.configSaveError = "Failed to save config: \(error.localizedDescription)"
                self?.reload()
            }
            self?.configSaveTask = nil
        }
    }

    // MARK: - Issue Updates

    /// Write an updated issue via CLI. FileWatcher will trigger reload automatically.
    func updateIssue(_ issue: Issue) {
        guard let writer = storyWriter else { return }
        Task {
            do {
                _ = try await writer.updateIssue(issue)
            } catch {
                loadError = "Failed to save issue \(issue.id): \(error.localizedDescription)"
            }
        }
    }

    /// Delete a ticket via CLI. FileWatcher will trigger reload automatically.
    /// Refuses to delete if the ticket is referenced by blockers, children, or issues.
    func deleteTicket(id: String) {
        let blockers = state.ticketsBlocking(id)
        let children = state.childrenOf(id)
        let issueRefs = state.issuesReferencing(id)
        guard blockers.isEmpty, children.isEmpty, issueRefs.isEmpty else {
            var reasons: [String] = []
            if !blockers.isEmpty { reasons.append("blocks \(blockers.joined(separator: ", "))") }
            if !children.isEmpty { reasons.append("has children: \(children.joined(separator: ", "))") }
            if !issueRefs.isEmpty { reasons.append("referenced by \(issueRefs.joined(separator: ", "))") }
            loadError = "Cannot delete \(id): \(reasons.joined(separator: "; "))."
            return
        }
        guard let writer = storyWriter else { return }
        Task {
            do {
                try await writer.deleteTicket(id, force: true)
            } catch {
                loadError = "Failed to delete ticket \(id): \(error.localizedDescription)"
            }
        }
    }

    /// Delete an issue via CLI. FileWatcher will trigger reload automatically.
    /// No cross-reference check needed: per the data model, nothing points TO an issue.
    /// Issues point to tickets (via relatedTickets), but not the reverse.
    func deleteIssue(id: String) {
        guard let writer = storyWriter else { return }
        Task {
            do {
                try await writer.deleteIssue(id)
            } catch {
                loadError = "Failed to delete issue \(id): \(error.localizedDescription)"
            }
        }
    }

    // MARK: - Notes

    var isNotesVisible: Bool = false

    func toggleNotes() {
        isNotesVisible.toggle()
    }

    func createNote(content: String, title: String? = nil, tags: [String] = []) {
        Log.info("createNote title=\(title ?? "nil") tags=\(tags)", tag: "Notes")
        guard let writer = storyWriter else { return }
        Task {
            do {
                _ = try await writer.createNote(content: content, title: title, tags: tags)
            } catch {
                loadError = "Failed to create note: \(error.localizedDescription)"
            }
        }
    }

    func updateNote(
        id: String,
        content: String? = nil,
        title: String?? = nil,
        tags: [String]? = nil,
        clearTags: Bool = false,
        status: NoteStatus? = nil
    ) {
        Log.info("updateNote id=\(id) status=\(status?.rawValue ?? "nil")", tag: "Notes")
        guard let writer = storyWriter else { return }
        Task {
            do {
                _ = try await writer.updateNote(id, content: content, title: title, tags: tags, clearTags: clearTags, status: status)
            } catch {
                loadError = "Failed to update note \(id): \(error.localizedDescription)"
            }
        }
    }

    func deleteNote(id: String) {
        Log.info("deleteNote id=\(id)", tag: "Notes")
        guard let writer = storyWriter else { return }
        Task {
            do {
                try await writer.deleteNote(id)
            } catch {
                loadError = "Failed to delete note \(id): \(error.localizedDescription)"
            }
        }
    }

    func nextNoteID() -> String {
        let maxNum = state.notes
            .compactMap { note -> Int? in
                guard note.id.hasPrefix("N-") else { return nil }
                return Int(note.id.dropFirst(2))
            }
            .max() ?? 0
        return String(format: "N-%03d", maxNum + 1)
    }

    func createTicket(phase: PhaseID? = nil) {
        guard let writer = storyWriter else { return }
        Log.info("createTicket phase=\(phase?.rawValue ?? "nil")", tag: "Tickets")
        Task {
            do {
                _ = try await writer.createTicket(
                    title: "New ticket",
                    type: .task,
                    phase: phase,
                    description: "",
                    blockedBy: [],
                    parentTicket: nil
                )
            } catch {
                loadError = "Failed to create ticket: \(error.localizedDescription)"
            }
        }
    }

    /// Returns the next sequential ticket ID (e.g., "T-050" when max is "T-049").
    func nextTicketID() -> String {
        let maxNum = state.tickets
            .compactMap { id -> Int? in
                guard id.id.hasPrefix("T-") else { return nil }
                return Int(id.id.dropFirst(2))
            }
            .max() ?? 0
        return String(format: "T-%03d", maxNum + 1)
    }

    /// Returns the next sequential issue ID (e.g., "ISS-005" when max is "ISS-004").
    func nextIssueID() -> String {
        let maxNum = state.issues
            .compactMap { id -> Int? in
                guard id.id.hasPrefix("ISS-") else { return nil }
                return Int(id.id.dropFirst(4))
            }
            .max() ?? 0
        return String(format: "ISS-%03d", maxNum + 1)
    }

    /// Returns the next order value for items in a phase (or unphased items when nil).
    /// Considers both tickets and issues to prevent order collisions on the unified board.
    func nextBoardOrder(in phase: PhaseID?) -> Int {
        let tickets: [Ticket]
        let issues: [Issue]
        if let phase {
            tickets = state.phaseTickets(phase)
            issues = state.phaseIssues(phase)
        } else {
            tickets = state.leafTickets.filter { $0.phase == nil }
            issues = state.issues.filter { $0.phase == nil }
        }
        let ticketMax = tickets.map(\.order).max() ?? 0
        let issueMax = issues.map(\.order).max() ?? 0
        return max(ticketMax, issueMax) + 10
    }

    // MARK: - Terminal

    func showTerminal() {
        terminalTabManager.isVisible = true
        if terminalTabManager.tabs.isEmpty {
            terminalTabManager.addTab()
        }
        if let tab = terminalTabManager.activeTab {
            tab.consecutiveRapidExits = 0
            tab.lastExitTime = nil
            if tab.session.processState.canLaunch, let url = projectURL {
                tab.restartEpoch += 1
                if AppSettings.autoPromptEnabled {
                    tab.session.markForAutoPrompt()
                }
                tab.session.requestLaunch(projectRoot: url)
            }
        }
    }

    /// Send a prompt to the active terminal tab. Shows terminal if hidden,
    /// creates a tab if needed, launches if idle/exited.
    func sendPromptToTerminal(_ prompt: String) {
        if !terminalTabManager.isVisible {
            terminalTabManager.isVisible = true
        }
        if terminalTabManager.tabs.isEmpty {
            terminalTabManager.addTab()
        }
        guard let tab = terminalTabManager.activeTab else { return }

        if tab.session.processState.canLaunch, let url = projectURL {
            tab.restartEpoch += 1
            tab.session.setCustomAutoPrompt(prompt)
            tab.session.requestLaunch(projectRoot: url)
            return
        }
        if tab.session.processState == .terminating {
            // Already terminating from a previous helper — update the prompt
            // so the pending relaunch task uses the latest request.
            tab.session.setCustomAutoPrompt(prompt)
            return
        }
        // .launching: UI buttons are disabled, so this can't be reached by user
        // interaction. Accepted trade-off.
        guard tab.session.processState == .running else { return }
        // Terminate-and-relaunch: we don't know if PTY is at shell prompt or
        // Claude REPL. Terminate and relaunch via the safe env-var path.
        tab.session.setCustomAutoPrompt(prompt)
        tab.session.requestTerminate()
        tab.restartEpoch += 1
        let epoch = tab.restartEpoch
        let tabID = tab.id
        tab.restartTask?.cancel()
        tab.restartTask = Task { [weak self] in
            var attempts = 0
            while self?.terminalTabManager.tab(for: tabID)?.session.processState == .terminating,
                  attempts < 100 {
                do { try await Task.sleep(for: .milliseconds(100)) }
                catch { return }
                attempts += 1
            }
            guard !Task.isCancelled, let self,
                  let tab = terminalTabManager.tab(for: tabID),
                  tab.restartEpoch == epoch,
                  terminalTabManager.activeTabID == tabID,
                  terminalTabManager.isVisible,
                  tab.session.processState.canLaunch,
                  let url = projectURL else { return }
            tab.restartEpoch += 1
            tab.session.requestLaunch(projectRoot: url)
        }
    }


    func hideTerminal() {
        // Cancel ALL tabs' restart tasks and clear stale auto-prompts
        // to prevent background relaunches and stale helper prompts
        for tab in terminalTabManager.tabs {
            tab.restartTask?.cancel()
            tab.restartTask = nil
            tab.restartEpoch += 1
            tab.session.clearPendingAutoPrompt()
        }
        terminalTabManager.isVisible = false
    }

    func toggleTerminal() {
        if terminalTabManager.isVisible {
            hideTerminal()
        } else {
            showTerminal()
        }
    }

    func addTerminalTab() {
        let tab = terminalTabManager.addTab()
        terminalTabManager.isVisible = true
        if let url = projectURL, tab.session.processState.canLaunch {
            tab.session.requestLaunch(projectRoot: url)
        }
    }

    func closeTerminalTab(_ tabID: UUID) {
        terminalTabManager.closeTab(tabID)
        // If the new active tab exited while inactive, auto-restart it
        // (closeTab's neighbor selection bypasses switchToTab's auto-restart)
        if let newTab = terminalTabManager.activeTab,
           case .exited = newTab.session.processState,
           let url = projectURL {
            newTab.restartEpoch += 1
            newTab.session.requestLaunch(projectRoot: url)
        }
    }

    func switchToTab(_ tabID: UUID) {
        guard let tab = terminalTabManager.selectTab(tabID) else { return }
        // Reset crash-loop counters on explicit tab switch (same as showTerminal)
        tab.consecutiveRapidExits = 0
        tab.lastExitTime = nil
        // Auto-restart only if the tab exited unexpectedly while inactive.
        // .idle means intentional termination — don't auto-restart.
        // .failed means PTY survived SIGKILL — user must explicitly restart.
        if case .exited = tab.session.processState, let url = projectURL {
            tab.restartEpoch += 1
            tab.session.requestLaunch(projectRoot: url)
        }
    }

    func restartTerminal() {
        guard let tab = terminalTabManager.activeTab else { return }
        tab.restartTask?.cancel()
        tab.restartEpoch += 1
        if tab.session.processState == .running {
            tab.session.requestTerminate()
            let epoch = tab.restartEpoch
            let tabID = tab.id
            tab.restartTask = Task { [weak self] in
                var attempts = 0
                while self?.terminalTabManager.tab(for: tabID)?.session.processState == .terminating,
                      attempts < 100 {
                    do { try await Task.sleep(for: .milliseconds(100)) }
                    catch { return }
                    attempts += 1
                }
                guard !Task.isCancelled, let self,
                      let tab = terminalTabManager.tab(for: tabID),
                      tab.restartEpoch == epoch,
                      terminalTabManager.activeTabID == tabID,
                      terminalTabManager.isVisible,
                      tab.session.processState.canLaunch,
                      let url = projectURL else { return }
                tab.restartEpoch += 1
                tab.session.requestLaunch(projectRoot: url)
            }
        } else if tab.session.processState.canLaunch, let url = projectURL {
            tab.session.requestLaunch(projectRoot: url)
        }
    }

    /// Called from ProjectWindowView's onProcessExit callback. Handles per-tab
    /// auto-restart with crash-loop detection. Only restarts the active tab
    /// when the terminal area is visible — inactive tabs stay in .exited.
    func handleProcessExit(forTabID tabID: UUID, exitCode: Int32) {
        guard let tab = terminalTabManager.tab(for: tabID),
              terminalTabManager.activeTabID == tabID,
              terminalTabManager.isVisible,
              projectURL != nil else { return }

        // Crash-loop detection
        let now = Date()
        if let last = tab.lastExitTime, now.timeIntervalSince(last) < 2.0 {
            tab.consecutiveRapidExits += 1
        } else {
            tab.consecutiveRapidExits = 0
        }
        tab.lastExitTime = now

        guard tab.consecutiveRapidExits < 5 else {
            tab.session.markFailed("Shell exited repeatedly (code \(exitCode))")
            tab.consecutiveRapidExits = 0
            return
        }

        // Brief delay, then auto-restart (with 4-point gate)
        tab.restartEpoch += 1
        let epoch = tab.restartEpoch
        tab.restartTask?.cancel()
        tab.restartTask = Task { [weak self] in
            do { try await Task.sleep(for: .milliseconds(500)) }
            catch { return }
            guard !Task.isCancelled, let self,
                  let tab = terminalTabManager.tab(for: tabID),
                  tab.restartEpoch == epoch,
                  terminalTabManager.activeTabID == tabID,
                  terminalTabManager.isVisible,
                  case .exited = tab.session.processState,
                  let url = projectURL else { return }
            tab.restartEpoch += 1
            tab.session.requestLaunch(projectRoot: url)
        }
    }

    func resetTerminal() {
        guard let session = terminalTabManager.activeSession,
              session.processState == .running else { return }
        session.resetRequested = true
    }

    func terminateTerminal() {
        guard let tab = terminalTabManager.activeTab else { return }
        tab.restartTask?.cancel()
        tab.restartTask = nil
        tab.restartEpoch += 1
        if tab.session.processState == .running || tab.session.processState == .launching {
            tab.session.requestTerminate()
        }
    }

    /// Stop watching, cancel in-flight loads, reset state to placeholder.
    /// Called from willTerminateNotification — synchronous cleanup is sufficient
    /// because the app is about to exit. View dismantling handles PTY kill.
    func closeProject() {
        openProjectTask?.cancel()
        openProjectTask = nil
        // Synchronous: request terminate on all live tabs, force-reset stuck ones
        for tab in terminalTabManager.tabs {
            switch tab.session.processState {
            case .running, .launching:
                tab.session.requestTerminate()
            case .terminating:
                // Already terminating — force-reset so closeAllTabs doesn't leave
                // tabs in ambiguous state. Coordinator cleanup() is the final backstop.
                tab.session.reset()
            default:
                break
            }
        }
        terminalTabManager.closeAllTabs()
        loadTask?.cancel()
        loadTask = nil
        fileWatcher.stop()
        // Order matters: projectURL must be nil before state reset.
        // ProjectWindowView's onChange(of: config.project) guard depends on this.
        storyWriter = nil
        projectURL = nil
        state = .placeholder
        warnings = []
        loadError = nil
        isLoading = false
    }

    // MARK: - Fix Warnings

    private static let dateLineRegex = try! NSRegularExpression(
        pattern: #"\*\*Date:\*\*\s*(.+)"#
    )

    /// Renames non-conforming handover files to include a YYYY-MM-DD date prefix.
    /// Extracts date from markdown content (`**Date:** ...`) or falls back to file modification date.
    /// Runs file I/O on a background thread to avoid blocking the main actor.
    func fixHandoverFilenames() {
        let fixableWarnings = warnings.filter { $0.fixable && $0.absolutePath != nil }
        guard !fixableWarnings.isEmpty else { return }

        Task.detached { [weak self] in
            let fm = FileManager.default
            var renamed = 0

            for warning in fixableWarnings {
                guard let absPath = warning.absolutePath else { continue }
                let sourceURL = URL(fileURLWithPath: absPath)
                let filename = sourceURL.lastPathComponent
                let directory = sourceURL.deletingLastPathComponent()

                guard let datePrefix = Self.extractDatePrefix(from: sourceURL, fileManager: fm) else {
                    Log.warning("Could not extract date for handover: \(filename)", tag: "ViewModel")
                    continue
                }

                // Build new filename: YYYY-MM-DD-<original>.md
                let baseStem = "\(datePrefix)-\(filename.replacingOccurrences(of: ".md", with: ""))"
                let targetURL = Self.uniqueURL(stem: baseStem, extension: "md", in: directory, fileManager: fm)

                do {
                    try fm.moveItem(at: sourceURL, to: targetURL)
                    Log.info("Renamed handover: \(filename) → \(targetURL.lastPathComponent)", tag: "ViewModel")
                    renamed += 1
                } catch {
                    Log.error("Failed to rename \(filename): \(error.localizedDescription)", tag: "ViewModel")
                }
            }

            if renamed > 0 {
                Log.info("Fixed \(renamed) handover filename(s), reloading", tag: "ViewModel")
                await self?.reload()
            }
        }
    }

    /// Returns a unique file URL, appending `-2`, `-3`, etc. if the base name is taken.
    private static func uniqueURL(stem: String, extension ext: String, in directory: URL, fileManager fm: FileManager) -> URL {
        var candidate = directory.appendingPathComponent("\(stem).\(ext)")
        var suffix = 2
        while fm.fileExists(atPath: candidate.path) {
            Log.warning("Collision for \(candidate.lastPathComponent), trying suffix -\(suffix)", tag: "ViewModel")
            candidate = directory.appendingPathComponent("\(stem)-\(suffix).\(ext)")
            suffix += 1
        }
        return candidate
    }

    /// Extracts a YYYY-MM-DD date string from handover markdown content.
    /// Reads only the first 2KB via FileHandle. Falls back to file modification date.
    private static func extractDatePrefix(from url: URL, fileManager fm: FileManager) -> String? {
        // Read only the first 2KB via FileHandle
        if let handle = try? FileHandle(forReadingFrom: url) {
            defer { try? handle.close() }
            if let data = try? handle.read(upToCount: 2048),
               let content = String(data: data, encoding: .utf8) {

                let lines = content.components(separatedBy: .newlines).prefix(20)
                for line in lines {
                    let nsLine = line as NSString
                    let match = dateLineRegex.firstMatch(
                        in: line, range: NSRange(location: 0, length: nsLine.length)
                    )
                    if let match, match.numberOfRanges >= 2 {
                        let rawDate = nsLine.substring(with: match.range(at: 1))
                            .trimmingCharacters(in: .whitespaces)
                        if let parsed = parseHandoverDate(rawDate) {
                            return parsed
                        }
                    }
                }
            }
        }

        // Fallback: file modification date
        if let attrs = try? fm.attributesOfItem(atPath: url.path),
           let modDate = attrs[.modificationDate] as? Date {
            let formatter = DateFormatter()
            formatter.dateFormat = "yyyy-MM-dd"
            formatter.locale = Locale(identifier: "en_US_POSIX")
            return formatter.string(from: modDate)
        }

        return nil
    }

    /// Parses a date string into YYYY-MM-DD format.
    /// Supports: "2026-01-27", "January 17, 2026", "Jan 17, 2026"
    private static func parseHandoverDate(_ raw: String) -> String? {
        let trimmed = raw.trimmingCharacters(in: .whitespaces)

        // ISO format: already YYYY-MM-DD
        if trimmed.range(of: #"^\d{4}-\d{2}-\d{2}$"#, options: .regularExpression) != nil {
            return trimmed
        }

        // Natural language: "January 17, 2026" or "Jan 17, 2026"
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        for format in ["MMMM d, yyyy", "MMM d, yyyy", "MMMM dd, yyyy", "MMM dd, yyyy"] {
            formatter.dateFormat = format
            if let date = formatter.date(from: trimmed) {
                formatter.dateFormat = "yyyy-MM-dd"
                return formatter.string(from: date)
            }
        }

        return nil
    }

    // MARK: - Private

    /// Cancels any in-flight load and starts a new one.
    private func reload() {
        guard let url = projectURL else {
            isLoading = false
            return
        }

        loadError = nil
        loadTask?.cancel()
        loadTask = Task { [weak self] in
            do {
                guard let self else { return }
                let result = try await self.loader.load(from: url)

                // Staleness guard: if closeProject() ran or a different project
                // was opened while we awaited, discard these results.
                guard !Task.isCancelled, self.projectURL == url else { return }

                self.state = result.state
                self.warnings = result.warnings
                self.loadError = nil
                self.isLoading = false
            } catch is CancellationError {
                // Cancelled — do not touch state (closeProject already reset it,
                // or a newer reload is in flight).
            } catch {
                guard !Task.isCancelled, self?.projectURL != nil else { return }
                self?.loadError = error.localizedDescription
                self?.isLoading = false
            }
        }
    }
}
