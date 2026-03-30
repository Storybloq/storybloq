import Foundation
import Testing
@testable import Modern_IDE

// Swift Testing defines its own `Issue` type — disambiguate with a typealias.
private typealias ProjectIssue = Modern_IDE.Issue

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

private func makeIssue(
    id: String,
    status: IssueStatus = .open,
    severity: IssueSeverity = .medium,
    relatedTickets: [String] = []
) -> ProjectIssue {
    ProjectIssue(
        id: id, title: "Test \(id)", status: status, severity: severity,
        components: [], impact: "Test.", resolution: nil,
        location: [], discoveredDate: "2026-03-11",
        resolvedDate: nil, relatedTickets: relatedTickets
    )
}

private let emptyRoadmap = Roadmap(title: "test", date: "2026-03-11", phases: [], blockers: [])

private let minimalConfig = Config(
    version: 2, project: "test", type: "macapp", language: "swift",
    features: Config.Features(tickets: true, issues: true, handovers: true, roadmap: true, reviews: true)
)

private func makeState(
    tickets: [Ticket] = [],
    issues: [ProjectIssue] = [],
    roadmap: Roadmap? = nil,
    handoverFilenames: [String] = []
) -> ProjectState {
    ProjectState(
        tickets: tickets,
        issues: issues,
        roadmap: roadmap ?? emptyRoadmap,
        config: minimalConfig,
        handoverFilenames: handoverFilenames
    )
}

// MARK: - Umbrella Detection

struct ProjectStateUmbrellaTests {
    @Test func ticketWithChildrenIsUmbrella() {
        let parent = makeTicket(id: "T-008")
        let child = makeTicket(id: "T-030", parentTicket: "T-008")
        let state = makeState(tickets: [parent, child])

        #expect(state.isUmbrella(parent) == true)
        #expect(state.isUmbrella(child) == false)
    }

    @Test func ticketWithNoChildrenIsNotUmbrella() {
        let ticket = makeTicket(id: "T-001")
        let state = makeState(tickets: [ticket])

        #expect(state.isUmbrella(ticket) == false)
    }

    @Test func umbrellaIDsSetIsCorrect() {
        let a = makeTicket(id: "A")
        let b = makeTicket(id: "B", parentTicket: "A")
        let c = makeTicket(id: "C")
        let state = makeState(tickets: [a, b, c])

        #expect(state.umbrellaIDs == Set(["A"]))
    }
}

// MARK: - Leaf Tickets

struct ProjectStateLeafTests {
    @Test func leafTicketsExcludeUmbrellas() {
        let parent = makeTicket(id: "P")
        let child1 = makeTicket(id: "C1", parentTicket: "P")
        let child2 = makeTicket(id: "C2", parentTicket: "P")
        let standalone = makeTicket(id: "S")
        let state = makeState(tickets: [parent, child1, child2, standalone])

        #expect(state.leafTickets.count == 3)
        #expect(state.leafTickets.map(\.id).contains("P") == false)
    }

    @Test func singleParentAndChild() {
        let parent = makeTicket(id: "P")
        let child = makeTicket(id: "C", parentTicket: "P")
        let state = makeState(tickets: [parent, child])

        #expect(state.leafTickets.map(\.id) == ["C"])
    }
}

// MARK: - Phase Tickets

struct ProjectStatePhaseTicketTests {
    @Test func sortedByOrder() {
        let t1 = makeTicket(id: "A", phase: .viewer, order: 30)
        let t2 = makeTicket(id: "B", phase: .viewer, order: 10)
        let t3 = makeTicket(id: "C", phase: .viewer, order: 20)
        let state = makeState(tickets: [t1, t2, t3])

        #expect(state.phaseTickets(.viewer).map(\.order) == [10, 20, 30])
    }

    @Test func excludesUmbrellas() {
        let umbrella = makeTicket(id: "U", phase: .viewer, order: 10)
        let child1 = makeTicket(id: "C1", phase: .viewer, order: 20, parentTicket: "U")
        let child2 = makeTicket(id: "C2", phase: .viewer, order: 30, parentTicket: "U")
        let state = makeState(tickets: [umbrella, child1, child2])

        let ids = state.phaseTickets(.viewer).map(\.id)
        #expect(ids == ["C1", "C2"])
        #expect(!ids.contains("U"))
    }

