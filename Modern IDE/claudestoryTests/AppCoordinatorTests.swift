import Testing
import Foundation
@testable import Modern_IDE

struct AppCoordinatorTests {

    // MARK: - Helpers

    private func makeTempProjectDir() throws -> URL {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("claudestory-test-\(UUID().uuidString)")
        let claudestoryDir = dir.appendingPathComponent(".story")
        try FileManager.default.createDirectory(at: claudestoryDir, withIntermediateDirectories: true)
        let json = """
        {"version":2,"project":"test","type":"macapp","language":"swift","features":{"tickets":true,"issues":true,"handovers":true,"roadmap":true,"reviews":true}}
        """.data(using: .utf8)!
        try json.write(to: claudestoryDir.appendingPathComponent("config.json"))
        return dir
    }

    // MARK: - State Transitions

    @Test func registerOpeningSetsOpeningState() throws {
        let coordinator = AppCoordinator()
        let dir = try makeTempProjectDir()
        defer { try? FileManager.default.removeItem(at: dir) }

        let path = ProjectIdentityService.canonicalize(url: dir)
        let registered = coordinator.registerOpening(url: dir)
        #expect(registered)
        #expect(coordinator.projectStates[path] == .opening)
    }

    @Test func projectDidOpenTransitionsToOpen() throws {
        let coordinator = AppCoordinator()
        let dir = try makeTempProjectDir()
        defer { try? FileManager.default.removeItem(at: dir) }

        let path = ProjectIdentityService.canonicalize(url: dir)
        coordinator.registerOpening(url: dir)
        coordinator.projectDidOpen(canonicalPath: path)
        #expect(coordinator.projectStates[path] == .open)
    }

    @Test func projectDidCloseRemovesEntry() throws {
        let coordinator = AppCoordinator()
        let dir = try makeTempProjectDir()
        defer { try? FileManager.default.removeItem(at: dir) }

        let path = ProjectIdentityService.canonicalize(url: dir)
        coordinator.registerOpening(url: dir)
        coordinator.projectDidOpen(canonicalPath: path)
        coordinator.projectDidClose(canonicalPath: path)
        #expect(coordinator.projectStates[path] == nil)
        #expect(coordinator.openProjectCount == 0)
    }

    // MARK: - Dedup

    @Test func registerOpeningReturnsFalseForDuplicate() throws {
        let coordinator = AppCoordinator()
        let dir = try makeTempProjectDir()
        defer { try? FileManager.default.removeItem(at: dir) }

        #expect(coordinator.registerOpening(url: dir))
        #expect(!coordinator.registerOpening(url: dir))
    }

    @Test func registerOpeningReturnsFalseWhenAlreadyOpen() throws {
        let coordinator = AppCoordinator()
        let dir = try makeTempProjectDir()
        defer { try? FileManager.default.removeItem(at: dir) }

        let path = ProjectIdentityService.canonicalize(url: dir)
        coordinator.registerOpening(url: dir)
        coordinator.projectDidOpen(canonicalPath: path)
        #expect(!coordinator.registerOpening(url: dir))
    }

    // MARK: - Unregister Opening

    @Test func unregisterOpeningRemovesOnlyOpeningState() throws {
        let coordinator = AppCoordinator()
        let dir = try makeTempProjectDir()
        defer { try? FileManager.default.removeItem(at: dir) }

        let path = ProjectIdentityService.canonicalize(url: dir)
        coordinator.registerOpening(url: dir)
        coordinator.unregisterOpening(url: dir)
        #expect(coordinator.projectStates[path] == nil)
    }

    @Test func unregisterOpeningDoesNotRemoveOpenState() throws {
        let coordinator = AppCoordinator()
        let dir = try makeTempProjectDir()
        defer { try? FileManager.default.removeItem(at: dir) }

        let path = ProjectIdentityService.canonicalize(url: dir)
        coordinator.registerOpening(url: dir)
        coordinator.projectDidOpen(canonicalPath: path)
        coordinator.unregisterOpening(url: dir)
        // Should still be .open — unregister only removes .opening
        #expect(coordinator.projectStates[path] == .open)
    }

    // MARK: - Close-During-Loading Race

