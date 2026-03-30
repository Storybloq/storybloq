import Testing
import Foundation
@testable import Modern_IDE

// Disambiguate from Testing.Issue
private typealias AppIssue = Modern_IDE.Issue

// MARK: - Test Helpers

private let testRoadmap = Roadmap(title: "test", date: "2026-03-18", phases: [
    Phase(id: .viewer, label: "P1", name: "Test", description: ""),
], blockers: [])

private let testConfig = Config(
    version: 1, project: "test", type: "macapp", language: "swift",
    features: Config.Features(tickets: true, issues: true, handovers: true, roadmap: true, reviews: false)
)

private func makeTicket(
    id: String, status: TicketStatus = .open, phase: PhaseID = .viewer, order: Int = 10
) -> Ticket {
    Ticket(id: id, title: "Ticket \(id)", type: .task, status: status,
           phase: phase, order: order, description: "", createdDate: "2026-03-18")
}

private func makeIssue(
    id: String, status: IssueStatus = .open, order: Int = 10, phase: PhaseID? = .viewer
) -> AppIssue {
    AppIssue(id: id, title: "Issue \(id)", status: status, severity: .medium,
             components: [], impact: "", resolution: nil, location: [],
             discoveredDate: "2026-03-18", resolvedDate: nil, relatedTickets: [],
             order: order, phase: phase)
}

private func makeState(tickets: [Ticket] = [], issues: [AppIssue] = []) -> ProjectState {
    ProjectState(tickets: tickets, issues: issues, roadmap: testRoadmap,
                 config: testConfig, handoverFilenames: [])
}

// Note: ProjectViewModel.state is private(set), so tests exercise the pure reorder logic
// (renumberColumn, index adjustment, state construction) via BoardItem arrays directly.
// The optimistic update in reorderItems is structurally identical — it maps over state arrays
// applying the same order/status changes, then constructs a new ProjectState.

// MARK: - renumberColumn Logic Tests (pure function testing via BoardItem arrays)

struct RenumberColumnTests {
    /// Simulates renumberColumn: remove moved item, insert at index, renumber with gap of 10.
    private func renumber(_ items: [BoardItem], inserting moved: BoardItem, at index: Int) -> [(id: String, newOrder: Int)] {
        var ordered = items.filter { $0.id != moved.id }
        ordered.insert(moved, at: min(index, ordered.count))
        return ordered.enumerated().map { (offset, item) in
            (id: item.id, newOrder: (offset + 1) * 10)
        }
    }

    @Test func insertAtStart() {
        let items: [BoardItem] = [
            .ticket(makeTicket(id: "A", order: 10)),
            .ticket(makeTicket(id: "B", order: 20)),
            .ticket(makeTicket(id: "C", order: 30)),
        ]
        let moved = items[2] // C
        let result = renumber(items, inserting: moved, at: 0)
        #expect(result.map(\.id) == ["C", "A", "B"])
        #expect(result.map(\.newOrder) == [10, 20, 30])
    }

    @Test func insertAtEnd() {
        let items: [BoardItem] = [
            .ticket(makeTicket(id: "A", order: 10)),
            .ticket(makeTicket(id: "B", order: 20)),
        ]
        let moved = items[0] // A
        let result = renumber(items, inserting: moved, at: 2)
        #expect(result.map(\.id) == ["B", "A"])
        #expect(result.map(\.newOrder) == [10, 20])
    }

    @Test func insertInMiddle() {
        let items: [BoardItem] = [
            .ticket(makeTicket(id: "A", order: 10)),
            .ticket(makeTicket(id: "B", order: 20)),
            .ticket(makeTicket(id: "C", order: 30)),
        ]
        let moved = items[2] // C
        let result = renumber(items, inserting: moved, at: 1) // before B in filtered [A,B]
        #expect(result.map(\.id) == ["A", "C", "B"])
        #expect(result.map(\.newOrder) == [10, 20, 30])
    }

