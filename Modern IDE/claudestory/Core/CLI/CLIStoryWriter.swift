import Foundation

// MARK: - StoryWriting Protocol

/// All .story/ write operations. Async because CLI calls are subprocess-based.
/// 17 operations covering tickets, issues, notes, phases, blockers, handovers, snapshots.
protocol StoryWriting: Sendable {
    // Tickets
    func createTicket(title: String, type: TicketType, phase: PhaseID?,
                      description: String, blockedBy: [String], parentTicket: String?) async throws -> Ticket
    func updateTicket(_ id: String, status: TicketStatus?, title: String?, type: TicketType?,
                      phase: PhaseID??, order: Int?, description: String?, blockedBy: [String]?,
                      parentTicket: String??) async throws -> Ticket
    func deleteTicket(_ id: String, force: Bool) async throws

    // Issues
    func createIssue(title: String, severity: IssueSeverity, impact: String,
                     components: [String], relatedTickets: [String], location: [String],
                     phase: PhaseID?) async throws -> Issue
    func updateIssue(_ id: String, status: IssueStatus?, title: String?, severity: IssueSeverity?,
                     impact: String?, resolution: String??, components: [String]?,
                     relatedTickets: [String]?, location: [String]?,
                     order: Int?, phase: PhaseID??) async throws -> Issue
    func deleteIssue(_ id: String) async throws

    // Notes
    func createNote(content: String, title: String?, tags: [String]) async throws -> Note
    func updateNote(_ id: String, content: String?, title: String??, tags: [String]?,
                    clearTags: Bool, status: NoteStatus?) async throws -> Note
    func deleteNote(_ id: String) async throws

    // Phases
    func createPhase(id: String, name: String, label: String, description: String,
                     summary: String?, after: String?, atStart: Bool) async throws -> Phase
    func renamePhase(_ id: String, name: String?, label: String?,
                     description: String?, summary: String?) async throws -> Phase
    func movePhase(_ id: String, after: String?, atStart: Bool) async throws -> Phase
    func deletePhase(_ id: String, reassign: String?) async throws

    // Blockers
    func addBlocker(name: String, note: String?) async throws
    func clearBlocker(name: String, note: String?) async throws

    // Handovers + Snapshots
    func createHandover(content: String, slug: String) async throws -> String
    func snapshot() async throws

    // Config
    func setRecipeOverrides(_ overrides: Config.RecipeOverrides?) async throws
}

// MARK: - Convenience Extensions

extension StoryWriting {
    /// Translates a full Ticket into field-level update args.
    func updateTicket(_ ticket: Ticket) async throws -> Ticket {
        try await updateTicket(
            ticket.id, status: ticket.status, title: ticket.title,
            type: ticket.type, phase: .some(ticket.phase), order: ticket.order,
            description: ticket.description, blockedBy: ticket.blockedBy,
            parentTicket: .some(ticket.parentTicket))
    }

    /// Translates a full Issue into field-level update args.
    func updateIssue(_ issue: Issue) async throws -> Issue {
        try await updateIssue(
            issue.id, status: issue.status, title: issue.title,
            severity: issue.severity, impact: issue.impact,
            resolution: .some(issue.resolution), components: issue.components,
            relatedTickets: issue.relatedTickets, location: issue.location,
            order: issue.order, phase: .some(issue.phase))
    }
}

// MARK: - CLIStoryWriter

/// StoryWriting implementation that delegates all writes to the `claudestory` CLI.
/// Project-scoped: initialized with a project root URL.
struct CLIStoryWriter: StoryWriting, Sendable {
    private let runner: any CLIRunning
    private let projectRoot: URL

    init(runner: any CLIRunning = ProcessCLIRunner(), projectRoot: URL) {
        self.runner = runner
        self.projectRoot = projectRoot
    }

    // MARK: - Tickets

