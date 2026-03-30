import SwiftUI
import Fabric

// MARK: - Ticket Row

struct TicketRow: View {
    let ticket: Ticket
    let isBlocked: Bool

    var body: some View {
        HStack(spacing: StorySpacing.sm) {
            StatusDot(ticketStatus: ticket.status)
                .accessibilityHidden(true)

            if isBlocked {
                Image(systemName: "lock.fill")
                    .font(.system(size: 10))
                    .foregroundStyle(StoryTheme.err)
                    .accessibilityHidden(true)
            }

            Text(ticket.title)
                .fabricTypography(.body)
                .foregroundStyle(StoryTheme.textPrimary)
                .lineLimit(1)

            Spacer()

            TypeBadge(type: ticket.type)

            Text(ticket.id)
                .fabricTypography(.monoSmall)
                .foregroundStyle(StoryTheme.textTertiary)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(accessibilityText)
    }

    private var accessibilityText: String {
        var parts = [ticket.id, ticket.title, ticket.status.displayName]
        if isBlocked { parts.append("Blocked") }
        return parts.joined(separator: ", ")
    }
}

// MARK: - Preview

#Preview("TicketRow") {
    VStack(spacing: 0) {
        TicketRow(
            ticket: Ticket(
                id: "T-035", title: "ProjectLoader — read .story/ into Swift models",
                type: .task, status: .open, phase: .viewer, order: 10,
                description: "", createdDate: "2026-03-10"
            ),
            isBlocked: false
        )
        .padding(StorySpacing.sm)

        TicketRow(
            ticket: Ticket(
                id: "T-036", title: "FileWatcher — monitor file changes",
                type: .feature, status: .complete, phase: .viewer, order: 20,
                description: "", createdDate: "2026-03-10", completedDate: "2026-03-11"
            ),
            isBlocked: false
        )
        .padding(StorySpacing.sm)

        TicketRow(
            ticket: Ticket(
                id: "T-039", title: "Overview content view",
                type: .chore, status: .open, phase: .viewer, order: 50,
                description: "", createdDate: "2026-03-10",
                blockedBy: ["T-048"]
            ),
            isBlocked: true
        )
        .padding(StorySpacing.sm)
    }
    .frame(width: 500)
    .background(StoryTheme.base)
}