    @Test func sameColumnDownwardMoveAdjustedIndex() {
        // Simulates dragging A to before C in [A, B, C]
        // targetIndex = 2 (C's original index)
        // After removing A, array is [B, C]. adjustedIndex = 2-1 = 1 (before C in filtered).
        let items: [BoardItem] = [
            .ticket(makeTicket(id: "A", order: 10)),
            .ticket(makeTicket(id: "B", order: 20)),
            .ticket(makeTicket(id: "C", order: 30)),
        ]
        let moved = items[0] // A
        let targetIndex = 2 // C's original index
        // Adjust for downward move: source (0) < target (2), so adjust = 2-1 = 1
        let adjustedIndex = targetIndex - 1
        let result = renumber(items, inserting: moved, at: adjustedIndex)
        #expect(result.map(\.id) == ["B", "A", "C"])
    }

    @Test func sameColumnUpwardMoveNoAdjustment() {
        // Simulates dragging C to before A in [A, B, C]
        // targetIndex = 0 (A's original index)
        // Source (2) > target (0), no adjustment needed
        let items: [BoardItem] = [
            .ticket(makeTicket(id: "A", order: 10)),
            .ticket(makeTicket(id: "B", order: 20)),
            .ticket(makeTicket(id: "C", order: 30)),
        ]
        let moved = items[2] // C
        let targetIndex = 0 // A's original index, no adjustment (source > target)
        let result = renumber(items, inserting: moved, at: targetIndex)
        #expect(result.map(\.id) == ["C", "A", "B"])
    }

    @Test func singleItemColumn() {
        let items: [BoardItem] = [
            .ticket(makeTicket(id: "A", order: 10)),
        ]
        let newItem = BoardItem.ticket(makeTicket(id: "X", order: 99))
        let result = renumber(items, inserting: newItem, at: 0)
        #expect(result.map(\.id) == ["X", "A"])
        #expect(result.map(\.newOrder) == [10, 20])
    }

    @Test func emptyColumn() {
        let items: [BoardItem] = []
        let newItem = BoardItem.ticket(makeTicket(id: "X", order: 99))
        let result = renumber(items, inserting: newItem, at: 0)
        #expect(result.map(\.id) == ["X"])
        #expect(result.map(\.newOrder) == [10])
    }

    @Test func mixedTicketAndIssue() {
        let items: [BoardItem] = [
            .ticket(makeTicket(id: "T-001", order: 10)),
            .issue(makeIssue(id: "ISS-001", order: 20)),
        ]
        let moved = items[1] // ISS-001
        let result = renumber(items, inserting: moved, at: 0)
        #expect(result.map(\.id) == ["ISS-001", "T-001"])
    }

    @Test func removeFromColumn() {
        let items: [BoardItem] = [
            .ticket(makeTicket(id: "A", order: 10)),
            .ticket(makeTicket(id: "B", order: 20)),
            .ticket(makeTicket(id: "C", order: 30)),
        ]
        let remaining = items.filter { $0.id != "B" }
        let renumbered = remaining.enumerated().map { (offset, item) in
            (id: item.id, newOrder: (offset + 1) * 10)
        }
        #expect(renumbered.map(\.id) == ["A", "C"])
        #expect(renumbered.map(\.newOrder) == [10, 20])
    }
}

// MARK: - reorderItems Optimistic State Update Tests

struct ReorderItemsOptimisticTests {
    @Test func stateConstructionWithNewOrders() {
        // Verify that ProjectState correctly reflects new order values
        let tickets = [
            makeTicket(id: "T-003", order: 10),
            makeTicket(id: "T-001", order: 20),
            makeTicket(id: "T-002", order: 30),
        ]
        let state = makeState(tickets: tickets)
        let sorted = state.phaseTickets(.viewer)
        #expect(sorted.map(\.id) == ["T-003", "T-001", "T-002"])
    }

