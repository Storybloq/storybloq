import Foundation

// MARK: - Tool Definition

/// Static registry of external tools the app depends on.
/// Each tool has a binary name, display info, and install instructions.
enum ToolDefinition: String, CaseIterable, Sendable {
    case node
    case npm
    case claudestoryCLI
    case claudeCode
    case codex
    case codexBridge

    /// The binary name used for PATH lookup (e.g., `which <binaryName>`).
    var binaryName: String {
        switch self {
        case .node: "node"
        case .npm: "npm"
        case .claudestoryCLI: "claudestory"
        case .claudeCode: "claude"
        case .codex: "codex"
        case .codexBridge: "codex-claude-bridge"
        }
    }

    /// Human-readable display name.
    var displayName: String {
        switch self {
        case .node: "Node.js"
        case .npm: "npm"
        case .claudestoryCLI: "Claude Story CLI"
        case .claudeCode: "Claude Code"
        case .codex: "Codex CLI"
        case .codexBridge: "Codex Bridge"
        }
    }

    /// Whether this tool is required for core functionality.
    var isRequired: Bool {
        switch self {
        case .node, .npm, .claudestoryCLI: true
        case .claudeCode, .codex, .codexBridge: false
        }
    }

    /// npm install command, or nil if not installable via npm (e.g., Node.js).
    var installCommand: String? {
        switch self {
        case .node, .npm: nil
        case .claudestoryCLI: "npm install -g @anthropologies/claudestory"
        case .claudeCode: "npm install -g @anthropic-ai/claude-code"
        case .codex: "npm install -g codex-cli"
        case .codexBridge: "npm install -g codex-claude-bridge"
        }
    }

    /// URL to open for manual install (e.g., nodejs.org for Node.js).
    var installURL: URL? {
        switch self {
        case .node, .npm: URL(string: "https://nodejs.org")
        default: nil
        }
    }

    /// One-sentence description of what the tool does.
    var helpText: String {
        switch self {
        case .node: "JavaScript runtime required to run CLI tools."
        case .npm: "Package manager bundled with Node.js."
        case .claudestoryCLI: "Manages your project's tickets, issues, roadmap, and session history."
        case .claudeCode: "AI coding assistant with embedded terminal support."
        case .codex: "Enables independent code review from a second AI."
        case .codexBridge: "Connects Claude Code to Codex for automated review."
        }
    }

    /// Wizard step group. Tools in the same group appear on the same step screen.
    /// 1 = Node+npm, 2 = claudestory CLI, 3 = Claude Code, 4 = Codex+Bridge
    var stepGroup: Int {
        switch self {
        case .node, .npm: 1
        case .claudestoryCLI: 2
        case .claudeCode: 3
        case .codex, .codexBridge: 4
        }
    }

    /// Step title for the wizard.
    static func stepTitle(for group: Int) -> String {
        switch group {
        case 1: "Node.js & npm"
        case 2: "Claude Story CLI"
        case 3: "Claude Code"
        case 4: "Codex & Bridge"
        default: "Setup"
        }
    }

    /// Step help text for the wizard.
    static func stepHelpText(for group: Int) -> String {
        switch group {
        case 1: "Node.js is the runtime that powers Claude Story's CLI tools. npm is the package manager used to install them."
        case 2: "The engine that manages your project's tickets, issues, roadmap, and session history."
        case 3: "AI coding assistant that enables the embedded terminal and autonomous coding features."
        case 4: "Optional tools that enable multi-backend code review — a second AI independently reviews your code."
        default: ""
        }
    }

    /// Whether a step group contains required tools.
    static func isStepRequired(_ group: Int) -> Bool {
        allCases.filter { $0.stepGroup == group }.contains { $0.isRequired }
    }

    /// Total number of wizard steps.
    static let totalSteps = 4
}
