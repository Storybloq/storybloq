import Testing
import Foundation
@testable import Modern_IDE

/// Mock runner that always throws — simulates CLI not found / process spawn failure.
private final class ThrowingCLIRunner: CLIRunning, @unchecked Sendable {
    struct RunError: Error, LocalizedError {
        var errorDescription: String? { "The file 'claudestory' could not be run." }
    }
    func run(arguments: [String], currentDirectory: URL) async throws -> CLIResult {
        throw RunError()
    }
}

struct ProjectSetupViewModelTests {

    // MARK: - Helpers

    private func makeTempDir() throws -> URL {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("claudestory-setup-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    // MARK: - Initialization

    @Test func prefillsFromDirectoryName() throws {
        let dir = try makeTempDir()
        defer { try? FileManager.default.removeItem(at: dir) }
        let vm = ProjectSetupViewModel(projectURL: dir)
        #expect(vm.name == dir.lastPathComponent)
    }

    @Test func prefillsFromDetector() throws {
        let dir = try makeTempDir()
        defer { try? FileManager.default.removeItem(at: dir) }
        // Add a marker
        FileManager.default.createFile(
            atPath: dir.appendingPathComponent("package.json").path,
            contents: nil
        )
        let vm = ProjectSetupViewModel(projectURL: dir)
        #expect(vm.language == "typescript")
        #expect(vm.type == "webapp")
    }

    @Test func fallsBackToUnknownGeneric() throws {
        let dir = try makeTempDir()
        defer { try? FileManager.default.removeItem(at: dir) }
        let vm = ProjectSetupViewModel(projectURL: dir)
        #expect(vm.language == "unknown")
        #expect(vm.type == "generic")
    }

    // MARK: - Initialize Success

    @Test func initializeSuccessSetsNoError() async throws {
        let dir = try makeTempDir()
        defer { try? FileManager.default.removeItem(at: dir) }
        let mock = MockCLIRunner()
        mock.stubbedResult = CLIResult(exitCode: 0, stdout: "{}", stderr: "")
        let vm = ProjectSetupViewModel(projectURL: dir, runner: mock)
        vm.name = "TestProject"

        let success = await vm.initialize()

        #expect(success == true)
        #expect(vm.error == nil)
        #expect(vm.isInitializing == false)
    }

    @Test func initializePassesCorrectArguments() async throws {
        let dir = try makeTempDir()
        defer { try? FileManager.default.removeItem(at: dir) }
        let mock = MockCLIRunner()
        mock.stubbedResult = CLIResult(exitCode: 0, stdout: "{}", stderr: "")
        let vm = ProjectSetupViewModel(projectURL: dir, runner: mock)
        vm.name = "MyApp"
        vm.type = "webapp"
        vm.language = "typescript"

        _ = await vm.initialize()

        #expect(mock.capturedArguments == ["init", "--name", "MyApp", "--type", "webapp", "--language", "typescript"])
        #expect(mock.capturedDirectory == dir)
    }

    // MARK: - Initialize Failure

    @Test func initializeFailureSetsError() async throws {
        let dir = try makeTempDir()
        defer { try? FileManager.default.removeItem(at: dir) }
        let mock = MockCLIRunner()
        mock.stubbedResult = CLIResult(exitCode: 1, stdout: "", stderr: "Something went wrong")
        let vm = ProjectSetupViewModel(projectURL: dir, runner: mock)
        vm.name = "TestProject"

        let success = await vm.initialize()

        #expect(success == false)
        #expect(vm.error == "Something went wrong")
        #expect(vm.isInitializing == false)
    }

    @Test func initializeEmptyNameRejectsImmediately() async throws {
        let dir = try makeTempDir()
        defer { try? FileManager.default.removeItem(at: dir) }
        let mock = MockCLIRunner()
        let vm = ProjectSetupViewModel(projectURL: dir, runner: mock)
        vm.name = "   "

        let success = await vm.initialize()

        #expect(success == false)
        #expect(vm.error == "Project name cannot be empty.")
        // CLI should not have been called
        #expect(mock.capturedArguments.isEmpty)
    }

    @Test func initializeHandlesThrownError() async throws {
        let dir = try makeTempDir()
        defer { try? FileManager.default.removeItem(at: dir) }
        let mock = ThrowingCLIRunner()
        let vm = ProjectSetupViewModel(projectURL: dir, runner: mock)
        vm.name = "TestProject"

        let success = await vm.initialize()

        #expect(success == false)
        #expect(vm.error != nil)
        #expect(vm.isInitializing == false)
    }

    @Test func initializeTrimsWhitespace() async throws {
        let dir = try makeTempDir()
        defer { try? FileManager.default.removeItem(at: dir) }
        let mock = MockCLIRunner()
        mock.stubbedResult = CLIResult(exitCode: 0, stdout: "{}", stderr: "")
        let vm = ProjectSetupViewModel(projectURL: dir, runner: mock)
        vm.name = "  MyApp  "

        _ = await vm.initialize()

        #expect(mock.capturedArguments.contains("MyApp"))
    }
}
