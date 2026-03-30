import Testing
import Foundation
@testable import Modern_IDE

// MARK: - Terminal Session State Machine Tests

struct TerminalSessionStateMachineTests {

    @Test func startsInIdleState() {
        let session = TerminalSession()
        #expect(session.processState == .idle)
        #expect(session.generation == 0)
    }

    @Test func requestLaunchTransitionsToLaunching() throws {
        let session = TerminalSession()
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("test-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }

        session.requestLaunch(projectRoot: root)
        #expect(session.processState == .launching)
        #expect(session.generation == 1)
        #expect(session.pendingLaunchConfig != nil)
    }

    @Test func didLaunchTransitionsToRunning() throws {
        let session = TerminalSession()
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("test-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }

        session.requestLaunch(projectRoot: root)
        session.didLaunch()
        #expect(session.processState == .running)
        #expect(session.pendingLaunchConfig == nil)
    }

    @Test func didExitTransitionsToExited() throws {
        let session = TerminalSession()
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("test-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }

        session.requestLaunch(projectRoot: root)
        let gen = session.generation
        session.didLaunch()
        session.didExit(0, forGeneration: gen)
        #expect(session.processState == .exited(0))
    }

    @Test func didExitWithNonZeroCode() throws {
        let session = TerminalSession()
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("test-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }

        session.requestLaunch(projectRoot: root)
        let gen = session.generation
        session.didLaunch()
        session.didExit(1, forGeneration: gen)
        #expect(session.processState == .exited(1))
    }

    @Test func requestTerminateTransitionsToTerminating() throws {
        let session = TerminalSession()
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("test-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }

        session.requestLaunch(projectRoot: root)
        session.didLaunch()
        session.requestTerminate()
        #expect(session.processState == .terminating)
    }

    @Test func didTerminateTransitionsToIdle() throws {
        let session = TerminalSession()
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("test-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }

        session.requestLaunch(projectRoot: root)
        let gen = session.generation
        session.didLaunch()
        session.requestTerminate()
        session.didTerminate(forGeneration: gen)
        #expect(session.processState == .idle)
    }

    @Test func staleGenerationIgnoredForDidExit() throws {
        let session = TerminalSession()
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("test-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }

        session.requestLaunch(projectRoot: root)
        let oldGen = session.generation  // gen 1
        session.didLaunch()
        session.requestTerminate()
        session.didTerminate(forGeneration: oldGen)
        // didTerminate bumps generation to 2

        // Start a new session (generation 3)
        session.requestLaunch(projectRoot: root)
        session.didLaunch()
        #expect(session.processState == .running)
        #expect(session.generation == 3)

        // Late callback from generation 1 should be ignored
        session.didExit(0, forGeneration: oldGen)
        #expect(session.processState == .running)
    }

    @Test func staleGenerationIgnoredForDidTerminate() throws {
        let session = TerminalSession()
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("test-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }

        session.requestLaunch(projectRoot: root)
        let gen1 = session.generation
        session.didLaunch()
        session.requestTerminate()

        // Start new session before old termination completes
        session.reset()
        session.requestLaunch(projectRoot: root)
        session.didLaunch()
        #expect(session.processState == .running)

        // Late terminate from gen1 should be ignored
        session.didTerminate(forGeneration: gen1)
        #expect(session.processState == .running)
    }

    @Test func requestLaunchOnlyFromCanLaunchStates() throws {
        let session = TerminalSession()
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("test-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }

        // From running — should not transition
        session.requestLaunch(projectRoot: root)
        session.didLaunch()
        session.requestLaunch(projectRoot: root)
        #expect(session.processState == .running)

        // From terminating — should not transition
        session.requestTerminate()
        session.requestLaunch(projectRoot: root)
        #expect(session.processState == .terminating)
    }

    @Test func canLaunchFromIdleExitedAndFailed() {
        #expect(TerminalSession.ProcessState.idle.canLaunch == true)
        #expect(TerminalSession.ProcessState.exited(0).canLaunch == true)
        #expect(TerminalSession.ProcessState.exited(1).canLaunch == true)
        #expect(TerminalSession.ProcessState.failed("error").canLaunch == true)
        #expect(TerminalSession.ProcessState.running.canLaunch == false)
        #expect(TerminalSession.ProcessState.launching.canLaunch == false)
        #expect(TerminalSession.ProcessState.terminating.canLaunch == false)
    }

    @Test func resetClearsToIdle() throws {
        let session = TerminalSession()
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("test-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }

        session.requestLaunch(projectRoot: root)
        session.didLaunch()
        session.reset()
        #expect(session.processState == .idle)
        #expect(session.pendingLaunchConfig == nil)
    }

    @Test func requestTerminateFromIdleDoesNothing() {
        let session = TerminalSession()
        session.requestTerminate()
        #expect(session.processState == .idle)
    }

    @Test func didTerminateBumpsGenerationToInvalidateStaleCallbacks() throws {
        let session = TerminalSession()
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("test-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }

        session.requestLaunch(projectRoot: root)
        let launchGen = session.generation  // gen 1
        session.didLaunch()
        session.requestTerminate()
        session.didTerminate(forGeneration: launchGen)
        #expect(session.processState == .idle)

        // A late processTerminated callback using the old generation should be ignored
        // because didTerminate bumped the generation
        session.didExit(0, forGeneration: launchGen)
        #expect(session.processState == .idle)  // not .exited
    }
}

// MARK: - Environment Tests (via launch config — buildEnvironment/userShell are private)

struct TerminalSessionEnvironmentTests {

    @Test func launchConfigIncludesTermVariable() throws {
        let session = TerminalSession()
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("test-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }

        session.requestLaunch(projectRoot: root)
        let config = try #require(session.pendingLaunchConfig)
        let termEntry = config.environment?.first(where: { $0.hasPrefix("TERM=") })
        #expect(termEntry == "TERM=xterm-256color")
    }

    @Test func launchConfigUsesShellExecutable() throws {
        let session = TerminalSession()
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("test-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }

        session.requestLaunch(projectRoot: root)
        let config = try #require(session.pendingLaunchConfig)
        // Should use $SHELL or /bin/zsh
        #expect(!config.executable.isEmpty)
        #expect(config.executable.hasSuffix("sh") || config.executable.hasSuffix("fish"))
        #expect(config.args == ["-l"])
        #expect(config.workingDirectory == root.path)
    }

    @Test func resetRequestedDefaultsFalse() {
        let session = TerminalSession()
        #expect(session.resetRequested == false)
    }

    @Test func canRelaunchFromFailed() throws {
        let session = TerminalSession()
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("test-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }

        // Reach .failed through a proper state machine path
        session.requestLaunch(projectRoot: root)
        session.markFailed("spawn error")
        #expect(session.processState == .failed("spawn error"))
        #expect(session.processState.canLaunch == true)

        session.requestLaunch(projectRoot: root)
        #expect(session.processState == .launching)
    }

    @Test func resetBumpsGeneration() throws {
        let session = TerminalSession()
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("test-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }

        session.requestLaunch(projectRoot: root)
        let gen = session.generation
        session.didLaunch()
        session.reset()
        #expect(session.generation > gen)

        // Late callback from pre-reset generation should be ignored
        session.didExit(0, forGeneration: gen)
        #expect(session.processState == .idle)
    }

    @Test func resetClearsResetRequested() throws {
        let session = TerminalSession()
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("test-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }

        session.requestLaunch(projectRoot: root)
        session.didLaunch()
        session.resetRequested = true
        #expect(session.resetRequested == true)

        session.reset()
        #expect(session.resetRequested == false)
    }

    @Test func didLaunchFromNonLaunchingStateDoesNothing() throws {
        let session = TerminalSession()
        // From .idle — should not transition
        session.didLaunch()
        #expect(session.processState == .idle)

        // From .failed — should not transition
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("test-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }

        session.requestLaunch(projectRoot: root)
        session.markFailed("test error")
        session.didLaunch()
        #expect(session.processState == .failed("test error"))
    }

    @Test func markFailedFromRunningTransitions() throws {
        let session = TerminalSession()
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("test-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }

        session.requestLaunch(projectRoot: root)
        session.didLaunch()
        #expect(session.processState == .running)

        session.markFailed("process unresponsive")
        #expect(session.processState == .failed("process unresponsive"))
        #expect(session.processState.canLaunch == true)
    }

    @Test func markFailedFromTerminatingTransitions() throws {
        let session = TerminalSession()
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("test-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }

        session.requestLaunch(projectRoot: root)
        session.didLaunch()
        session.requestTerminate()
        #expect(session.processState == .terminating)

        session.markFailed("did not respond to signals")
        #expect(session.processState == .failed("did not respond to signals"))
    }

    @Test func markFailedFromIdleIsIgnored() {
        let session = TerminalSession()
        #expect(session.processState == .idle)

        session.markFailed("should be ignored")
        #expect(session.processState == .idle)
    }
}

