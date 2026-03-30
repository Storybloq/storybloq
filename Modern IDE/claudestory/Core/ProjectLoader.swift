import Foundation

// MARK: - Error

enum ProjectLoaderError: LocalizedError {
    case missingStoryDir
    case fileNotFound(String)
    case unreadableFile(String)
    case decodeFailed(String, Error)
    case directoryEnumerationFailed(String, Error)

    var errorDescription: String? {
        switch self {
        case .missingStoryDir:
            return "Missing .story/ directory."
        case .fileNotFound(let path):
            return "File not found: \(path)"
        case .unreadableFile(let path):
            return "Cannot read file: \(path)"
        case .decodeFailed(let path, let error):
            return "Decode failed for \(path): \(error.localizedDescription)"
        case .directoryEnumerationFailed(let path, let error):
            return "Cannot enumerate \(path): \(error.localizedDescription)"
        }
    }
}

// MARK: - Load Result

struct LoadWarning: Equatable, Sendable {
    let file: String
    let message: String
    let fixable: Bool
    let absolutePath: String?

    init(file: String, message: String, fixable: Bool = false, absolutePath: String? = nil) {
        self.file = file
        self.message = message
        self.fixable = fixable
        self.absolutePath = absolutePath
    }
}

struct LoadResult: Equatable, Sendable {
    let state: ProjectState
    let warnings: [LoadWarning]
}

// MARK: - ProjectLoading Protocol

/// Async protocol for loading a `.story/` project. Two conformances:
/// - `ProjectLoader` (production) — bridges sync file I/O to async with cancellation checkpoints.
/// - `MockProjectLoader` (tests) — returns instantly with controlled data.
protocol ProjectLoading: Sendable {
    func load(from projectRoot: URL) async throws -> LoadResult
}

// MARK: - Project Loader

struct ProjectLoader: Sendable {

    private static let handoverDateRegex = /^\d{4}-\d{2}-\d{2}/

    /// Synchronous loader — reads all `.story/` data from `projectRoot` and assembles a `ProjectState`.
    ///
    /// - Critical files (config.json, roadmap.json) throw on failure.
    /// - Best-effort files (tickets, issues) skip corrupt entries with warnings.
    /// - Handover filenames are listed and sorted newest-first; content is not parsed.
    nonisolated func loadSync(from projectRoot: URL) throws -> LoadResult {
        let fm = FileManager.default
        var warnings: [LoadWarning] = []

        let wrapDir = projectRoot.appendingPathComponent(".story")

        // 1. Validate .story/ exists as directory
        var isDir: ObjCBool = false
        guard fm.fileExists(atPath: wrapDir.path, isDirectory: &isDir), isDir.boolValue else {
            throw ProjectLoaderError.missingStoryDir
        }

        // 2. Load config.json (critical — throws on failure)
        let config: Config = try loadSingletonFile(
            "config.json", from: wrapDir, relativeTo: projectRoot
        )

        // 3. Validate config
        do {
            try config.validate()
        } catch {
            let relPath = relativePath("config.json", in: wrapDir, relativeTo: projectRoot)
            throw ProjectLoaderError.decodeFailed(relPath, error)
        }

        // 4. Load roadmap.json (critical — throws on failure)
        let roadmap: Roadmap = try loadSingletonFile(
            "roadmap.json", from: wrapDir, relativeTo: projectRoot
        )

        // 5. Load tickets (best-effort)
        let ticketsDir = wrapDir.appendingPathComponent("tickets")
        let tickets: [Ticket] = try loadDirectory(
            Ticket.self, from: ticketsDir, relativeTo: projectRoot, warnings: &warnings
        )

        // 6. Load issues (best-effort, missing dir is fine)
        let issuesDir = wrapDir.appendingPathComponent("issues")
        let issues: [Issue] = try loadDirectory(
            Issue.self, from: issuesDir, relativeTo: projectRoot, warnings: &warnings
        )

        // 7. Load notes (best-effort, missing dir is fine)
        let notesDir = wrapDir.appendingPathComponent("notes")
        let notes: [Note] = try loadDirectory(
            Note.self, from: notesDir, relativeTo: projectRoot, warnings: &warnings
        )

        // 8. List handover filenames
        let handoversDir = wrapDir.appendingPathComponent("handovers")
        let handoverFilenames = listHandovers(
            from: handoversDir, relativeTo: projectRoot, warnings: &warnings
        )

        // 9. Assemble ProjectState
        let state = ProjectState(
            tickets: tickets,
            issues: issues,
            notes: notes,
            roadmap: roadmap,
            config: config,
            handoverFilenames: handoverFilenames
        )

        return LoadResult(state: state, warnings: warnings)
    }

