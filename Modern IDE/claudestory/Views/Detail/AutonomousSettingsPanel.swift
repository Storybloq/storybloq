import SwiftUI

/// Project-scoped settings panel for autonomous mode recipe overrides.
/// Accessible from toolbar. Reads/writes .story/config.json via CLI.
struct AutonomousSettingsPanel: View {
    let viewModel: ProjectViewModel

    // Session
    @State private var unlimited = true
    @State private var maxTickets = 3
    @State private var handoverInterval = 5

    // Review
    @State private var codexEnabled = true
    @State private var agentEnabled = true

    // Pipeline stages
    @State private var writeTestsEnabled = true
    @State private var testEnabled = false
    @State private var testCommand = ""
    @State private var verifyEnabled = false
    @State private var startCommand = ""
    @State private var readinessUrl = ""

    @State private var initialized = false

    private var overrides: Config.RecipeOverrides? {
        viewModel.state.config.recipeOverrides
    }

    private var unknownBackends: [String] {
        let known: Set<String> = ["codex", "agent"]
        return (overrides?.reviewBackends ?? []).filter { !known.contains($0) }
    }

    var body: some View {
        ScrollView {
            Form {
                sessionSection
                checkpointSection
                reviewSection
                testingSection
                verifySection
                resetSection
            }
            .formStyle(.grouped)
        }
        .frame(width: 380)
        .frame(maxHeight: 700)
        .onAppear { loadFromConfig(); initialized = true }
        .onChange(of: unlimited) { if initialized { save() } }
        .onChange(of: maxTickets) { if initialized { save() } }
        .onChange(of: handoverInterval) { if initialized { save() } }
        .onChange(of: codexEnabled) { if initialized { save() } }
        .onChange(of: agentEnabled) { if initialized { save() } }
        .onChange(of: writeTestsEnabled) { if initialized { save() } }
        .onChange(of: testEnabled) { if initialized { save() } }
        .onChange(of: testCommand) { if initialized { save() } }
        .onChange(of: verifyEnabled) { if initialized { save() } }
        .onChange(of: startCommand) { if initialized { save() } }
        .onChange(of: readinessUrl) { if initialized { save() } }
    }

    // MARK: - Sections

    private var sessionSection: some View {
        Section {
            Text("How many tickets the agent completes before stopping.")
                .font(.caption)
                .foregroundStyle(.secondary)
            Toggle("Unlimited", isOn: $unlimited)
            if !unlimited {
                Stepper("Stop after \(maxTickets) tickets", value: $maxTickets, in: 1...50)
            }
        } header: {
            Label("Session Limit", systemImage: "number.circle")
        }
    }

    private var checkpointSection: some View {
        Section {
            Text("Saves progress at regular intervals. If the session crashes, the next one picks up from the last checkpoint.")
                .font(.caption)
                .foregroundStyle(.secondary)
            if handoverInterval == 0 {
                Stepper("Disabled", value: $handoverInterval, in: 0...5)
            } else {
                Stepper("Every \(handoverInterval) ticket\(handoverInterval == 1 ? "" : "s")", value: $handoverInterval, in: 0...5)
            }
        } header: {
            Label("Checkpoints", systemImage: "bookmark")
        }
    }

    private var reviewSection: some View {
        Section {
            Text("AI reviewers that check code before each commit. Using both gives independent perspectives.")
                .font(.caption)
                .foregroundStyle(.secondary)
            Toggle("ChatGPT (Codex)", isOn: $codexEnabled)
                .disabled(!agentEnabled && unknownBackends.isEmpty)
            Toggle("Claude", isOn: $agentEnabled)
                .disabled(!codexEnabled && unknownBackends.isEmpty)
            if !unknownBackends.isEmpty {
                Text("Also active: \(unknownBackends.joined(separator: ", "))")
                    .font(.caption)
                    .foregroundStyle(.tertiary)
            }
        } header: {
            Label("Code Review", systemImage: "eye")
        }
    }

