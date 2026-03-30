import Testing
import Foundation
@testable import Modern_IDE

struct DependencyStatusTests {

    // MARK: - Helpers

    private func makeStatus(
        nodeFound: Bool = true,
        npmFound: Bool = true,
        cliFound: Bool = true,
        claudeCodeFound: Bool = false,
        acknowledged: Bool = false,
        acknowledgedHash: String? = nil
    ) -> DependencyStatus {
        DependencyStatus(
            results: [
                ToolScanResult(tool: .node, resolvedPath: nodeFound ? "/usr/local/bin/node" : nil, version: nil),
                ToolScanResult(tool: .npm, resolvedPath: npmFound ? "/usr/local/bin/npm" : nil, version: nil),
                ToolScanResult(tool: .claudestoryCLI, resolvedPath: cliFound ? "/usr/local/bin/claudestory" : nil, version: nil),
                ToolScanResult(tool: .claudeCode, resolvedPath: claudeCodeFound ? "/usr/local/bin/claude" : nil, version: nil),
                ToolScanResult(tool: .codex, resolvedPath: nil, version: nil),
                ToolScanResult(tool: .codexBridge, resolvedPath: nil, version: nil),
            ],
            limitedModeAcknowledged: acknowledged,
            lastAcknowledgedMissingHash: acknowledgedHash
        )
    }

    // MARK: - allRequiredMet

    @Test func allRequiredMetWhenAllFound() {
        let status = makeStatus(nodeFound: true, npmFound: true, cliFound: true)
        #expect(status.allRequiredMet == true)
    }

    @Test func allRequiredMetFalseWhenNodeMissing() {
        let status = makeStatus(nodeFound: false)
        #expect(status.allRequiredMet == false)
    }

    @Test func allRequiredMetIgnoresOptionalTools() {
        // All required found, optional missing — still met
        let status = makeStatus(claudeCodeFound: false)
        #expect(status.allRequiredMet == true)
    }

    // MARK: - needsWizard

    @Test func needsWizardFalseWhenAllRequiredFound() {
        let status = makeStatus(nodeFound: true, npmFound: true, cliFound: true)
        #expect(status.needsWizard == false)
    }

    @Test func needsWizardTrueWhenRequiredMissingAndNotAcknowledged() {
        let status = makeStatus(nodeFound: false, acknowledged: false)
        #expect(status.needsWizard == true)
    }

    @Test func needsWizardFalseWhenAcknowledgedAndHashMatches() {
        // Node is missing, but user acknowledged with matching hash
        let hash = makeStatus(nodeFound: false).missingRequiredHash
        let status = makeStatus(nodeFound: false, acknowledged: true, acknowledgedHash: hash)
        #expect(status.needsWizard == false)
    }

    @Test func needsWizardTrueWhenAcknowledgedButHashChanged() {
        // User acknowledged when only node was missing
        let oldHash = makeStatus(nodeFound: false, npmFound: true, cliFound: true).missingRequiredHash
        // Now node AND CLI are missing — hash changed
        let status = makeStatus(nodeFound: false, cliFound: false, acknowledged: true, acknowledgedHash: oldHash)
        #expect(status.needsWizard == true)
    }

    @Test func needsWizardFalseWhenAllRequiredFoundEvenIfAcknowledged() {
        // Previously acknowledged, but now all required are found
        let status = makeStatus(nodeFound: true, npmFound: true, cliFound: true, acknowledged: true, acknowledgedHash: "stale")
        #expect(status.needsWizard == false)
    }

    // MARK: - missingRequiredHash

    @Test func missingRequiredHashIsSortedAndDeterministic() {
        let status = makeStatus(nodeFound: false, npmFound: false, cliFound: false)
        let hash = status.missingRequiredHash
        // Should be sorted by rawValue
        let expected = [ToolDefinition.claudestoryCLI, .node, .npm]
            .map(\.rawValue)
            .sorted()
            .joined(separator: ",")
        #expect(hash == expected)
    }

    @Test func missingRequiredHashEmptyWhenAllFound() {
        let status = makeStatus(nodeFound: true, npmFound: true, cliFound: true)
        #expect(status.missingRequiredHash == "")
    }

    @Test func missingRequiredHashIgnoresOptionalTools() {
        // All required found, optional missing — hash should be empty
        let status = makeStatus(claudeCodeFound: false)
        #expect(status.missingRequiredHash == "")
    }

    // MARK: - result(for:)

    @Test func resultForReturnsCorrectTool() {
        let status = makeStatus(nodeFound: true)
        let result = status.result(for: .node)
        #expect(result.isFound == true)
        #expect(result.tool == .node)
    }

    @Test func resultForReturnsFallbackForMissingTool() {
        // Create a status with only one result to test the fallback
        let status = DependencyStatus(
            results: [ToolScanResult(tool: .node, resolvedPath: "/usr/local/bin/node", version: nil)],
            limitedModeAcknowledged: false,
            lastAcknowledgedMissingHash: nil
        )
        let result = status.result(for: .codex)
        #expect(result.isFound == false)
        #expect(result.tool == .codex)
    }
}