    // MARK: - Private Helpers

    /// Loads and decodes a single critical JSON file. Throws on any failure.
    private nonisolated func loadSingletonFile<T: Decodable>(
        _ filename: String,
        from directory: URL,
        relativeTo root: URL
    ) throws -> T {
        let fileURL = directory.appendingPathComponent(filename)
        let relPath = relativePath(filename, in: directory, relativeTo: root)
        let fm = FileManager.default

        guard fm.fileExists(atPath: fileURL.path) else {
            throw ProjectLoaderError.fileNotFound(relPath)
        }

        let data: Data
        do {
            data = try Data(contentsOf: fileURL)
        } catch {
            throw ProjectLoaderError.unreadableFile(relPath)
        }

        do {
            return try JSONDecoder().decode(T.self, from: data)
        } catch {
            throw ProjectLoaderError.decodeFailed(relPath, error)
        }
    }

    /// Reads and decodes all JSON files in a directory into an array.
    /// Top-level .json files only — skips directories, .gitkeep, .DS_Store, non-JSON.
    /// If directory doesn't exist, returns empty array (no error).
    /// Skips files that fail to decode, collecting LoadWarnings.
    private nonisolated func loadDirectory<T: Decodable>(
        _ type: T.Type,
        from directory: URL,
        relativeTo root: URL,
        warnings: inout [LoadWarning]
    ) throws -> [T] {
        let fm = FileManager.default

        guard fm.fileExists(atPath: directory.path) else {
            return []
        }

        let contents: [URL]
        do {
            contents = try fm.contentsOfDirectory(
                at: directory,
                includingPropertiesForKeys: [.isRegularFileKey],
                options: [.skipsHiddenFiles]
            )
        } catch {
            throw ProjectLoaderError.directoryEnumerationFailed(
                relativePathFor(directory, relativeTo: root), error
            )
        }

        var results: [T] = []
        let decoder = JSONDecoder()

        for fileURL in contents {
            guard fileURL.pathExtension == "json" else { continue }

            // Skip directories and non-regular files
            if let resourceValues = try? fileURL.resourceValues(forKeys: [.isRegularFileKey]),
               resourceValues.isRegularFile == false {
                continue
            }

            do {
                let data = try Data(contentsOf: fileURL)
                let item = try decoder.decode(T.self, from: data)
                results.append(item)
            } catch {
                warnings.append(LoadWarning(
                    file: relativePathFor(fileURL, relativeTo: root),
                    message: error.localizedDescription
                ))
            }
        }

        return results
    }

    /// Lists handover markdown filenames, sorted newest-first.
    /// Conforming filenames (YYYY-MM-DD prefix) are sorted reverse.
    /// Non-conforming filenames are appended last with a warning.
    private nonisolated func listHandovers(
        from directory: URL,
        relativeTo root: URL,
        warnings: inout [LoadWarning]
    ) -> [String] {
        let fm = FileManager.default

        // Check directory exists and is actually a directory
        var isDir: ObjCBool = false
        guard fm.fileExists(atPath: directory.path, isDirectory: &isDir), isDir.boolValue else {
            return []
        }

        let contents: [URL]
        do {
            contents = try fm.contentsOfDirectory(
                at: directory,
                includingPropertiesForKeys: [.isRegularFileKey],
                options: [.skipsHiddenFiles]
            )
        } catch {
            warnings.append(LoadWarning(
                file: relativePathFor(directory, relativeTo: root),
                message: "Cannot enumerate handovers: \(error.localizedDescription)"
            ))
            return []
        }

        var conforming: [String] = []
        var nonConforming: [String] = []

        for fileURL in contents {
            guard fileURL.pathExtension == "md" else { continue }

            if let resourceValues = try? fileURL.resourceValues(forKeys: [.isRegularFileKey]),
               resourceValues.isRegularFile == false {
                continue
            }

            let filename = fileURL.lastPathComponent

            if filename.prefixMatch(of: Self.handoverDateRegex) != nil {
                conforming.append(filename)
            } else {
                nonConforming.append(filename)
                let relPath = relativePathFor(fileURL, relativeTo: root)
                Log.warning("Handover filename does not start with YYYY-MM-DD date prefix: \(relPath)", tag: "ProjectLoader")
                warnings.append(LoadWarning(
                    file: relPath,
                    message: "Handover filename does not start with YYYY-MM-DD date prefix.",
                    fixable: true,
                    absolutePath: fileURL.path
                ))
            }
        }

        conforming.sort(by: >)
        return conforming + nonConforming
    }

