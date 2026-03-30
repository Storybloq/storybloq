import SwiftUI

// MARK: - Settings View

/// App preferences, opened via Cmd+, (macOS Settings scene).
struct SettingsView: View {
    @Environment(AppCoordinator.self) private var coordinator
    @AppStorage(AppSettings.Key.experimentalFeatures) private var experimentalFeatures = false

    var body: some View {
        TabView {
            GeneralSettingsTab(coordinator: coordinator)
                .tabItem { Label("General", systemImage: "gear") }
            if experimentalFeatures {
                TerminalSettingsTab()
                    .tabItem { Label("Terminal", systemImage: "terminal") }
                PromptsSettingsTab()
                    .tabItem { Label("Prompts", systemImage: "text.bubble") }
            }
        }
        .frame(width: 550, height: 450)
        .id(experimentalFeatures)
    }
}

// MARK: - General Tab

private struct GeneralSettingsTab: View {
    let coordinator: AppCoordinator
    @AppStorage(AppSettings.Key.restoreOnLaunch) private var restoreOnLaunch = true
    @AppStorage(AppSettings.Key.experimentalFeatures) private var experimentalFeatures = false
    @State private var isRechecking = false

    var body: some View {
        Form {
            Toggle("Reopen projects from last session", isOn: $restoreOnLaunch)

            Section {
                Toggle("Enable experimental features", isOn: $experimentalFeatures)
                Text("Enables embedded terminal, autonomous mode, and session resume buttons.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            } header: {
                Text("Experimental")
            }

            Section {
                ForEach(ToolDefinition.allCases, id: \.self) { tool in
                    let result = coordinator.dependencyStatus.result(for: tool)
                    HStack {
                        Image(systemName: result.isFound ? "checkmark.circle.fill" : "xmark.circle")
                            .foregroundStyle(result.isFound ? .green : (tool.isRequired ? .red : .secondary))
                        Text(tool.displayName)
                        Spacer()
                        if let version = result.version {
                            Text(version)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        } else if !result.isFound {
                            Text(tool.isRequired ? "Required" : "Optional")
                                .font(.caption)
                                .foregroundStyle(tool.isRequired ? .red : .secondary)
                        }
                    }
                }

                HStack {
                    Spacer()
                    if isRechecking {
                        ProgressView()
                            .controlSize(.small)
                            .padding(.trailing, 4)
                    }
                    Button("Re-check") {
                        isRechecking = true
                        Task {
                            await coordinator.recheckDependencies()
                            isRechecking = false
                        }
                    }
                    .disabled(isRechecking)
                }
            } header: {
                Text("Dependencies")
            }
        }
        .formStyle(.grouped)
        .padding()
    }
}

// MARK: - Terminal Tab

private struct TerminalSettingsTab: View {
    @AppStorage(AppSettings.Key.autoPromptEnabled) private var autoPromptEnabled = true
    @AppStorage(AppSettings.Key.defaultShell) private var defaultShell = ""

    var body: some View {
        Form {
            Toggle("Auto-prompt on terminal launch", isOn: $autoPromptEnabled)
            TextField("Default shell", text: $defaultShell, prompt: Text("System default (\(systemShell))"))
        }
        .formStyle(.grouped)
        .padding()
    }

    private var systemShell: String {
        ProcessInfo.processInfo.environment["SHELL"] ?? "/bin/zsh"
    }
}

// MARK: - Prompts Tab

private struct PromptsSettingsTab: View {
    @AppStorage(AppSettings.Key.autoPrompt) private var autoPrompt = AppSettings.Defaults.autoPrompt
    @AppStorage(AppSettings.Key.resumeWork) private var resumeWork = AppSettings.Defaults.resumeWork
    @AppStorage(AppSettings.Key.autoWork) private var autoWork = AppSettings.Defaults.autoWork

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                PromptField(label: "On Terminal Launch", text: $autoPrompt, defaultValue: AppSettings.Defaults.autoPrompt)
                PromptField(label: "Resume Work Button", text: $resumeWork, defaultValue: AppSettings.Defaults.resumeWork)
                PromptField(label: "Auto Work Button", text: $autoWork, defaultValue: AppSettings.Defaults.autoWork)
            }
            .padding()
        }
    }
}

// MARK: - Prompt Field

private struct PromptField: View {
    let label: String
    @Binding var text: String
    let defaultValue: String

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(label)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Spacer()
                if text != defaultValue {
                    Button("Reset") {
                        text = defaultValue
                    }
                    .font(.caption)
                    .buttonStyle(.plain)
                    .foregroundStyle(.blue)
                }
            }
            TextEditor(text: $text)
                .font(.body.monospaced())
                .frame(height: 60)
                .scrollContentBackground(.hidden)
                .padding(6)
                .background(Color(nsColor: .controlBackgroundColor))
                .clipShape(RoundedRectangle(cornerRadius: 6))
        }
    }
}
