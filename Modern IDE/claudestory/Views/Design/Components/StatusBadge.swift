import SwiftUI
import Fabric

// MARK: - Status Badge

struct StatusBadge: View {
    private let text: String
    private let accent: FabricAccent?

    init(ticketStatus: TicketStatus) {
        text = ticketStatus.displayName
        switch ticketStatus {
        case .open: accent = nil
        case .inprogress: accent = .ochre
        case .complete: accent = .sage
        }
    }

    init(issueStatus: IssueStatus) {
        text = issueStatus.displayName
        switch issueStatus {
        case .open: accent = .ochre
        case .inprogress: accent = .indigo
        case .resolved: accent = .sage
        }
    }

    init(phaseStatus: PhaseStatus) {
        text = phaseStatus.displayName
        switch phaseStatus {
        case .notstarted: accent = nil
        case .inprogress: accent = .ochre
        case .complete: accent = .sage
        }
    }

    var body: some View {
        FabricBadge(text, accent: accent)
    }
}

// MARK: - Preview

#Preview("StatusBadge") {
    VStack(alignment: .leading, spacing: StorySpacing.sm) {
        Text("Ticket").fabricLabel()
        HStack(spacing: StorySpacing.xs) {
            StatusBadge(ticketStatus: .open)
            StatusBadge(ticketStatus: .inprogress)
            StatusBadge(ticketStatus: .complete)
        }
        Text("Issue").fabricLabel()
        HStack(spacing: StorySpacing.xs) {
            StatusBadge(issueStatus: .open)
            StatusBadge(issueStatus: .inprogress)
            StatusBadge(issueStatus: .resolved)
        }
        Text("Phase").fabricLabel()
        HStack(spacing: StorySpacing.xs) {
            StatusBadge(phaseStatus: .notstarted)
            StatusBadge(phaseStatus: .inprogress)
            StatusBadge(phaseStatus: .complete)
        }
    }
    .padding(StorySpacing.lg)
    .background(StoryTheme.base)
}