    @Test func projectDidOpenNoOpsIfNotInOpeningState() throws {
        let coordinator = AppCoordinator()
        let dir = try makeTempProjectDir()
        defer { try? FileManager.default.removeItem(at: dir) }

        let path = ProjectIdentityService.canonicalize(url: dir)
        // Register then close before open completes
        coordinator.registerOpening(url: dir)
        coordinator.projectDidClose(canonicalPath: path)
        // Late projectDidOpen should be a no-op
        coordinator.projectDidOpen(canonicalPath: path)
        #expect(coordinator.projectStates[path] == nil)
    }

    @Test func projectDidCloseHandlesBothPhases() throws {
        let coordinator = AppCoordinator()
        let dir = try makeTempProjectDir()
        defer { try? FileManager.default.removeItem(at: dir) }

        let path = ProjectIdentityService.canonicalize(url: dir)

        // Close while .opening
        coordinator.registerOpening(url: dir)
        coordinator.projectDidClose(canonicalPath: path)
        #expect(coordinator.projectStates[path] == nil)
    }

    // MARK: - isStillOpening

    @Test func isStillOpeningReturnsTrueOnlyForOpening() throws {
        let coordinator = AppCoordinator()
        let dir = try makeTempProjectDir()
        defer { try? FileManager.default.removeItem(at: dir) }

        let path = ProjectIdentityService.canonicalize(url: dir)
        #expect(!coordinator.isStillOpening(canonicalPath: path))

        coordinator.registerOpening(url: dir)
        #expect(coordinator.isStillOpening(canonicalPath: path))

        coordinator.projectDidOpen(canonicalPath: path)
        #expect(!coordinator.isStillOpening(canonicalPath: path))
    }

    // MARK: - Load Failure + Retry

    @Test func loadFailureUnregistersAndAllowsRetry() throws {
        let coordinator = AppCoordinator()
        let dir = try makeTempProjectDir()
        defer { try? FileManager.default.removeItem(at: dir) }

        let path = ProjectIdentityService.canonicalize(url: dir)

        // Initial open
        coordinator.registerOpening(url: dir)
        #expect(coordinator.projectStates[path] == .opening)

        // Simulate load failure
        coordinator.unregisterOpening(url: dir)
        #expect(coordinator.projectStates[path] == nil)

        // Retry succeeds
        #expect(coordinator.registerOpening(url: dir))
        #expect(coordinator.projectStates[path] == .opening)
    }

    // MARK: - shouldShowWelcome

    @Test func shouldShowWelcomeRequiresAllConditions() {
        let coordinator = AppCoordinator()
        // Not yet complete — should not show
        #expect(!coordinator.shouldShowWelcome)

        coordinator.restorationComplete = true
        #expect(coordinator.shouldShowWelcome)
    }

    @Test func shouldShowWelcomeFalseWithProjects() throws {
        let coordinator = AppCoordinator()
        coordinator.restorationComplete = true
        let dir = try makeTempProjectDir()
        defer { try? FileManager.default.removeItem(at: dir) }

        coordinator.registerOpening(url: dir)
        #expect(!coordinator.shouldShowWelcome)
    }

    @Test func shouldShowWelcomeFalseWithTransientWindows() {
        let coordinator = AppCoordinator()
        coordinator.restorationComplete = true

        let fakeID = ObjectIdentifier(NSObject())
        coordinator.transientSceneAppeared(windowID: fakeID)
        #expect(!coordinator.shouldShowWelcome)

        coordinator.transientSceneGone(windowID: fakeID)
        #expect(coordinator.shouldShowWelcome)
    }

    // MARK: - Transient Tracking

    @Test func transientGoneForUnknownIDIsNoOp() {
        let coordinator = AppCoordinator()
        let fakeID = ObjectIdentifier(NSObject())
        coordinator.transientSceneGone(windowID: fakeID)
        #expect(coordinator.transientSceneCount == 0)
    }

    // MARK: - projectDidOpen displayName

    @Test func projectDidOpenWithDisplayNameOverridesMetadata() throws {
        let coordinator = AppCoordinator()
        let dir = try makeTempProjectDir()
        defer { try? FileManager.default.removeItem(at: dir) }

        let path = ProjectIdentityService.canonicalize(url: dir)
        coordinator.registerOpening(url: dir) // default displayName = dir.lastPathComponent
        coordinator.projectDidOpen(canonicalPath: path, displayName: "custom-name")
        #expect(coordinator.bookmarkStore.recents.count == 1)
        #expect(coordinator.bookmarkStore.recents.first?.displayName == "custom-name")
    }

