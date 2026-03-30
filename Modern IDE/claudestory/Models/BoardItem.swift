import SwiftUI
import UniformTypeIdentifiers

// MARK: - Kanban Item (Transferable wrapper for drag-and-drop)

struct KanbanItem: Codable, Transferable, Equatable {
    let id: String
    let title: String

    static var transferRepresentation: some TransferRepresentation {
        CodableRepresentation(contentType: .json)
    }
}

// MARK: - Board Item (unified view-layer abstraction)

/// Wraps a Ticket or Issue for display on the unified kanban board.
/// Not Codable — this is a view-layer abstraction only.
enum BoardItem: Identifiable, Equatable {
    case ticket(Ticket)
    case issue(Issue)

    var id: String {
        switch self {
        case .ticket(let t): t.id
        case .issue(let i): i.id
        }
    }

    var title: String {
        switch self {
        case .ticket(let t): t.title
        case .issue(let i): i.title
        }
    }

    var description: String? {
        switch self {
        case .ticket(let t): t.description.isEmpty ? nil : t.description
        case .issue(let i): i.impact.isEmpty ? nil : i.impact
        }
    }

    var order: Int {
        switch self {
        case .ticket(let t): t.order
        case .issue(let i): i.order
        }
    }

    var phase: PhaseID? {
        switch self {
        case .ticket(let t): t.phase
        case .issue(let i): i.phase
        }
    }

    /// Completion date for sorting the Complete column (most recent first).
    /// Tickets use completedDate, issues use resolvedDate.
    var completionDate: String? {
        switch self {
        case .ticket(let t): t.completedDate
        case .issue(let i): i.resolvedDate
        }
    }

    // MARK: - Column Status

    enum ColumnStatus {
        case open, inprogress, complete
    }

    var columnStatus: ColumnStatus {
        switch self {
        case .ticket(let t):
            switch t.status {
            case .open: .open
            case .inprogress: .inprogress
            case .complete: .complete
            }
        case .issue(let i):
            switch i.status {
            case .open: .open
            case .inprogress: .inprogress
            case .resolved: .complete
            }
        }
    }

    var isTicket: Bool {
        if case .ticket = self { return true }
        return false
    }

    var isIssue: Bool {
        if case .issue = self { return true }
        return false
    }

    var kanbanItem: KanbanItem {
        KanbanItem(id: id, title: title)
    }
}