    func createTicket(title: String, type: TicketType, phase: PhaseID?,
                      description: String, blockedBy: [String], parentTicket: String?) async throws -> Ticket {
        Log.debug("createTicket: \(title) (\(type.rawValue), phase: \(phase?.rawValue ?? "nil"))", tag: "StoryWriter")
        var args = ["ticket", "create", "--title", title, "--type", type.rawValue]
        if let phase { args += ["--phase", phase.rawValue] }
        if !description.isEmpty { args += ["--description", description] }
        for id in blockedBy { args += ["--blocked-by", id] }
        if let parentTicket { args += ["--parent-ticket", parentTicket] }
        let result = try await runner.run(arguments: args, currentDirectory: projectRoot)
        return try CLIResponseParser.parse(Ticket.self, from: result)
    }

    func updateTicket(_ id: String, status: TicketStatus?, title: String?, type: TicketType?,
                      phase: PhaseID??, order: Int?, description: String?, blockedBy: [String]?,
                      parentTicket: String??) async throws -> Ticket {
        Log.debug("updateTicket: \(id)", tag: "StoryWriter")
        var args = ["ticket", "update", id]
        if let status { args += ["--status", status.rawValue] }
        if let title { args += ["--title", title] }
        if let type { args += ["--type", type.rawValue] }
        // PhaseID?? → String??: preserves nil/some(nil)/some(id) three-state semantics
        appendNullable("--phase", phase.map { $0?.rawValue }, to: &args)
        if let order { args += ["--order", String(order)] }
        if let description { args += ["--description", description] }
        if let blockedBy { for bid in blockedBy { args += ["--blocked-by", bid] } }
        appendNullable("--parent-ticket", parentTicket, to: &args)
        let result = try await runner.run(arguments: args, currentDirectory: projectRoot)
        return try CLIResponseParser.parse(Ticket.self, from: result)
    }

    func deleteTicket(_ id: String, force: Bool) async throws {
        Log.debug("deleteTicket: \(id) (force: \(force))", tag: "StoryWriter")
        var args = ["ticket", "delete", id]
        if force { args.append("--force") }
        let result = try await runner.run(arguments: args, currentDirectory: projectRoot)
        try CLIResponseParser.parseDeleteConfirmation(from: result)
    }

    // MARK: - Issues

    func createIssue(title: String, severity: IssueSeverity, impact: String,
                     components: [String], relatedTickets: [String], location: [String],
                     phase: PhaseID?) async throws -> Issue {
        Log.debug("createIssue: \(title) (\(severity.rawValue))", tag: "StoryWriter")
        var args = ["issue", "create", "--title", title, "--severity", severity.rawValue, "--impact", impact]
        for c in components { args += ["--components", c] }
        for t in relatedTickets { args += ["--related-tickets", t] }
        for l in location { args += ["--location", l] }
        if let phase { args += ["--phase", phase.rawValue] }
        let result = try await runner.run(arguments: args, currentDirectory: projectRoot)
        return try CLIResponseParser.parse(Issue.self, from: result)
    }

    func updateIssue(_ id: String, status: IssueStatus?, title: String?, severity: IssueSeverity?,
                     impact: String?, resolution: String??, components: [String]?,
                     relatedTickets: [String]?, location: [String]?,
                     order: Int?, phase: PhaseID??) async throws -> Issue {
        Log.debug("updateIssue: \(id)", tag: "StoryWriter")
        var args = ["issue", "update", id]
        if let status { args += ["--status", status.rawValue] }
        if let title { args += ["--title", title] }
        if let severity { args += ["--severity", severity.rawValue] }
        if let impact { args += ["--impact", impact] }
        appendNullable("--resolution", resolution, to: &args)
        if let components { for c in components { args += ["--components", c] } }
        if let relatedTickets { for t in relatedTickets { args += ["--related-tickets", t] } }
        if let location { for l in location { args += ["--location", l] } }
        if let order { args += ["--order", String(order)] }
        // PhaseID?? → String??: preserves nil/some(nil)/some(id) three-state semantics
        appendNullable("--phase", phase.map { $0?.rawValue }, to: &args)
        let result = try await runner.run(arguments: args, currentDirectory: projectRoot)
        return try CLIResponseParser.parse(Issue.self, from: result)
    }

