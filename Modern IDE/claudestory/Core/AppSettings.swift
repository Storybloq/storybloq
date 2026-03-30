import Foundation

// MARK: - App Settings

/// Centralized app preferences backed by UserDefaults.
/// Readable from anywhere (views, view models, plain classes).
/// SettingsView uses @AppStorage with the same keys for two-way bindings.
enum AppSettings {

    // MARK: - Keys

    enum Key {
        static let restoreOnLaunch = "restoreWorkspaceOnLaunch"
        static let autoPromptEnabled = "autoPromptEnabled"
        static let defaultShell = "defaultShell"
        static let autoPrompt = "prompt.autoPrompt"
        static let resumeWork = "prompt.resumeWork"
        static let autoWork = "prompt.autoWork"
        static let experimentalFeatures = "experimentalFeaturesEnabled"
        static let limitedModeAcknowledged = "dependencyLimitedModeAcknowledged"
        static let lastAcknowledgedMissingHash = "dependencyLastAcknowledgedMissingHash"
    }

    // MARK: - Defaults

    enum Defaults {
        static let autoPrompt = "/story"
        static let resumeWork = "/story"
        static let autoWork = "Run /story to load project context, then pick the highest-priority unblocked ticket and work on it autonomously. Update ticket status to inprogress when starting. Follow WORK_STRATEGIES.md process."
    }

    // MARK: - General

    static var restoreOnLaunch: Bool {
        UserDefaults.standard.object(forKey: Key.restoreOnLaunch) as? Bool ?? true
    }

    // MARK: - Feature Flags

    static var experimentalFeaturesEnabled: Bool {
        UserDefaults.standard.object(forKey: Key.experimentalFeatures) as? Bool ?? false
    }

    // MARK: - Dependencies

    static var limitedModeAcknowledged: Bool {
        get { UserDefaults.standard.bool(forKey: Key.limitedModeAcknowledged) }
        set { UserDefaults.standard.set(newValue, forKey: Key.limitedModeAcknowledged) }
    }

    static var lastAcknowledgedMissingHash: String? {
        get { UserDefaults.standard.string(forKey: Key.lastAcknowledgedMissingHash) }
        set { UserDefaults.standard.set(newValue, forKey: Key.lastAcknowledgedMissingHash) }
    }

    // MARK: - Terminal

    static var autoPromptEnabled: Bool {
        UserDefaults.standard.object(forKey: Key.autoPromptEnabled) as? Bool ?? true
    }

    static var resolvedShell: String {
        let custom = UserDefaults.standard.string(forKey: Key.defaultShell) ?? ""
        return custom.isEmpty
            ? (ProcessInfo.processInfo.environment["SHELL"] ?? "/bin/zsh")
            : custom
    }

    // MARK: - Prompts

    static var autoPrompt: String {
        UserDefaults.standard.string(forKey: Key.autoPrompt) ?? Defaults.autoPrompt
    }

    static var resumeWork: String {
        UserDefaults.standard.string(forKey: Key.resumeWork) ?? Defaults.resumeWork
    }

    static var autoWork: String {
        UserDefaults.standard.string(forKey: Key.autoWork) ?? Defaults.autoWork
    }
}
