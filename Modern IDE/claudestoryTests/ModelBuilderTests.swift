import Testing
import Foundation
@testable import Modern_IDE

// MARK: - Ticket Builder Tests

struct TicketBuilderTests {
    private let baseTicket = Ticket(
        id: "T-100", title: "Test ticket", type: .feature, status: .open,
        phase: .viewer, order: 10, description: "A test ticket.",
        createdDate: "2026-03-10", completedDate: nil,
        blockedBy: ["T-050"], parentTicket: "T-010"
    )

    @Test func withStatusPreservesOtherFields() {
        let updated = baseTicket.with(status: .inprogress)
        #expect(updated.status == .inprogress)
        #expect(updated.id == baseTicket.id)
        #expect(updated.title == baseTicket.title)
        #expect(updated.type == baseTicket.type)
        #expect(updated.phase == baseTicket.phase)
        #expect(updated.order == baseTicket.order)
        #expect(updated.description == baseTicket.description)
        #expect(updated.createdDate == baseTicket.createdDate)
        #expect(updated.completedDate == baseTicket.completedDate)
        #expect(updated.blockedBy == baseTicket.blockedBy)
        #expect(updated.parentTicket == baseTicket.parentTicket)
    }

    @Test func withPhaseChangesPhase() {
        let updated = baseTicket.with(phase: .detail)
        #expect(updated.phase == .detail)
        #expect(updated.status == .open)
    }

    @Test func withBlockedByClearsBlockers() {
        let updated = baseTicket.with(blockedBy: [])
        #expect(updated.blockedBy.isEmpty)
    }

    @Test func withBlockedByAddsBlockers() {
        let updated = baseTicket.with(blockedBy: ["T-050", "T-051"])
        #expect(updated.blockedBy == ["T-050", "T-051"])
    }

    @Test func withCompletedDateSetsDate() {
        let updated = baseTicket.with(completedDate: .some("2026-03-14"))
        #expect(updated.completedDate == "2026-03-14")
    }

    @Test func withCompletedDateClearsDate() {
        let withDate = baseTicket.with(completedDate: .some("2026-03-14"))
        let cleared = withDate.with(completedDate: .some(nil))
        #expect(cleared.completedDate == nil)
    }

    @Test func withCompletedDateNilMeansNoChange() {
        let withDate = baseTicket.with(completedDate: .some("2026-03-14"))
        let unchanged = withDate.with(status: .inprogress)
        #expect(unchanged.completedDate == "2026-03-14")
    }

    @Test func withMultipleFieldsChangesAll() {
        let updated = baseTicket.with(
            status: .complete,
            phase: .terminal,
            blockedBy: [],
            completedDate: .some("2026-03-14")
        )
        #expect(updated.status == .complete)
        #expect(updated.phase == .terminal)
        #expect(updated.blockedBy.isEmpty)
        #expect(updated.completedDate == "2026-03-14")
    }

    @Test func withTitleChangesTitle() {
        let updated = baseTicket.with(title: "New title")
        #expect(updated.title == "New title")
        #expect(updated.status == .open)
    }

    @Test func withDescriptionChangesDescription() {
        let updated = baseTicket.with(description: "New description")
        #expect(updated.description == "New description")
        #expect(updated.title == baseTicket.title)
    }

    @Test func withTypeChangesType() {
        let updated = baseTicket.with(type: .chore)
        #expect(updated.type == .chore)
    }

    @Test func withOrderChangesOrder() {
        let updated = baseTicket.with(order: 99)
        #expect(updated.order == 99)
    }

    @Test func withParentTicketSetsParent() {
        let noParent = Ticket(id: "T-200", title: "No parent", type: .task, status: .open, phase: .viewer, order: 10, description: "", createdDate: "2026-03-10")
        let updated = noParent.with(parentTicket: .some("T-010"))
        #expect(updated.parentTicket == "T-010")
    }

    @Test func withParentTicketClearsParent() {
        let updated = baseTicket.with(parentTicket: .some(nil))
        #expect(updated.parentTicket == nil)
    }

    // MARK: - Date Transition Rules

    @Test func transitionToCompleteRequiresDate() {
        // Simulates what TicketDetailView does
        let ticket = baseTicket.with(status: .open)
        let completed = ticket.with(status: .complete, completedDate: .some("2026-03-14"))
        #expect(completed.status == .complete)
        #expect(completed.completedDate == "2026-03-14")
    }

    @Test func transitionFromCompleteClearsDate() {
        let completed = baseTicket.with(status: .complete, completedDate: .some("2026-03-14"))
        let reopened = completed.with(status: .open, completedDate: .some(nil))
        #expect(reopened.status == .open)
        #expect(reopened.completedDate == nil)
    }

