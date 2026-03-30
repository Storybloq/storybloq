import SwiftUI
import Fabric

// MARK: - Control Panel View

/// Unified project view replacing the 4-tab navigation.
/// Shows a horizontal roadmap timeline (interactive phase filter) at top,
/// and a unified kanban board below with tickets and issues together.
/// Supports intra-column drag reordering when a phase is selected.
struct ControlPanelView: View {
    let state: ProjectState
    @Binding var selectedItemID: String?
    var onUpdateTicket: ((Ticket) -> Void)? = nil
    var onUpdateIssue: ((Issue) -> Void)? = nil
    var onCreateTicket: ((PhaseID?) -> Void)? = nil
    var onDeleteTicket: ((String) -> Void)? = nil
    var onDeleteIssue: ((String) -> Void)? = nil
    var onReorderItems: ((_ changes: [(id: String, newOrder: Int, isTicket: Bool)],
                          _ statusChange: (id: String, newTicketStatus: TicketStatus?,
                                           newIssueStatus: IssueStatus?,
                                           completedDate: String??, resolvedDate: String??)?) -> Void)? = nil
    var isSidebarVisible: Bool = false
    var searchText: String = ""
    var nextTicketID: () -> String = { "T-001" }
    var nextIssueID: () -> String = { "ISS-001" }
    var nextOrderForPhase: ((PhaseID?) -> Int)? = nil

    @State private var selectedPhase: String? = nil
    @State private var pendingNewTicketCount: Int?
    @State private var isCreatingTicket = false

    // Drop targets
    @State private var openTargeted = false
    @State private var inProgressTargeted = false
    @State private var completeTargeted = false

    // Card-level drop target for positional insertion
    @State private var dropTarget: (column: String, itemID: String)? = nil
    // Tracks which card is being dragged for ghost/lift visual on source card
    @State private var draggingItemID: String? = nil

    // MARK: - Filtered Items

    private var phaseID: PhaseID? {
        guard let selectedPhase else { return nil }
        return PhaseID(selectedPhase)
    }

    /// Reordering is only safe when a phase is selected.
    /// In "All Phases" view, items from different phases share the order space,
    /// so reordering would corrupt phase-local sequences.
    private var canReorder: Bool { phaseID != nil }

    /// Maps a phase to its position in the roadmap (0-based).
    private func phaseName(for phase: PhaseID?) -> String {
        guard let phase else { return "" }
        return state.roadmap.phases.first(where: { $0.id == phase })?.name ?? ""
    }

    private func itemTags(for item: BoardItem) -> [String] {
        switch item {
        case .ticket(let t): [t.type.displayName]
        case .issue(let i): [i.severity.displayName] + i.components
        }
    }

    /// Unphased items sort last (Int.max).
    private func phaseIndex(_ phase: PhaseID?) -> Int {
        guard let phase else { return Int.max }
        return state.roadmap.phases.firstIndex(where: { $0.id == phase }) ?? Int.max
    }

    private var filteredItems: [BoardItem] {
        var items: [BoardItem] = []

        let tickets: [Ticket]
        let issues: [Issue]

        if let phase = phaseID {
            tickets = state.phaseTickets(phase)
            issues = state.phaseIssues(phase)
        } else {
            tickets = state.leafTickets
            issues = state.issues
        }

        items.append(contentsOf: tickets.map { .ticket($0) })
        items.append(contentsOf: issues.map { .issue($0) })

        // Search filter
        if !searchText.isEmpty {
            items = items.filter { item in
                item.id.localizedCaseInsensitiveContains(searchText)
                || item.title.localizedCaseInsensitiveContains(searchText)
                || (item.description ?? "").localizedCaseInsensitiveContains(searchText)
                || phaseName(for: item.phase).localizedCaseInsensitiveContains(searchText)
                || itemTags(for: item).contains { $0.localizedCaseInsensitiveContains(searchText) }
            }
        }

        return items
    }

    private var openItems: [BoardItem] {
        filteredItems.filter { $0.columnStatus == .open }.sorted { (phaseIndex($0.phase), $0.order, $0.id) < (phaseIndex($1.phase), $1.order, $1.id) }
    }