    private var testingSection: some View {
        Section {
            Group {
                if writeTestsEnabled && testEnabled {
                    Text("Writes failing tests from the plan, implements to make them pass, then verifies the full suite.")
                } else if writeTestsEnabled {
                    Text("Writes failing tests from the plan, then implements code to make them pass.")
                } else if testEnabled {
                    Text("Runs the test suite after implementation to catch regressions.")
                } else {
                    Text("No automated testing. The agent relies on code review only.")
                }
            }
            .font(.caption)
            .foregroundStyle(.secondary)
            Toggle("Write Tests First (TDD)", isOn: $writeTestsEnabled)
            Toggle("Run Tests After Code", isOn: $testEnabled)
            if writeTestsEnabled || testEnabled {
                TextField("Test command", text: $testCommand, prompt: Text("e.g. npm test, pnpm test, swift test"))
                    .textFieldStyle(.roundedBorder)
            }
        } header: {
            Label("Testing", systemImage: "checkmark.circle")
        }
    }

    private var verifySection: some View {
        Section {
            Group {
                if verifyEnabled {
                    Text("Starts the dev server after code review and curls API endpoints to catch runtime errors. For web projects with HTTP endpoints.")
                } else {
                    Text("For web projects: smoke tests HTTP endpoints before each commit. Not needed for iOS, macOS, or CLI projects.")
                }
            }
            .font(.caption)
            .foregroundStyle(.secondary)
            Toggle("Smoke Test Endpoints", isOn: $verifyEnabled)
            if verifyEnabled {
                TextField("Start command", text: $startCommand, prompt: Text("e.g. npm run dev, python manage.py runserver"))
                    .textFieldStyle(.roundedBorder)
                TextField("Readiness URL", text: $readinessUrl, prompt: Text("e.g. http://localhost:3000"))
                    .textFieldStyle(.roundedBorder)
            }
        } header: {
            Label("Endpoint Verification", systemImage: "network")
        }
    }

    private var resetSection: some View {
        Section {
            Button("Reset All to Defaults") {
                unlimited = true
                maxTickets = 3
                handoverInterval = 5
                codexEnabled = true
                agentEnabled = true
                writeTestsEnabled = true
                testEnabled = false
                testCommand = ""
                verifyEnabled = false
                startCommand = ""
                readinessUrl = ""
                save()
            }
            .frame(maxWidth: .infinity)
            .foregroundStyle(.secondary)
        }
    }

    // MARK: - Config I/O

    private func loadFromConfig() {
        let o = overrides
        unlimited = o?.maxTicketsPerSession == 0
        maxTickets = (o?.maxTicketsPerSession ?? 3) > 0 ? (o?.maxTicketsPerSession ?? 3) : 3
        handoverInterval = o?.handoverInterval ?? 5

        let backends = o?.reviewBackends ?? ["codex", "agent"]
        codexEnabled = backends.contains("codex")
        agentEnabled = backends.contains("agent")

        let stages = o?.stages
        writeTestsEnabled = stages?.WRITE_TESTS?.enabled ?? false
        testEnabled = stages?.TEST?.enabled ?? false
        testCommand = stages?.TEST?.command ?? stages?.WRITE_TESTS?.command ?? ""
        verifyEnabled = stages?.VERIFY?.enabled ?? false
        startCommand = stages?.VERIFY?.startCommand ?? ""
        readinessUrl = stages?.VERIFY?.readinessUrl ?? ""
    }

    private func save() {
        var backends = unknownBackends
        if codexEnabled { backends.insert("codex", at: 0) }
        if agentEnabled { backends.append("agent") }

        let writeTests = writeTestsEnabled
            ? Config.StageConfig(enabled: true, command: testCommand.isEmpty ? nil : testCommand, onExhaustion: "plan")
            : nil
        let test = testEnabled
            ? Config.StageConfig(enabled: true, command: testCommand.isEmpty ? nil : testCommand, onExhaustion: nil)
            : nil
        let verify = verifyEnabled
            ? Config.VerifyStageConfig(enabled: true, startCommand: startCommand.isEmpty ? nil : startCommand, readinessUrl: readinessUrl.isEmpty ? nil : readinessUrl, endpoints: nil)
            : nil

        let stages: Config.StageOverrides? = {
            let s = Config.StageOverrides(WRITE_TESTS: writeTests, TEST: test, VERIFY: verify)
            return s.isEmpty ? nil : s
        }()

        let newOverrides = Config.RecipeOverrides(
            maxTicketsPerSession: unlimited ? 0 : maxTickets,
            compactThreshold: nil,
            reviewBackends: backends.isEmpty ? nil : backends,
            handoverInterval: handoverInterval,
            stages: stages
        )

        viewModel.updateRecipeOverrides(newOverrides.isEmpty ? nil : newOverrides)
    }
}