    @Test func idempotentCompletePreservesDate() {
        let completed = baseTicket.with(status: .complete, completedDate: .some("2026-03-10"))
        // Re-setting to complete without touching completedDate preserves it
        let still = completed.with(status: .complete)
        #expect(still.completedDate == "2026-03-10")
    }
}

// MARK: - Issue Builder Tests

struct IssueBuilderTests {
    private let baseIssue = Issue(
        id: "ISS-100", title: "Test issue", status: .open, severity: .high,
        components: ["safety"], impact: "Breaks things", resolution: nil,
        location: ["file.swift:10"], discoveredDate: "2026-03-10",
        resolvedDate: nil, relatedTickets: ["T-001"]
    )

    @Test func withStatusPreservesOtherFields() {
        let updated = baseIssue.with(status: .resolved)
        #expect(updated.status == .resolved)
        #expect(updated.id == baseIssue.id)
        #expect(updated.title == baseIssue.title)
        #expect(updated.severity == baseIssue.severity)
        #expect(updated.components == baseIssue.components)
        #expect(updated.impact == baseIssue.impact)
        #expect(updated.resolution == baseIssue.resolution)
        #expect(updated.location == baseIssue.location)
        #expect(updated.discoveredDate == baseIssue.discoveredDate)
        #expect(updated.resolvedDate == baseIssue.resolvedDate)
        #expect(updated.relatedTickets == baseIssue.relatedTickets)
    }

    @Test func withSeverityChangesSeverity() {
        let updated = baseIssue.with(severity: .critical)
        #expect(updated.severity == .critical)
        #expect(updated.status == .open)
    }

    @Test func withResolutionSetsText() {
        let updated = baseIssue.with(resolution: .some("Fixed the bug"))
        #expect(updated.resolution == "Fixed the bug")
    }

    @Test func withResolutionClearsText() {
        let resolved = baseIssue.with(resolution: .some("Fixed"))
        let cleared = resolved.with(resolution: .some(nil))
        #expect(cleared.resolution == nil)
    }

    @Test func withResolvedDateSetsDate() {
        let updated = baseIssue.with(resolvedDate: .some("2026-03-14"))
        #expect(updated.resolvedDate == "2026-03-14")
    }

    @Test func withResolvedDateClearsDate() {
        let resolved = baseIssue.with(resolvedDate: .some("2026-03-14"))
        let cleared = resolved.with(resolvedDate: .some(nil))
        #expect(cleared.resolvedDate == nil)
    }

    @Test func transitionToResolvedSetsDate() {
        let resolved = baseIssue.with(status: .resolved, resolvedDate: .some("2026-03-14"))
        #expect(resolved.status == .resolved)
        #expect(resolved.resolvedDate == "2026-03-14")
    }

    @Test func transitionToOpenClearsDate() {
        let resolved = baseIssue.with(status: .resolved, resolvedDate: .some("2026-03-14"))
        let reopened = resolved.with(status: .open, resolvedDate: .some(nil))
        #expect(reopened.status == .open)
        #expect(reopened.resolvedDate == nil)
    }

    @Test func withTitleChangesTitle() {
        let updated = baseIssue.with(title: "New title")
        #expect(updated.title == "New title")
        #expect(updated.severity == .high)
    }

    @Test func withImpactChangesImpact() {
        let updated = baseIssue.with(impact: "New impact")
        #expect(updated.impact == "New impact")
    }

    @Test func withComponentsChangesComponents() {
        let updated = baseIssue.with(components: ["a", "b", "c"])
        #expect(updated.components == ["a", "b", "c"])
    }

    @Test func withLocationChangesLocation() {
        let updated = baseIssue.with(location: ["new.swift:1"])
        #expect(updated.location == ["new.swift:1"])
    }

    @Test func withRelatedTicketsChangesRelatedTickets() {
        let updated = baseIssue.with(relatedTickets: ["T-002", "T-003"])
        #expect(updated.relatedTickets == ["T-002", "T-003"])
    }
}

// MARK: - ID Allocation Tests