    @Test func emptyForUnknownPhase() {
        let t = makeTicket(id: "A", phase: .viewer)
        let state = makeState(tickets: [t])

        #expect(state.phaseTickets(.multiProject).isEmpty)
    }
}

// MARK: - Phase Status

struct ProjectStatePhaseStatusTests {
    @Test func completeWhenAllLeavesComplete() {
        let t1 = makeTicket(id: "A", status: .complete, phase: .dogfood)
        let t2 = makeTicket(id: "B", status: .complete, phase: .dogfood)
        let state = makeState(tickets: [t1, t2])

        #expect(state.phaseStatus(.dogfood) == .complete)
    }

    @Test func inProgressWhenAnyLeafInProgress() {
        let t1 = makeTicket(id: "A", status: .complete, phase: .viewer)
        let t2 = makeTicket(id: "B", status: .inprogress, phase: .viewer)
        let state = makeState(tickets: [t1, t2])

        #expect(state.phaseStatus(.viewer) == .inprogress)
    }

    @Test func notStartedWhenAllLeavesOpen() {
        let t1 = makeTicket(id: "A", status: .open, phase: .detail)
        let t2 = makeTicket(id: "B", status: .open, phase: .detail)
        let state = makeState(tickets: [t1, t2])

        #expect(state.phaseStatus(.detail) == .notstarted)
    }

    @Test func notStartedWhenNoTickets() {
        let state = makeState(tickets: [])
        #expect(state.phaseStatus(.multiProject) == .notstarted)
    }

    @Test func inProgressWhenMixOfCompleteAndOpen() {
        let t1 = makeTicket(id: "A", status: .complete, phase: .viewer)
        let t2 = makeTicket(id: "B", status: .open, phase: .viewer)
        let state = makeState(tickets: [t1, t2])

        // Some complete + some open = inprogress (work has started)
        #expect(state.phaseStatus(.viewer) == .inprogress)
    }

    @Test func phaseWithOnlyUmbrellaTicketsIsNotStarted() {
        let umbrella = makeTicket(id: "U", status: .complete, phase: .viewer)
        // No children — U is not actually an umbrella since no ticket references it
        // To make U an umbrella, we need a child in a DIFFERENT phase
        let child = makeTicket(id: "C", status: .open, phase: .detail, parentTicket: "U")
        let state = makeState(tickets: [umbrella, child])

        // viewer has only the umbrella (excluded from leaves) → notstarted
        #expect(state.phaseTickets(.viewer).isEmpty)
        #expect(state.phaseStatus(.viewer) == .notstarted)
    }

    @Test func leafStatusWinsOverUmbrellaStoredStatus() {
        // Umbrella stored status is "complete" but leaf child is "open"
        let umbrella = makeTicket(id: "U", status: .complete, phase: .viewer)
        let leaf = makeTicket(id: "L", status: .open, phase: .viewer, parentTicket: "U")
        let state = makeState(tickets: [umbrella, leaf])

        // Phase status derived from leaf only — leaf is open, so phase is notstarted
        // (umbrella's "complete" stored status is ignored entirely)
        #expect(state.phaseStatus(.viewer) == .notstarted)
    }
}

// MARK: - Umbrella Status

struct ProjectStateUmbrellaStatusTests {
    @Test func completeWhenAllChildrenComplete() {
        let parent = makeTicket(id: "P")
        let c1 = makeTicket(id: "C1", status: .complete, parentTicket: "P")
        let c2 = makeTicket(id: "C2", status: .complete, parentTicket: "P")
        let state = makeState(tickets: [parent, c1, c2])

        #expect(state.umbrellaStatus("P") == .complete)
    }

    @Test func inProgressWhenAnyChildInProgress() {
        let parent = makeTicket(id: "P")
        let c1 = makeTicket(id: "C1", status: .complete, parentTicket: "P")
        let c2 = makeTicket(id: "C2", status: .inprogress, parentTicket: "P")
        let state = makeState(tickets: [parent, c1, c2])

        #expect(state.umbrellaStatus("P") == .inprogress)
    }

    @Test func inProgressWhenMixOfCompleteAndOpenChildren() {
        let parent = makeTicket(id: "P")
        let c1 = makeTicket(id: "C1", status: .complete, parentTicket: "P")
        let c2 = makeTicket(id: "C2", status: .open, parentTicket: "P")
        let state = makeState(tickets: [parent, c1, c2])

        #expect(state.umbrellaStatus("P") == .inprogress)
    }