    /// Computes a relative path by stripping the root prefix from an absolute path.
    private nonisolated func relativePathFor(_ url: URL, relativeTo root: URL) -> String {
        let fullPath = url.standardizedFileURL.path
        let rootPath = root.standardizedFileURL.path
        if fullPath.hasPrefix(rootPath) {
            return String(fullPath.dropFirst(rootPath.count))
                .trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        }
        return fullPath
    }

    /// Convenience: computes relative path for a filename inside a directory.
    private nonisolated func relativePath(
        _ filename: String,
        in directory: URL,
        relativeTo root: URL
    ) -> String {
        relativePathFor(directory.appendingPathComponent(filename), relativeTo: root)
    }
}

// MARK: - ProjectWriting Protocol

/// Writes individual ticket/issue JSON files back to `.story/`.
protocol ProjectWriting: Sendable {
    func writeTicket(_ ticket: Ticket, to projectRoot: URL) throws
    func writeIssue(_ issue: Issue, to projectRoot: URL) throws
    func deleteTicket(id: String, from projectRoot: URL) throws
    func deleteIssue(id: String, from projectRoot: URL) throws
}

extension ProjectLoader: ProjectWriting {
    /// Allowed ID pattern: alphanumeric, hyphens, underscores only.
    private static let validIDPattern = /^[A-Za-z0-9_-]+$/

    nonisolated func writeTicket(_ ticket: Ticket, to projectRoot: URL) throws {
        guard ticket.id.wholeMatch(of: Self.validIDPattern) != nil else {
            throw ProjectLoaderError.unreadableFile("Invalid ticket ID: \(ticket.id)")
        }
        let fileURL = projectRoot
            .appendingPathComponent(".story")
            .appendingPathComponent("tickets")
            .appendingPathComponent("\(ticket.id).json")
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        let data = try encoder.encode(ticket)
        try data.write(to: fileURL, options: .atomic)
    }

    nonisolated func writeIssue(_ issue: Issue, to projectRoot: URL) throws {
        guard issue.id.wholeMatch(of: Self.validIDPattern) != nil else {
            throw ProjectLoaderError.unreadableFile("Invalid issue ID: \(issue.id)")
        }
        let fileURL = projectRoot
            .appendingPathComponent(".story")
            .appendingPathComponent("issues")
            .appendingPathComponent("\(issue.id).json")
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        let data = try encoder.encode(issue)
        try data.write(to: fileURL, options: .atomic)
    }

    nonisolated func deleteTicket(id: String, from projectRoot: URL) throws {
        guard id.wholeMatch(of: Self.validIDPattern) != nil else {
            throw ProjectLoaderError.unreadableFile("Invalid ticket ID: \(id)")
        }
        let fileURL = projectRoot
            .appendingPathComponent(".story")
            .appendingPathComponent("tickets")
            .appendingPathComponent("\(id).json")
        guard FileManager.default.fileExists(atPath: fileURL.path) else {
            throw ProjectLoaderError.fileNotFound("tickets/\(id).json")
        }
        try FileManager.default.removeItem(at: fileURL)
    }

    nonisolated func deleteIssue(id: String, from projectRoot: URL) throws {
        guard id.wholeMatch(of: Self.validIDPattern) != nil else {
            throw ProjectLoaderError.unreadableFile("Invalid issue ID: \(id)")
        }
        let fileURL = projectRoot
            .appendingPathComponent(".story")
            .appendingPathComponent("issues")
            .appendingPathComponent("\(id).json")
        guard FileManager.default.fileExists(atPath: fileURL.path) else {
            throw ProjectLoaderError.fileNotFound("issues/\(id).json")
        }
        try FileManager.default.removeItem(at: fileURL)
    }
}

// MARK: - ProjectLoading Conformance

extension ProjectLoader: ProjectLoading {
    /// Async wrapper over `loadSync(from:)` with cooperative cancellation checkpoints.
    ///
    /// Runs on the caller's executor (MainActor). For `.story/` (~50 small JSON files,
    /// <50ms on SSD), this is imperceptible. The async wrapper provides cancellation semantics
    /// and protocol conformance, not background execution.
    nonisolated func load(from projectRoot: URL) async throws -> LoadResult {
        try Task.checkCancellation()
        let result = try loadSync(from: projectRoot)
        try Task.checkCancellation()
        return result
    }
}
