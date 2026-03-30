import Foundation
import os

// MARK: - Dependency Scanning Protocol

/// Protocol for dependency detection. Injectable for testing.
protocol DependencyScanning: Sendable {
    /// Fast synchronous scan — filesystem checks only (no --version calls).
    func scan() -> DependencyStatus

    /// Full async scan — resolves paths AND runs --version for each found tool.
    func scanWithVersions() async -> DependencyStatus
}

// MARK: - Dependency Scanner

/// Production scanner using ExecutableResolver for PATH resolution.
struct DependencyScanner: DependencyScanning {

    func scan() -> DependencyStatus {
        let results = ToolDefinition.allCases.map { tool -> ToolScanResult in
            let path = ExecutableResolver.resolve(binary: tool.binaryName)
            return ToolScanResult(tool: tool, resolvedPath: path, version: nil)
        }
        return DependencyStatus(
            results: results,
            limitedModeAcknowledged: false,
            lastAcknowledgedMissingHash: nil
        )
    }

    func scanWithVersions() async -> DependencyStatus {
        let results = await withTaskGroup(of: ToolScanResult.self, returning: [ToolScanResult].self) { group in
            for tool in ToolDefinition.allCases {
                group.addTask {
                    let path = await ExecutableResolver.resolveAsync(binary: tool.binaryName)
                    guard let resolvedPath = path else {
                        return ToolScanResult(tool: tool, resolvedPath: nil, version: nil)
                    }
                    let version = await Self.getVersion(executablePath: resolvedPath, tool: tool)
                    return ToolScanResult(tool: tool, resolvedPath: resolvedPath, version: version)
                }
            }
            var collected: [ToolScanResult] = []
            for await result in group {
                collected.append(result)
            }
            return collected
        }
        // Sort to match ToolDefinition.allCases order
        let sorted = ToolDefinition.allCases.map { tool in
            results.first { $0.tool == tool } ?? ToolScanResult(tool: tool, resolvedPath: nil, version: nil)
        }
        return DependencyStatus(
            results: sorted,
            limitedModeAcknowledged: false,
            lastAcknowledgedMissingHash: nil
        )
    }

    // MARK: - Version Detection

    private static func getVersion(executablePath: String, tool: ToolDefinition) async -> String? {
        let runner = ProcessCLIRunner(
            executablePath: executablePath,
            appendFormatJson: false,
            timeout: 10
        )
        do {
            // Use a temp directory as cwd — version checks don't need a project root
            let tempDir = URL(fileURLWithPath: NSTemporaryDirectory())
            let result = try await runner.run(arguments: ["--version"], currentDirectory: tempDir)
            guard result.exitCode == 0 else { return nil }
            // Parse version from output — typically first line, may have prefix like "v20.11.0"
            let output = result.stdout.trimmingCharacters(in: .whitespacesAndNewlines)
            let firstLine = output.components(separatedBy: .newlines).first ?? output
            return firstLine.isEmpty ? nil : firstLine
        } catch {
            Log.warning("version check failed for \(tool.binaryName): \(error)", tag: "DependencyScanner")
            return nil
        }
    }
}
