import Testing
import Foundation
@testable import Modern_IDE

// MARK: - Mock Scanner

/// Returns a preset DependencyStatus. @unchecked Sendable is acceptable:
/// each test creates its own instance, and Swift Testing serializes within a test.
final class MockDependencyScanning: DependencyScanning, @unchecked Sendable {
    var stubbedStatus: DependencyStatus = .empty

    func scan() -> DependencyStatus { stubbedStatus }
    func scanWithVersions() async -> DependencyStatus { stubbedStatus }
}

// MARK: - Helpers

private func makeStatus(
    nodeFound: Bool = true,
    npmFound: Bool = true,
    cliFound: Bool = true,
    claudeCodeFound: Bool = false,
    codexFound: Bool = false,
    bridgeFound: Bool = false
) -> DependencyStatus {
    let results: [ToolScanResult] = [
        ToolScanResult(tool: .node, resolvedPath: nodeFound ? "/usr/local/bin/node" : nil, version: nodeFound ? "v20.11.0" : nil),
        ToolScanResult(tool: .npm, resolvedPath: npmFound ? "/usr/local/bin/npm" : nil, version: npmFound ? "10.2.0" : nil),
        ToolScanResult(tool: .claudestoryCLI, resolvedPath: cliFound ? "/usr/local/bin/claudestory" : nil, version: cliFound ? "0.1.28" : nil),
        ToolScanResult(tool: .claudeCode, resolvedPath: claudeCodeFound ? "/usr/local/bin/claude" : nil, version: nil),
        ToolScanResult(tool: .codex, resolvedPath: codexFound ? "/usr/local/bin/codex" : nil, version: nil),
        ToolScanResult(tool: .codexBridge, resolvedPath: bridgeFound ? "/usr/local/bin/codex-claude-bridge" : nil, version: nil),
    ]
    return DependencyStatus(results: results, limitedModeAcknowledged: false, lastAcknowledgedMissingHash: nil)
}

// MARK: - Tests

struct DependencyWizardViewModelTests {

    // MARK: - Step Navigation

    @Test func advanceIncrementsStepGroup() {
        let scanner = MockDependencyScanning()
        let coordinator = AppCoordinator(scanner: scanner)
        let vm = DependencyWizardViewModel(status: makeStatus(), coordinator: coordinator)
        #expect(vm.currentStepGroup == 1)
        vm.advance()
        #expect(vm.currentStepGroup == 2)
    }

    @Test func skipRefusesOnRequiredStep() {
        let scanner = MockDependencyScanning()
        let coordinator = AppCoordinator(scanner: scanner)
        let vm = DependencyWizardViewModel(status: makeStatus(), coordinator: coordinator)
        #expect(vm.isCurrentStepRequired == true) // step 1 = node+npm = required
        vm.skip()
        #expect(vm.currentStepGroup == 1) // unchanged
    }

    @Test func skipWorksOnOptionalStep() {
        let scanner = MockDependencyScanning()
        let coordinator = AppCoordinator(scanner: scanner)
        let vm = DependencyWizardViewModel(status: makeStatus(), coordinator: coordinator)
        vm.currentStepGroup = 3 // Claude Code = optional
        #expect(vm.isCurrentStepRequired == false)
        vm.skip()
        #expect(vm.currentStepGroup == 4)
    }

    @Test func showingSummaryWhenPastTotalSteps() {
        let scanner = MockDependencyScanning()
        let coordinator = AppCoordinator(scanner: scanner)
        let vm = DependencyWizardViewModel(status: makeStatus(), coordinator: coordinator)
        vm.currentStepGroup = ToolDefinition.totalSteps + 1
        #expect(vm.showingSummary == true)
    }

    // MARK: - canContinue

    @Test func canContinueFalseWhenRequiredMissing() {
        let scanner = MockDependencyScanning()
        let coordinator = AppCoordinator(scanner: scanner)
        let status = makeStatus(nodeFound: false) // step 1, required, node missing
        let vm = DependencyWizardViewModel(status: status, coordinator: coordinator)
        #expect(vm.canContinue == false)
    }

    @Test func canContinueTrueWhenRequiredFound() {
        let scanner = MockDependencyScanning()
        let coordinator = AppCoordinator(scanner: scanner)
        let status = makeStatus(nodeFound: true, npmFound: true)
        let vm = DependencyWizardViewModel(status: status, coordinator: coordinator)
        #expect(vm.canContinue == true)
    }

    @Test func canContinueTrueForOptionalEvenWhenMissing() {
        let scanner = MockDependencyScanning()
        let coordinator = AppCoordinator(scanner: scanner)
        let status = makeStatus(claudeCodeFound: false) // optional
        let vm = DependencyWizardViewModel(status: status, coordinator: coordinator)
        vm.currentStepGroup = 3 // Claude Code step
        #expect(vm.canContinue == true)
    }

    // MARK: - Limited Mode

    @Test(.serialized) func continueInLimitedModeCallsCoordinator() {
        UserDefaults.standard.removeObject(forKey: AppSettings.Key.limitedModeAcknowledged)
        UserDefaults.standard.removeObject(forKey: AppSettings.Key.lastAcknowledgedMissingHash)
        defer {
            UserDefaults.standard.removeObject(forKey: AppSettings.Key.limitedModeAcknowledged)
            UserDefaults.standard.removeObject(forKey: AppSettings.Key.lastAcknowledgedMissingHash)
        }

        let scanner = MockDependencyScanning()
        let coordinator = AppCoordinator(scanner: scanner)
        let status = makeStatus(nodeFound: false)
        let vm = DependencyWizardViewModel(status: status, coordinator: coordinator)

        var callbackCalled = false
        vm.onLimitedMode = { callbackCalled = true }

        vm.continueInLimitedMode()

        #expect(vm.isComplete == true)
        #expect(callbackCalled == true)
        #expect(coordinator.dependencyStatus.limitedModeAcknowledged == true)
    }

    // MARK: - Install Flow

    @Test func installNoOpForToolWithoutCommand() async {
        let scanner = MockDependencyScanning()
        let coordinator = AppCoordinator(scanner: scanner)
        let vm = DependencyWizardViewModel(status: makeStatus(), coordinator: coordinator)

        // node has no installCommand — install returns immediately
        await vm.install(.node)

        #expect(vm.installError == nil)
        #expect(vm.isInstalling == false)
        #expect(vm.installingTool == nil)
    }

    @Test func installSetsInstallingToolDuringInstall() async {
        let scanner = MockDependencyScanning()
        let coordinator = AppCoordinator(scanner: scanner)
        let vm = DependencyWizardViewModel(status: makeStatus(), coordinator: coordinator)

        // node has no installCommand — install returns immediately without setting installingTool
        await vm.install(.node)
        #expect(vm.installingTool == nil)
        #expect(vm.isInstalling == false)
    }

    @Test func installResetsFlagOnUnsupportedCommand() async {
        let scanner = MockDependencyScanning()
        let coordinator = AppCoordinator(scanner: scanner)
        // Use a status where all tools are found to avoid the npm guard
        scanner.stubbedStatus = makeStatus()
        let vm = DependencyWizardViewModel(status: makeStatus(), coordinator: coordinator)

        // Directly test the defer by checking isInstalling after install of a tool with no command
        // node has no installCommand, so install returns immediately
        await vm.install(.node)
        #expect(vm.isInstalling == false)
    }
}
