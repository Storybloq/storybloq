import Foundation
import os

// MARK: - Executable Resolver

/// Shared PATH resolution for CLI tools. Extracted from ProcessCLIRunner.resolveExecutable().
/// Handles macOS GUI app's minimal PATH by checking common install locations:
/// /usr/local/bin, /opt/homebrew/bin, ~/.npm-global/bin, nvm dirs, fnm dirs.
enum ExecutableResolver {

    /// Returns candidate filesystem paths where `binary` might be installed.
    static func candidatePaths(for binary: String) -> [String] {
        let home = NSHomeDirectory()
        var candidates = [
            "/usr/local/bin/\(binary)",
            "/opt/homebrew/bin/\(binary)",
            "\(home)/.npm-global/bin/\(binary)",
        ]

        // nvm: scan all installed node versions (newest first)
        let nvmVersionsDir = "\(home)/.nvm/versions/node"
        if let versions = try? FileManager.default.contentsOfDirectory(atPath: nvmVersionsDir) {
            for version in versions.sorted().reversed() {
                candidates.append("\(nvmVersionsDir)/\(version)/bin/\(binary)")
            }
        }

        // fnm: similar to nvm
        let fnmVersionsDir = "\(home)/Library/Application Support/fnm/node-versions"
        if let versions = try? FileManager.default.contentsOfDirectory(atPath: fnmVersionsDir) {
            for version in versions.sorted().reversed() {
                candidates.append("\(fnmVersionsDir)/\(version)/installation/bin/\(binary)")
            }
        }

        // volta
        candidates.append("\(home)/.volta/bin/\(binary)")

        // asdf
        candidates.append("\(home)/.asdf/shims/\(binary)")

        return candidates
    }

    /// Fast synchronous resolution — filesystem candidate checks only.
    /// Used by `ProcessCLIRunner.init` where sync is required.
    static func resolve(binary: String) -> String? {
        let fm = FileManager.default
        for path in candidatePaths(for: binary) {
            if fm.isExecutableFile(atPath: path) {
                Log.info("resolved \(binary): \(path)", tag: "ExecutableResolver")
                return path
            }
        }
        Log.warning("no candidate found for \(binary) (sync)", tag: "ExecutableResolver")
        return nil
    }

    /// Full async resolution — tries fast candidate paths first, then login shell fallback.
    /// Used by `DependencyScanner` where async is available and thoroughness matters.
    static func resolveAsync(binary: String) async -> String? {
        if let path = resolve(binary: binary) { return path }
        // Slow fallback: login shell (covers custom PATH, shim managers not in candidatePaths)
        if let shellResult = await runWhich(binary: binary) {
            Log.info("resolved \(binary) via login shell: \(shellResult)", tag: "ExecutableResolver")
            return shellResult
        }
        Log.warning("no candidate found for \(binary) (async)", tag: "ExecutableResolver")
        return nil
    }

    /// Resolves a binary via the user's login shell. Non-blocking (uses terminationHandler).
    /// Uses `zsh -lc 'command -v -- <binary>'` to pick up shell-managed PATH (asdf, etc.).
    private static func runWhich(binary: String) async -> String? {
        // Reject binary names with shell metacharacters
        guard binary.allSatisfy({ $0.isLetter || $0.isNumber || $0 == "-" || $0 == "_" }) else {
            return nil
        }

        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/zsh")
        process.arguments = ["-lc", "command -v -- \(binary)"]

        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = FileHandle.nullDevice

        var runFailed = false
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            process.terminationHandler = { _ in continuation.resume() }
            do {
                try process.run()
            } catch {
                process.terminationHandler = nil
                runFailed = true
                continuation.resume()
            }
        }

        guard !runFailed, process.terminationStatus == 0 else { return nil }
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        let path = String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let resolved = path, !resolved.isEmpty else { return nil }
        return resolved
    }

    /// Builds an environment dictionary with the resolved binary's parent directory
    /// prepended to PATH. This ensures child processes (e.g., `node` for claudestory scripts)
    /// can be found even in macOS GUI apps with minimal PATH.
    static func augmentedEnvironment(for resolvedPath: String) -> [String: String] {
        var env = ProcessInfo.processInfo.environment
        let execDir = (resolvedPath as NSString).deletingLastPathComponent
        let existingPath = env["PATH"] ?? "/usr/bin:/bin:/usr/sbin:/sbin"
        env["PATH"] = "\(execDir):\(existingPath)"
        return env
    }
}
