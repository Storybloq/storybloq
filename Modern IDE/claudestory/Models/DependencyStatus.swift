import Foundation

// MARK: - Tool Scan Result

/// Result of scanning for a single tool's availability.
struct ToolScanResult: Sendable, Equatable {
    let tool: ToolDefinition
    let resolvedPath: String?
    let version: String?

    var isFound: Bool { resolvedPath != nil }
}

// MARK: - Dependency Status

/// Aggregate result of scanning all tools. Drives wizard visibility and limited mode.
struct DependencyStatus: Sendable, Equatable {
    let results: [ToolScanResult]
    var limitedModeAcknowledged: Bool
    var lastAcknowledgedMissingHash: String?

    /// Whether all required tools are installed.
    var allRequiredMet: Bool {
        results.filter { $0.tool.isRequired && !$0.isFound }.isEmpty
    }

    /// Whether the wizard should be shown.
    /// True when required deps are missing AND user hasn't acknowledged limited mode
    /// (or the set of missing deps changed since acknowledgment).
    var needsWizard: Bool {
        let missingRequired = results.filter { $0.tool.isRequired && !$0.isFound }
        guard !missingRequired.isEmpty else { return false }
        if !limitedModeAcknowledged { return true }
        let currentHash = missingRequired.map(\.tool.rawValue).sorted().joined(separator: ",")
        return currentHash != lastAcknowledgedMissingHash
    }

    /// Look up a specific tool's result.
    func result(for tool: ToolDefinition) -> ToolScanResult {
        results.first { $0.tool == tool } ?? ToolScanResult(tool: tool, resolvedPath: nil, version: nil)
    }

    /// Results for a specific wizard step group.
    func results(forStepGroup group: Int) -> [ToolScanResult] {
        results.filter { $0.tool.stepGroup == group }
    }

    /// Hash of currently missing required tools (for re-show detection).
    var missingRequiredHash: String {
        results
            .filter { $0.tool.isRequired && !$0.isFound }
            .map(\.tool.rawValue)
            .sorted()
            .joined(separator: ",")
    }

    /// Empty status for initial state.
    static let empty = DependencyStatus(
        results: ToolDefinition.allCases.map { ToolScanResult(tool: $0, resolvedPath: nil, version: nil) },
        limitedModeAcknowledged: false,
        lastAcknowledgedMissingHash: nil
    )
}

// MARK: - Scan State

/// Lifecycle state of the dependency scan.
enum DependencyScanState: Sendable, Equatable {
    case idle
    case scanning
    case ready
}
