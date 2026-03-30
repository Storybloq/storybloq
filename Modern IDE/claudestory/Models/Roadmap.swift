import Foundation

// MARK: - Roadmap

struct Roadmap: Codable, Equatable, Sendable {
    let title: String
    let date: String
    let phases: [Phase]
    let blockers: [Blocker]
}

// MARK: - Phase

struct Phase: Codable, Identifiable, Equatable, Sendable {
    let id: PhaseID
    let label: String
    let name: String
    let description: String
    let summary: String?

    init(id: PhaseID, label: String, name: String, description: String, summary: String? = nil) {
        self.id = id
        self.label = label
        self.name = name
        self.description = description
        self.summary = summary
    }
}

// MARK: - Blocker

struct Blocker: Codable, Sendable {
    let name: String
    let createdDate: String?
    let clearedDate: String?
    let note: String?

    /// Format detected during decode — determines encode shape for round-trip fidelity.
    private let sourceFormat: SourceFormat

    /// Simplified format tag for Equatable — collapses legacy(Bool) to just .legacy.
    private enum FormatTag: Sendable, Equatable {
        case legacy
        case dated
        case minimal
    }

    private enum SourceFormat: Sendable {
        case legacy(Bool)
        case dated
        case minimal

        var tag: FormatTag {
            switch self {
            case .legacy: .legacy
            case .dated: .dated
            case .minimal: .minimal
            }
        }
    }

    /// Whether this blocker has been cleared.
    var cleared: Bool {
        switch sourceFormat {
        case .dated: clearedDate != nil
        case .legacy(let v): v
        case .minimal: false
        }
    }

    private enum CodingKeys: String, CodingKey {
        case name, cleared, createdDate, clearedDate, note
    }

    init(name: String, createdDate: String? = nil, clearedDate: String? = nil, note: String? = nil) {
        self.name = name
        self.createdDate = createdDate
        self.clearedDate = clearedDate
        self.note = note
        self.sourceFormat = (createdDate != nil || clearedDate != nil) ? .dated : .minimal
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        name = try c.decode(String.self, forKey: .name)
        note = try c.decodeIfPresent(String.self, forKey: .note)

        let hasDateKeys = c.contains(.createdDate) || c.contains(.clearedDate)
        let hasClearedKey = c.contains(.cleared)

        // When both date keys and legacy cleared are present (mixed format from CLI),
        // treat as dated format — date keys take precedence over the boolean.
        if hasDateKeys {
            // New date-based format
            createdDate = try c.decodeIfPresent(String.self, forKey: .createdDate)
            clearedDate = try c.decodeIfPresent(String.self, forKey: .clearedDate)
            sourceFormat = .dated
        } else if hasClearedKey {
            // Legacy format: cleared: Bool
            let legacyCleared = try c.decode(Bool.self, forKey: .cleared)
            createdDate = nil
            clearedDate = nil
            sourceFormat = .legacy(legacyCleared)
        } else {
            // Minimal format: name only (+ optional note)
            createdDate = nil
            clearedDate = nil
            sourceFormat = .minimal
        }
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(name, forKey: .name)
        try c.encodeIfPresent(note, forKey: .note)

        switch sourceFormat {
        case .dated:
            // createdDate: omit key when nil (TS schema is optional, not nullable)
            // clearedDate: always emit (null = not yet cleared)
            try c.encodeIfPresent(createdDate, forKey: .createdDate)
            try c.encode(clearedDate, forKey: .clearedDate)
        case .legacy(let v):
            try c.encode(v, forKey: .cleared)
        case .minimal:
            break // Only name + note
        }
    }
}

// MARK: - Blocker + Equatable

extension Blocker: Equatable {
    /// Representational equality — two blockers are equal only if they have the same
    /// data AND the same format (so encoding produces the same JSON shape).
    static func == (lhs: Blocker, rhs: Blocker) -> Bool {
        lhs.name == rhs.name
            && lhs.createdDate == rhs.createdDate
            && lhs.clearedDate == rhs.clearedDate
            && lhs.note == rhs.note
            && lhs.cleared == rhs.cleared
            && lhs.sourceFormat.tag == rhs.sourceFormat.tag
    }
}
