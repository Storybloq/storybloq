import Foundation

// MARK: - Ticket Type

enum TicketType: String, Codable, Sendable, CaseIterable {
    case task
    case feature
    case chore

    var displayName: String {
        switch self {
        case .task: "Task"
        case .feature: "Feature"
        case .chore: "Chore"
        }
    }
}

// MARK: - Ticket Status

enum TicketStatus: String, Codable, Sendable, CaseIterable {
    case open
    case inprogress
    case complete

    var displayName: String {
        switch self {
        case .open: "Open"
        case .inprogress: "In Progress"
        case .complete: "Complete"
        }
    }
}

// MARK: - Phase ID

/// A type-safe wrapper around phase ID strings.
/// Uses a struct (not enum) to preserve unknown phase IDs from future projects.
struct PhaseID: Hashable, Sendable {
    let rawValue: String
    init(_ value: String) { self.rawValue = value }

    static let dogfood = PhaseID("dogfood")
    static let viewer = PhaseID("viewer")
    static let detail = PhaseID("detail")
    static let terminal = PhaseID("terminal")
    static let pivot = PhaseID("pivot")
    static let multiProject = PhaseID("multi-project")
    static let cliMcp = PhaseID("cli-mcp")
    static let polish = PhaseID("polish")
    static let distribution = PhaseID("distribution")
    static let insights = PhaseID("insights")
}

extension PhaseID: Codable {
    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        rawValue = try container.decode(String.self)
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(rawValue)
    }
}

extension PhaseID: ExpressibleByStringLiteral {
    init(stringLiteral value: String) { self.rawValue = value }
}

// MARK: - Ticket

struct Ticket: Codable, Identifiable, Equatable, Sendable {
    let id: String
    let title: String
    let type: TicketType
    let status: TicketStatus
    let phase: PhaseID?
    let order: Int
    let description: String
    let createdDate: String
    let completedDate: String?
    let blockedBy: [String]
    let parentTicket: String?

    private enum CodingKeys: String, CodingKey {
        case id, title, type, status, phase, order, description
        case createdDate, completedDate, blockedBy, parentTicket
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        title = try c.decode(String.self, forKey: .title)
        type = try c.decode(TicketType.self, forKey: .type)
        status = try c.decode(TicketStatus.self, forKey: .status)
        phase = try c.decodeIfPresent(PhaseID.self, forKey: .phase)
        order = try c.decode(Int.self, forKey: .order)
        description = try c.decode(String.self, forKey: .description)
        createdDate = try c.decode(String.self, forKey: .createdDate)
        completedDate = try c.decodeIfPresent(String.self, forKey: .completedDate)
        blockedBy = try c.decode([String].self, forKey: .blockedBy)
        parentTicket = try c.decodeIfPresent(String.self, forKey: .parentTicket)
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(id, forKey: .id)
        try c.encode(title, forKey: .title)
        try c.encode(type, forKey: .type)
        try c.encode(status, forKey: .status)
        try c.encodeIfPresent(phase, forKey: .phase)
        try c.encode(order, forKey: .order)
        try c.encode(description, forKey: .description)
        try c.encode(createdDate, forKey: .createdDate)
        // completedDate emits null when nil (always present in JSON schema).
        // parentTicket omits the key when nil (absent in older ticket files — see RULES.md Rule 5).
        try c.encode(completedDate, forKey: .completedDate)
        try c.encode(blockedBy, forKey: .blockedBy)
        if let parentTicket {
            try c.encode(parentTicket, forKey: .parentTicket)
        }
    }

    init(
        id: String, title: String, type: TicketType, status: TicketStatus,
        phase: PhaseID? = nil, order: Int, description: String,
        createdDate: String, completedDate: String? = nil,
        blockedBy: [String] = [], parentTicket: String? = nil
    ) {
        self.id = id
        self.title = title
        self.type = type
        self.status = status
        self.phase = phase
        self.order = order
        self.description = description
        self.createdDate = createdDate
        self.completedDate = completedDate
        self.blockedBy = blockedBy
        self.parentTicket = parentTicket
    }

    // MARK: - Builder

    /// Returns a copy with specified fields changed. Uses double-optional for nullable fields:
    /// `nil` = no change, `.some(nil)` = clear, `.some("value")` = set.
    func with(
        title: String? = nil,
        type: TicketType? = nil,
        status: TicketStatus? = nil,
        phase: PhaseID?? = nil,
        order: Int? = nil,
        description: String? = nil,
        blockedBy: [String]? = nil,
        completedDate: String?? = nil,
        parentTicket: String?? = nil
    ) -> Ticket {
        Ticket(
            id: id,
            title: title ?? self.title,
            type: type ?? self.type,
            status: status ?? self.status,
            phase: phase ?? self.phase,
            order: order ?? self.order,
            description: description ?? self.description,
            createdDate: createdDate,
            completedDate: completedDate ?? self.completedDate,
            blockedBy: blockedBy ?? self.blockedBy,
            parentTicket: parentTicket ?? self.parentTicket
        )
    }
}
