import Foundation

// MARK: - Project Setup View Model

/// Owns the init flow state for setting up `.story/` in a new project directory.
/// Calls `claudestory init` via `ProcessCLIRunner` to create the scaffolding.
@Observable
final class ProjectSetupViewModel {

    // MARK: - Form State

    var name: String
    var type: String
    var language: String

    // MARK: - Flow State

    var isInitializing = false
    var error: String?

    // MARK: - Immutable

    let projectURL: URL
    let detection: ProjectDetector.Detection
    private let runner: any CLIRunning

    // MARK: - Init

    init(projectURL: URL, runner: any CLIRunning = ProcessCLIRunner()) {
        self.projectURL = projectURL
        self.runner = runner
        self.detection = ProjectDetector.detect(at: projectURL)
        self.name = projectURL.lastPathComponent
        self.type = detection.type
        self.language = detection.language
    }

    // MARK: - Actions

    /// Runs `claudestory init` to create `.story/` scaffolding.
    /// Sets `isInitializing` during execution and `error` on failure.
    func initialize() async -> Bool {
        isInitializing = true
        error = nil
        defer { isInitializing = false }

        let trimmedName = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedName.isEmpty else {
            error = "Project name cannot be empty."
            return false
        }

        Log.info("init: \(trimmedName) (\(type)/\(language)) at \(projectURL.lastPathComponent)", tag: "ProjectSetup")
        let args = ["init", "--name", trimmedName, "--type", type, "--language", language]

        do {
            let result = try await runner.run(arguments: args, currentDirectory: projectURL)
            if result.exitCode != 0 {
                let message = result.stderr.trimmingCharacters(in: .whitespacesAndNewlines)
                error = message.isEmpty ? "Init failed (exit code \(result.exitCode))." : message
                Log.error("init failed: \(error ?? "unknown")", tag: "ProjectSetup")
                return false
            }
            Log.info("init succeeded for \(trimmedName)", tag: "ProjectSetup")
            return true
        } catch {
            self.error = error.localizedDescription
            Log.error("init threw: \(error.localizedDescription)", tag: "ProjectSetup")
            return false
        }
    }
}
