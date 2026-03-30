import Foundation

// MARK: - Issue Status

enum IssueStatus: String, Codable, Sendable, CaseIterable {
    case open
    case inprogress
    case resolved

    var displayName: String {
        switch self {
        case .open: "Open"
        case .inprogress: "In Progress"
        case .resolved: "Resolved"
        }
    }
}

// MARK: - Issue Severity

enum IssueSeverity: String, Codable, Sendable, CaseIterable, Comparable {
    case critical
    case high
    case medium
    case low

    static func < (lhs: IssueSeverity, rhs: IssueSeverity) -> Bool {
        lhs.sortOrder < rhs.sortOrder
    }

    private var sortOrder: Int {
        switch self {
        case .critical: 0
        case .high: 1
        case .medium: 2
        case .low: 3
        }
    }

    var displayName: String {
        switch self {
        case .critical: "Critical"
        case .high: "High"
        case .medium: "Medium"
        case .low: "Low"
        }
    }
}

// MARK: - Issue

struct Issue: Codable, Identifiable, Equatable, Sendable {
    let id: String
    let title: String
    let status: IssueStatus
    let severity: IssueSeverity
    let components: [String]
    let impact: String
    let resolution: String?
    let location: [String]
    let discoveredDate: String
    let resolvedDate: String?
    let relatedTickets: [String]
    let order: Int
    let phase: PhaseID?

    private enum CodingKeys: String, CodingKey {
        case id, title, status, severity, components, impact, resolution
        case location, discoveredDate, resolvedDate, relatedTickets, order, phase
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        title = try c.decode(String.self, forKey: .title)
        status = try c.decode(IssueStatus.self, forKey: .status)
        severity = try c.decode(IssueSeverity.self, forKey: .severity)
        components = try c.decode([String].self, forKey: .components)
        impact = try c.decode(String.self, forKey: .impact)
        resolution = try c.decodeIfPresent(String.self, forKey: .resolution)
        location = try c.decode([String].self, forKey: .location)
        discoveredDate = try c.decode(String.self, forKey: .discoveredDate)
        resolvedDate = try c.decodeIfPresent(String.self, forKey: .resolvedDate)
        relatedTickets = try c.decode([String].self, forKey: .relatedTickets)
        order = try c.decodeIfPresent(Int.self, forKey: .order) ?? 0
        phase = try c.decodeIfPresent(PhaseID.self, forKey: .phase)
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(id, forKey: .id)
        try c.encode(title, forKey: .title)
        try c.encode(status, forKey: .status)
        try c.encode(severity, forKey: .severity)
        try c.encode(components, forKey: .components)
        try c.encode(impact, forKey: .impact)
        try c.encode(resolution, forKey: .resolution)
        try c.encode(location, forKey: .location)
        try c.encode(discoveredDate, forKey: .discoveredDate)
        try c.encode(resolvedDate, forKey: .resolvedDate)
        try c.encode(relatedTickets, forKey: .relatedTickets)
        try c.encode(order, forKey: .order)
        try c.encode(phase, forKey: .phase)
    }

    init(
        id: String, title: String, status: IssueStatus, severity: IssueSeverity,
        components: [String], impact: String, resolution: String?,
        location: [String], discoveredDate: String, resolvedDate: String?,
        relatedTickets: [String], order: Int = 0, phase: PhaseID? = nil
    ) {
        self.id = id
        self.title = title
        self.status = status
        self.severity = severity
        self.components = components
        self.impact = impact
        self.resolution = resolution
        self.location = location
        self.discoveredDate = discoveredDate
        self.resolvedDate = resolvedDate
        self.relatedTickets = relatedTickets
        self.order = order
        self.phase = phase
    }

    // MARK: - Builder

    /// Returns a copy with specified fields changed. Uses double-optional for nullable fields.
    func with(
        title: String? = nil,
        status: IssueStatus? = nil,
        severity: IssueSeverity? = nil,
        components: [String]? = nil,
        impact: String? = nil,
        resolution: String?? = nil,
        location: [String]? = nil,
        resolvedDate: String?? = nil,
        relatedTickets: [String]? = nil,
        order: Int? = nil,
        phase: PhaseID?? = nil
    ) -> Issue {
        Issue(
            id: id,
            title: title ?? self.title,
            status: status ?? self.status,
            severity: severity ?? self.severity,
            components: components ?? self.components,
            impact: impact ?? self.impact,
            resolution: resolution ?? self.resolution,
            location: location ?? self.location,
            discoveredDate: discoveredDate,
            resolvedDate: resolvedDate ?? self.resolvedDate,
            relatedTickets: relatedTickets ?? self.relatedTickets,
            order: order ?? self.order,
            phase: phase ?? self.phase
        )
    }
}