    @Test func notStartedWhenNoChildren() {
        let state = makeState(tickets: [])
        #expect(state.umbrellaStatus("nonexistent") == .notstarted)
    }
}

// MARK: - Umbrella Children

struct ProjectStateUmbrellaChildrenTests {
    @Test func returnsCorrectChildren() {
        let parent = makeTicket(id: "P")
        let c1 = makeTicket(id: "C1", parentTicket: "P")
        let c2 = makeTicket(id: "C2", parentTicket: "P")
        let other = makeTicket(id: "X")
        let state = makeState(tickets: [parent, c1, c2, other])

        let children = state.umbrellaChildren("P")
        #expect(children.count == 2)
        #expect(Set(children.map(\.id)) == Set(["C1", "C2"]))
    }

    @Test func emptyForLeafTicket() {
        let leaf = makeTicket(id: "L")
        let state = makeState(tickets: [leaf])

        #expect(state.umbrellaChildren("L").isEmpty)
    }
}

// MARK: - Reverse Blocks

struct ProjectStateReverseBlocksTests {
    @Test func findsBlockedTickets() {
        let blocker = makeTicket(id: "A")
        let blocked1 = makeTicket(id: "B", blockedBy: ["A"])
        let blocked2 = makeTicket(id: "C", blockedBy: ["A"])
        let state = makeState(tickets: [blocker, blocked1, blocked2])

        let result = state.reverseBlocks("A")
        #expect(result.count == 2)
        #expect(Set(result.map(\.id)) == Set(["B", "C"]))
    }

    @Test func emptyWhenNothingBlocked() {
        let ticket = makeTicket(id: "A")
        let state = makeState(tickets: [ticket])

        #expect(state.reverseBlocks("A").isEmpty)
    }

    @Test func ticketBlockedByMultipleAppears() {
        let a = makeTicket(id: "A")
        let b = makeTicket(id: "B")
        let c = makeTicket(id: "C", blockedBy: ["A", "B"])
        let state = makeState(tickets: [a, b, c])

        #expect(state.reverseBlocks("A").map(\.id) == ["C"])
        #expect(state.reverseBlocks("B").map(\.id) == ["C"])
    }

    @Test func selfBlockStoredWithoutError() {
        let ticket = makeTicket(id: "A", blockedBy: ["A"])
        let state = makeState(tickets: [ticket])

        let result = state.reverseBlocks("A")
        #expect(result.count == 1)
        #expect(result.first?.id == "A")
    }

    @Test func cycleIsStable() {
        let a = makeTicket(id: "A", blockedBy: ["B"])
        let b = makeTicket(id: "B", blockedBy: ["A"])
        let state = makeState(tickets: [a, b])

        #expect(state.reverseBlocks("A").map(\.id) == ["B"])
        #expect(state.reverseBlocks("B").map(\.id) == ["A"])
    }
}

// MARK: - Counts

struct ProjectStateCountTests {
    @Test func ticketCountsCorrect() {
        let tickets = [
            makeTicket(id: "A", status: .complete),
            makeTicket(id: "B", status: .open),
            makeTicket(id: "C", status: .inprogress),
            makeTicket(id: "D", status: .complete),
            makeTicket(id: "E", status: .open),
        ]
        let state = makeState(tickets: tickets)

        #expect(state.totalTicketCount == 5)
        #expect(state.completeTicketCount == 2)
        #expect(state.openTicketCount == 3)
    }

    @Test func openTicketCountIncludesInProgress() {
        let tickets = [
            makeTicket(id: "A", status: .inprogress),
            makeTicket(id: "B", status: .inprogress),
        ]
        let state = makeState(tickets: tickets)

        #expect(state.openTicketCount == 2)
        #expect(state.completeTicketCount == 0)
    }

    @Test func activeIssueCountFiltersResolved() {
        let issues = [
            makeIssue(id: "ISS-1", status: .open),
            makeIssue(id: "ISS-2", status: .open),
            makeIssue(id: "ISS-3", status: .resolved),
        ]
        let state = makeState(issues: issues)

        #expect(state.activeIssueCount == 2)
    }

