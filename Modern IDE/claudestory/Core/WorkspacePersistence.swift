import Foundation

// MARK: - Workspace Persistence

/// Persists the set of currently open projects to disk (workspace.json).
/// Complements SwiftUI's built-in state restoration, which is unreliable
/// for multi-window scenarios. On relaunch, workspace entries that SwiftUI
/// failed to restore are opened explicitly.
///
/// Thread safety: Implicitly `@MainActor` (project setting).
final class WorkspacePersistence {

    // MARK: - Types

    struct WorkspaceEntry: Codable, Equatable {
        var canonicalPath: String
        var bookmarkData: Data
    }

    private struct WorkspaceFile: Codable {
        var version: Int
        var entries: [WorkspaceEntry]
    }

    // MARK: - Constants

    private static let currentVersion = 1
    private static let fileName = "workspace.json"

    // MARK: - Init

    init() {}

    /// Init with a custom store URL for testing.
    init(storeURL: URL) {
        customStoreURL = storeURL
    }

    private var customStoreURL: URL?

    // MARK: - Public API

    /// Save workspace entries to disk. Overwrites previous contents atomically.
    @discardableResult
    func saveWorkspace(_ entries: [WorkspaceEntry]) -> Bool {
        let file = WorkspaceFile(version: Self.currentVersion, entries: entries)
        let url = resolvedStoreURL
        let dir = url.deletingLastPathComponent()

        do {
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            let encoder = JSONEncoder()
            encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
            let data = try encoder.encode(file)
            try data.write(to: url, options: .atomic)
            return true
        } catch {
            return false
        }
    }

    /// Load workspace entries from disk. Deduplicates by canonicalPath (keeps first).
    /// Returns empty array if file doesn't exist or is corrupt.
    func loadWorkspace() -> [WorkspaceEntry] {
        let url = resolvedStoreURL
        guard FileManager.default.fileExists(atPath: url.path) else {
            return []
        }

        do {
            let data = try Data(contentsOf: url)
            let file = try JSONDecoder().decode(WorkspaceFile.self, from: data)

            // Version check — return empty for unrecognized versions
            guard file.version <= Self.currentVersion else { return [] }

            // Deduplicate by canonicalPath (keep first occurrence)
            var seen = Set<String>()
            var deduped: [WorkspaceEntry] = []
            for entry in file.entries {
                if seen.insert(entry.canonicalPath).inserted {
                    deduped.append(entry)
                }
            }

            // Rewrite if duplicates were found
            if deduped.count != file.entries.count {
                saveWorkspace(deduped)
            }

            return deduped
        } catch {
            // Corrupt JSON — rename to backup and start fresh
            let backupURL = url.deletingLastPathComponent()
                .appendingPathComponent("workspace.corrupt-\(Int(Date().timeIntervalSince1970)).json")
            try? FileManager.default.moveItem(at: url, to: backupURL)
            return []
        }
    }

    /// Resolve a workspace entry's bookmark data to a URL.
    /// Validates that .story/ still exists at the resolved path.
    /// Returns nil if the bookmark is unresolvable or the project is missing.
    ///
    /// Note: `isStale` is tracked but not acted on here. Stale bookmarks self-correct
    /// because `persistWorkspace()` re-creates bookmark data from `bookmarkStore.recents`
    /// (which refreshes on every `projectDidOpen`) on the next save cycle.
    func resolveEntry(_ entry: WorkspaceEntry) -> URL? {
        var isStale = false

        // Try resolving without security scope (app is unsandboxed)
        var resolvedURL = try? URL(
            resolvingBookmarkData: entry.bookmarkData,
            options: [],
            relativeTo: nil,
            bookmarkDataIsStale: &isStale
        )

        // Fallback: try with security scope for legacy bookmarks
        if resolvedURL == nil {
            resolvedURL = try? URL(
                resolvingBookmarkData: entry.bookmarkData,
                options: [.withSecurityScope],
                relativeTo: nil,
                bookmarkDataIsStale: &isStale
            )
        }

        guard let url = resolvedURL else { return nil }

        // Validate .story/ still exists
        do {
            try ProjectIdentityService.validateProjectRoot(url)
        } catch {
            return nil
        }

        return url
    }

    // MARK: - Private

    private var resolvedStoreURL: URL {
        if let custom = customStoreURL { return custom }
        return Self.defaultStoreURL
    }

    static var defaultStoreURL: URL {
        let appSupport = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
        return appSupport
            .appendingPathComponent("claudestory")
            .appendingPathComponent(fileName)
    }
}