    func deleteIssue(_ id: String) async throws {
        Log.debug("deleteIssue: \(id)", tag: "StoryWriter")
        let result = try await runner.run(arguments: ["issue", "delete", id], currentDirectory: projectRoot)
        try CLIResponseParser.parseDeleteConfirmation(from: result)
    }

    // MARK: - Notes

    func createNote(content: String, title: String?, tags: [String]) async throws -> Note {
        Log.debug("createNote: \(title ?? "(untitled)")", tag: "StoryWriter")
        var args = ["note", "create", "--content", content]
        if let title { args += ["--title", title] }
        for tag in tags { args += ["--tags", tag] }
        let result = try await runner.run(arguments: args, currentDirectory: projectRoot)
        return try CLIResponseParser.parse(Note.self, from: result)
    }

    func updateNote(_ id: String, content: String?, title: String??, tags: [String]?,
                    clearTags: Bool, status: NoteStatus?) async throws -> Note {
        Log.debug("updateNote: id=\(id) content=\(content != nil) title=\(String(describing: title)) tags=\(String(describing: tags)) clearTags=\(clearTags) status=\(String(describing: status))", tag: "StoryWriter")
        var args = ["note", "update", id]
        if let content { args += ["--content", content] }
        appendNullable("--title", title, to: &args)
        // clearTags takes precedence over tags (matches CLI's --clear-tags / --tags conflict)
        if clearTags {
            args.append("--clear-tags")
        } else if let tags {
            for tag in tags { args += ["--tags", tag] }
        }
        if let status { args += ["--status", status.rawValue] }
        Log.debug("updateNote args: \(args.joined(separator: " "))", tag: "StoryWriter")
        let result = try await runner.run(arguments: args, currentDirectory: projectRoot)
        return try CLIResponseParser.parse(Note.self, from: result)
    }

    func deleteNote(_ id: String) async throws {
        Log.debug("deleteNote: \(id)", tag: "StoryWriter")
        let result = try await runner.run(arguments: ["note", "delete", id], currentDirectory: projectRoot)
        try CLIResponseParser.parseDeleteConfirmation(from: result)
    }

    // MARK: - Phases

    func createPhase(id: String, name: String, label: String, description: String,
                     summary: String?, after: String?, atStart: Bool) async throws -> Phase {
        Log.debug("createPhase: \(id)", tag: "StoryWriter")
        var args = ["phase", "create", "--id", id, "--name", name, "--label", label, "--description", description]
        if let summary { args += ["--summary", summary] }
        if atStart { args.append("--at-start") }
        else if let after { args += ["--after", after] }
        let result = try await runner.run(arguments: args, currentDirectory: projectRoot)
        return try CLIResponseParser.parse(Phase.self, from: result)
    }

    func renamePhase(_ id: String, name: String?, label: String?,
                     description: String?, summary: String?) async throws -> Phase {
        Log.debug("renamePhase: \(id)", tag: "StoryWriter")
        var args = ["phase", "rename", id]
        if let name { args += ["--name", name] }
        if let label { args += ["--label", label] }
        if let description { args += ["--description", description] }
        if let summary { args += ["--summary", summary] }
        let result = try await runner.run(arguments: args, currentDirectory: projectRoot)
        return try CLIResponseParser.parse(Phase.self, from: result)
    }

    func movePhase(_ id: String, after: String?, atStart: Bool) async throws -> Phase {
        Log.debug("movePhase: \(id)", tag: "StoryWriter")
        var args = ["phase", "move", id]
        if atStart { args.append("--at-start") }
        else if let after { args += ["--after", after] }
        let result = try await runner.run(arguments: args, currentDirectory: projectRoot)
        return try CLIResponseParser.parse(Phase.self, from: result)
    }