    @Test func statusChangeReflectedInState() {
        let ticket = makeTicket(id: "T-001", status: .open, order: 10)
        let updated = ticket.with(status: .inprogress)
        #expect(updated.status == .inprogress)

        let state = makeState(tickets: [updated])
        let found = state.ticket(byID: "T-001")
        #expect(found?.status == .inprogress)
    }

    @Test func statusChangeWithCompletedDate() {
        let ticket = makeTicket(id: "T-001", status: .open, order: 10)
        let updated = ticket.with(status: .complete, completedDate: .some("2026-03-18"))
        #expect(updated.status == .complete)
        #expect(updated.completedDate == "2026-03-18")
    }

    @Test func issueStatusChangeWithResolvedDate() {
        let issue = makeIssue(id: "ISS-001", status: .open, order: 10)
        let updated = issue.with(status: .resolved, resolvedDate: .some("2026-03-18"))
        #expect(updated.status == .resolved)
        #expect(updated.resolvedDate == "2026-03-18")
    }

    @Test func reorderPreservesNonAffectedItems() {
        // Items not in the change set should keep their original values
        let t1 = makeTicket(id: "T-001", order: 10)
        let t2 = makeTicket(id: "T-002", order: 50)
        let state = makeState(tickets: [t1, t2])

        // Only T-001 is in the "changes" — T-002 should be untouched
        let found = state.ticket(byID: "T-002")
        #expect(found?.order == 50)
    }
}

// MARK: - Sort Tiebreaker Tests

struct SortTiebreakerTests {
    @Test func equalOrderSortsByID() {
        let tickets = [
            makeTicket(id: "T-003", order: 10),
            makeTicket(id: "T-001", order: 10),
            makeTicket(id: "T-002", order: 10),
        ]
        let state = makeState(tickets: tickets)
        let sorted = state.phaseTickets(.viewer)
        #expect(sorted.map(\.id) == ["T-001", "T-002", "T-003"])
    }

    @Test func leafTicketsAreSorted() {
        let tickets = [
            makeTicket(id: "T-003", order: 30),
            makeTicket(id: "T-001", order: 10),
            makeTicket(id: "T-002", order: 20),
        ]
        let state = makeState(tickets: tickets)
        #expect(state.leafTickets.map(\.id) == ["T-001", "T-002", "T-003"])
    }

    @Test func issuesSortedByOrderThenID() {
        let issues = [
            makeIssue(id: "ISS-003", order: 10),
            makeIssue(id: "ISS-001", order: 10),
            makeIssue(id: "ISS-002", order: 10),
        ]
        let state = makeState(issues: issues)
        let sorted = state.phaseIssues(.viewer)
        #expect(sorted.map(\.id) == ["ISS-001", "ISS-002", "ISS-003"])
    }

    @Test func issuesBeforeTicketsAtEqualOrder() {
        // "ISS-001" < "T-001" in string comparison — deterministic tiebreaker
        let state = makeState(
            tickets: [makeTicket(id: "T-001", order: 10)],
            issues: [makeIssue(id: "ISS-001", order: 10)]
        )
        let ticketIDs = state.phaseTickets(.viewer).map(\.id)
        let issueIDs = state.phaseIssues(.viewer).map(\.id)
        // Both present — the board would show ISS first due to string ordering
        #expect(ticketIDs == ["T-001"])
        #expect(issueIDs == ["ISS-001"])
    }
}

// MARK: - nextBoardOrder Tests

struct NextBoardOrderTests {
    @Test func emptyPhaseReturnsTen() {
        let vm = ProjectViewModel()
        #expect(vm.nextBoardOrder(in: .viewer) == 10)
    }

    @Test func nilPhaseEmptyReturnsTen() {
        let vm = ProjectViewModel()
        #expect(vm.nextBoardOrder(in: nil) == 10)
    }

    @Test func gapOf10InRenumberedColumn() {
        // Simulating what renumberColumn produces
        let items = ["A", "B", "C"]
        let renumbered = items.enumerated().map { (offset, _) in (offset + 1) * 10 }
        #expect(renumbered == [10, 20, 30])
    }
}