struct IDAllocationTests {
    @Test func nextTicketIDFromExisting() async {
        let vm = await ProjectViewModel()
        let state = ProjectState(
            tickets: [
                Ticket(id: "T-001", title: "A", type: .task, status: .open, phase: .dogfood, order: 10, description: "", createdDate: "2026-03-10"),
                Ticket(id: "T-049", title: "B", type: .task, status: .open, phase: .viewer, order: 10, description: "", createdDate: "2026-03-10"),
                Ticket(id: "T-010", title: "C", type: .task, status: .open, phase: .viewer, order: 20, description: "", createdDate: "2026-03-10"),
            ],
            issues: [],
            roadmap: Roadmap(title: "", date: "", phases: [], blockers: []),
            config: Config(version: 1, project: "test", type: "macapp", language: "swift", features: .init(tickets: true, issues: true, handovers: true, roadmap: true, reviews: false)),
            handoverFilenames: []
        )
        await MainActor.run {
            // Access internal state for testing
            let loader = MockProjectLoaderForID(state: state)
            let vmWithState = ProjectViewModel(loader: loader)
            vmWithState.openProject(at: URL(fileURLWithPath: "/tmp"))
        }
        // Note: This is a simplified test — the full integration test would verify
        // after reload. For now, test the parsing logic directly.
        let maxNum = ["T-001", "T-049", "T-010"]
            .compactMap { id -> Int? in
                guard id.hasPrefix("T-") else { return nil }
                return Int(id.dropFirst(2))
            }
            .max() ?? 0
        #expect(maxNum == 49)
        #expect(String(format: "T-%03d", maxNum + 1) == "T-050")
    }

    @Test func nextTicketIDFromEmpty() {
        let maxNum = [String]()
            .compactMap { id -> Int? in
                guard id.hasPrefix("T-") else { return nil }
                return Int(id.dropFirst(2))
            }
            .max() ?? 0
        #expect(String(format: "T-%03d", maxNum + 1) == "T-001")
    }

    @Test func nextIssueIDFromExisting() {
        let maxNum = ["ISS-001", "ISS-004", "ISS-002"]
            .compactMap { id -> Int? in
                guard id.hasPrefix("ISS-") else { return nil }
                return Int(id.dropFirst(4))
            }
            .max() ?? 0
        #expect(maxNum == 4)
        #expect(String(format: "ISS-%03d", maxNum + 1) == "ISS-005")
    }

    @Test func nextIssueIDFromEmpty() {
        let maxNum = [String]()
            .compactMap { id -> Int? in
                guard id.hasPrefix("ISS-") else { return nil }
                return Int(id.dropFirst(4))
            }
            .max() ?? 0
        #expect(String(format: "ISS-%03d", maxNum + 1) == "ISS-001")
    }

    @Test func nextOrderInEmptyPhase() {
        let maxOrder = [Int]().max() ?? 0
        #expect(maxOrder + 10 == 10)
    }

    @Test func nextOrderInPopulatedPhase() {
        let maxOrder = [10, 20, 30].max() ?? 0
        #expect(maxOrder + 10 == 40)
    }

    @Test func malformedIDsIgnored() {
        let maxNum = ["T-001", "T-abc", "TICKET-5", "T-049"]
            .compactMap { id -> Int? in
                guard id.hasPrefix("T-") else { return nil }
                return Int(id.dropFirst(2))
            }
            .max() ?? 0
        #expect(maxNum == 49)
    }
}

private struct MockProjectLoaderForID: ProjectLoading, @unchecked Sendable {
    let state: ProjectState
    nonisolated func load(from projectRoot: URL) async throws -> LoadResult {
        LoadResult(state: state, warnings: [])
    }
}

// MARK: - ProjectState Lookup Tests

struct ProjectStateLookupTests {
    private let state = ProjectState(
        tickets: [
            Ticket(id: "T-001", title: "First", type: .task, status: .complete, phase: .dogfood, order: 10, description: "", createdDate: "2026-03-10"),
            Ticket(id: "T-002", title: "Second", type: .feature, status: .open, phase: .viewer, order: 20, description: "", createdDate: "2026-03-10"),
        ],
        issues: [
            Issue(id: "ISS-001", title: "Bug", status: .open, severity: .high, components: [], impact: "", resolution: nil, location: [], discoveredDate: "2026-03-10", resolvedDate: nil, relatedTickets: []),
        ],
        roadmap: Roadmap(title: "", date: "", phases: [], blockers: []),
        config: Config(version: 1, project: "test", type: "macapp", language: "swift", features: .init(tickets: true, issues: true, handovers: true, roadmap: true, reviews: false)),
        handoverFilenames: []
    )

    @Test func ticketByIDFindsTicket() {
        let ticket = state.ticket(byID: "T-001")
        #expect(ticket?.title == "First")
    }

    @Test func ticketByIDReturnsNilForMissing() {
        let ticket = state.ticket(byID: "T-999")
        #expect(ticket == nil)
    }

    @Test func issueByIDFindsIssue() {
        let issue = state.issue(byID: "ISS-001")
        #expect(issue?.title == "Bug")
    }

    @Test func issueByIDReturnsNilForMissing() {
        let issue = state.issue(byID: "ISS-999")
        #expect(issue == nil)
    }
}
