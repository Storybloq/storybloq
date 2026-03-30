import Foundation

// MARK: - Config

struct Config: Codable, Equatable, Sendable {
    let version: Int
    let schemaVersion: Int?
    let project: String
    let type: String
    let language: String
    let features: Features
    let recipeOverrides: RecipeOverrides?

    init(version: Int, schemaVersion: Int? = nil, project: String, type: String, language: String, features: Features, recipeOverrides: RecipeOverrides? = nil) {
        self.version = version
        self.schemaVersion = schemaVersion
        self.project = project
        self.type = type
        self.language = language
        self.features = features
        self.recipeOverrides = recipeOverrides
    }

    struct Features: Codable, Equatable, Sendable {
        let tickets: Bool
        let issues: Bool
        let handovers: Bool
        let roadmap: Bool
        let reviews: Bool
    }

    /// Recipe override configuration for the autonomous guide.
    /// nil fields = use recipe defaults. maxTicketsPerSession 0 = no limit. handoverInterval 0 = disabled.
    struct RecipeOverrides: Codable, Equatable, Sendable {
        let maxTicketsPerSession: Int?
        let compactThreshold: String?
        let reviewBackends: [String]?
        let handoverInterval: Int?
        let stages: StageOverrides?

        var isEmpty: Bool {
            maxTicketsPerSession == nil && compactThreshold == nil && reviewBackends == nil && handoverInterval == nil && stages == nil
        }
    }

    /// Per-stage configuration overrides.
    struct StageOverrides: Codable, Equatable, Sendable {
        var WRITE_TESTS: StageConfig?
        var TEST: StageConfig?
        var VERIFY: VerifyStageConfig?

        var isEmpty: Bool {
            WRITE_TESTS == nil && TEST == nil && VERIFY == nil
        }
    }

    /// Configuration for WRITE_TESTS and TEST stages.
    struct StageConfig: Codable, Equatable, Sendable {
        let enabled: Bool?
        let command: String?
        let onExhaustion: String?
    }

    /// Configuration for VERIFY stage.
    struct VerifyStageConfig: Codable, Equatable, Sendable {
        let enabled: Bool?
        let startCommand: String?
        let readinessUrl: String?
        let endpoints: [String]?
    }

    func validate() throws {
        guard version >= 1 else { throw ConfigError.unsupportedVersion(version) }
        guard !project.isEmpty else { throw ConfigError.emptyProject }
        guard !type.isEmpty else { throw ConfigError.emptyField("type") }
        guard !language.isEmpty else { throw ConfigError.emptyField("language") }
    }
}

// MARK: - Config Error

enum ConfigError: LocalizedError {
    case unsupportedVersion(Int)
    case emptyProject
    case emptyField(String)

    var errorDescription: String? {
        switch self {
        case .unsupportedVersion(let v): return "Unsupported config version: \(v)"
        case .emptyProject: return "Config project name is empty."
        case .emptyField(let field): return "Config field '\(field)' is empty."
        }
    }
}
