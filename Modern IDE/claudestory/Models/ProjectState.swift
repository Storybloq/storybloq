import Foundation

// MARK: - Phase Status

enum PhaseStatus: String, Sendable {
    case notstarted
    case inprogress
    case complete

    var displayName: String {
        switch self {
        case .notstarted: "Not Started"
        case .inprogress: "In Progress"
        case .complete: "Complete"
        }
    }
}

// MARK: - Project State

struct ProjectState: Equatable, Sendable {

    // MARK: Raw Inputs

    let tickets: [Ticket]
    let issues: [Issue]
    let notes: [Note]
    let roadmap: Roadmap
    let config: Config
    let handoverFilenames: [String]

    // MARK: Derived (stored at init)

    let umbrellaIDs: Set<String>
    let leafTickets: [Ticket]
    private let leafTicketsByPhase: [PhaseID?: [Ticket]]
    private let issuesByPhase: [PhaseID?: [Issue]]
    private let childrenByParent: [String: [Ticket]]
    private let reverseBlocksMap: [String: [Ticket]]
    private let ticketsByID: [String: Ticket]
    private let issuesByID: [String: Issue]
    private let notesByID: [String: Note]

    // MARK: Counts

    let totalTicketCount: Int
    let openTicketCount: Int
    let completeTicketCount: Int
    let activeIssueCount: Int
    let issuesBySeverity: [IssueSeverity: Int]

    // MARK: Init

