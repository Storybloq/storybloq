import SwiftUI
import Fabric

// MARK: - Project Window View

/// Root view for a single project window. Created by ProjectSceneView
/// only when a valid canonical path is available. Owns its own
/// ProjectViewModel via @State — .id(canonicalPath) in the parent
/// forces a fresh instance per project.
struct ProjectWindowView: View {
    let canonicalPath: String
    /// Callback to register viewModel.closeProject() with the parent scene.
    /// ProjectSceneView calls this closure in its close handler for PTY cleanup.
    var onRegisterCloseProject: ((@escaping () -> Void) -> Void)?
    /// Callback with (canonicalPath, displayName) — includes identity for stale-emission rejection.
    var onProjectNameChanged: ((String, String) -> Void)?

    @State private var viewModel = ProjectViewModel()
    @State private var showError = false
    @State private var errorMessage = ""
    @State private var isLoading = true
    @State private var terminalWidth: CGFloat = 400
    @State private var navigationPath = NavigationPath()
    @State private var searchText = ""
    @State private var notesWidth: CGFloat = 400
    @State private var showAutonomousSettings = false
    @AppStorage(AppSettings.Key.experimentalFeatures) private var experimentalFeatures = false
    @State private var showSetupFromFailure = false

    /// Guard against .task re-fires on SwiftUI view updates.
    @State private var hasOpened = false
    /// Guard against multiple projectDidOpen calls (e.g., from FileWatcher reloads).
    @State private var didNotifyCoordinator = false

    @Environment(AppCoordinator.self) private var coordinator

