import Foundation

// MARK: - Terminal Session

/// Pure state machine for terminal process lifecycle. No NSView dependency — fully testable.
///
/// State transitions:
///   .idle → .launching → .running → .exited(code)
///   .running → .terminating → .idle
///   .exited/.failed → .launching (restart)
///
/// Generation tokens prevent stale callbacks from old processes from affecting current state.
/// Implicitly `@MainActor` via SWIFT_DEFAULT_ACTOR_ISOLATION build setting.
/// If this file is ever moved to a separate module, add explicit `@MainActor`.
@Observable
final class TerminalSession {

    // MARK: - Types

    enum ProcessState: Equatable {
        case idle
        case launching
        case running
        case exited(Int32)
        case terminating
        case failed(String)

        var canLaunch: Bool {
            switch self {
            case .idle, .exited, .failed: return true
            default: return false
            }
        }
    }

    struct LaunchConfig: Sendable {
        let executable: String
        let args: [String]
        let environment: [String]?
        let workingDirectory: String
    }

    // MARK: - Observable State

    private(set) var processState: ProcessState = .idle
    var resetRequested: Bool = false
    var pendingCommand: String?

    // MARK: - Internal State

    @ObservationIgnored private(set) var pendingLaunchConfig: LaunchConfig?
    @ObservationIgnored private(set) var generation: Int = 0
    @ObservationIgnored private var shouldAutoPrompt = false
    @ObservationIgnored private var customAutoPrompt: String?

    // MARK: - Auto Context Prompt

    static var defaultPrompt: String { AppSettings.autoPrompt }

    /// Builds the auto-prompt shell script. The prompt is read from the
    /// CLAUDESTORY_AUTO_PROMPT environment variable (set in LaunchConfig).
    private static func autoPromptScript(shell: String) -> String {
        let escaped = shell.replacingOccurrences(of: "'", with: "'\\''")
        return """
        if command -v claude >/dev/null 2>&1; then \
        claude --dangerously-skip-permissions "$CLAUDESTORY_AUTO_PROMPT"; \
        s=$?; [ $s -ne 0 ] && echo "claudestory: claude exited with status $s"; \
        else echo "claudestory: claude CLI not found on PATH"; fi; \
        exec '\(escaped)' -i
        """
    }

    /// Mark the next launch for auto-prompting with the default context prompt.
    func markForAutoPrompt() {
        shouldAutoPrompt = true
    }

    /// Mark the next launch for auto-prompting with a custom prompt.
    func setCustomAutoPrompt(_ prompt: String) {
        customAutoPrompt = prompt
        shouldAutoPrompt = true
    }

    /// Clear any pending auto-prompt state. Called on project close to prevent
    /// stale prompts from being replayed in a later session.
    func clearPendingAutoPrompt() {
        shouldAutoPrompt = false
        customAutoPrompt = nil
    }

    /// Queue text to be sent to the terminal on the next update cycle.
    func sendCommand(_ text: String) {
        guard processState == .running else { return }
        pendingCommand = text
    }

    // MARK: - State Transitions

    func requestLaunch(projectRoot: URL) {
        let autoPrompt = shouldAutoPrompt
        let prompt = customAutoPrompt ?? Self.defaultPrompt
        shouldAutoPrompt = false
        customAutoPrompt = nil
        guard processState.canLaunch else { return }

        generation += 1
        let shell = userShell()

        let executable: String
        let args: [String]
        let env: [String]?
        if autoPrompt {
            // Use /bin/zsh for POSIX-compatible -c execution (guaranteed on macOS).
            // Pass the prompt via environment variable to avoid shell-quoting issues.
            executable = "/bin/zsh"
            args = ["-l", "-i", "-c", Self.autoPromptScript(shell: shell)]
            var envDict = ProcessInfo.processInfo.environment
            envDict["TERM"] = "xterm-256color"
            envDict["CLAUDESTORY_AUTO_PROMPT"] = prompt
            env = envDict.map { "\($0.key)=\($0.value)" }
        } else {
            executable = shell
            args = ["-l"]
            env = buildEnvironment()
        }

        pendingLaunchConfig = LaunchConfig(
            executable: executable,
            args: args,
            environment: env,
            workingDirectory: projectRoot.path
        )
        processState = .launching
    }

    func didLaunch() {
        guard processState == .launching else { return }
        pendingLaunchConfig = nil
        processState = .running
    }

    func didExit(_ code: Int32, forGeneration gen: Int) {
        guard gen == generation else { return }
        pendingCommand = nil
        processState = .exited(code)
    }

    func requestTerminate() {
        guard processState == .running || processState == .launching else { return }
        processState = .terminating
    }

    func didTerminate(forGeneration gen: Int) {
        guard gen == generation else { return }
        pendingCommand = nil
        generation += 1
        processState = .idle
    }

    func markFailed(_ message: String) {
        guard processState != .idle else { return }
        processState = .failed(message)
    }

    func reset() {
        generation += 1
        processState = .idle
        pendingLaunchConfig = nil
        pendingCommand = nil
        resetRequested = false
    }

    // MARK: - Environment

    private func buildEnvironment() -> [String]? {
        var env = ProcessInfo.processInfo.environment
        env["TERM"] = "xterm-256color"
        return env.map { "\($0.key)=\($0.value)" }
    }

    private func userShell() -> String {
        AppSettings.resolvedShell
    }
}