    private var inProgressItems: [BoardItem] {
        filteredItems.filter { $0.columnStatus == .inprogress }.sorted { (phaseIndex($0.phase), $0.order, $0.id) < (phaseIndex($1.phase), $1.order, $1.id) }
    }

    private var completeItems: [BoardItem] {
        filteredItems.filter { $0.columnStatus == .complete }.sorted {
            // Most recently completed first; items without a date sort to the end
            let date0 = $0.completionDate ?? ""
            let date1 = $1.completionDate ?? ""
            if date0 != date1 { return date0 > date1 }
            return (phaseIndex($0.phase), $0.order, $0.id) < (phaseIndex($1.phase), $1.order, $1.id)
        }
    }

    // MARK: - Body

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            phaseTimeline
            boardContent
        }
        .onChange(of: state.tickets.count) { oldCount, newCount in
            if let expected = pendingNewTicketCount, newCount > expected {
                if let newest = state.tickets.sorted(by: { $0.id > $1.id }).first {
                    Log.info("Kanban: auto-selecting new ticket \(newest.id)", tag: "Tickets")
                    if selectedItemID == nil {
                        withAnimation(.smooth(duration: 0.35)) { selectedItemID = newest.id }
                    } else {
                        selectedItemID = newest.id
                    }
                }
                pendingNewTicketCount = nil
                // Small delay before re-enabling + button to prevent accidental double-create
                Task {
                    try? await Task.sleep(for: .milliseconds(500))
                    isCreatingTicket = false
                }
            }
        }
    }

    // MARK: - Phase Timeline

    private var currentPhaseID: String? {
        state.roadmap.phases.first { state.phaseStatus($0.id) == .inprogress }?.id.rawValue
    }

    private var phaseTimeline: some View {
        let items = state.roadmap.phases.map { phase -> FabricTimelineItem in
            let status = state.phaseStatus(phase.id)
            let kind: FabricTimelineItem.Kind = switch status {
            case .complete: .milestone(accent: .sage)
            case .inprogress: .milestone(accent: .indigo)
            case .notstarted: .event
            }
            return FabricTimelineItem(
                id: phase.id.rawValue,
                timestamp: phase.label,
                title: phase.name,
                description: phase.description.isEmpty ? nil : phase.description,
                kind: kind
            )
        }

        return FabricTimeline(
            items: items,
            selection: $selectedPhase,
            currentItemID: currentPhaseID,
            accent: .indigo,
            axis: .horizontal,
            descriptionAlignment: isSidebarVisible ? .leading : .center
        )
        .padding(.horizontal, StorySpacing.lg)
        .padding(.vertical, StorySpacing.sm)
    }

    // MARK: - Board

    private var boardContent: some View {
        GeometryReader { geo in
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(alignment: .top, spacing: StorySpacing.md) {
                    column("Open", items: openItems, isTargeted: $openTargeted, targetStatus: .open, onAdd: isCreatingTicket ? nil : {
                        // Reuse existing empty ticket instead of creating a duplicate
                        if let empty = state.tickets.first(where: { $0.title == "New ticket" && $0.description.isEmpty && $0.status == .open }) {
                            Log.info("Kanban +: reusing empty ticket \(empty.id)", tag: "Tickets")
                            selectedItemID = empty.id
                            return
                        }
                        Log.info("Kanban +: creating new ticket phase=\(phaseID?.rawValue ?? "nil")", tag: "Tickets")
                        isCreatingTicket = true
                        pendingNewTicketCount = state.tickets.count
                        onCreateTicket?(phaseID)
                        // Timeout: reset guard after 5s in case CLI fails silently
                        Task {
                            try? await Task.sleep(for: .seconds(5))
                            if isCreatingTicket {
                                Log.warning("Kanban +: create timeout, resetting guard", tag: "Tickets")
                                isCreatingTicket = false
                                pendingNewTicketCount = nil
                            }
                        }
                    })
                    column("In Progress", items: inProgressItems, isTargeted: $inProgressTargeted, targetStatus: .inprogress)
                    column("Complete", items: completeItems, isTargeted: $completeTargeted, targetStatus: .complete)
                }
                .padding(StorySpacing.lg)
                .frame(
                    minWidth: isSidebarVisible ? nil : geo.size.width,
                    minHeight: geo.size.height,
                    alignment: .center
                )
            }
        }
    }

    private func column(_ title: String, items: [BoardItem], isTargeted: Binding<Bool>, targetStatus: BoardItem.ColumnStatus, onAdd: (() -> Void)? = nil) -> some View {
        FabricKanbanColumn(title, count: items.count, isDropTarget: isTargeted.wrappedValue, columnWidth: FabricSpacing.columnMaxWidth, showShadow: true, onAdd: onAdd) {
            ForEach(Array(items.enumerated()), id: \.element.id) { index, item in
                if canReorder {
                    VStack(spacing: FabricSpacing.sm) {
                        // Drop placeholder above this card
                        if dropTarget?.column == title && dropTarget?.itemID == item.id {
                            FabricDropPlaceholder(accent: .indigo)
                                .transition(.opacity.combined(with: .scale(scale: 0.95)))
                        }

                        cardView(item, index: index, items: items, targetStatus: targetStatus)
                    }
                    .dropDestination(for: KanbanItem.self) { dropped, _ in
                        defer { dropTarget = nil }
                        guard let first = dropped.first, first.id != item.id else { return false }
                        return handlePositionalDrop(first, before: item, inColumn: items, targetStatus: targetStatus)
                    } isTargeted: { targeted in
                        if targeted {
                            dropTarget = (column: title, itemID: item.id)
                        } else if dropTarget?.column == title && dropTarget?.itemID == item.id {
                            dropTarget = nil
                        }
                    }
                } else {
                    cardView(item, index: index, items: items, targetStatus: targetStatus)
                }
            }

            // End-of-column placeholder
            if canReorder && isTargeted.wrappedValue && dropTarget?.column != title {
                FabricDropPlaceholder(accent: .indigo)
                    .transition(.opacity.combined(with: .scale(scale: 0.95)))
            }
        }
        .dropDestination(for: KanbanItem.self) { droppedItems, _ in
            guard let dropped = droppedItems.first else { return false }
            if canReorder {
                // Append to end of column with positional awareness
                return handleColumnDrop(dropped, inColumn: items, targetStatus: targetStatus)
            } else {
                // All Phases: status change only
                return handleDrop(dropped, toStatus: targetStatus)
            }
        } isTargeted: { targeted in
            isTargeted.wrappedValue = targeted && (dropTarget?.column != title || !canReorder)
        }
        .animation(FabricAnimation.reorder, value: items.map(\.id))
        .animation(FabricAnimation.reorder, value: dropTarget?.column == title ? dropTarget?.itemID : nil)
        .animation(FabricAnimation.press, value: isTargeted.wrappedValue)
    }

    // MARK: - Card View

    private func cardView(_ item: BoardItem, index: Int, items: [BoardItem], targetStatus: BoardItem.ColumnStatus) -> some View {
        let kanbanItem = item.kanbanItem
        return FabricTaskCard(
            item.title,
            ticketNumber: item.id,
            description: item.description.map { StoryMarkdownView.plainText(from: $0) },
            tags: tags(for: item),
            isSelected: selectedItemID == item.id,
            isDragging: Binding(get: { draggingItemID == item.id }, set: { _ in }),
            onTap: {
                if selectedItemID == nil {
                    withAnimation(.smooth(duration: 0.35)) { selectedItemID = item.id }
                } else {
                    selectedItemID = item.id
                }
            },
            onMoveUp: canReorder && index > 0 ? {
                handleMoveUp(item, at: index, inColumn: items, targetStatus: targetStatus)
            } : nil,
            onMoveDown: canReorder && index < items.count - 1 ? {
                handleMoveDown(item, at: index, inColumn: items, targetStatus: targetStatus)
            } : nil,
            onMoveToColumn: { columnName in
                moveItem(item, toColumnNamed: columnName)
            },
            availableColumns: availableColumns(excluding: targetStatus)
        )
        .draggable(kanbanItem) {
            FabricTaskCard(item.title, tags: tags(for: item))
                .frame(width: FabricAnimation.dragPreviewWidth)
                .opacity(FabricAnimation.dragPreviewOpacity)
                .shadow(color: FabricColors.shadow, radius: 16, y: 8)
                .onAppear { draggingItemID = item.id }
                .onDisappear { draggingItemID = nil }
        }
    }

    // MARK: - Inspector

    // MARK: - Tags

    private func tags(for item: BoardItem) -> [FabricTaskCard.Tag] {
        switch item {
        case .ticket(let ticket):
            var tags: [FabricTaskCard.Tag] = []
            tags.append(.init(ticket.type.displayName, accent: .indigo, id: "\(item.id)-type"))
            if let phase = ticket.phase,
               let roadmapPhase = state.roadmap.phases.first(where: { $0.id == phase }) {
                tags.append(.init(roadmapPhase.label, accent: .ochre, id: "\(item.id)-phase"))
            }
            if state.isBlocked(ticket) {
                tags.append(.init("Blocked", accent: .madder, id: "\(item.id)-blocked"))
            }
            return tags

        case .issue(let issue):
            var tags: [FabricTaskCard.Tag] = []
            tags.append(.init("Bug", accent: .madder, id: "\(item.id)-bug"))
            tags.append(.init(issue.severity.displayName, accent: severityAccent(issue.severity), id: "\(item.id)-severity"))
            if let phase = issue.phase,
               let roadmapPhase = state.roadmap.phases.first(where: { $0.id == phase }) {
                tags.append(.init(roadmapPhase.label, accent: .ochre, id: "\(item.id)-phase"))
            }
            return tags
        }
    }

    private func severityAccent(_ severity: IssueSeverity) -> FabricAccent {
        switch severity {
        case .critical: .madder
        case .high: .ochre
        case .medium: .indigo
        case .low: .sage
        }
    }

    // MARK: - Reorder Helpers

    /// Renumber all items in a column, inserting the moved item at the given index.
    /// Returns change tuples with gap-of-10 ordering.
    private func renumberColumn(_ items: [BoardItem], inserting moved: BoardItem,
                                at index: Int) -> [(id: String, newOrder: Int, isTicket: Bool)] {
        var ordered = items.filter { $0.id != moved.id }
        ordered.insert(moved, at: min(index, ordered.count))
        return ordered.enumerated().map { (offset, item) in
            (id: item.id, newOrder: (offset + 1) * 10, isTicket: item.isTicket)
        }
    }

    /// Renumber a column after removing an item (source column in cross-column move).
    private func renumberColumnWithout(_ items: [BoardItem], removing itemID: String) -> [(id: String, newOrder: Int, isTicket: Bool)] {
        let remaining = items.filter { $0.id != itemID }
        return remaining.enumerated().map { (offset, item) in
            (id: item.id, newOrder: (offset + 1) * 10, isTicket: item.isTicket)
        }
    }

    /// Find a BoardItem by ID from state.
    private func findBoardItem(_ id: String) -> BoardItem? {
        if let ticket = state.ticket(byID: id) { return .ticket(ticket) }
        if let issue = state.issue(byID: id) { return .issue(issue) }
        return nil
    }

    /// Announce a move for VoiceOver accessibility.
    private func announceMove(_ title: String, position: Int?, column: String) {
        let message = if let position {
            "Moved \(title) to position \(position) in \(column)"
        } else {
            "Moved \(title) to \(column)"
        }
        guard let window = NSApp.mainWindow else { return }
        NSAccessibility.post(
            element: window,
            notification: .announcementRequested,
            userInfo: [
                .announcement: message,
                .priority: NSAccessibilityPriorityLevel.high
            ]
        )
    }

    /// Column items for a given status (used for source column renumbering).
    private func columnItems(for status: BoardItem.ColumnStatus) -> [BoardItem] {
        switch status {
        case .open: openItems
        case .inprogress: inProgressItems
        case .complete: completeItems
        }
    }

    private func columnName(for status: BoardItem.ColumnStatus) -> String {
        switch status {
        case .open: "Open"
        case .inprogress: "In Progress"
        case .complete: "Complete"
        }
    }

    // MARK: - Drag & Drop Handlers

    /// Handle a card dropped onto a specific card (positional insert).
    private func handlePositionalDrop(
        _ dropped: KanbanItem,
        before target: BoardItem,
        inColumn columnItems: [BoardItem],
        targetStatus: BoardItem.ColumnStatus
    ) -> Bool {
        defer { draggingItemID = nil }
        guard let sourceItem = findBoardItem(dropped.id) else { return false }

        let targetIndex = columnItems.firstIndex(where: { $0.id == target.id }) ?? columnItems.count

        // Adjust for same-column downward moves: after removing the source item,
        // all items below it shift up by 1, so the target index must be decremented.
        var adjustedIndex = targetIndex
        if sourceItem.columnStatus == targetStatus {
            if let sourceIndex = columnItems.firstIndex(where: { $0.id == sourceItem.id }),
               sourceIndex < targetIndex {
                adjustedIndex -= 1
            }
            // No-op guard: dropping at current position
            if let sourceIndex = columnItems.firstIndex(where: { $0.id == sourceItem.id }),
               sourceIndex == adjustedIndex {
                return false
            }
        }
        var changes = renumberColumn(columnItems, inserting: sourceItem, at: adjustedIndex)

        // Cross-column: also renumber source column (item removed)
        var statusChange: (id: String, newTicketStatus: TicketStatus?,
                           newIssueStatus: IssueStatus?,
                           completedDate: String??, resolvedDate: String??)? = nil
        if sourceItem.columnStatus != targetStatus {
            let sourceColumn = self.columnItems(for: sourceItem.columnStatus)
            changes.append(contentsOf: renumberColumnWithout(sourceColumn, removing: sourceItem.id))
            statusChange = buildStatusChange(for: sourceItem, to: targetStatus)
        }

        onReorderItems?(changes, statusChange)
        let finalIndex = adjustedIndex + 1
        announceMove(sourceItem.title, position: finalIndex, column: columnName(for: targetStatus))
        return true
    }

    /// Handle a card dropped onto empty column space (append to end).
    private func handleColumnDrop(
        _ dropped: KanbanItem,
        inColumn columnItems: [BoardItem],
        targetStatus: BoardItem.ColumnStatus
    ) -> Bool {
        defer { draggingItemID = nil }
        guard let sourceItem = findBoardItem(dropped.id) else { return false }

        // If card-level drop target is active for this column, defer to it
        if let dt = dropTarget, dt.column == columnName(for: targetStatus) {
            return false
        }

        var changes = renumberColumn(columnItems, inserting: sourceItem, at: columnItems.count)

        var statusChange: (id: String, newTicketStatus: TicketStatus?,
                           newIssueStatus: IssueStatus?,
                           completedDate: String??, resolvedDate: String??)? = nil
        if sourceItem.columnStatus != targetStatus {
            let sourceColumn = self.columnItems(for: sourceItem.columnStatus)
            changes.append(contentsOf: renumberColumnWithout(sourceColumn, removing: sourceItem.id))
            statusChange = buildStatusChange(for: sourceItem, to: targetStatus)
        }

        onReorderItems?(changes, statusChange)
        announceMove(sourceItem.title, position: nil, column: columnName(for: targetStatus))
        return true
    }

    /// Handle status-only drop (All Phases mode — no reordering).
    private func handleDrop(_ dropped: KanbanItem, toStatus: BoardItem.ColumnStatus) -> Bool {
        defer { draggingItemID = nil }
        if let ticket = state.ticket(byID: dropped.id) {
            let newStatus = ticketStatus(from: toStatus)
            guard ticket.status != newStatus else { return false }
            var completedDate: String?? = nil
            if newStatus == .complete && ticket.status != .complete {
                completedDate = .some(StoryDate.today())
            } else if newStatus != .complete && ticket.status == .complete {
                completedDate = .some(nil)
            }
            let updated = ticket.with(status: newStatus, completedDate: completedDate)
            onUpdateTicket?(updated)
            return true
        } else if let issue = state.issue(byID: dropped.id) {
            let newStatus = issueStatus(from: toStatus)
            guard issue.status != newStatus else { return false }
            var resolvedDate: String?? = nil
            if newStatus == .resolved && issue.status != .resolved {
                resolvedDate = .some(StoryDate.today())
            } else if newStatus != .resolved && issue.status == .resolved {
                resolvedDate = .some(nil)
            }
            let updated = issue.with(status: newStatus, resolvedDate: resolvedDate)
            onUpdateIssue?(updated)
            return true
        }
        return false
    }

    /// Build status change tuple for cross-column moves.
    private func buildStatusChange(for item: BoardItem, to targetStatus: BoardItem.ColumnStatus) -> (id: String, newTicketStatus: TicketStatus?, newIssueStatus: IssueStatus?, completedDate: String??, resolvedDate: String??) {
        switch item {
        case .ticket(let ticket):
            let newStatus = ticketStatus(from: targetStatus)
            var completedDate: String?? = nil
            if newStatus == .complete && ticket.status != .complete {
                completedDate = .some(StoryDate.today())
            } else if newStatus != .complete && ticket.status == .complete {
                completedDate = .some(nil)
            }
            return (id: item.id, newTicketStatus: newStatus, newIssueStatus: nil, completedDate: completedDate, resolvedDate: nil)
        case .issue(let issue):
            let newStatus = issueStatus(from: targetStatus)
            var resolvedDate: String?? = nil
            if newStatus == .resolved && issue.status != .resolved {
                resolvedDate = .some(StoryDate.today())
            } else if newStatus != .resolved && issue.status == .resolved {
                resolvedDate = .some(nil)
            }
            return (id: item.id, newTicketStatus: nil, newIssueStatus: newStatus, completedDate: nil, resolvedDate: resolvedDate)
        }
    }

    // MARK: - Accessibility Reorder

    private func handleMoveUp(_ item: BoardItem, at index: Int, inColumn items: [BoardItem], targetStatus: BoardItem.ColumnStatus) {
        guard index > 0 else { return }
        var reordered = items
        reordered.swapAt(index, index - 1)
        let changes = reordered.enumerated().map { (offset, item) in
            (id: item.id, newOrder: (offset + 1) * 10, isTicket: item.isTicket)
        }
        onReorderItems?(changes, nil)
        announceMove(item.title, position: index, column: columnName(for: targetStatus))
    }

    private func handleMoveDown(_ item: BoardItem, at index: Int, inColumn items: [BoardItem], targetStatus: BoardItem.ColumnStatus) {
        guard index < items.count - 1 else { return }
        var reordered = items
        reordered.swapAt(index, index + 1)
        let changes = reordered.enumerated().map { (offset, item) in
            (id: item.id, newOrder: (offset + 1) * 10, isTicket: item.isTicket)
        }
        onReorderItems?(changes, nil)
        announceMove(item.title, position: index + 2, column: columnName(for: targetStatus))
    }

    private func moveItem(_ item: BoardItem, toColumnNamed name: String) {
        let targetStatus = columnStatusForName(name)
        if canReorder {
            let targetColumn = columnItems(for: targetStatus)
            var changes = renumberColumn(targetColumn, inserting: item, at: targetColumn.count)
            let sourceColumn = self.columnItems(for: item.columnStatus)
            changes.append(contentsOf: renumberColumnWithout(sourceColumn, removing: item.id))
            let statusChange = buildStatusChange(for: item, to: targetStatus)
            onReorderItems?(changes, statusChange)
        } else {
            _ = handleDrop(item.kanbanItem, toStatus: targetStatus)
        }
        announceMove(item.title, position: nil, column: name)
    }

    // MARK: - Status Mapping

    private func availableColumns(excluding status: BoardItem.ColumnStatus) -> [String] {
        ["Open", "In Progress", "Complete"].filter { name in
            columnStatusForName(name) != status
        }
    }

    private func columnStatusForName(_ name: String) -> BoardItem.ColumnStatus {
        switch name {
        case "In Progress": .inprogress
        case "Complete": .complete
        default: .open
        }
    }

    private func ticketStatus(from column: BoardItem.ColumnStatus) -> TicketStatus {
        switch column {
        case .open: .open
        case .inprogress: .inprogress
        case .complete: .complete
        }
    }

    private func issueStatus(from column: BoardItem.ColumnStatus) -> IssueStatus {
        switch column {
        case .open: .open
        case .inprogress: .inprogress
        case .complete: .resolved
        }
    }
}
