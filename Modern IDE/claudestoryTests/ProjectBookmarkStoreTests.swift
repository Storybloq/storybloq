import Testing
import Foundation
@testable import Modern_IDE

struct ProjectBookmarkStoreTests {

    // MARK: - Helpers

    private func makeTempStoreURL() -> URL {
        FileManager.default.temporaryDirectory
            .appendingPathComponent("claudestory-store-\(UUID().uuidString)")
            .appendingPathComponent("recent-projects.json")
    }

    private func makeTempProjectDir(name: String = "test") throws -> URL {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("claudestory-proj-\(UUID().uuidString)")
        let claudestoryDir = dir.appendingPathComponent(".story")
        try FileManager.default.createDirectory(at: claudestoryDir, withIntermediateDirectories: true)
        let json = """
        {"version":2,"project":"\(name)","type":"macapp","language":"swift","features":{"tickets":true,"issues":true,"handovers":true,"roadmap":true,"reviews":true}}
        """.data(using: .utf8)!
        try json.write(to: claudestoryDir.appendingPathComponent("config.json"))
        return dir
    }

    // MARK: - Add Recent

    @Test func addRecentCreatesEntry() throws {
        let storeURL = makeTempStoreURL()
        defer { try? FileManager.default.removeItem(at: storeURL.deletingLastPathComponent()) }
        let store = ProjectBookmarkStore(storeURL: storeURL)
        let dir = try makeTempProjectDir()
        defer { try? FileManager.default.removeItem(at: dir) }

        let success = store.addRecent(url: dir, displayName: "Test")
        #expect(success)
        #expect(store.recents.count == 1)
        #expect(store.recents[0].displayName == "Test")
        #expect(store.recents[0].canonicalPath == ProjectIdentityService.canonicalize(url: dir))
    }

    @Test func addRecentSamePathUpsertsToTop() throws {
        let storeURL = makeTempStoreURL()
        defer { try? FileManager.default.removeItem(at: storeURL.deletingLastPathComponent()) }
        let store = ProjectBookmarkStore(storeURL: storeURL)
        let dir1 = try makeTempProjectDir()
        let dir2 = try makeTempProjectDir()
        defer { try? FileManager.default.removeItem(at: dir1) }
        defer { try? FileManager.default.removeItem(at: dir2) }

        store.addRecent(url: dir1, displayName: "First")
        store.addRecent(url: dir2, displayName: "Second")
        #expect(store.recents.count == 2)
        #expect(store.recents[0].displayName == "Second")

        // Upsert dir1 with new name — should bump to top
        store.addRecent(url: dir1, displayName: "First Updated")
        #expect(store.recents.count == 2)
        #expect(store.recents[0].displayName == "First Updated")
    }

    @Test func addRecentPrunesToMax() throws {
        let storeURL = makeTempStoreURL()
        defer { try? FileManager.default.removeItem(at: storeURL.deletingLastPathComponent()) }
        let store = ProjectBookmarkStore(storeURL: storeURL)

        var dirs: [URL] = []
        for i in 0..<21 {
            let dir = try makeTempProjectDir(name: "proj-\(i)")
            dirs.append(dir)
            store.addRecent(url: dir, displayName: "Project \(i)")
        }
        defer { dirs.forEach { try? FileManager.default.removeItem(at: $0) } }

        #expect(store.recents.count == ProjectBookmarkStore.maxRecents)
        // First added (index 0) should have been pruned
        let firstPath = ProjectIdentityService.canonicalize(url: dirs[0])
        #expect(!store.recents.contains { $0.canonicalPath == firstPath })
    }

    // MARK: - Remove Recent

    @Test func removeRecentRemovesCorrectEntry() throws {
        let storeURL = makeTempStoreURL()
        defer { try? FileManager.default.removeItem(at: storeURL.deletingLastPathComponent()) }
        let store = ProjectBookmarkStore(storeURL: storeURL)
        let dir = try makeTempProjectDir()
        defer { try? FileManager.default.removeItem(at: dir) }

        store.addRecent(url: dir, displayName: "Test")
        let path = ProjectIdentityService.canonicalize(url: dir)
        store.removeRecent(canonicalPath: path)
        #expect(store.recents.isEmpty)
    }

    // MARK: - Resolve Bookmark

