import Foundation
import AppKit

// MARK: - Project Identity Service

// MARK: - Project Root Error

/// Error types for project validation.
enum ProjectRootError: LocalizedError {
    case missingDir
    case missingConfig
    case unreadableFile(URL)
    case invalidConfig(Error)
    case accessDenied
    case bookmarkStale
    case userCancelled

    var errorDescription: String? {
        switch self {
        case .missingDir:
            return "Selected directory does not contain a .story/ folder."
        case .missingConfig:
            return "No config.json found in .story/ directory."
        case .unreadableFile(let url):
            return "Cannot read file: \(url.lastPathComponent)"
        case .invalidConfig(let error):
            return "Invalid config.json: \(error.localizedDescription)"
        case .accessDenied:
            return "Cannot access the selected directory. Please try again."
        case .bookmarkStale:
            return "Previously opened project is no longer accessible."
        case .userCancelled:
            return "No project selected."
        }
    }
}

// MARK: - Project Status

/// Classification of a directory's readiness as a claudestory project.
enum ProjectStatus {
    case uninitialized
    case ready
    case broken(String)
}

// MARK: - Project Identity Service

/// Centralized project identity: canonicalization + validation.
/// Single source of truth used by AppCoordinator, bookmark store, and restoration.
enum ProjectIdentityService {

    /// Classifies a directory as uninitialized (no .story/), ready (valid project),
    /// or broken (has .story/ but config is invalid/missing).
    static func classifyProject(at url: URL) -> ProjectStatus {
        let storyDir = url.appendingPathComponent(".story")
        var isDir: ObjCBool = false
        let exists = FileManager.default.fileExists(atPath: storyDir.path, isDirectory: &isDir)
        if exists && !isDir.boolValue {
            Log.warning("classify: .story exists but is not a directory at \(url.lastPathComponent)", tag: "Identity")
            return .broken(".story exists but is not a directory.")
        }
        guard exists else {
            Log.debug("classify: uninitialized — no .story/ at \(url.lastPathComponent)", tag: "Identity")
            return .uninitialized
        }
        do {
            try validateProjectRoot(url)
            Log.debug("classify: ready at \(url.lastPathComponent)", tag: "Identity")
            return .ready
        } catch {
            Log.warning("classify: broken at \(url.lastPathComponent) — \(error.localizedDescription)", tag: "Identity")
            return .broken(error.localizedDescription)
        }
    }

    /// Canonical path string for a project URL. Resolves symlinks, normalizes
    /// `.` / `..`, strips trailing slashes. Two different URLs pointing to the
    /// same directory produce the same canonical string.
    static func canonicalize(url: URL) -> String {
        url.standardizedFileURL.resolvingSymlinksInPath().path
    }

    /// Validates that `url` is a claudestory project root:
    /// 1. `.story/` directory exists
    /// 2. `config.json` exists and is readable
    /// 3. `config.json` decodes to a valid `Config`
    static func validateProjectRoot(_ url: URL) throws {
        let claudestoryDir = url.appendingPathComponent(".story")
        var isDir: ObjCBool = false
        guard FileManager.default.fileExists(atPath: claudestoryDir.path, isDirectory: &isDir),
              isDir.boolValue else {
            throw ProjectRootError.missingDir
        }

        let configURL = claudestoryDir.appendingPathComponent("config.json")
        guard FileManager.default.fileExists(atPath: configURL.path) else {
            throw ProjectRootError.missingConfig
        }

        let data: Data
        do {
            data = try Data(contentsOf: configURL)
        } catch {
            throw ProjectRootError.unreadableFile(configURL)
        }

        let config: Config
        do {
            config = try JSONDecoder().decode(Config.self, from: data)
        } catch {
            throw ProjectRootError.invalidConfig(error)
        }

        do {
            try config.validate()
        } catch {
            throw ProjectRootError.invalidConfig(error)
        }
    }

    /// Shows an NSOpenPanel for choosing a project directory.
    /// Returns the selected URL, or throws `ProjectRootError.userCancelled`.
    static func showDirectoryPicker() async throws -> URL {
        try await withCheckedThrowingContinuation { continuation in
            let panel = NSOpenPanel()
            panel.canChooseFiles = false
            panel.canChooseDirectories = true
            panel.allowsMultipleSelection = false
            panel.message = "Select a project directory"
            panel.prompt = "Open Project"

            panel.begin { response in
                if response == .OK, let url = panel.url {
                    continuation.resume(returning: url)
                } else {
                    continuation.resume(throwing: ProjectRootError.userCancelled)
                }
            }
        }
    }
}