    init(
        tickets: [Ticket],
        issues: [Issue],
        notes: [Note] = [],
        roadmap: Roadmap,
        config: Config,
        handoverFilenames: [String]
    ) {
        self.tickets = tickets
        self.issues = issues
        self.notes = notes
        self.roadmap = roadmap
        self.config = config
        self.handoverFilenames = handoverFilenames

        // 1. Umbrella IDs — any ticket referenced as parentTicket by another ticket
        let parentIDs = Set(tickets.compactMap(\.parentTicket))
        self.umbrellaIDs = parentIDs

        // 2. Leaf tickets — not umbrellas, sorted by (order, id) for deterministic rendering
        self.leafTickets = tickets.filter { !parentIDs.contains($0.id) }
            .sorted { ($0.order, $0.id) < ($1.order, $1.id) }

        // 3. Leaf tickets by phase, sorted by order
        var byPhase: [PhaseID?: [Ticket]] = [:]
        for ticket in self.leafTickets {
            byPhase[ticket.phase, default: []].append(ticket)
        }
        for key in byPhase.keys {
            byPhase[key]?.sort { ($0.order, $0.id) < ($1.order, $1.id) }
        }
        self.leafTicketsByPhase = byPhase

        // 3b. Issues by phase, sorted by order
        var issueByPhase: [PhaseID?: [Issue]] = [:]
        for issue in issues {
            issueByPhase[issue.phase, default: []].append(issue)
        }
        for key in issueByPhase.keys {
            issueByPhase[key]?.sort { ($0.order, $0.id) < ($1.order, $1.id) }
        }
        self.issuesByPhase = issueByPhase

        // 4. Children by parent
        var children: [String: [Ticket]] = [:]
        for ticket in tickets {
            if let parent = ticket.parentTicket {
                children[parent, default: []].append(ticket)
            }
        }
        self.childrenByParent = children

        // 5. Reverse blocks map
        var reverseBlocks: [String: [Ticket]] = [:]
        for ticket in tickets {
            for blockerID in ticket.blockedBy {
                reverseBlocks[blockerID, default: []].append(ticket)
            }
        }
        self.reverseBlocksMap = reverseBlocks

        // 6. Ticket and issue lookup by ID
        // Use uniquingKeysWith to avoid fatal crash if two ticket files share the same ID.
        self.ticketsByID = Dictionary(tickets.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        self.issuesByID = Dictionary(issues.map { ($0.id, $0) }, uniquingKeysWith: { _, new in new })
        self.notesByID = Dictionary(notes.map { ($0.id, $0) }, uniquingKeysWith: { _, new in new })

        // 7. Counts
        self.totalTicketCount = tickets.count
        self.openTicketCount = tickets.filter { $0.status != .complete }.count
        self.completeTicketCount = tickets.filter { $0.status == .complete }.count
        self.activeIssueCount = issues.filter { $0.status != .resolved }.count

        var bySeverity: [IssueSeverity: Int] = [:]
        for issue in issues where issue.status != .resolved {
            bySeverity[issue.severity, default: 0] += 1
        }
        self.issuesBySeverity = bySeverity
    }

    // MARK: Query Methods

    func isUmbrella(_ ticket: Ticket) -> Bool {
        umbrellaIDs.contains(ticket.id)
    }

    func phaseTickets(_ phase: PhaseID) -> [Ticket] {
        leafTicketsByPhase[phase] ?? []
    }

    func phaseIssues(_ phase: PhaseID) -> [Issue] {
        issuesByPhase[phase] ?? []
    }

    /// Phase status derived from leaf tickets only. Umbrella stored status is ignored.
    func phaseStatus(_ phase: PhaseID) -> PhaseStatus {
        let leaves = phaseTickets(phase)
        return Self.aggregateStatus(leaves)
    }

    func umbrellaChildren(_ ticketID: String) -> [Ticket] {
        childrenByParent[ticketID] ?? []
    }

    /// Umbrella status derived from descendant leaf tickets (recursive traversal).
    func umbrellaStatus(_ ticketID: String) -> PhaseStatus {
        var visited = Set<String>()
        let leaves = descendantLeaves(of: ticketID, visited: &visited)
        return Self.aggregateStatus(leaves)
    }

    func reverseBlocks(_ ticketID: String) -> [Ticket] {
        reverseBlocksMap[ticketID] ?? []
    }

    /// A ticket is blocked if any blockedBy reference points to a non-complete ticket.
    /// Unknown blocker IDs treated as blocked (conservative — unknown dependency = assume not cleared).
    func isBlocked(_ ticket: Ticket) -> Bool {
        guard !ticket.blockedBy.isEmpty else { return false }
        return ticket.blockedBy.contains { blockerID in
            guard let blocker = ticketsByID[blockerID] else { return true }
            return blocker.status != .complete
        }
    }

    /// Count of tickets currently blocked by incomplete dependencies.
    var blockedCount: Int {
        tickets.filter { isBlocked($0) }.count
    }

    func ticket(byID id: String) -> Ticket? {
        ticketsByID[id]
    }

    func issue(byID id: String) -> Issue? {
        issuesByID[id]
    }

    func note(byID id: String) -> Note? {
        notesByID[id]
    }

    // MARK: Deletion Safety

    /// Returns IDs of tickets that list `ticketID` in their blockedBy.
    func ticketsBlocking(_ ticketID: String) -> [String] {
        (reverseBlocksMap[ticketID] ?? []).map(\.id)
    }

    /// Returns IDs of tickets that have `ticketID` as their parentTicket.
    func childrenOf(_ ticketID: String) -> [String] {
        (childrenByParent[ticketID] ?? []).map(\.id)
    }

    /// Returns IDs of issues that reference `ticketID` in relatedTickets.
    func issuesReferencing(_ ticketID: String) -> [String] {
        issues.filter { $0.relatedTickets.contains(ticketID) }.map(\.id)
    }

    // MARK: Private

    /// Recursively collects all descendant leaf tickets of an umbrella.
    /// Uses a visited set to guard against cycles in malformed data.
    private func descendantLeaves(of ticketID: String, visited: inout Set<String>) -> [Ticket] {
        guard visited.insert(ticketID).inserted else { return [] }
        let directChildren = childrenByParent[ticketID] ?? []
        var leaves: [Ticket] = []
        for child in directChildren {
            if umbrellaIDs.contains(child.id) {
                leaves.append(contentsOf: descendantLeaves(of: child.id, visited: &visited))
            } else {
                leaves.append(child)
            }
        }
        return leaves
    }

    /// Shared aggregation logic for phase and umbrella status.
    /// - all complete → complete
    /// - any inprogress OR any complete (but not all) → inprogress
    /// - else → notstarted (nothing started)
    private static func aggregateStatus(_ tickets: [Ticket]) -> PhaseStatus {
        guard !tickets.isEmpty else { return .notstarted }
        let allComplete = tickets.allSatisfy { $0.status == .complete }
        if allComplete { return .complete }
        let anyProgress = tickets.contains { $0.status == .inprogress }
        let anyComplete = tickets.contains { $0.status == .complete }
        if anyProgress || anyComplete { return .inprogress }
        return .notstarted
    }
}

// MARK: - Placeholder

extension ProjectState {
    static let placeholder = ProjectState(
        tickets: [],
        issues: [],
        notes: [],
        roadmap: Roadmap(title: "", date: "", phases: [], blockers: []),
        config: Config(
            version: 1, project: "loading", type: "unknown", language: "unknown",
            features: Config.Features(tickets: true, issues: true, handovers: true, roadmap: true, reviews: false)
        ),
        handoverFilenames: []
    )
}
