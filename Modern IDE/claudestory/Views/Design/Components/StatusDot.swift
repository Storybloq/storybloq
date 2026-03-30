import SwiftUI
import Fabric

// MARK: - Status Dot

struct StatusDot: View {
    private let accent: FabricAccent?
    private let label: String

    init(ticketStatus: TicketStatus) {
        switch ticketStatus {
        case .open: accent = nil
        case .inprogress: accent = .ochre
        case .complete: accent = .sage
        }
        label = ticketStatus.displayName
    }

    init(issueStatus: IssueStatus) {
        switch issueStatus {
        case .open: accent = .ochre
        case .inprogress: accent = .indigo
        case .resolved: accent = .sage
        }
        label = issueStatus.displayName
    }

    init(phaseStatus: PhaseStatus) {
        switch phaseStatus {
        case .notstarted: accent = nil
        case .inprogress: accent = .ochre
        case .complete: accent = .sage
        }
        label = phaseStatus.displayName
    }

    var body: some View {
        FabricStatusDot(accent: accent, label: label)
    }
}

// MARK: - Preview

#Preview("StatusDot") {
    HStack(spacing: StorySpacing.md) {
        VStack(alignment: .leading, spacing: StorySpacing.sm) {
            Text("Ticket").fabricCaption()
            HStack(spacing: StorySpacing.xs) {
                StatusDot(ticketStatus: .open)
                StatusDot(ticketStatus: .inprogress)
                StatusDot(ticketStatus: .complete)
            }
        }
        VStack(alignment: .leading, spacing: StorySpacing.sm) {
            Text("Phase").fabricCaption()
            HStack(spacing: StorySpacing.xs) {
                StatusDot(phaseStatus: .notstarted)
                StatusDot(phaseStatus: .inprogress)
                StatusDot(phaseStatus: .complete)
            }
        }
        VStack(alignment: .leading, spacing: StorySpacing.sm) {
            Text("Issue").fabricCaption()
            HStack(spacing: StorySpacing.xs) {
                StatusDot(issueStatus: .open)
                StatusDot(issueStatus: .inprogress)
                StatusDot(issueStatus: .resolved)
            }
        }
    }
    .padding(StorySpacing.lg)
    .background(StoryTheme.base)
}