    func deletePhase(_ id: String, reassign: String?) async throws {
        Log.debug("deletePhase: \(id) (reassign: \(reassign ?? "none"))", tag: "StoryWriter")
        var args = ["phase", "delete", id]
        if let reassign { args += ["--reassign", reassign] }
        let result = try await runner.run(arguments: args, currentDirectory: projectRoot)
        try CLIResponseParser.parseDeleteConfirmation(from: result)
    }

    // MARK: - Blockers

    func addBlocker(name: String, note: String?) async throws {
        Log.debug("addBlocker: \(name)", tag: "StoryWriter")
        var args = ["blocker", "add", "--name", name]
        if let note { args += ["--note", note] }
        let result = try await runner.run(arguments: args, currentDirectory: projectRoot)
        // Parse the returned blocker entity to confirm the operation succeeded
        _ = try CLIResponseParser.parse(CLIBlockerResult.self, from: result)
    }

    func clearBlocker(name: String, note: String?) async throws {
        Log.debug("clearBlocker: \(name)", tag: "StoryWriter")
        var args = ["blocker", "clear", "--name", name]
        if let note { args += ["--note", note] }
        let result = try await runner.run(arguments: args, currentDirectory: projectRoot)
        _ = try CLIResponseParser.parse(CLIBlockerResult.self, from: result)
    }

    // MARK: - Handovers + Snapshots

    func createHandover(content: String, slug: String) async throws -> String {
        Log.debug("createHandover: \(slug)", tag: "StoryWriter")
        let effectiveSlug = slug.isEmpty ? "session" : slug
        let args = ["handover", "create", "--content", content, "--slug", effectiveSlug]
        let result = try await runner.run(arguments: args, currentDirectory: projectRoot)
        let handover = try CLIResponseParser.parse(CLIHandoverResult.self, from: result)
        return handover.filename
    }

    func snapshot() async throws {
        Log.debug("snapshot", tag: "StoryWriter")
        let result = try await runner.run(arguments: ["snapshot"], currentDirectory: projectRoot)
        try CLIResponseParser.parseSuccess(from: result)
    }

    // MARK: - Config

    func setRecipeOverrides(_ overrides: Config.RecipeOverrides?) async throws {
        Log.debug("setRecipeOverrides: \(overrides?.maxTicketsPerSession.map(String.init) ?? "clear")", tag: "StoryWriter")
        if let overrides, !overrides.isEmpty {
            // Use --clear then --json to ensure a clean full replacement (avoids
            // Codable omitting nil keys which would leave stale values on disk).
            let clearResult = try await runner.run(
                arguments: ["config", "set-overrides", "--clear", "--format", "json"],
                currentDirectory: projectRoot
            )
            try CLIResponseParser.parseSuccess(from: clearResult)

            let data = try JSONEncoder().encode(overrides)
            let jsonString = String(data: data, encoding: .utf8)!
            let setResult = try await runner.run(
                arguments: ["config", "set-overrides", "--json", jsonString, "--format", "json"],
                currentDirectory: projectRoot
            )
            try CLIResponseParser.parseSuccess(from: setResult)
        } else {
            let result = try await runner.run(
                arguments: ["config", "set-overrides", "--clear", "--format", "json"],
                currentDirectory: projectRoot
            )
            try CLIResponseParser.parseSuccess(from: result)
        }
    }

    // MARK: - Helpers

    /// Appends a nullable CLI flag. `.some(nil)` → `["--flag", ""]` (clear). `.some(value)` → `["--flag", value]`. `nil` → nothing.
    private func appendNullable(_ flag: String, _ value: String??, to args: inout [String]) {
        guard let outer = value else { return } // nil = no change
        if let inner = outer {
            args += [flag, inner]
        } else {
            args += [flag, ""] // clear to null
        }
    }
}
