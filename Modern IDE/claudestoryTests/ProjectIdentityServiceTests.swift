import Testing
import Foundation
@testable import Modern_IDE

struct ProjectIdentityServiceTests {

    // MARK: - Helpers

    private func makeTempDir() throws -> URL {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("claudestory-identity-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    private func makeValidProject(at dir: URL) throws {
        let claudestoryDir = dir.appendingPathComponent(".story")
        try FileManager.default.createDirectory(at: claudestoryDir, withIntermediateDirectories: true)
        let json = """
        {"version":2,"project":"test","type":"macapp","language":"swift","features":{"tickets":true,"issues":true,"handovers":true,"roadmap":true,"reviews":true}}
        """.data(using: .utf8)!
        try json.write(to: claudestoryDir.appendingPathComponent("config.json"))
    }

    // MARK: - Canonicalization

    @Test func canonicalizeResolvesSymlinks() throws {
        let realDir = try makeTempDir()
        defer { try? FileManager.default.removeItem(at: realDir) }

        let symlinkDir = realDir.deletingLastPathComponent()
            .appendingPathComponent("claudestory-symlink-\(UUID().uuidString)")
        try FileManager.default.createSymbolicLink(at: symlinkDir, withDestinationURL: realDir)
        defer { try? FileManager.default.removeItem(at: symlinkDir) }

        let realPath = ProjectIdentityService.canonicalize(url: realDir)
        let symlinkPath = ProjectIdentityService.canonicalize(url: symlinkDir)
        #expect(realPath == symlinkPath)
    }

    @Test func canonicalizeStripsTrailingDot() throws {
        let dir = try makeTempDir()
        defer { try? FileManager.default.removeItem(at: dir) }

        let withDot = dir.appendingPathComponent(".")
        let path1 = ProjectIdentityService.canonicalize(url: dir)
        let path2 = ProjectIdentityService.canonicalize(url: withDot)
        #expect(path1 == path2)
    }

    // MARK: - Validation

    @Test func validProjectAccepted() throws {
        let dir = try makeTempDir()
        defer { try? FileManager.default.removeItem(at: dir) }
        try makeValidProject(at: dir)

        try ProjectIdentityService.validateProjectRoot(dir)
    }

    @Test func missingStoryDirRejected() throws {
        let dir = try makeTempDir()
        defer { try? FileManager.default.removeItem(at: dir) }

        #expect(throws: ProjectRootError.self) {
            try ProjectIdentityService.validateProjectRoot(dir)
        }
    }

    @Test func missingConfigRejected() throws {
        let dir = try makeTempDir()
        defer { try? FileManager.default.removeItem(at: dir) }

        let claudestoryDir = dir.appendingPathComponent(".story")
        try FileManager.default.createDirectory(at: claudestoryDir, withIntermediateDirectories: true)

        #expect(throws: ProjectRootError.self) {
            try ProjectIdentityService.validateProjectRoot(dir)
        }
    }

    @Test func malformedConfigRejected() throws {
        let dir = try makeTempDir()
        defer { try? FileManager.default.removeItem(at: dir) }

        let claudestoryDir = dir.appendingPathComponent(".story")
        try FileManager.default.createDirectory(at: claudestoryDir, withIntermediateDirectories: true)
        try Data("not json".utf8).write(to: claudestoryDir.appendingPathComponent("config.json"))

        #expect(throws: ProjectRootError.self) {
            try ProjectIdentityService.validateProjectRoot(dir)
        }
    }

    @Test func invalidConfigVersionRejected() throws {
        let dir = try makeTempDir()
        defer { try? FileManager.default.removeItem(at: dir) }

        let claudestoryDir = dir.appendingPathComponent(".story")
        try FileManager.default.createDirectory(at: claudestoryDir, withIntermediateDirectories: true)
        let json = """
        {"version":0,"project":"test","type":"macapp","language":"swift","features":{"tickets":true,"issues":true,"handovers":true,"roadmap":true,"reviews":true}}
        """.data(using: .utf8)!
        try json.write(to: claudestoryDir.appendingPathComponent("config.json"))

        #expect(throws: ProjectRootError.self) {
            try ProjectIdentityService.validateProjectRoot(dir)
        }
    }

    // MARK: - Classification

    @Test func classifyReadyProject() throws {
        let dir = try makeTempDir()
        defer { try? FileManager.default.removeItem(at: dir) }
        try makeValidProject(at: dir)

        let status = ProjectIdentityService.classifyProject(at: dir)
        guard case .ready = status else {
            Issue.record("Expected .ready, got \(status)")
            return
        }
    }

    @Test func classifyUninitializedProject() throws {
        let dir = try makeTempDir()
        defer { try? FileManager.default.removeItem(at: dir) }

        let status = ProjectIdentityService.classifyProject(at: dir)
        guard case .uninitialized = status else {
            Issue.record("Expected .uninitialized, got \(status)")
            return
        }
    }

    @Test func classifyBrokenProjectMissingConfig() throws {
        let dir = try makeTempDir()
        defer { try? FileManager.default.removeItem(at: dir) }
        let storyDir = dir.appendingPathComponent(".story")
        try FileManager.default.createDirectory(at: storyDir, withIntermediateDirectories: true)

        let status = ProjectIdentityService.classifyProject(at: dir)
        guard case .broken = status else {
            Issue.record("Expected .broken, got \(status)")
            return
        }
    }

    @Test func classifyBrokenWhenStoryIsFile() throws {
        let dir = try makeTempDir()
        defer { try? FileManager.default.removeItem(at: dir) }
        // Create .story as a regular file, not a directory
        FileManager.default.createFile(
            atPath: dir.appendingPathComponent(".story").path,
            contents: nil
        )

        let status = ProjectIdentityService.classifyProject(at: dir)
        guard case .broken(let msg) = status else {
            Issue.record("Expected .broken, got \(status)")
            return
        }
        #expect(msg.contains("not a directory"))
    }

    @Test func classifyBrokenProjectMalformedConfig() throws {
        let dir = try makeTempDir()
        defer { try? FileManager.default.removeItem(at: dir) }
        let storyDir = dir.appendingPathComponent(".story")
        try FileManager.default.createDirectory(at: storyDir, withIntermediateDirectories: true)
        try Data("not json".utf8).write(to: storyDir.appendingPathComponent("config.json"))

        let status = ProjectIdentityService.classifyProject(at: dir)
        guard case .broken = status else {
            Issue.record("Expected .broken, got \(status)")
            return
        }
    }
}
