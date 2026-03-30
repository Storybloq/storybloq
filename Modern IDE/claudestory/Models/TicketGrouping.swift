import Foundation

// MARK: - Ticket Group

struct TicketGroup: Identifiable {
    let id: String
    let title: String?
    let umbrellaStatus: PhaseStatus?
    let tickets: [Ticket]
}

// MARK: - Grouping Logic

/// Groups leaf tickets into standalone and umbrella-parented groups.
/// Standalone tickets (no parentTicket) appear first; umbrella groups follow, sorted by umbrella order.
nonisolated func groupTickets(leafTickets: [Ticket], state: ProjectState) -> [TicketGroup] {
    let standalone = leafTickets.filter { $0.parentTicket == nil }
    let withParent = leafTickets.filter { $0.parentTicket != nil }

    var groups: [TicketGroup] = []

    // Standalone group
    if !standalone.isEmpty {
        groups.append(TicketGroup(
            id: "standalone",
            title: nil,
            umbrellaStatus: nil,
            tickets: standalone
        ))
    }

    // Group by parent, then sort by umbrella order
    let grouped = Dictionary(grouping: withParent) { $0.parentTicket! }
    let umbrellaGroups: [(order: Int, group: TicketGroup)] = grouped.compactMap { parentID, children in
        guard let umbrella = state.tickets.first(where: { $0.id == parentID }) else {
            return (order: Int.max, group: TicketGroup(
                id: parentID,
                title: parentID,
                umbrellaStatus: nil,
                tickets: children
            ))
        }
        return (order: umbrella.order, group: TicketGroup(
            id: parentID,
            title: umbrella.title,
            umbrellaStatus: state.umbrellaStatus(parentID),
            tickets: children
        ))
    }

    groups.append(contentsOf: umbrellaGroups.sorted { ($0.order, $0.group.id) < ($1.order, $1.group.id) }.map(\.group))
    return groups
}
