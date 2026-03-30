import Testing
import Foundation
@testable import Modern_IDE

struct ProjectDetectorTests {

    // MARK: - Helpers

    private func makeTempDir() throws -> URL {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("claudestory-detector-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    private func touch(_ name: String, at dir: URL) throws {
        let path = dir.appendingPathComponent(name)
        FileManager.default.createFile(atPath: path.path, contents: nil)
    }

    private func mkdir(_ name: String, at dir: URL) throws {
        let path = dir.appendingPathComponent(name)
        try FileManager.default.createDirectory(at: path, withIntermediateDirectories: true)
    }

    // MARK: - Swift

    @Test func detectSwiftPackage() throws {
        let dir = try makeTempDir()
        defer { try? FileManager.default.removeItem(at: dir) }
        try touch("Package.swift", at: dir)
        let result = ProjectDetector.detect(at: dir)
        #expect(result.language == "swift")
        #expect(result.type == "macapp")
    }

    @Test func detectXcodeProject() throws {
        let dir = try makeTempDir()
        defer { try? FileManager.default.removeItem(at: dir) }
        try mkdir("MyApp.xcodeproj", at: dir)
        let result = ProjectDetector.detect(at: dir)
        #expect(result.language == "swift")
        #expect(result.type == "macapp")
    }

    // MARK: - Node / TypeScript

    @Test func detectPackageJson() throws {
        let dir = try makeTempDir()
        defer { try? FileManager.default.removeItem(at: dir) }
        try touch("package.json", at: dir)
        let result = ProjectDetector.detect(at: dir)
        #expect(result.language == "typescript")
        #expect(result.type == "webapp")
    }

    // MARK: - Rust

    @Test func detectCargoToml() throws {
        let dir = try makeTempDir()
        defer { try? FileManager.default.removeItem(at: dir) }
        try touch("Cargo.toml", at: dir)
        let result = ProjectDetector.detect(at: dir)
        #expect(result.language == "rust")
        #expect(result.type == "cli")
    }

    // MARK: - Go

    @Test func detectGoMod() throws {
        let dir = try makeTempDir()
        defer { try? FileManager.default.removeItem(at: dir) }
        try touch("go.mod", at: dir)
        let result = ProjectDetector.detect(at: dir)
        #expect(result.language == "go")
        #expect(result.type == "cli")
    }

    // MARK: - Python

    @Test func detectPyprojectToml() throws {
        let dir = try makeTempDir()
        defer { try? FileManager.default.removeItem(at: dir) }
        try touch("pyproject.toml", at: dir)
        let result = ProjectDetector.detect(at: dir)
        #expect(result.language == "python")
        #expect(result.type == "cli")
    }

    @Test func detectRequirementsTxt() throws {
        let dir = try makeTempDir()
        defer { try? FileManager.default.removeItem(at: dir) }
        try touch("requirements.txt", at: dir)
        let result = ProjectDetector.detect(at: dir)
        #expect(result.language == "python")
        #expect(result.type == "cli")
    }

    // MARK: - Java / Kotlin

    @Test func detectGradleKts() throws {
        let dir = try makeTempDir()
        defer { try? FileManager.default.removeItem(at: dir) }
        try touch("build.gradle.kts", at: dir)
        let result = ProjectDetector.detect(at: dir)
        #expect(result.language == "kotlin")
        #expect(result.type == "api")
    }

    // MARK: - C# / .NET

    @Test func detectCsproj() throws {
        let dir = try makeTempDir()
        defer { try? FileManager.default.removeItem(at: dir) }
        try touch("MyApp.csproj", at: dir)
        let result = ProjectDetector.detect(at: dir)
        #expect(result.language == "csharp")
        #expect(result.type == "api")
    }

    // MARK: - Ruby

    @Test func detectGemfile() throws {
        let dir = try makeTempDir()
        defer { try? FileManager.default.removeItem(at: dir) }
        try touch("Gemfile", at: dir)
        let result = ProjectDetector.detect(at: dir)
        #expect(result.language == "ruby")
        #expect(result.type == "webapp")
    }

    // MARK: - Flutter / Dart

    @Test func detectPubspec() throws {
        let dir = try makeTempDir()
        defer { try? FileManager.default.removeItem(at: dir) }
        try touch("pubspec.yaml", at: dir)
        let result = ProjectDetector.detect(at: dir)
        #expect(result.language == "dart")
        #expect(result.type == "mobile")
    }

    // MARK: - C / C++

    @Test func detectCMakeLists() throws {
        let dir = try makeTempDir()
        defer { try? FileManager.default.removeItem(at: dir) }
        try touch("CMakeLists.txt", at: dir)
        let result = ProjectDetector.detect(at: dir)
        #expect(result.language == "cpp")
        #expect(result.type == "cli")
    }

    // MARK: - Fallback

    @Test func detectFallbackOnEmptyDir() throws {
        let dir = try makeTempDir()
        defer { try? FileManager.default.removeItem(at: dir) }
        let result = ProjectDetector.detect(at: dir)
        #expect(result.language == "unknown")
        #expect(result.type == "generic")
    }

    // MARK: - Priority (first match wins)

    @Test func detectSwiftOverNodeWhenBothPresent() throws {
        let dir = try makeTempDir()
        defer { try? FileManager.default.removeItem(at: dir) }
        try touch("Package.swift", at: dir)
        try touch("package.json", at: dir)
        let result = ProjectDetector.detect(at: dir)
        #expect(result.language == "swift")
    }
}
