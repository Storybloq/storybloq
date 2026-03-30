import SwiftUI
import Fabric

// MARK: - Ticket Inspector View

/// Always-editable ticket editor for the kanban board inspector sidebar.
/// Uses last-known-model comparison to prevent file-watcher races during editing.
struct TicketInspectorView: View {
    let ticketID: String
    let state: ProjectState
    var onUpdateTicket: ((Ticket) -> Void)? = nil

    @State private var title = ""
    @State private var description = ""
    @State private var lastModelTitle = ""
    @State private var lastModelDescription = ""
    @State private var previousTicketID: String?
    @State private var blockerToRemove: String? = nil
    @State private var saveTask: Task<Void, Never>?
    @State private var isPreviewingDescription = false

    private var ticket: Ticket? {
        state.ticket(byID: ticketID)
    }

    var body: some View {
        if let ticket {
            ScrollView {
                VStack(alignment: .leading, spacing: StorySpacing.lg) {
                    titleSection
                    descriptionSection
                    phaseSection(ticket)
                    blockedBySection(ticket)
                    typeSection(ticket)
                }
                .padding(StorySpacing.md)
            }
            .task(id: ticketID) {
                // Flush dirty edits for the previous record before reseeding
                if let oldID = previousTicketID, oldID != ticketID,
                   let oldTicket = state.ticket(byID: oldID) {
                    saveTask?.cancel()
                    let trimmedTitle = title.trimmingCharacters(in: .whitespacesAndNewlines)
                    let finalTitle = trimmedTitle.isEmpty ? oldTicket.title : trimmedTitle
                    if finalTitle != oldTicket.title || description != oldTicket.description {
                        Log.info("TicketInspector: flush save for \(oldID)", tag: "Tickets")
                        let updated = oldTicket.with(title: finalTitle, description: description)
                        onUpdateTicket?(updated)
                    }
                } else {
                    saveTask?.cancel()
                }
                previousTicketID = ticketID
                title = ticket.title
                description = ticket.description
                lastModelTitle = ticket.title
                lastModelDescription = ticket.description
                isPreviewingDescription = !ticket.description.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            }
            .onChange(of: ticket) { _, newTicket in
                // Title: clean if normalized UI matches either lastModel or incoming model
                let trimmedUI = title.trimmingCharacters(in: .whitespacesAndNewlines)
                let trimmedLast = lastModelTitle.trimmingCharacters(in: .whitespacesAndNewlines)
                let trimmedNew = newTicket.title.trimmingCharacters(in: .whitespacesAndNewlines)
                if trimmedUI == trimmedLast || trimmedUI == trimmedNew {
                    title = newTicket.title
                }
                lastModelTitle = newTicket.title

                // Description: raw comparison (no trimming for markdown)
                if description == lastModelDescription || description == newTicket.description {
                    description = newTicket.description
                }
                lastModelDescription = newTicket.description
            }
            .confirmationDialog(
                "Remove Dependency",
                isPresented: .init(
                    get: { blockerToRemove != nil },
                    set: { if !$0 { blockerToRemove = nil } }
                ),
                presenting: blockerToRemove
            ) { blockerID in
                Button("Remove", role: .destructive) {
                    removeBlocker(blockerID, from: ticket)
                    blockerToRemove = nil
                }
                Button("Cancel", role: .cancel) {
                    blockerToRemove = nil
                }
            } message: { blockerID in
                Text("Remove \(blockerID) from blocked-by list?")
            }
        } else {
            EmptyState(icon: "ticket", title: "Ticket Not Found")
        }
    }

    // MARK: - Title

    private var titleSection: some View {
        VStack(alignment: .leading, spacing: StorySpacing.sm) {
            Text("Title")
                .fabricTypography(.caption)
                .foregroundStyle(FabricColors.inkTertiary)

            FabricTextField(
                placeholder: "Ticket title",
                text: $title
            )
            .onChange(of: title) { _, _ in debouncedSave() }
        }
    }

    // MARK: - Description

    private var descriptionSection: some View {
        VStack(alignment: .leading, spacing: StorySpacing.sm) {
            HStack {
                Text("Description")
                    .fabricTypography(.caption)
                    .foregroundStyle(FabricColors.inkTertiary)
                Spacer()
                Button {
                    isPreviewingDescription.toggle()
                } label: {
                    Text(isPreviewingDescription ? "Edit" : "Preview")
                        .fabricTypography(.caption)
                }
                .buttonStyle(.plain)
                .foregroundStyle(FabricColors.inkTertiary)
            }

            if isPreviewingDescription {
                MarkdownPreviewBox(
                    text: description,
                    placeholder: "No description",
                    minHeight: 400
                )
            } else {
                FabricTextEditor(
                    placeholder: "Describe this ticket...",
                    text: $description,
                    minHeight: 400,
                    maxHeight: .infinity
                )
                .onChange(of: description) { _, _ in debouncedSave() }
            }
        }
    }

    // MARK: - Type

    private func typeSection(_ ticket: Ticket) -> some View {
        VStack(alignment: .leading, spacing: StorySpacing.sm) {
            Text("Type")
                .fabricTypography(.caption)
                .foregroundStyle(FabricColors.inkTertiary)

            FabricSegmentedControl(
                selection: typeBinding(ticket),
                segments: TicketType.allCases.map {
                    .init($0.displayName, value: $0)
                },
                accent: .indigo
            )
        }
    }