    private var rootContent: some View {
        Group {
            if isLoading {
                loadingView
            } else if viewModel.loadError != nil && !didNotifyCoordinator {
                loadFailureView
            } else {
                projectOpenView
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .toolbarBackground(StoryTheme.base, for: .windowToolbar)
        .toolbarBackgroundVisibility(.visible, for: .windowToolbar)
        .toolbar { toolbarContent }
    }

    var body: some View {
        rootContent
        .task {
            guard !hasOpened else { return }
            hasOpened = true
            viewModel.openProject(at: URL(fileURLWithPath: canonicalPath))
        }
        .onAppear {
            // Register viewModel.closeProject() with parent for window-close PTY cleanup.
            // .onAppear fires synchronously before .task body executes on MainActor,
            // so this is registered before any resources (FileWatcher, terminals) are created.
            onRegisterCloseProject? { [weak viewModel] in
                viewModel?.closeProject()
            }
        }
        .alert("Error", isPresented: $showError) {
            Button("OK") { }
        } message: {
            Text(errorMessage)
        }
        .onChange(of: viewModel.loadError) { _, newValue in
            if let error = newValue, didNotifyCoordinator {
                // Post-load error (e.g., file save failure) — show as alert
                errorMessage = error
                showError = true
            } else if let error = newValue, !didNotifyCoordinator {
                // Initial load failure — clear stale .opening state so the user
                // can retry or open the same project from another window.
                coordinator.unregisterOpening(url: URL(fileURLWithPath: canonicalPath))
                errorMessage = error
                isLoading = false
            }
        }
        .onChange(of: viewModel.isLoading) { old, new in
            // Detect successful first load: isLoading transitions true → false
            if old && !new && !didNotifyCoordinator
                && viewModel.loadError == nil
                && viewModel.projectURL != nil
                && coordinator.isStillOpening(canonicalPath: canonicalPath) {
                didNotifyCoordinator = true
                isLoading = false
                coordinator.projectDidOpen(canonicalPath: canonicalPath, displayName: viewModel.state.config.project)
                onProjectNameChanged?(canonicalPath, viewModel.state.config.project)
            }
        }
        .onChange(of: viewModel.state.config.project) { _, newName in
            // Guard: didNotifyCoordinator prevents double-fire with the explicit initial emission above.
            // Guard: projectURL != nil prevents emission during closeProject() teardown.
            // Ordering dependency: closeProject() clears projectURL before resetting state
            // to .placeholder, so by the time config.project changes to "loading",
            // projectURL is already nil and this guard rejects it.
            guard didNotifyCoordinator, viewModel.projectURL != nil else { return }
            onProjectNameChanged?(canonicalPath, newName)
        }
        .onReceive(NotificationCenter.default.publisher(for: NSApplication.willTerminateNotification)) { _ in
            viewModel.closeProject()
        }
    }

    // MARK: - Subviews

    private var loadingView: some View {
        ProgressView()
            .controlSize(.large)
    }

    private var loadFailureView: some View {
        VStack(spacing: StorySpacing.lg) {
            if viewModel.isMissingStoryDir {
                Image(systemName: "folder.badge.gearshape")
                    .font(.system(size: 40))
                    .foregroundStyle(StoryTheme.accent)
                Text("No .story/ directory")
                    .fabricTitle()
                Text("Set up this project to track tickets, issues, and session handovers.")
                    .fabricCaption()
                Button("Set Up Project") {
                    showSetupFromFailure = true
                }
                .controlSize(.large)
                .sheet(isPresented: $showSetupFromFailure) {
                    ProjectSetupSheet(
                        viewModel: ProjectSetupViewModel(projectURL: URL(fileURLWithPath: canonicalPath)),
                        onComplete: { retryLoad() }
                    )
                }
            } else {
                Image(systemName: "exclamationmark.triangle")
                    .font(.system(size: 40))
                    .foregroundStyle(StoryTheme.err)
                Text("Failed to load project")
                    .fabricTitle()
                if let error = viewModel.loadError {
                    Text(error)
                        .fabricCaption()
                }
                Button("Try Again") {
                    retryLoad()
                }
                .controlSize(.large)
            }
        }
    }

    private func retryLoad() {
        let url = URL(fileURLWithPath: canonicalPath)
        // Re-register with coordinator (unregisterOpening was called on failure)
        if coordinator.registerOpening(url: url) {
            hasOpened = false
            isLoading = true
            viewModel.openProject(at: url)
        }
    }

    @ToolbarContentBuilder
    private var toolbarContent: some ToolbarContent {
        ToolbarItem(placement: .automatic) {
            TextField("Search tickets, issues...", text: $searchText)
                .textFieldStyle(.plain)
                .padding(.leading, 14)
                .padding(.trailing, 8)
                .padding(.vertical, 4)
                .background(FabricColors.burlap.opacity(0.5), in: Capsule())
                .frame(width: 220)
                .padding(.trailing, 12)
        }
        if experimentalFeatures {
            ToolbarItem(placement: .primaryAction) {
                Button {
                    viewModel.sendPromptToTerminal(AppSettings.autoWork)
                } label: {
                    Image(systemName: "bolt.fill")
                }
                .help("Auto Work")
                .disabled(viewModel.terminalTabManager.isActiveTabTransitional)
            }
            ToolbarItem(placement: .primaryAction) {
                Button {
                    viewModel.sendPromptToTerminal(AppSettings.resumeWork)
                } label: {
                    Image(systemName: "wand.and.stars")
                }
                .help("Resume Work")
                .disabled(viewModel.terminalTabManager.isActiveTabTransitional)
            }
        }
        ToolbarItem(placement: .primaryAction) {
            Button {
                viewModel.toggleNotes()
            } label: {
                Image(systemName: viewModel.isNotesVisible ? "note.text.badge.plus" : "note.text")
            }
            .help(viewModel.isNotesVisible ? "Hide Notes" : "Show Notes")
        }
        if experimentalFeatures {
            ToolbarItem(placement: .primaryAction) {
                Button {
                    viewModel.toggleTerminal()
                } label: {
                    Image(systemName: viewModel.terminalTabManager.isVisible ? "terminal.fill" : "terminal")
                }
                .help(viewModel.terminalTabManager.isVisible ? "Hide Terminal" : "Show Terminal")
            }
            ToolbarItem(placement: .primaryAction) {
                Button {
                    showAutonomousSettings.toggle()
                } label: {
                    Image(systemName: "gearshape")
                }
                .help("Project Settings")
                .popover(isPresented: $showAutonomousSettings) {
                    AutonomousSettingsPanel(viewModel: viewModel)
                }
            }
        }
    }

    private static let minContentWidth: CGFloat = 300
    private static let dividerWidth: CGFloat = 0

    private var projectOpenView: some View {
        VStack(spacing: 0) {
            GeometryReader { proxy in
                let isTerminalVisible = experimentalFeatures && viewModel.terminalTabManager.isVisible
                let maxTerminalWidth = max(proxy.size.width - Self.minContentWidth - (isTerminalVisible ? Self.dividerWidth : 0), 0)
                let clampedTerminalWidth = min(terminalWidth, maxTerminalWidth)
                let isNotesVisible = viewModel.isNotesVisible
                HStack(spacing: 0) {
                    ProjectContentArea(viewModel: viewModel, navigationPath: $navigationPath, searchText: searchText)
                        .frame(minWidth: Self.minContentWidth, maxWidth: .infinity, maxHeight: .infinity)

                    // Notes panel (between board and terminal)
                    SidebarPanel(
                        panelWidth: $notesWidth,
                        minWidth: 300,
                        maxWidth: 600,
                        showDivider: isNotesVisible,
                        applyLeadingOverlap: isNotesVisible,
                        onClose: { viewModel.toggleNotes() }
                    ) {
                        HStack(spacing: StorySpacing.xs) {
                            Image(systemName: "note.text")
                                .foregroundStyle(StoryTheme.accent)
                            Text("Notes")
                                .fabricMonoSmall()
                        }
                    } content: {
                        NotesPanel(
                            state: viewModel.state,
                            onCreateNote: { content, title, tags in
                                viewModel.createNote(content: content, title: title, tags: tags)
                            },
                            onUpdateNote: { id, content, title, tags, clearTags, status in
                                viewModel.updateNote(id: id, content: content, title: title, tags: tags, clearTags: clearTags, status: status)
                            },
                            onDeleteNote: { viewModel.deleteNote(id: $0) }
                        )
                    }
                    .frame(width: isNotesVisible ? notesWidth : 0)
                    .frame(maxHeight: .infinity)
                    .opacity(isNotesVisible ? 1 : 0)
                    .allowsHitTesting(isNotesVisible)

                    // Terminal area (right side, hidden via width=0)
                    SidebarPanel(
                        panelWidth: $terminalWidth,
                        minWidth: 250,
                        maxWidth: 600,
                        showDivider: isTerminalVisible,
                        applyLeadingOverlap: isTerminalVisible,
                        onClose: { viewModel.hideTerminal() }
                    ) {
                        // Header: terminal label
                        HStack(spacing: StorySpacing.xs) {
                            Image(systemName: "terminal.fill")
                                .foregroundStyle(StoryTheme.accent)
                            Text("Terminal")
                                .fabricMonoSmall()
                        }
                    } content: {
                        VStack(spacing: 0) {
                            // Tab bar (sticky, below top bar)
                            if isTerminalVisible {
                                TerminalTabBar(
                                    tabs: viewModel.terminalTabManager.tabs,
                                    activeTabID: viewModel.terminalTabManager.activeTabID,
                                    canAddTab: viewModel.terminalTabManager.canAddTab,
                                    onSelect: { viewModel.switchToTab($0) },
                                    onClose: { viewModel.closeTerminalTab($0) },
                                    onAdd: { viewModel.addTerminalTab() }
                                )
                                if let activeSession = viewModel.terminalTabManager.activeSession {
                                    TerminalToolbar(
                                        session: activeSession,
                                        onRestart: { viewModel.restartTerminal() },
                                        onReset: { viewModel.resetTerminal() }
                                    )
                                }
                            }
                            // ZStack: ALL terminal panes in hierarchy (preserves PTY across tab switches).
                            // Visibility controlled by NSView.isHidden via isActive prop.
                            ZStack {
                                ForEach(viewModel.terminalTabManager.tabs) { tab in
                                    let tabID = tab.id
                                    TerminalPaneView(
                                        session: tab.session,
                                        isActive: tabID == viewModel.terminalTabManager.activeTabID
                                            && viewModel.terminalTabManager.isVisible,
                                        onProcessExit: { exitCode in
                                            viewModel.handleProcessExit(forTabID: tabID, exitCode: exitCode)
                                        }
                                    )
                                }
                            }
                            .padding(.horizontal, 10)
                            .frame(maxWidth: .infinity, maxHeight: .infinity)
                            .transaction { $0.animation = nil }
                        }
                    }
                    .frame(width: isTerminalVisible ? clampedTerminalWidth : 0)
                    .frame(maxHeight: .infinity)
                    .opacity(isTerminalVisible ? 1 : 0)
                    .allowsHitTesting(isTerminalVisible)
                    .animation(.smooth(duration: 0.35), value: isTerminalVisible)
                }
                .onChange(of: maxTerminalWidth) { _, newMax in
                    if terminalWidth > newMax {
                        terminalWidth = newMax
                    }
                }
            }
        }
        .onChange(of: viewModel.projectURL) { _, _ in
            navigationPath = NavigationPath()
        }
        .onChange(of: experimentalFeatures) { _, newValue in
            if !newValue {
                viewModel.hideTerminal()
            }
        }
    }
}

// MARK: - Project Content Area

/// Extracted subview to prevent ControlPanelView from re-evaluating
/// during terminal drag. When terminalWidth @State changes in ProjectWindowView,
/// the parent body re-evaluates but this view's inputs (viewModel reference,
/// navigationPath binding) remain the same — SwiftUI skips body re-evaluation.
private struct ProjectContentArea: View {
    let viewModel: ProjectViewModel
    @Binding var navigationPath: NavigationPath
    let searchText: String

    @State private var selectedItemID: String? = nil
    @State private var inspectorWidth: CGFloat = 400
    @State private var showDeleteConfirmation = false
    @State private var showDeleteBlockedAlert = false
    @State private var deleteBlockReasons: [String] = []

    var body: some View {
        NavigationStack(path: $navigationPath) {
            HStack(spacing: 0) {
                let isSidebarVisible = selectedItemID != nil || viewModel.terminalTabManager.isVisible || viewModel.isNotesVisible
                BoardWrapper(viewModel: viewModel, selectedItemID: $selectedItemID, isSidebarVisible: isSidebarVisible, searchText: searchText)
                    .frame(maxWidth: .infinity)

                // Inspector panel — owned here so inspectorWidth changes
                // don't trigger ControlPanelView.body re-evaluation.
                if let itemID = selectedItemID {
                    SidebarPanel(
                        panelWidth: $inspectorWidth,
                        onClose: { withAnimation(.smooth(duration: 0.35)) { selectedItemID = nil } }
                    ) {
                        inspectorHeader(for: itemID)
                    } actions: {
                        inspectorActions(for: itemID)
                    } content: {
                        inspectorContent(for: itemID)
                            .frame(maxWidth: .infinity, maxHeight: .infinity)
                            .id(itemID)
                    }
                    .frame(width: inspectorWidth)
                    .confirmationDialog(
                        "Delete Item",
                        isPresented: $showDeleteConfirmation
                    ) {
                        Button("Delete", role: .destructive) {
                            if viewModel.state.ticket(byID: itemID) != nil {
                                viewModel.deleteTicket(id: itemID)
                            } else {
                                viewModel.deleteIssue(id: itemID)
                            }
                        }
                        Button("Cancel", role: .cancel) {}
                    } message: {
                        Text("Delete \(itemID)? This cannot be undone.")
                    }
                    .alert("Cannot Delete", isPresented: $showDeleteBlockedAlert) {
                        Button("OK") {}
                    } message: {
                        Text(deleteBlockReasons.joined(separator: "\n"))
                    }
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .fabricSurface(StoryTheme.base)
        }
        .onChange(of: viewModel.state) {
            if let id = selectedItemID,
               viewModel.state.ticket(byID: id) == nil,
               viewModel.state.issue(byID: id) == nil {
                withAnimation(.smooth(duration: 0.35)) { selectedItemID = nil }
            }
        }
    }

    // MARK: - Inspector

    @ViewBuilder
    private func inspectorHeader(for itemID: String) -> some View {
        if let ticket = viewModel.state.ticket(byID: itemID) {
            HStack(spacing: StorySpacing.xs) {
                Text(ticket.id)
                    .fabricMonoSmall()
                StatusDot(ticketStatus: ticket.status)
            }
        } else if let issue = viewModel.state.issue(byID: itemID) {
            HStack(spacing: StorySpacing.xs) {
                Text(issue.id)
                    .fabricMonoSmall()
                SeverityBadge(severity: issue.severity)
            }
        }
    }

    @ViewBuilder
    private func inspectorActions(for itemID: String) -> some View {
        PanelCloseButton(systemImage: "trash", helpText: "Delete") {
            requestDelete(itemID)
        }
    }

    private func requestDelete(_ itemID: String) {
        if viewModel.state.ticket(byID: itemID) != nil {
            var reasons: [String] = []
            let blockers = viewModel.state.ticketsBlocking(itemID)
            if !blockers.isEmpty {
                reasons.append("Blocks: \(blockers.joined(separator: ", "))")
            }
            let children = viewModel.state.childrenOf(itemID)
            if !children.isEmpty {
                reasons.append("Has children: \(children.joined(separator: ", "))")
            }
            let issueRefs = viewModel.state.issuesReferencing(itemID)
            if !issueRefs.isEmpty {
                reasons.append("Referenced by: \(issueRefs.joined(separator: ", "))")
            }
            if reasons.isEmpty {
                showDeleteConfirmation = true
            } else {
                deleteBlockReasons = reasons
                showDeleteBlockedAlert = true
            }
        } else {
            showDeleteConfirmation = true
        }
    }

    @ViewBuilder
    private func inspectorContent(for itemID: String) -> some View {
        if viewModel.state.ticket(byID: itemID) != nil {
            TicketInspectorView(ticketID: itemID, state: viewModel.state, onUpdateTicket: { viewModel.updateTicket($0) })
        } else if viewModel.state.issue(byID: itemID) != nil {
            IssueInspectorView(issueID: itemID, state: viewModel.state, onUpdateIssue: { viewModel.updateIssue($0) })
        }
    }
}

// MARK: - Board Wrapper

/// Isolates ControlPanelView from inspector width changes.
/// When inspectorWidth @State changes in ProjectContentArea, its body re-evaluates,
/// but BoardWrapper is created with the same viewModel + selectedItemID binding —
/// SwiftUI skips its body, preventing the kanban board from re-evaluating.
/// Note: terminal visibility toggle does re-evaluate (for board centering), but
/// continuous terminal drag (terminalWidth changes) does not.
private struct BoardWrapper: View {
    let viewModel: ProjectViewModel
    @Binding var selectedItemID: String?
    let isSidebarVisible: Bool
    let searchText: String

    var body: some View {
        VStack(spacing: 0) {
            if !viewModel.warnings.isEmpty {
                ErrorBanner(warnings: viewModel.warnings) {
                    viewModel.fixHandoverFilenames()
                }
                .padding(.horizontal, StorySpacing.md)
                .padding(.top, StorySpacing.sm)
            }

            ControlPanelView(
                state: viewModel.state,
                selectedItemID: $selectedItemID,
                onUpdateTicket: { viewModel.updateTicket($0) },
                onUpdateIssue: { viewModel.updateIssue($0) },
                onCreateTicket: { phase in viewModel.createTicket(phase: phase) },
                onDeleteTicket: { viewModel.deleteTicket(id: $0) },
                onDeleteIssue: { viewModel.deleteIssue(id: $0) },
                onReorderItems: { changes, statusChange in
                    withAnimation(FabricAnimation.reorder) {
                        viewModel.reorderItems(changes, statusChange: statusChange)
                    }
                },
                isSidebarVisible: isSidebarVisible,
                searchText: searchText,
                nextTicketID: { viewModel.nextTicketID() },
                nextIssueID: { viewModel.nextIssueID() },
                nextOrderForPhase: { viewModel.nextBoardOrder(in: $0) }
            )
        }
    }
}
