import Testing
import Foundation
@testable import Modern_IDE

struct WorkspacePersistenceTests {

    // MARK: - Helpers

    private func makeTempStoreURL() -> URL {
        FileManager.default.temporaryDirectory
            .appendingPathComponent("claudestory-ws-\(UUID().uuidString)")
            .appendingPathComponent("workspace.json")
    }

    private func makeTempProjectDir(name: String = "test") throws -> URL {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("claudestory-ws-proj-\(UUID().uuidString)")
        let claudestoryDir = dir.appendingPathComponent(".story")
        try FileManager.default.createDirectory(at: claudestoryDir, withIntermediateDirectories: true)
        let json = """
        {"version":2,"project":"\(name)","type":"macapp","language":"swift","features":{"tickets":true,"issues":true,"handovers":true,"roadmap":true,"reviews":true}}
        """.data(using: .utf8)!
        try json.write(to: claudestoryDir.appendingPathComponent("config.json"))
        return dir
    }

    private func makeEntry(for dir: URL) throws -> WorkspacePersistence.WorkspaceEntry {
        let bookmarkData = try dir.bookmarkData(
            options: [],
            includingResourceValuesForKeys: nil,
            relativeTo: nil
        )
        return .init(
            canonicalPath: ProjectIdentityService.canonicalize(url: dir),
            bookmarkData: bookmarkData
        )
    }

    // MARK: - Save & Load

    @Test func saveAndLoadRoundTrips() throws {
        let storeURL = makeTempStoreURL()
        defer { try? FileManager.default.removeItem(at: storeURL.deletingLastPathComponent()) }

        let dir1 = try makeTempProjectDir(name: "proj1")
        let dir2 = try makeTempProjectDir(name: "proj2")
        defer { try? FileManager.default.removeItem(at: dir1) }
        defer { try? FileManager.default.removeItem(at: dir2) }

        let store = WorkspacePersistence(storeURL: storeURL)
        let entries = [try makeEntry(for: dir1), try makeEntry(for: dir2)]
        let success = store.saveWorkspace(entries)
        #expect(success)

        // Load from a fresh instance at the same URL
        let store2 = WorkspacePersistence(storeURL: storeURL)
        let loaded = store2.loadWorkspace()
        #expect(loaded.count == 2)
        #expect(loaded[0].canonicalPath == entries[0].canonicalPath)
        #expect(loaded[1].canonicalPath == entries[1].canonicalPath)
    }

    @Test func emptyWorkspaceLoadsWithoutError() {
        let storeURL = makeTempStoreURL()
        defer { try? FileManager.default.removeItem(at: storeURL.deletingLastPathComponent()) }

        let store = WorkspacePersistence(storeURL: storeURL)
        let loaded = store.loadWorkspace()
        #expect(loaded.isEmpty)
    }

    @Test func saveOverwritesPreviousEntries() throws {
        let storeURL = makeTempStoreURL()
        defer { try? FileManager.default.removeItem(at: storeURL.deletingLastPathComponent()) }

        let dir1 = try makeTempProjectDir(name: "proj1")
        let dir2 = try makeTempProjectDir(name: "proj2")
        let dir3 = try makeTempProjectDir(name: "proj3")
        defer { try? FileManager.default.removeItem(at: dir1) }
        defer { try? FileManager.default.removeItem(at: dir2) }
        defer { try? FileManager.default.removeItem(at: dir3) }

        let store = WorkspacePersistence(storeURL: storeURL)
        store.saveWorkspace([try makeEntry(for: dir1), try makeEntry(for: dir2), try makeEntry(for: dir3)])

        // Overwrite with just one entry
        store.saveWorkspace([try makeEntry(for: dir1)])

        let loaded = store.loadWorkspace()
        #expect(loaded.count == 1)
        #expect(loaded[0].canonicalPath == ProjectIdentityService.canonicalize(url: dir1))
    }

    // MARK: - Resolve Entry

    @Test func resolveEntryReturnsURLForValidProject() throws {
        let dir = try makeTempProjectDir()
        defer { try? FileManager.default.removeItem(at: dir) }

        let store = WorkspacePersistence()
        let entry = try makeEntry(for: dir)
        let resolved = store.resolveEntry(entry)
        #expect(resolved != nil)
    }

    @Test func resolveEntrySucceedsWithStaleBookmark() throws {
        // Stale bookmarks resolve successfully — staleness self-corrects
        // on the next persistWorkspace() cycle via fresh bookmarkStore data.
        let dir = try makeTempProjectDir()
        defer { try? FileManager.default.removeItem(at: dir) }

        let store = WorkspacePersistence()
        let entry = try makeEntry(for: dir)

        // Resolve should succeed regardless of staleness
        // (we can't force a stale bookmark in tests, but verify the
        // resolve path works and returns a valid URL)
        let resolved = store.resolveEntry(entry)
        #expect(resolved != nil)
        #expect(resolved?.standardizedFileURL == dir.standardizedFileURL)
    }

    @Test func resolveEntryReturnsNilForDeletedProject() throws {
        let dir = try makeTempProjectDir()
        let entry = try makeEntry(for: dir)

        // Delete the project directory
        try FileManager.default.removeItem(at: dir)

        let store = WorkspacePersistence()
        let resolved = store.resolveEntry(entry)
        #expect(resolved == nil)
    }

    // MARK: - Corrupt JSON

    @Test func corruptJSONLoadsEmpty() throws {
        let storeURL = makeTempStoreURL()
        let dir = storeURL.deletingLastPathComponent()
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }

        // Write corrupt data
        try Data("not json at all".utf8).write(to: storeURL)

        let store = WorkspacePersistence(storeURL: storeURL)
        let loaded = store.loadWorkspace()
        #expect(loaded.isEmpty)

        // Original file should be renamed to .corrupt-*
        #expect(!FileManager.default.fileExists(atPath: storeURL.path))
    }

    // MARK: - Dedup

    @Test func duplicateEntriesDeduplicatedOnLoad() throws {
        let storeURL = makeTempStoreURL()
        let dir = storeURL.deletingLastPathComponent()
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }

        let projDir = try makeTempProjectDir()
        defer { try? FileManager.default.removeItem(at: projDir) }
        let entry = try makeEntry(for: projDir)

        // Write JSON with duplicate entries directly
        let dupeJSON = """
        {"version":1,"entries":[\(String(data: try JSONEncoder().encode(entry), encoding: .utf8)!),\(String(data: try JSONEncoder().encode(entry), encoding: .utf8)!)]}
        """.data(using: .utf8)!
        try dupeJSON.write(to: storeURL)

        let store = WorkspacePersistence(storeURL: storeURL)
        let loaded = store.loadWorkspace()
        #expect(loaded.count == 1)
    }
}