    @Test func resolveBookmarkReturnsURLForValidEntry() throws {
        let storeURL = makeTempStoreURL()
        defer { try? FileManager.default.removeItem(at: storeURL.deletingLastPathComponent()) }
        let store = ProjectBookmarkStore(storeURL: storeURL)
        let dir = try makeTempProjectDir()
        defer { try? FileManager.default.removeItem(at: dir) }

        store.addRecent(url: dir, displayName: "Test")
        let path = ProjectIdentityService.canonicalize(url: dir)
        let resolved = store.resolveBookmark(for: path)
        #expect(resolved != nil)
    }

    @Test func resolveBookmarkPrunesDeletedProject() throws {
        let storeURL = makeTempStoreURL()
        defer { try? FileManager.default.removeItem(at: storeURL.deletingLastPathComponent()) }
        let store = ProjectBookmarkStore(storeURL: storeURL)
        let dir = try makeTempProjectDir()

        store.addRecent(url: dir, displayName: "Test")
        let path = ProjectIdentityService.canonicalize(url: dir)

        // Delete the project directory
        try FileManager.default.removeItem(at: dir)

        // Resolve should fail and prune
        let resolved = store.resolveBookmark(for: path)
        #expect(resolved == nil)
        #expect(store.recents.isEmpty)
    }

    // MARK: - JSON Round-Trip

    @Test func jsonRoundTrip() throws {
        let storeURL = makeTempStoreURL()
        defer { try? FileManager.default.removeItem(at: storeURL.deletingLastPathComponent()) }
        let store = ProjectBookmarkStore(storeURL: storeURL)
        let dir = try makeTempProjectDir()
        defer { try? FileManager.default.removeItem(at: dir) }

        store.addRecent(url: dir, displayName: "Test")

        // Load a fresh store from same URL
        let store2 = ProjectBookmarkStore(storeURL: storeURL)
        #expect(store2.recents.count == 1)
        #expect(store2.recents[0].displayName == "Test")
        #expect(store2.recents[0].canonicalPath == store.recents[0].canonicalPath)
    }

    // MARK: - Corrupt JSON Recovery

    @Test func corruptJSONRecovery() throws {
        let storeURL = makeTempStoreURL()
        let dir = storeURL.deletingLastPathComponent()
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }

        // Write corrupt data
        try Data("not json at all".utf8).write(to: storeURL)

        // Load should recover gracefully
        let store = ProjectBookmarkStore(storeURL: storeURL)
        #expect(store.recents.isEmpty)

        // Original file should be renamed to .corrupt-*
        #expect(!FileManager.default.fileExists(atPath: storeURL.path))
    }

    // MARK: - Empty Store

    @Test func emptyStoreLoadsWithoutError() {
        let storeURL = makeTempStoreURL()
        defer { try? FileManager.default.removeItem(at: storeURL.deletingLastPathComponent()) }
        let store = ProjectBookmarkStore(storeURL: storeURL)
        #expect(store.recents.isEmpty)
    }

    // MARK: - Migration

    @Test func migrateFromUserDefaultsCreatesEntry() throws {
        let storeURL = makeTempStoreURL()
        defer { try? FileManager.default.removeItem(at: storeURL.deletingLastPathComponent()) }
        let dir = try makeTempProjectDir(name: "migrated")
        defer { try? FileManager.default.removeItem(at: dir) }

        // Set up old bookmark
        let bookmarkData = try dir.bookmarkData(options: [], includingResourceValuesForKeys: nil, relativeTo: nil)
        UserDefaults.standard.set(bookmarkData, forKey: "lastProjectBookmark")
        defer { UserDefaults.standard.removeObject(forKey: "lastProjectBookmark") }

        let store = ProjectBookmarkStore(storeURL: storeURL)
        store.migrateFromUserDefaults()

        #expect(store.recents.count == 1)
        #expect(store.recents[0].displayName == "migrated")
        // Old key should be removed after successful save
        #expect(UserDefaults.standard.data(forKey: "lastProjectBookmark") == nil)
    }

    @Test func migrateFromUserDefaultsWithInvalidBookmarkCleansUp() {
        let storeURL = makeTempStoreURL()
        defer { try? FileManager.default.removeItem(at: storeURL.deletingLastPathComponent()) }

        // Set up invalid bookmark data
        UserDefaults.standard.set(Data("invalid".utf8), forKey: "lastProjectBookmark")
        defer { UserDefaults.standard.removeObject(forKey: "lastProjectBookmark") }

        let store = ProjectBookmarkStore(storeURL: storeURL)
        store.migrateFromUserDefaults()

        #expect(store.recents.isEmpty)
        // Old key should be cleaned up even on failure
        #expect(UserDefaults.standard.data(forKey: "lastProjectBookmark") == nil)
    }
}
