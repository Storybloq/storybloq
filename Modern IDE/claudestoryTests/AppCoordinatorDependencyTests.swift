import Testing
import Foundation
@testable import Modern_IDE

struct AppCoordinatorDependencyTests {

    // MARK: - performInitialScan

    @Test func performInitialScanRunsOnce() async {
        let scanner = MockDependencyScanning()
        scanner.stubbedStatus = DependencyStatus(
            results: [ToolScanResult(tool: .node, resolvedPath: "/usr/local/bin/node", version: "v20")],
            limitedModeAcknowledged: false,
            lastAcknowledgedMissingHash: nil
        )
        let coordinator = AppCoordinator(scanner: scanner)

        #expect(coordinator.dependencyScanState == .idle)

        await coordinator.performInitialScan()
        #expect(coordinator.dependencyScanState == .ready)

        // Second call is a no-op
        scanner.stubbedStatus = .empty
        await coordinator.performInitialScan()
        // State should still reflect first scan's results, not empty
        #expect(coordinator.dependencyStatus.results.first?.resolvedPath == "/usr/local/bin/node")
    }

    @Test func performInitialScanSetsReady() async {
        let scanner = MockDependencyScanning()
        scanner.stubbedStatus = .empty
        let coordinator = AppCoordinator(scanner: scanner)

        await coordinator.performInitialScan()
        #expect(coordinator.dependencyScanState == .ready)
    }

    // MARK: - recheckDependencies

    @Test func recheckUpdatesStatus() async {
        let scanner = MockDependencyScanning()
        scanner.stubbedStatus = .empty
        let coordinator = AppCoordinator(scanner: scanner)

        await coordinator.performInitialScan()
        #expect(coordinator.dependencyStatus.results.allSatisfy { !$0.isFound })

        // Update scanner to return found tools
        scanner.stubbedStatus = DependencyStatus(
            results: [ToolScanResult(tool: .node, resolvedPath: "/usr/local/bin/node", version: "v20")],
            limitedModeAcknowledged: false,
            lastAcknowledgedMissingHash: nil
        )

        await coordinator.recheckDependencies()
        #expect(coordinator.dependencyStatus.results.first?.isFound == true)
    }

    // MARK: - acknowledgeLimitedMode

    @Test(.serialized) func acknowledgeLimitedModePersists() {
        // Clean UserDefaults before AND after to avoid cross-test pollution
        UserDefaults.standard.removeObject(forKey: AppSettings.Key.limitedModeAcknowledged)
        UserDefaults.standard.removeObject(forKey: AppSettings.Key.lastAcknowledgedMissingHash)
        defer {
            UserDefaults.standard.removeObject(forKey: AppSettings.Key.limitedModeAcknowledged)
            UserDefaults.standard.removeObject(forKey: AppSettings.Key.lastAcknowledgedMissingHash)
        }

        let scanner = MockDependencyScanning()
        let coordinator = AppCoordinator(scanner: scanner)

        #expect(coordinator.dependencyStatus.limitedModeAcknowledged == false)

        coordinator.acknowledgeLimitedMode()

        #expect(coordinator.dependencyStatus.limitedModeAcknowledged == true)
        #expect(AppSettings.limitedModeAcknowledged == true)
    }
}
