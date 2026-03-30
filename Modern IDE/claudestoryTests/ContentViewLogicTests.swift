import Foundation
import Testing
@testable import Modern_IDE

// MARK: - Test Helpers

private func makeTicket(
    id: String,
    status: TicketStatus = .open,
    phase: PhaseID = .viewer,
    order: Int = 10,
    blockedBy: [String] = [],
    parentTicket: String? = nil
) -> Ticket {
    Ticket(
        id: id, title: "Test \(id)", type: .task, status: status,
        phase: phase, order: order, description: "Test ticket.",
        createdDate: "2026-03-11", blockedBy: blockedBy, parentTicket: parentTicket
    )
}

private func makeState(
    tickets: [Ticket] = [],
    roadmap: Roadmap? = nil
) -> ProjectState {
    ProjectState(
        tickets: tickets,
        issues: [],
        roadmap: roadmap ?? Roadmap(title: "test", date: "2026-03-11", phases: [
            Phase(id: .viewer, label: "PHASE 1", name: "Test Phase", description: ""),
        ], blockers: []),
        config: Config(
            version: 1, project: "test", type: "macapp", language: "swift",
            features: Config.Features(tickets: true, issues: true, handovers: true, roadmap: true, reviews: false)
        ),
        handoverFilenames: []
    )
}

// MARK: - PhaseContentView Grouping Tests

struct PhaseTicketGroupingTests {
    @Test func standaloneTicketsGroupedWithoutUmbrella() {
        let a = makeTicket(id: "A", order: 20)
        let b = makeTicket(id: "B", order: 10)
        let state = makeState(tickets: [a, b])
        let leafTickets = state.phaseTickets(.viewer)

        let groups = groupTickets(leafTickets: leafTickets, state: state)

        #expect(groups.count == 1)
        #expect(groups[0].id == "standalone")
        #expect(groups[0].title == nil)
        #expect(groups[0].tickets.map(\.id) == ["B", "A"])
    }

    @Test func childrenGroupedUnderUmbrella() {
        let umbrella = makeTicket(id: "U", order: 10)
        let c1 = makeTicket(id: "C1", order: 20, parentTicket: "U")
        let c2 = makeTicket(id: "C2", order: 30, parentTicket: "U")
        let state = makeState(tickets: [umbrella, c1, c2])
        let leafTickets = state.phaseTickets(.viewer)

        let groups = groupTickets(leafTickets: leafTickets, state: state)

        #expect(groups.count == 1)
        #expect(groups[0].id == "U")
        #expect(groups[0].title == "Test U")
        #expect(groups[0].tickets.map(\.id) == ["C1", "C2"])
    }

    @Test func emptyPhaseReturnsEmptyGroups() {
        let state = makeState(tickets: [])
        let leafTickets = state.phaseTickets(.viewer)

        let groups = groupTickets(leafTickets: leafTickets, state: state)

        #expect(groups.isEmpty)
    }

    @Test func orphanedChildrenGroupedUnderMissingParent() {
        // Parent not in ticket list — children should still be grouped
        let orphan = makeTicket(id: "O", order: 10, parentTicket: "MISSING")
        let state = makeState(tickets: [orphan])
        let leafTickets = state.phaseTickets(.viewer)

        let groups = groupTickets(leafTickets: leafTickets, state: state)

        #expect(groups.count == 1)
        #expect(groups[0].id == "MISSING")
        #expect(groups[0].title == "MISSING") // fallback: uses ID as title
        #expect(groups[0].tickets.count == 1)
    }

    @Test func mixedStandaloneAndUmbrellaGrouped() {
        let umbrella = makeTicket(id: "U", order: 50)
        let child = makeTicket(id: "C", order: 60, parentTicket: "U")
        let standalone = makeTicket(id: "S", order: 10)
        let state = makeState(tickets: [umbrella, child, standalone])
        let leafTickets = state.phaseTickets(.viewer)

        let groups = groupTickets(leafTickets: leafTickets, state: state)

        #expect(groups.count == 2)
        // Standalone first
        #expect(groups[0].id == "standalone")
        #expect(groups[0].tickets.map(\.id) == ["S"])
        // Then umbrella group
        #expect(groups[1].id == "U")
        #expect(groups[1].tickets.map(\.id) == ["C"])
    }
}
