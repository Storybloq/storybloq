import Foundation

// MARK: - Note Status

enum NoteStatus: String, Codable, Sendable, CaseIterable {
    case active
    case archived

    var displayName: String {
        switch self {
        case .active: "Active"
        case .archived: "Archived"
        }
    }
}

// MARK: - Note

struct Note: Codable, Identifiable, Equatable, Sendable {
    let id: String
    let title: String?
    let content: String
    let tags: [String]
    let status: NoteStatus
    let createdDate: String
    let updatedDate: String

    private enum CodingKeys: String, CodingKey {
        case id, title, content, tags, status, createdDate, updatedDate
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        title = try c.decodeIfPresent(String.self, forKey: .title)
        content = try c.decode(String.self, forKey: .content)
        tags = try c.decodeIfPresent([String].self, forKey: .tags) ?? []
        status = try c.decode(NoteStatus.self, forKey: .status)
        createdDate = try c.decode(String.self, forKey: .createdDate)
        updatedDate = try c.decode(String.self, forKey: .updatedDate)
    }

    init(
        id: String, title: String? = nil, content: String,
        tags: [String] = [], status: NoteStatus = .active,
        createdDate: String, updatedDate: String
    ) {
        self.id = id
        self.title = title
        self.content = content
        self.tags = tags
        self.status = status
        self.createdDate = createdDate
        self.updatedDate = updatedDate
    }
}