    @Test func activeIssueCountIncludesInProgress() {
        let issues = [
            makeIssue(id: "ISS-1", status: .open),
            makeIssue(id: "ISS-2", status: .inprogress),
            makeIssue(id: "ISS-3", status: .resolved),
        ]
        let state = makeState(issues: issues)

        #expect(state.activeIssueCount == 2)
    }

    @Test func issuesBySeverityCountsNonResolved() {
        let issues = [
            makeIssue(id: "ISS-1", status: .open, severity: .critical),
            makeIssue(id: "ISS-2", status: .inprogress, severity: .critical),
            makeIssue(id: "ISS-3", status: .resolved, severity: .critical),
            makeIssue(id: "ISS-4", status: .open, severity: .medium),
        ]
        let state = makeState(issues: issues)

        #expect(state.issuesBySeverity[.critical] == 2)
        #expect(state.issuesBySeverity[.medium] == 1)
        #expect(state.issuesBySeverity[.low] == nil)
    }
}

// MARK: - Is Blocked

struct ProjectStateBlockedTests {
    @Test func unblockedTicketIsNotBlocked() {
        let t = makeTicket(id: "A")
        let state = makeState(tickets: [t])
        #expect(state.isBlocked(t) == false)
    }

    @Test func blockedByOpenTicketIsBlocked() {
        let blocker = makeTicket(id: "A", status: .open)
        let blocked = makeTicket(id: "B", blockedBy: ["A"])
        let state = makeState(tickets: [blocker, blocked])
        #expect(state.isBlocked(blocked) == true)
    }

    @Test func blockedByInProgressTicketIsBlocked() {
        let blocker = makeTicket(id: "A", status: .inprogress)
        let blocked = makeTicket(id: "B", blockedBy: ["A"])
        let state = makeState(tickets: [blocker, blocked])
        #expect(state.isBlocked(blocked) == true)
    }

    @Test func blockedByCompleteTicketIsNotBlocked() {
        let blocker = makeTicket(id: "A", status: .complete)
        let blocked = makeTicket(id: "B", blockedBy: ["A"])
        let state = makeState(tickets: [blocker, blocked])
        #expect(state.isBlocked(blocked) == false)
    }

    @Test func blockedByMissingTicketIsBlocked() {
        // Conservative: unknown dependency = assume not cleared
        let blocked = makeTicket(id: "B", blockedBy: ["nonexistent"])
        let state = makeState(tickets: [blocked])
        #expect(state.isBlocked(blocked) == true)
    }

    @Test func multipleBlockersAllComplete() {
        let a = makeTicket(id: "A", status: .complete)
        let b = makeTicket(id: "B", status: .complete)
        let c = makeTicket(id: "C", blockedBy: ["A", "B"])
        let state = makeState(tickets: [a, b, c])
        #expect(state.isBlocked(c) == false)
    }

    @Test func multipleBlockersOneNotComplete() {
        let a = makeTicket(id: "A", status: .complete)
        let b = makeTicket(id: "B", status: .open)
        let c = makeTicket(id: "C", blockedBy: ["A", "B"])
        let state = makeState(tickets: [a, b, c])
        #expect(state.isBlocked(c) == true)
    }

    @Test func emptyBlockedByIsNotBlocked() {
        let t = makeTicket(id: "A", blockedBy: [])
        let state = makeState(tickets: [t])
        #expect(state.isBlocked(t) == false)
    }
}

// MARK: - Blocked Count

struct ProjectStateBlockedCountTests {
    @Test func zeroWhenNoBlockedTickets() {
        let a = makeTicket(id: "A")
        let state = makeState(tickets: [a])
        #expect(state.blockedCount == 0)
    }

    @Test func blockedCountIncludesMissingBlockers() {
        let blocked = makeTicket(id: "B", blockedBy: ["nonexistent"])
        let state = makeState(tickets: [blocked])
        #expect(state.blockedCount == 1)
    }

    @Test func countsBlockedTicketsCorrectly() {
        let blocker = makeTicket(id: "A", status: .open)
        let blocked1 = makeTicket(id: "B", blockedBy: ["A"])
        let blocked2 = makeTicket(id: "C", blockedBy: ["A"])
        let free = makeTicket(id: "D")
        let state = makeState(tickets: [blocker, blocked1, blocked2, free])
        #expect(state.blockedCount == 2)
    }
}

