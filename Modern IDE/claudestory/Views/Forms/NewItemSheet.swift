import SwiftUI
import Fabric

// MARK: - Item Kind

private enum ItemKind: String, CaseIterable, Hashable {
    case ticket = "Ticket"
    case issue = "Issue"
}

// MARK: - New Item Sheet

/// Unified creation sheet for tickets and issues.
/// User picks the item kind first, then fills in the appropriate fields.
/// IDs and order values are computed at submit time via closures to prevent stale values (ISS-006).
struct NewItemSheet: View {
    let nextTicketID: () -> String
    let nextIssueID: () -> String
    let defaultPhase: PhaseID?
    let defaultOrder: Int
    let phases: [Phase]
    var nextOrderForPhase: ((PhaseID?) -> Int)? = nil
    var onCreateTicket: ((Ticket) -> Void)? = nil
    var onCreateIssue: ((Issue) -> Void)? = nil

    @Environment(\.dismiss) private var dismiss

    @State private var kind: ItemKind = .ticket
    // Shared fields
    @State private var title = ""
    @State private var phase: PhaseID?
    @State private var itemOrder: Int = 10
    // Ticket fields
    @State private var description = ""
    @State private var ticketType: TicketType = .task
    // Issue fields
    @State private var impact = ""
    @State private var severity: IssueSeverity = .medium

    private var isValid: Bool {
        !title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    var body: some View {
        VStack(spacing: 0) {
            // Header
            HStack {
                Text("New Item")
                    .fabricTitle()
                Spacer()
                Text(kind == .ticket ? nextTicketID() : nextIssueID())
                    .fabricMonoCaption()
            }
            .padding(StorySpacing.lg)

            Divider()

            // Form
            ScrollView {
                VStack(alignment: .leading, spacing: StorySpacing.md) {
                    // Kind picker
                    FabricCard {
                        VStack(alignment: .leading, spacing: StorySpacing.sm) {
                            Text("Type")
                                .fabricLabel()
                            Picker("Kind", selection: $kind) {
                                ForEach(ItemKind.allCases, id: \.self) { k in
                                    Text(k.rawValue).tag(k)
                                }
                            }
                            .pickerStyle(.segmented)
                        }
                    }

                    // Title (required for both)
                    FabricCard {
                        VStack(alignment: .leading, spacing: StorySpacing.sm) {
                            Text("Title")
                                .fabricLabel()
                            FabricTextField(
                                placeholder: kind == .ticket ? "Ticket title..." : "Issue title...",
                                text: $title
                            )
                        }
                    }

                    if kind == .ticket {
                        ticketFields
                    } else {
                        issueFields
                    }

                    // Phase (shared, optional)
                    if !phases.isEmpty {
                        FabricCard {
                            VStack(alignment: .leading, spacing: StorySpacing.sm) {
                                Text("Phase")
                                    .fabricLabel()
                                Picker("Phase", selection: $phase) {
                                    Text("None").tag(PhaseID?.none)
                                    ForEach(phases) { p in
                                        Text("\(p.label) — \(p.name)").tag(PhaseID?.some(p.id))
                                    }
                                }
                                .pickerStyle(.menu)
                            }
                        }
                    }
                }
                .padding(StorySpacing.lg)
            }

            Divider()

            // Actions
            HStack {
                Button("Cancel") { dismiss() }
                    .buttonStyle(.fabricGhost)
                    .keyboardShortcut(.cancelAction)
                Spacer()
                Button(kind == .ticket ? "Create Ticket" : "Create Issue") {
                    createAndDismiss()
                }
                .buttonStyle(.fabric)
                .keyboardShortcut(.defaultAction)
                .disabled(!isValid)
            }
            .padding(StorySpacing.lg)
        }
        .frame(width: 500, height: 550)
        .background(StoryTheme.base)
        .onAppear {
            title = ""
            description = ""
            impact = ""
            ticketType = .task
            severity = .medium
            phase = defaultPhase
            itemOrder = defaultOrder
        }
        .onChange(of: phase) { _, newPhase in
            itemOrder = nextOrderForPhase?(newPhase) ?? 10
        }
        .onChange(of: kind) { _, _ in
            itemOrder = nextOrderForPhase?(phase) ?? 10
        }
    }

    // MARK: - Ticket Fields

    private var ticketFields: some View {
        Group {
            FabricCard {
                VStack(alignment: .leading, spacing: StorySpacing.sm) {
                    Text("Ticket Type")
                        .fabricLabel()
                    Picker("Ticket Type", selection: $ticketType) {
                        ForEach(TicketType.allCases, id: \.self) { t in
                            Text(t.displayName).tag(t)
                        }
                    }
                    .pickerStyle(.segmented)
                }
            }

            FabricCard {
                VStack(alignment: .leading, spacing: StorySpacing.sm) {
                    Text("Description")
                        .fabricLabel()
                    TextEditor(text: $description)
                        .font(.body)
                        .frame(minHeight: 80)
                        .scrollContentBackground(.hidden)
                }
            }
        }
    }

    // MARK: - Issue Fields

    private var issueFields: some View {
        Group {
            FabricCard {
                VStack(alignment: .leading, spacing: StorySpacing.sm) {
                    Text("Severity")
                        .fabricLabel()
                    Picker("Severity", selection: $severity) {
                        ForEach(IssueSeverity.allCases, id: \.self) { s in
                            Text(s.displayName).tag(s)
                        }
                    }
                    .pickerStyle(.segmented)
                }
            }

            FabricCard {
                VStack(alignment: .leading, spacing: StorySpacing.sm) {
                    Text("Impact")
                        .fabricLabel()
                    TextEditor(text: $impact)
                        .font(.body)
                        .frame(minHeight: 80)
                        .scrollContentBackground(.hidden)
                }
            }
        }
    }

    // MARK: - Create

    private func createAndDismiss() {
        let trimmedTitle = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedTitle.isEmpty else { return }

        // Compute fresh ID and order at submit time (ISS-006 fix)
        let freshOrder = nextOrderForPhase?(phase) ?? itemOrder

        if kind == .ticket {
            let freshID = nextTicketID()
            let ticket = Ticket(
                id: freshID,
                title: trimmedTitle,
                type: ticketType,
                status: .open,
                phase: phase,
                order: freshOrder,
                description: description.trimmingCharacters(in: .whitespacesAndNewlines),
                createdDate: StoryDate.today()
            )
            onCreateTicket?(ticket)
        } else {
            let freshID = nextIssueID()
            let issue = Issue(
                id: freshID,
                title: trimmedTitle,
                status: .open,
                severity: severity,
                components: [],
                impact: impact.trimmingCharacters(in: .whitespacesAndNewlines),
                resolution: nil,
                location: [],
                discoveredDate: StoryDate.today(),
                resolvedDate: nil,
                relatedTickets: [],
                order: freshOrder,
                phase: phase
            )
            onCreateIssue?(issue)
        }
        dismiss()
    }
}