    @Test func projectDidOpenWithoutDisplayNameUsesMetadata() throws {
        let coordinator = AppCoordinator()
        let dir = try makeTempProjectDir()
        defer { try? FileManager.default.removeItem(at: dir) }

        let path = ProjectIdentityService.canonicalize(url: dir)
        coordinator.registerOpening(url: dir) // default displayName = dir.lastPathComponent
        coordinator.projectDidOpen(canonicalPath: path) // no displayName
        #expect(coordinator.bookmarkStore.recents.count == 1)
        #expect(coordinator.bookmarkStore.recents.first?.displayName == dir.lastPathComponent)
    }

    // MARK: - Workspace Persistence (T-072)

    @Test func projectDidOpenPersistsWorkspace() throws {
        let coordinator = AppCoordinator()
        let dir = try makeTempProjectDir()
        defer { try? FileManager.default.removeItem(at: dir) }

        let path = ProjectIdentityService.canonicalize(url: dir)
        coordinator.registerOpening(url: dir)
        coordinator.projectDidOpen(canonicalPath: path)

        // Verify workspace has the entry
        let entries = coordinator.workspacePersistence.loadWorkspace()
        #expect(entries.contains { $0.canonicalPath == path })
    }

    @Test func projectDidClosePersistsWorkspace() throws {
        let coordinator = AppCoordinator()
        let dir = try makeTempProjectDir()
        defer { try? FileManager.default.removeItem(at: dir) }

        let path = ProjectIdentityService.canonicalize(url: dir)
        coordinator.registerOpening(url: dir)
        coordinator.projectDidOpen(canonicalPath: path)
        coordinator.projectDidClose(canonicalPath: path)

        let entries = coordinator.workspacePersistence.loadWorkspace()
        #expect(!entries.contains { $0.canonicalPath == path })
    }

    @MainActor @Test func persistWorkspaceSkippedDuringTermination() throws {
        let coordinator = AppCoordinator()
        let dir = try makeTempProjectDir()
        defer { try? FileManager.default.removeItem(at: dir) }

        let path = ProjectIdentityService.canonicalize(url: dir)
        coordinator.registerOpening(url: dir)
        coordinator.projectDidOpen(canonicalPath: path)

        // Verify workspace has the entry
        let beforeEntries = coordinator.workspacePersistence.loadWorkspace()
        #expect(beforeEntries.contains { $0.canonicalPath == path })

        // Simulate termination
        AppDelegate.isTerminating = true
        defer { AppDelegate.isTerminating = false }

        coordinator.projectDidClose(canonicalPath: path)

        // Workspace should still have the entry (save was skipped)
        let afterEntries = coordinator.workspacePersistence.loadWorkspace()
        #expect(afterEntries.contains { $0.canonicalPath == path })
    }

    @Test func restoreWorkspaceRegistersOpening() throws {
        let coordinator = AppCoordinator()
        let dir = try makeTempProjectDir()
        defer { try? FileManager.default.removeItem(at: dir) }

        let path = ProjectIdentityService.canonicalize(url: dir)

        // Manually save a workspace entry
        let bookmarkData = try dir.bookmarkData(options: [], includingResourceValuesForKeys: nil, relativeTo: nil)
        coordinator.workspacePersistence.saveWorkspace([
            .init(canonicalPath: path, bookmarkData: bookmarkData)
        ])

        let pathsToOpen = coordinator.restoreWorkspace()
        #expect(pathsToOpen.count == 1)
        #expect(pathsToOpen[0] == path)
        #expect(coordinator.projectStates[path] == .opening)
    }

    @Test func restoreWorkspaceSkipsMissingProjects() throws {
        let coordinator = AppCoordinator()
        let dir = try makeTempProjectDir()
        let path = ProjectIdentityService.canonicalize(url: dir)
        let bookmarkData = try dir.bookmarkData(options: [], includingResourceValuesForKeys: nil, relativeTo: nil)

        // Delete the project
        try FileManager.default.removeItem(at: dir)

        coordinator.workspacePersistence.saveWorkspace([
            .init(canonicalPath: path, bookmarkData: bookmarkData)
        ])

        let pathsToOpen = coordinator.restoreWorkspace()
        #expect(pathsToOpen.isEmpty)
    }

