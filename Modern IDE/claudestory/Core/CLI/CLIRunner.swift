import Foundation
import os

// MARK: - CLIResult

/// Result of a CLI process execution.
struct CLIResult: Sendable {
    let exitCode: Int32
    let stdout: String
    let stderr: String
}

// MARK: - CLIRunning Protocol

/// Thin protocol for running CLI commands. Mockable for tests.
protocol CLIRunning: Sendable {
    func run(arguments: [String], currentDirectory: URL) async throws -> CLIResult
}

// MARK: - ProcessCLIRunner

/// Production CLI runner that spawns `claudestory` as a subprocess.
///
/// Uses the ProcessRunner pattern from DevSweep:
/// - `readabilityHandler` on both pipes for concurrent reading (prevents deadlock > 64KB)
/// - `OSAllocatedUnfairLock` for thread-safe data accumulation
/// - `withCheckedContinuation` + `terminationHandler` set BEFORE `run()` (avoids race)
/// - Timeout support (default 30s)
///
/// Always appends `--format json` to arguments for machine-parseable output
/// unless `appendFormatJson` is false (used for non-claudestory binaries like `node --version`).
/// Sets `currentDirectoryURL` since the CLI has no `--root` flag.
final class ProcessCLIRunner: CLIRunning, Sendable {

    /// Resolved path to the executable. Cached after first lookup.
    private let executablePath: String

    /// Whether to append `--format json` to arguments. True for claudestory CLI, false for other tools.
    private let appendFormatJson: Bool

    /// Default timeout for CLI operations (seconds). 0 = no timeout.
    private let timeout: TimeInterval

    init(executablePath: String? = nil, appendFormatJson: Bool = true, timeout: TimeInterval = 30) {
        self.executablePath = executablePath ?? ExecutableResolver.resolve(binary: "claudestory") ?? "/usr/bin/env"
        self.appendFormatJson = appendFormatJson
        self.timeout = timeout
    }

    nonisolated func run(arguments: [String], currentDirectory: URL) async throws -> CLIResult {
        Log.debug("exec: \(executablePath) \(arguments.joined(separator: " "))", tag: "CLIRunner")
        Log.debug("cwd: \(currentDirectory.path)", tag: "CLIRunner")

        let process = Process()
        process.executableURL = URL(fileURLWithPath: executablePath)
        // Build arguments: optionally append --format json for claudestory CLI calls
        var fullArgs = arguments
        if appendFormatJson {
            // When falling back to /usr/bin/env, prepend "claudestory" to arguments
            if executablePath == "/usr/bin/env" {
                fullArgs = ["claudestory"] + arguments + ["--format", "json"]
            } else {
                fullArgs = arguments + ["--format", "json"]
            }
        }
        process.arguments = fullArgs
        process.currentDirectoryURL = currentDirectory

        // Augment PATH so child processes (e.g., node) can be found in GUI apps
        process.environment = ExecutableResolver.augmentedEnvironment(for: executablePath)

        let stdoutPipe = Pipe()
        let stderrPipe = Pipe()
        process.standardOutput = stdoutPipe
        process.standardError = stderrPipe

        // Collect data from both pipes concurrently to avoid buffer deadlock
        let stdoutData = OSAllocatedUnfairLock(initialState: Data())
        let stderrData = OSAllocatedUnfairLock(initialState: Data())

        stdoutPipe.fileHandleForReading.readabilityHandler = { handle in
            let data = handle.availableData
            if !data.isEmpty {
                stdoutData.withLock { $0.append(data) }
            }
        }

        stderrPipe.fileHandleForReading.readabilityHandler = { handle in
            let data = handle.availableData
            if !data.isEmpty {
                stderrData.withLock { $0.append(data) }
            }
        }

        // Set up timeout if requested
        let timeoutTask: Task<Void, Error>?
        if timeout > 0 {
            timeoutTask = Task {
                try await Task.sleep(for: .seconds(timeout))
                if process.isRunning {
                    process.terminate()
                }
            }
        } else {
            timeoutTask = nil
        }

        // Wait for process termination without blocking the cooperative thread pool.
        // terminationHandler is set BEFORE run() to avoid a race where a fast-
        // exiting process completes before the handler is assigned.
        var runError: (any Error)?
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            process.terminationHandler = { _ in
                continuation.resume()
            }
            do {
                try process.run()
            } catch {
                process.terminationHandler = nil
                runError = error
                continuation.resume()
            }
        }
        timeoutTask?.cancel()
        if let runError { throw runError }

        // Clean up handlers and drain any remaining buffered data.
        // ACCEPTED RISK: There is a narrow race window where an in-flight
        // readabilityHandler dispatch block could fire concurrently with
        // readDataToEndOfFile(), potentially splitting data between the two
        // readers. In practice, availableData consumes bytes from the fd, so
        // readDataToEndOfFile gets only what the handler hasn't read. For the
        // CLI JSON output sizes involved (< 10KB), the pipe buffer (64KB)
        // never fills and this race is practically unreachable. A proper fix
        // would use DispatchGroup to drain handler callbacks before reading.
        stdoutPipe.fileHandleForReading.readabilityHandler = nil
        stderrPipe.fileHandleForReading.readabilityHandler = nil

        let trailingStdout = stdoutPipe.fileHandleForReading.readDataToEndOfFile()
        let trailingStderr = stderrPipe.fileHandleForReading.readDataToEndOfFile()
        if !trailingStdout.isEmpty { stdoutData.withLock { $0.append(trailingStdout) } }
        if !trailingStderr.isEmpty { stderrData.withLock { $0.append(trailingStderr) } }

        let finalStdout = stdoutData.withLock { String(data: $0, encoding: .utf8) ?? "" }
        let finalStderr = stderrData.withLock { String(data: $0, encoding: .utf8) ?? "" }

        let result = CLIResult(
            exitCode: process.terminationStatus,
            stdout: finalStdout,
            stderr: finalStderr
        )
        Log.debug("exit: \(result.exitCode) | stdout: \(result.stdout.prefix(200)) | stderr: \(result.stderr.prefix(200))", tag: "CLIRunner")
        return result
    }

    // MARK: - Executable Resolution (delegated to ExecutableResolver)
    // Path resolution logic lives in ExecutableResolver.swift — shared by DependencyScanner.

}
