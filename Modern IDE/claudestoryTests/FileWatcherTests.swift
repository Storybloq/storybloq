import Foundation
import Testing
@testable import Modern_IDE

// MARK: - Test Helpers

private struct TimeoutError: Error {}

/// Polls a condition every 20ms until true or timeout (default 2s).
private func waitUntil(
    timeout: TimeInterval = 2.0,
    condition: @escaping @MainActor () -> Bool
) async throws {
    let deadline = Date().addingTimeInterval(timeout)
    while await !condition() {
        guard Date() < deadline else {
            throw TimeoutError()
        }
        try await Task.sleep(for: .milliseconds(20))
    }
}

/// Creates a unique temp directory for testing. Caller must clean up with defer.
private func makeTempDir() throws -> URL {
    let dir = FileManager.default.temporaryDirectory
        .appendingPathComponent("fw-test-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    return dir
}

// MARK: - Lifecycle Tests

struct FileWatcherLifecycleTests {
    @Test func startsInStoppedState() {
        let watcher = FileWatcher(debounceInterval: 0.05)
        #expect(watcher.isWatching == false)
        #expect(watcher.watchedURL == nil)
        watcher.stop()
    }

    @Test func startSetsIsWatching() throws {
        let dir = try makeTempDir()
        defer { try? FileManager.default.removeItem(at: dir) }

        let watcher = FileWatcher(debounceInterval: 0.05)
        watcher.start(watching: dir, onChange: {})

        #expect(watcher.isWatching == true)
        #expect(watcher.watchedURL == dir)
        watcher.stop()
    }

    @Test func stopClearsState() throws {
        let dir = try makeTempDir()
        defer { try? FileManager.default.removeItem(at: dir) }

        let watcher = FileWatcher(debounceInterval: 0.05)
        watcher.start(watching: dir, onChange: {})
        watcher.stop()

        #expect(watcher.isWatching == false)
        #expect(watcher.watchedURL == nil)
    }

    @Test func startWhileWatchingRestartsCleanly() throws {
        let dirA = try makeTempDir()
        let dirB = try makeTempDir()
        defer {
            try? FileManager.default.removeItem(at: dirA)
            try? FileManager.default.removeItem(at: dirB)
        }

        let watcher = FileWatcher(debounceInterval: 0.05)
        watcher.start(watching: dirA, onChange: {})
        watcher.start(watching: dirB, onChange: {})

        #expect(watcher.isWatching == true)
        #expect(watcher.watchedURL == dirB)
        watcher.stop()
    }

    @Test func stopIsIdempotent() {
        let watcher = FileWatcher(debounceInterval: 0.05)
        watcher.stop()
        watcher.stop()
        watcher.stop()
        #expect(watcher.isWatching == false)
    }

    @Test func startWithNonexistentDirectoryDoesNotCrash() {
        let fakeURL = URL(fileURLWithPath: "/tmp/does-not-exist-\(UUID().uuidString)")
        let watcher = FileWatcher(debounceInterval: 0.05)
        watcher.start(watching: fakeURL, onChange: {})
        // FSEventStreamCreate may or may not succeed for nonexistent paths —
        // either way, no crash and stop() is safe.
        watcher.stop()
    }

    @Test func rapidStartStopCyclingDoesNotCrash() throws {
        let dir = try makeTempDir()
        defer { try? FileManager.default.removeItem(at: dir) }

        let watcher = FileWatcher(debounceInterval: 0.05)
        for _ in 0..<50 {
            watcher.start(watching: dir, onChange: {})
            watcher.stop()
        }
        #expect(watcher.isWatching == false)
    }
}

// MARK: - Detection Tests

struct FileWatcherDetectionTests {
    @Test func detectsFileCreation() async throws {
        let dir = try makeTempDir()
        defer { try? FileManager.default.removeItem(at: dir) }

        var callbackCount = 0
        let watcher = FileWatcher(debounceInterval: 0.05)
        watcher.start(watching: dir) {
            callbackCount += 1
        }

        // Write a file after a brief delay for FSEvents to register.
        try await Task.sleep(for: .milliseconds(50))
        try "test".write(
            to: dir.appendingPathComponent("test.json"),
            atomically: true, encoding: .utf8
        )

        try await waitUntil { callbackCount >= 1 }
        #expect(callbackCount >= 1)
        watcher.stop()
    }

    @Test func detectsFileModification() async throws {
        let dir = try makeTempDir()
        defer { try? FileManager.default.removeItem(at: dir) }

        let fileURL = dir.appendingPathComponent("existing.json")
        try "original".write(to: fileURL, atomically: true, encoding: .utf8)

        var callbackCount = 0
        let watcher = FileWatcher(debounceInterval: 0.05)
        watcher.start(watching: dir) {
            callbackCount += 1
        }

        try await Task.sleep(for: .milliseconds(50))
        try "modified".write(to: fileURL, atomically: true, encoding: .utf8)

        try await waitUntil { callbackCount >= 1 }
        #expect(callbackCount >= 1)
        watcher.stop()
    }

    @Test func detectsFileInSubdirectory() async throws {
        let dir = try makeTempDir()
        let subdir = dir.appendingPathComponent("tickets")
        try FileManager.default.createDirectory(at: subdir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }

        var callbackCount = 0
        let watcher = FileWatcher(debounceInterval: 0.05)
        watcher.start(watching: dir) {
            callbackCount += 1
        }

        try await Task.sleep(for: .milliseconds(50))
        try "ticket".write(
            to: subdir.appendingPathComponent("T-001.json"),
            atomically: true, encoding: .utf8
        )

        try await waitUntil { callbackCount >= 1 }
        #expect(callbackCount >= 1)
        watcher.stop()
    }

    @Test func detectsFileDeletion() async throws {
        let dir = try makeTempDir()
        let fileURL = dir.appendingPathComponent("delete-me.json")
        try "content".write(to: fileURL, atomically: true, encoding: .utf8)
        defer { try? FileManager.default.removeItem(at: dir) }

        var callbackCount = 0
        let watcher = FileWatcher(debounceInterval: 0.05)
        watcher.start(watching: dir) {
            callbackCount += 1
        }

        try await Task.sleep(for: .milliseconds(50))
        try FileManager.default.removeItem(at: fileURL)

        try await waitUntil { callbackCount >= 1 }
        #expect(callbackCount >= 1)
        watcher.stop()
    }
}

// MARK: - Debounce Tests

struct FileWatcherDebounceTests {
    @Test func noCallbackAfterStop() async throws {
        let dir = try makeTempDir()
        defer { try? FileManager.default.removeItem(at: dir) }

        var callbackCount = 0
        let watcher = FileWatcher(debounceInterval: 0.05)
        watcher.start(watching: dir) {
            callbackCount += 1
        }

        try await Task.sleep(for: .milliseconds(50))
        try "test".write(
            to: dir.appendingPathComponent("trigger.json"),
            atomically: true, encoding: .utf8
        )

        // Immediately stop — should cancel the pending debounce.
        watcher.stop()

        // Wait 500ms (10x debounce). Asserting absence — a slow system gives
        // MORE time for a spurious callback, making this test stricter.
        try await Task.sleep(for: .milliseconds(500))
        #expect(callbackCount == 0)
    }
}