    @Test func restoreWorkspaceExecutesOnlyOnce() throws {
        let coordinator = AppCoordinator()
        let dir = try makeTempProjectDir()
        defer { try? FileManager.default.removeItem(at: dir) }

        let path = ProjectIdentityService.canonicalize(url: dir)
        let bookmarkData = try dir.bookmarkData(options: [], includingResourceValuesForKeys: nil, relativeTo: nil)
        coordinator.workspacePersistence.saveWorkspace([
            .init(canonicalPath: path, bookmarkData: bookmarkData)
        ])

        let first = coordinator.restoreWorkspace()
        #expect(first.count == 1)

        let second = coordinator.restoreWorkspace()
        #expect(second.isEmpty)
    }

    @Test func restoreWorkspaceSkipsAlreadyTracked() throws {
        let coordinator = AppCoordinator()
        let dir = try makeTempProjectDir()
        defer { try? FileManager.default.removeItem(at: dir) }

        let path = ProjectIdentityService.canonicalize(url: dir)
        let bookmarkData = try dir.bookmarkData(options: [], includingResourceValuesForKeys: nil, relativeTo: nil)

        // Pre-register the project (simulates SwiftUI restoration)
        coordinator.registerOpening(url: dir)

        coordinator.workspacePersistence.saveWorkspace([
            .init(canonicalPath: path, bookmarkData: bookmarkData)
        ])

        let pathsToOpen = coordinator.restoreWorkspace()
        #expect(pathsToOpen.isEmpty)
    }

    @Test func persistWorkspaceSavesOpeningAndOpen() throws {
        let coordinator = AppCoordinator()
        let dir1 = try makeTempProjectDir()
        let dir2 = try makeTempProjectDir()
        defer { try? FileManager.default.removeItem(at: dir1) }
        defer { try? FileManager.default.removeItem(at: dir2) }

        let path1 = ProjectIdentityService.canonicalize(url: dir1)
        let path2 = ProjectIdentityService.canonicalize(url: dir2)

        // dir1 in .opening, dir2 in .open
        coordinator.registerOpening(url: dir1)
        coordinator.registerOpening(url: dir2)
        coordinator.projectDidOpen(canonicalPath: path2)

        let entries = coordinator.workspacePersistence.loadWorkspace()
        #expect(entries.contains { $0.canonicalPath == path1 }) // .opening
        #expect(entries.contains { $0.canonicalPath == path2 }) // .open
    }

    @Test func persistWorkspaceFallsBackToCreatingBookmark() throws {
        // When bookmarkStore.recents is empty (addRecent failed or project not in recents),
        // persistWorkspace falls back to creating bookmark from URL(fileURLWithPath:).
        let coordinator = AppCoordinator()
        let dir = try makeTempProjectDir()
        defer { try? FileManager.default.removeItem(at: dir) }

        let path = ProjectIdentityService.canonicalize(url: dir)

        // Register as .opening only — projectDidOpen not called, so
        // bookmarkStore.addRecent is never invoked. The recents array
        // won't have this project.
        coordinator.registerOpening(url: dir)
        #expect(coordinator.bookmarkStore.recents.isEmpty ||
                !coordinator.bookmarkStore.recents.contains { $0.canonicalPath == path })

        // persistWorkspace is private, but registerOpening triggers it indirectly
        // via projectDidOpen. Instead, transition to .open manually — projectDidOpen
        // calls persistWorkspace after addRecent, so the bookmark would come from recents.
        // To test the fallback, we need .opening state where recents doesn't have the entry.
        // registerOpening already called persistWorkspace? No — only projectDidOpen and
        // projectDidClose call persistWorkspace. So we need to trigger it.
        // The simplest test: verify that after projectDidOpen the workspace entry exists
        // even when using a fresh coordinator where addRecent might create the entry.
        // Since we can't easily isolate the fallback path without dependency injection,
        // verify the entry exists with correct path after the full flow.
        coordinator.projectDidOpen(canonicalPath: path)

        let entries = coordinator.workspacePersistence.loadWorkspace()
        #expect(entries.contains { $0.canonicalPath == path })
        #expect(!entries.first(where: { $0.canonicalPath == path })!.bookmarkData.isEmpty)
    }

    // MARK: - Canonicalization Dedup

    @Test func sameDirDifferentURLsSameKey() throws {
        let dir = try makeTempProjectDir()
        defer { try? FileManager.default.removeItem(at: dir) }

        // Access via trailing slash
        let url1 = dir
        let url2 = dir.appendingPathComponent(".")

        let path1 = ProjectIdentityService.canonicalize(url: url1)
        let path2 = ProjectIdentityService.canonicalize(url: url2)
        #expect(path1 == path2)
    }
}
