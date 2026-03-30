import Foundation
import AppKit

// MARK: - Dependency Wizard View Model

/// Step-by-step state machine for the dependency setup wizard.
/// Presents one tool group per screen, auto-advances when all found.
@Observable
final class DependencyWizardViewModel {

    // MARK: - State

    /// Current wizard step (1-based, matches ToolDefinition.stepGroup).
    var currentStepGroup: Int = 1

    /// Current dependency status (updated after installs/rescans).
    var status: DependencyStatus

    /// Output from the most recent install attempt.
    var installOutput: String = ""

    /// Error from the most recent install attempt.
    var installError: String?

    /// Whether an install is in progress.
    var isInstalling: Bool = false

    /// The specific tool currently being installed (for per-row spinner).
    var installingTool: ToolDefinition?

    /// Whether a rescan is in progress.
    var isRescanning: Bool = false

    /// Whether the wizard is complete (user clicked Get Started).
    var isComplete: Bool = false

    /// Callback when wizard finishes.
    var onComplete: (() -> Void)?

    /// Callback when user chooses limited mode.
    var onLimitedMode: (() -> Void)?

    // MARK: - Computed

    /// Tools in the current step group.
    var currentTools: [ToolScanResult] {
        status.results(forStepGroup: currentStepGroup)
    }

    /// Title for the current step.
    var currentStepTitle: String {
        ToolDefinition.stepTitle(for: currentStepGroup)
    }

    /// Help text for the current step.
    var currentStepHelpText: String {
        ToolDefinition.stepHelpText(for: currentStepGroup)
    }

    /// Whether the current step contains required tools.
    var isCurrentStepRequired: Bool {
        ToolDefinition.isStepRequired(currentStepGroup)
    }

    /// Whether all tools in the current step are found.
    var allCurrentFound: Bool {
        currentTools.allSatisfy { $0.isFound }
    }

    /// Whether the user can advance from this step.
    var canContinue: Bool {
        if isCurrentStepRequired {
            return allCurrentFound
        }
        return true // optional steps can always be skipped
    }

    /// Whether this is the last step.
    var isLastStep: Bool {
        currentStepGroup >= ToolDefinition.totalSteps
    }

    /// Whether we're on the summary screen (past the last step).
    var showingSummary: Bool {
        currentStepGroup > ToolDefinition.totalSteps
    }

    // MARK: - Dependencies

    private let coordinator: AppCoordinator

    // MARK: - Init

    init(status: DependencyStatus, coordinator: AppCoordinator) {
        self.status = status
        self.coordinator = coordinator
    }

    // MARK: - Actions

    /// Advance to the next step. If past the last step, show summary.
    func advance() {
        currentStepGroup += 1
        Log.debug("wizard advance → step \(currentStepGroup)", tag: "DepWizard")
    }

    /// Skip the current (optional) step and advance.
    func skip() {
        guard !isCurrentStepRequired else { return }
        Log.info("wizard skip step \(currentStepGroup) (\(currentStepTitle))", tag: "DepWizard")
        advance()
    }

    /// Install a tool via npm subprocess.
    func install(_ tool: ToolDefinition) async {
        guard let command = tool.installCommand else { return }
        guard let npmPath = status.result(for: .npm).resolvedPath else {
            installError = "npm not found. Install Node.js first."
            Log.warning("install \(tool.displayName): npm not found in scan results", tag: "DepWizard")
            return
        }
        Log.info("install \(tool.displayName): \(command)", tag: "DepWizard")

        isInstalling = true
        installingTool = tool
        installOutput = ""
        installError = nil

        let runner = ProcessCLIRunner(
            executablePath: npmPath,
            appendFormatJson: false,
            timeout: 120
        )

        do {
            let tempDir = URL(fileURLWithPath: NSTemporaryDirectory())
            // Parse: "npm install -g @anthropologies/claudestory" → ["install", "-g", "@anthropologies/claudestory"]
            guard command.hasPrefix("npm ") else {
                installError = "Unsupported install command format: \(command)"
                isInstalling = false
                installingTool = nil
                return
            }
            let args = String(command.dropFirst(4))
                .split(separator: " ", omittingEmptySubsequences: true)
                .map(String.init)
            let result = try await runner.run(arguments: args, currentDirectory: tempDir)
            installOutput = result.stdout + result.stderr
            if result.exitCode != 0 {
                installError = "Install failed (exit \(result.exitCode)). Try running the command manually in your terminal."
                Log.error("install \(tool.displayName) failed: exit \(result.exitCode)", tag: "DepWizard")
            } else {
                Log.info("install \(tool.displayName) succeeded", tag: "DepWizard")
            }
        } catch {
            installError = "Install failed: \(error.localizedDescription). Try running the command manually in your terminal."
            Log.error("install \(tool.displayName) threw: \(error.localizedDescription)", tag: "DepWizard")
        }

        // Clear install state before rescan so the spinner stops
        // and "Continue" button state reflects scan results cleanly.
        isInstalling = false
        installingTool = nil

        await rescan()
    }

    /// Open the install URL in the default browser (e.g., nodejs.org).
    func openInstallURL(_ tool: ToolDefinition) {
        guard let url = tool.installURL else { return }
        NSWorkspace.shared.open(url)
    }

    /// Copy the install command to clipboard.
    func copyCommand(_ tool: ToolDefinition) {
        guard let command = tool.installCommand else { return }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(command, forType: .string)
    }

    /// Re-scan dependencies via coordinator (keeps wizard and coordinator in sync).
    func rescan() async {
        isRescanning = true
        await coordinator.recheckDependencies()
        status = coordinator.dependencyStatus
        isRescanning = false
    }

    /// User chose to continue in limited mode despite missing required deps.
    /// Persists acknowledgment directly via coordinator (not dependent on callback wiring).
    func continueInLimitedMode() {
        Log.info("wizard: user chose limited mode", tag: "DepWizard")
        coordinator.acknowledgeLimitedMode()
        onLimitedMode?()
        isComplete = true
    }

    /// Wizard done — all set or user is continuing.
    func complete() {
        Log.info("wizard: complete", tag: "DepWizard")
        onComplete?()
        isComplete = true
    }
}