// MARK: - Edge Cases

struct ProjectStateEdgeCaseTests {
    @Test func emptyInputsProduceValidState() {
        let state = ProjectState.placeholder

        #expect(state.tickets.isEmpty)
        #expect(state.leafTickets.isEmpty)
        #expect(state.umbrellaIDs.isEmpty)
        #expect(state.totalTicketCount == 0)
        #expect(state.openTicketCount == 0)
        #expect(state.activeIssueCount == 0)
        #expect(state.phaseStatus(.dogfood) == .notstarted)
    }

    @Test func equalStatesAreEqual() {
        let tickets = [makeTicket(id: "A"), makeTicket(id: "B")]
        let stateA = makeState(tickets: tickets)
        let stateB = makeState(tickets: tickets)

        #expect(stateA == stateB)
    }

    @Test func nestedUmbrellaDerivesFromLeaf() {
        // A → B (umbrella) → C (leaf)
        let a = makeTicket(id: "A")
        let b = makeTicket(id: "B", status: .open, parentTicket: "A")
        let c = makeTicket(id: "C", status: .complete, parentTicket: "B")
        let state = makeState(tickets: [a, b, c])

        // A is umbrella (B references it). B is umbrella (C references it). C is leaf.
        #expect(state.isUmbrella(a) == true)
        #expect(state.isUmbrella(b) == true)
        #expect(state.isUmbrella(c) == false)

        // umbrellaStatus(A) should derive from leaf C (complete), not from B's stored status (open)
        #expect(state.umbrellaStatus("A") == .complete)
        #expect(state.umbrellaStatus("B") == .complete)
    }
}

// MARK: - Deletion Safety

struct ProjectStateDeletionSafetyTests {
    @Test func ticketsBlockingReturnsBlockedTicketIDs() {
        let a = makeTicket(id: "A")
        let b = makeTicket(id: "B", blockedBy: ["A"])
        let c = makeTicket(id: "C", blockedBy: ["A"])
        let state = makeState(tickets: [a, b, c])

        let blocking = state.ticketsBlocking("A")
        #expect(Set(blocking) == Set(["B", "C"]))
    }

    @Test func ticketsBlockingEmptyWhenNoReferences() {
        let a = makeTicket(id: "A")
        let state = makeState(tickets: [a])

        #expect(state.ticketsBlocking("A").isEmpty)
    }

    @Test func childrenOfReturnsChildTicketIDs() {
        let parent = makeTicket(id: "P")
        let c1 = makeTicket(id: "C1", parentTicket: "P")
        let c2 = makeTicket(id: "C2", parentTicket: "P")
        let state = makeState(tickets: [parent, c1, c2])

        let children = state.childrenOf("P")
        #expect(Set(children) == Set(["C1", "C2"]))
    }

    @Test func childrenOfEmptyForLeafTicket() {
        let leaf = makeTicket(id: "L")
        let state = makeState(tickets: [leaf])

        #expect(state.childrenOf("L").isEmpty)
    }

    @Test func issuesReferencingReturnsIssueIDs() {
        let t = makeTicket(id: "T-001")
        let iss1 = makeIssue(id: "ISS-001", relatedTickets: ["T-001"])
        let iss2 = makeIssue(id: "ISS-002", relatedTickets: ["T-001", "T-002"])
        let iss3 = makeIssue(id: "ISS-003")
        let state = makeState(tickets: [t], issues: [iss1, iss2, iss3])

        let refs = state.issuesReferencing("T-001")
        #expect(Set(refs) == Set(["ISS-001", "ISS-002"]))
    }

    @Test func issuesReferencingEmptyWhenNoReferences() {
        let t = makeTicket(id: "T-001")
        let iss = makeIssue(id: "ISS-001")
        let state = makeState(tickets: [t], issues: [iss])

        #expect(state.issuesReferencing("T-001").isEmpty)
    }

    @Test func unreferencedTicketHasNoDeletionBlockers() {
        let a = makeTicket(id: "A")
        let b = makeTicket(id: "B")
        let state = makeState(tickets: [a, b])

        #expect(state.ticketsBlocking("A").isEmpty)
        #expect(state.childrenOf("A").isEmpty)
        #expect(state.issuesReferencing("A").isEmpty)
    }
}
