import SwiftUI
import Fabric

// MARK: - Project Setup Sheet

/// Setup form for initializing `.story/` in a project directory that doesn't have one.
/// Bound to a `ProjectSetupViewModel` which handles CLI execution.
/// Type and language are auto-detected by `ProjectDetector` and passed to the CLI silently.
struct ProjectSetupSheet: View {
    @Bindable var viewModel: ProjectSetupViewModel
    var onComplete: () -> Void

    @Environment(\.dismiss) private var dismiss
    @Environment(AppCoordinator.self) private var coordinator

    /// Whether the claudestory CLI is available (derived from coordinator's scan results).
    private var isCLIAvailable: Bool {
        coordinator.dependencyStatus.result(for: .claudestoryCLI).isFound
    }

    private var isValid: Bool {
        !viewModel.name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && isCLIAvailable
    }

    var body: some View {
        VStack(spacing: 0) {
            // Header
            Text("Get Started with Claude Story")
                .fabricTitle()
                .minimumScaleFactor(0.7)
                .lineLimit(1)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(StorySpacing.lg)

            Divider()

            // Form
            VStack(alignment: .leading, spacing: StorySpacing.md) {
                Text("This project doesn't have a .story/ directory yet. Claude Story uses this directory to track your tickets, issues, roadmap, and session handovers.")
                    .fabricCaption()
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.horizontal, StorySpacing.xs)

                FabricCard {
                    VStack(alignment: .leading, spacing: StorySpacing.sm) {
                        Text("Project Name")
                            .fabricLabel()
                        FabricTextField(
                            placeholder: "Project name...",
                            text: $viewModel.name
                        )
                    }
                }

                if !isCLIAvailable {
                    Text("Claude Story CLI is required but not installed. Check Settings \u{2192} Dependencies.")
                        .font(.caption)
                        .foregroundStyle(StoryTheme.err)
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(.horizontal, StorySpacing.xs)
                }

                if let error = viewModel.error {
                    Text(error)
                        .font(.caption)
                        .foregroundStyle(StoryTheme.err)
                        .padding(.horizontal, StorySpacing.xs)
                }
            }
            .padding(StorySpacing.lg)

            Divider()

            // Actions
            HStack {
                Button("Cancel") {
                    dismiss()
                }
                .buttonStyle(.fabricGhost)
                .keyboardShortcut(.cancelAction)

                Spacer()

                if viewModel.isInitializing {
                    ProgressView()
                        .controlSize(.small)
                        .padding(.trailing, StorySpacing.sm)
                }

                Button("Get Started") {
                    Task {
                        let success = await viewModel.initialize()
                        if success {
                            onComplete()
                            dismiss()
                        }
                    }
                }
                .buttonStyle(.fabric)
                .keyboardShortcut(.defaultAction)
                .disabled(!isValid || viewModel.isInitializing)
            }
            .padding(StorySpacing.lg)
        }
        .frame(width: 450, height: 400)
        .background(StoryTheme.base)
    }
}
