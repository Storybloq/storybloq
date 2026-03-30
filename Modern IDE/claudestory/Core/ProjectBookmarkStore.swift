import Foundation

// MARK: - Project Bookmark Store

/// Persists recent project entries to Application Support JSON file.
/// Provides bookmark-based directory rename resilience and recent project tracking.
///
/// Thread safety: Implicitly `@MainActor` (project setting).
@Observable
final class ProjectBookmarkStore {

    // MARK: - Types

    struct RecentProject: Codable, Equatable, Identifiable {
        var id: String { canonicalPath }
        var canonicalPath: String
        var displayName: String
        var bookmarkData: Data
        var lastOpened: Date
    }

    // MARK: - Constants

    static let maxRecents = 20
    private static let fileName = "recent-projects.json"

    // MARK: - State

    private(set) var recents: [RecentProject] = []

    // MARK: - Init

    init() {
        load()
    }

    /// Init with a custom store URL for testing.
    init(storeURL: URL) {
        customStoreURL = storeURL
        load()
    }

    @ObservationIgnored private var customStoreURL: URL?

    // MARK: - Public API

    /// Add or update a recent project entry. Upserts by canonical path,
    /// bumps to top, prunes to maxRecents. Returns true if disk write succeeded.
    @discardableResult
    func addRecent(url: URL, displayName: String) -> Bool {
        guard let bookmarkData = try? url.bookmarkData(
            options: [],
            includingResourceValuesForKeys: nil,
            relativeTo: nil
        ) else { return false }

        let path = ProjectIdentityService.canonicalize(url: url)
        let entry = RecentProject(
            canonicalPath: path,
            displayName: displayName,
            bookmarkData: bookmarkData,
            lastOpened: Date()
        )

        // Remove existing entry with same path (upsert)
        recents.removeAll { $0.canonicalPath == path }
        // Insert at top
        recents.insert(entry, at: 0)
        // Prune
        if recents.count > Self.maxRecents {
            recents = Array(recents.prefix(Self.maxRecents))
        }

        return save()
    }

    /// Remove a recent project by canonical path.
    func removeRecent(canonicalPath: String) {
        recents.removeAll { $0.canonicalPath == canonicalPath }
        save()
    }

    /// Resolve a bookmark for a recent project. Returns the resolved URL if valid,
    /// or nil if the bookmark is stale (entry is pruned). If the directory was
    /// moved/renamed, the entry is remapped to the new canonical path.
    func resolveBookmark(for canonicalPath: String) -> URL? {
        guard let index = recents.firstIndex(where: { $0.canonicalPath == canonicalPath }) else {
            return nil
        }

        let entry = recents[index]
        var isStale = false

        // Try resolving without security scope (unsandboxed)
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

        guard let url = resolvedURL else {
            // Bookmark is unresolvable — prune
            recents.remove(at: index)
            save()
            return nil
        }

        // Validate .story/ still exists
        do {
            try ProjectIdentityService.validateProjectRoot(url)
        } catch {
            recents.remove(at: index)
            save()
            return nil
        }

        // Check for path remap (directory moved/renamed)
        let newPath = ProjectIdentityService.canonicalize(url: url)
        if newPath != canonicalPath {
            // Remove any existing entry at the new path to prevent duplicates
            recents.removeAll { $0.canonicalPath == newPath }
            // Re-find index (may have shifted after removal)
            if let currentIndex = recents.firstIndex(where: { $0.canonicalPath == canonicalPath }) {
                var updated = recents[currentIndex]
                updated.canonicalPath = newPath
                updated.displayName = readDisplayName(from: url) ?? url.lastPathComponent
                // Refresh bookmark data if stale
                if isStale, let newBookmark = try? url.bookmarkData(options: [], includingResourceValuesForKeys: nil, relativeTo: nil) {
                    updated.bookmarkData = newBookmark
                }
                recents[currentIndex] = updated
                save()
            }
        } else if isStale {
            // Same path but stale bookmark — refresh
            if let newBookmark = try? url.bookmarkData(options: [], includingResourceValuesForKeys: nil, relativeTo: nil),
               let currentIndex = recents.firstIndex(where: { $0.canonicalPath == canonicalPath }) {
                recents[currentIndex].bookmarkData = newBookmark
                save()
            }
        }

        return url
    }

    /// Migrate from the old single-bookmark UserDefaults storage.
    /// Transactional: only deletes the old key after successful disk write.
    func migrateFromUserDefaults() {
        let key = "lastProjectBookmark"
        guard let oldData = UserDefaults.standard.data(forKey: key) else { return }

        var isStale = false
        let url = try? URL(
            resolvingBookmarkData: oldData,
            options: [],
            relativeTo: nil,
            bookmarkDataIsStale: &isStale
        )

        guard let resolvedURL = url else {
            // Unresolvable bookmark — nothing to migrate, clean up
            UserDefaults.standard.removeObject(forKey: key)
            return
        }

        // Validate
        do {
            try ProjectIdentityService.validateProjectRoot(resolvedURL)
        } catch {
            UserDefaults.standard.removeObject(forKey: key)
            return
        }

        let displayName = readDisplayName(from: resolvedURL) ?? resolvedURL.lastPathComponent

        // addRecent returns true if disk write succeeded
        if addRecent(url: resolvedURL, displayName: displayName) {
            // Only delete old key after confirmed disk write
            UserDefaults.standard.removeObject(forKey: key)
        }
        // If addRecent returned false (disk write failed), old key is preserved
    }

    // MARK: - Private

    private func load() {
        let url = resolvedStoreURL
        guard FileManager.default.fileExists(atPath: url.path) else {
            recents = []
            return
        }

        do {
            let data = try Data(contentsOf: url)
            let decoder = JSONDecoder()
            decoder.dateDecodingStrategy = .iso8601
            recents = try decoder.decode([RecentProject].self, from: data)
        } catch {
            // Corrupt JSON — rename to backup and start fresh
            let backupURL = url.deletingLastPathComponent()
                .appendingPathComponent("recent-projects.corrupt-\(Int(Date().timeIntervalSince1970)).json")
            try? FileManager.default.moveItem(at: url, to: backupURL)
            recents = []
        }
    }

    /// Save recents to disk. Returns true if write succeeded.
    @discardableResult
    private func save() -> Bool {
        let url = resolvedStoreURL
        let dir = url.deletingLastPathComponent()

        do {
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            let encoder = JSONEncoder()
            encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
            encoder.dateEncodingStrategy = .iso8601
            let data = try encoder.encode(recents)
            try data.write(to: url, options: .atomic)
            return true
        } catch {
            return false
        }
    }

    private var resolvedStoreURL: URL {
        if let custom = customStoreURL { return custom }
        return Self.defaultStoreURL
    }

    static var defaultStoreURL: URL {
        let appSupport = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
        return appSupport
            .appendingPathComponent("claudestory")
            .appendingPathComponent("recent-projects.json")
    }

    private func readDisplayName(from projectURL: URL) -> String? {
        let configURL = projectURL.appendingPathComponent(".story/config.json")
        guard let data = try? Data(contentsOf: configURL),
              let config = try? JSONDecoder().decode(Config.self, from: data) else {
            return nil
        }
        return config.project
    }
}