    // MARK: - Phase

    private func phaseSection(_ ticket: Ticket) -> some View {
        VStack(alignment: .leading, spacing: StorySpacing.sm) {
            Text("Phase")
                .fabricTypography(.caption)
                .foregroundStyle(FabricColors.inkTertiary)

            Picker("Phase", selection: phaseBinding(ticket)) {
                Text("None").tag(PhaseID?.none)
                ForEach(state.roadmap.phases) { phase in
                    Text("\(phase.label) — \(phase.name)").tag(PhaseID?.some(phase.id))
                }
            }
            .pickerStyle(.menu)
        }
    }

    // MARK: - Blocked By

    private func blockedBySection(_ ticket: Ticket) -> some View {
        VStack(alignment: .leading, spacing: StorySpacing.sm) {
            HStack {
                Text("Blocked By")
                    .fabricTypography(.caption)
                    .foregroundStyle(FabricColors.inkTertiary)
                Spacer()
                addBlockerMenu(ticket)
            }

            if ticket.blockedBy.isEmpty {
                Text("No dependencies")
                    .fabricTypography(.caption)
                    .foregroundStyle(FabricColors.inkTertiary)
            } else {
                FabricFlowLayout(spacing: StorySpacing.xs) {
                    ForEach(ticket.blockedBy, id: \.self) { blockerID in
                        let blockerTitle = state.ticket(byID: blockerID)?.title ?? blockerID
                        FabricChip(
                            blockerID,
                            accent: .indigo,
                            isRemovable: true,
                            onRemove: {
                                blockerToRemove = blockerID
                            }
                        )
                        .help(blockerTitle)
                    }
                }
            }
        }
    }

    // MARK: - Bindings (instant save)

    private func typeBinding(_ ticket: Ticket) -> Binding<TicketType> {
        Binding(
            get: { ticket.type },
            set: { newType in
                Log.info("TicketInspector: type → \(newType.displayName) for \(ticketID)", tag: "Tickets")
                let updated = ticket.with(type: newType)
                onUpdateTicket?(updated)
            }
        )
    }

    private func phaseBinding(_ ticket: Ticket) -> Binding<PhaseID?> {
        Binding(
            get: { ticket.phase },
            set: { newPhase in
                Log.info("TicketInspector: phase → \(newPhase?.rawValue ?? "none") for \(ticketID)", tag: "Tickets")
                let updated = ticket.with(phase: .some(newPhase))
                onUpdateTicket?(updated)
            }
        )
    }

    // MARK: - Save

    private func debouncedSave() {
        saveTask?.cancel()
        let currentID = ticketID
        saveTask = Task {
            try? await Task.sleep(for: .seconds(1))
            guard !Task.isCancelled else { return }
            guard let ticket = state.ticket(byID: currentID) else { return }
            let trimmedTitle = title.trimmingCharacters(in: .whitespacesAndNewlines)
            let finalTitle = trimmedTitle.isEmpty ? ticket.title : trimmedTitle
            guard finalTitle != ticket.title || description != ticket.description else { return }
            Log.info("TicketInspector: saving title/description for \(currentID)", tag: "Tickets")
            let updated = ticket.with(title: finalTitle, description: description)
            onUpdateTicket?(updated)
        }
    }

    // MARK: - Blocker Actions

    private func addBlockerMenu(_ ticket: Ticket) -> some View {
        let candidates = availableBlockerCandidates(for: ticket)
        return Menu {
            if candidates.isEmpty {
                Text("No available tickets")
            } else {
                ForEach(candidates) { candidate in
                    Button("\(candidate.id): \(candidate.title)") {
                        addBlocker(candidate.id, to: ticket)
                    }
                }
            }
        } label: {
            Label("Add", systemImage: "plus.circle")
                .fabricTypography(.caption)
        }
        .menuStyle(.borderlessButton)
    }

    private func availableBlockerCandidates(for ticket: Ticket) -> [Ticket] {
        state.tickets.filter { candidate in
            guard candidate.id != ticket.id else { return false }
            guard !ticket.blockedBy.contains(candidate.id) else { return false }
            guard !wouldCreateCycle(adding: candidate.id, to: ticket) else { return false }
            return true
        }
        .sorted { $0.id < $1.id }
    }

    private func wouldCreateCycle(adding blockerID: String, to ticket: Ticket) -> Bool {
        var visited = Set<String>()
        var stack = [blockerID]
        while let current = stack.popLast() {
            guard visited.insert(current).inserted else { continue }
            guard let currentTicket = state.ticket(byID: current) else { continue }
            for dep in currentTicket.blockedBy {
                if dep == ticket.id { return true }
                stack.append(dep)
            }
        }
        return false
    }

    private func addBlocker(_ blockerID: String, to ticket: Ticket) {
        let updated = ticket.with(blockedBy: ticket.blockedBy + [blockerID])
        onUpdateTicket?(updated)
    }

    private func removeBlocker(_ blockerID: String, from ticket: Ticket) {
        let updated = ticket.with(blockedBy: ticket.blockedBy.filter { $0 != blockerID })
        onUpdateTicket?(updated)
    }
}
