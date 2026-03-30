import SwiftUI
import Fabric

// MARK: - Dependency Wizard View

/// Step-by-step wizard for checking and installing dependencies.
/// Renders one tool group per screen, auto-advances when all found.
struct DependencyWizardView: View {
    @Bindable var viewModel: DependencyWizardViewModel

    var body: some View {
        VStack(spacing: 0) {
            if viewModel.showingSummary {
                summaryView
            } else {
                stepView
            }
        }
        .frame(width: 500, height: 450)
        .background(StoryTheme.base)
    }

    // MARK: - Step View

    private var stepView: some View {
        VStack(spacing: 0) {
            // Header
            VStack(alignment: .leading, spacing: StorySpacing.sm) {
                Text("Step \(viewModel.currentStepGroup) of \(ToolDefinition.totalSteps)")
                    .font(.caption)
                    .foregroundStyle(StoryTheme.textSecondary)

                Text(viewModel.currentStepTitle)
                    .fabricTitle()

                Text(viewModel.currentStepHelpText)
                    .fabricCaption()
                    .fixedSize(horizontal: false, vertical: true)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(StorySpacing.lg)

            Divider()

            // Tool rows
            VStack(spacing: 0) {
                ForEach(viewModel.currentTools, id: \.tool) { result in
                    DependencyStepView(
                        result: result,
                        installingTool: viewModel.installingTool,
                        onInstall: {
                            Task { await viewModel.install(result.tool) }
                        },
                        onOpenLink: {
                            viewModel.openInstallURL(result.tool)
                        },
                        onCopyCommand: {
                            viewModel.copyCommand(result.tool)
                        }
                    )
                    Divider()
                }
            }
            .padding(.horizontal, StorySpacing.lg)

            Spacer()

            // Install error
            if let error = viewModel.installError {
                Text(error)
                    .font(.caption)
                    .foregroundStyle(StoryTheme.err)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.horizontal, StorySpacing.lg)
                    .padding(.bottom, StorySpacing.sm)
            }

            Divider()

            // Actions
            HStack {
                if viewModel.isCurrentStepRequired {
                    Button("Continue in limited mode") {
                        viewModel.continueInLimitedMode()
                    }
                    .buttonStyle(.fabricGhost)
                    .controlSize(.small)
                }

                Spacer()

                if viewModel.isRescanning {
                    ProgressView()
                        .controlSize(.small)
                        .padding(.trailing, StorySpacing.sm)
                }

                Button("Check Again") {
                    Task { await viewModel.rescan() }
                }
                .buttonStyle(.fabricGhost)
                .disabled(viewModel.isInstalling || viewModel.isRescanning)

                if !viewModel.isCurrentStepRequired && !viewModel.allCurrentFound {
                    Button("Skip") {
                        viewModel.skip()
                    }
                    .buttonStyle(.fabricGhost)
                }

                if viewModel.canContinue {
                    Button("Continue") {
                        viewModel.advance()
                    }
                    .buttonStyle(.fabric)
                }
            }
            .padding(StorySpacing.lg)
        }
    }

    // MARK: - Summary View

    private var summaryView: some View {
        VStack(spacing: 0) {
            // Header
            Text("All Set!")
                .fabricTitle()
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(StorySpacing.lg)

            Divider()

            // All tools summary
            VStack(spacing: 0) {
                ForEach(ToolDefinition.allCases, id: \.self) { tool in
                    let result = viewModel.status.result(for: tool)
                    HStack(spacing: StorySpacing.md) {
                        Image(systemName: result.isFound ? "checkmark.circle.fill" : "forward.fill")
                            .foregroundStyle(result.isFound ? StoryTheme.ok : StoryTheme.textTertiary)
                            .font(.title3)

                        Text(tool.displayName)
                            .fabricLabel()

                        Spacer()

                        if let version = result.version {
                            Text(version)
                                .font(.caption)
                                .foregroundStyle(StoryTheme.textSecondary)
                        } else if !result.isFound {
                            Text("Skipped")
                                .font(.caption)
                                .foregroundStyle(StoryTheme.textTertiary)
                        }
                    }
                    .padding(.vertical, StorySpacing.xs)
                    .padding(.horizontal, StorySpacing.sm)
                }
            }
            .padding(StorySpacing.lg)

            Spacer()

            Divider()

            // Get Started button
            HStack {
                Spacer()
                Button("Get Started") {
                    viewModel.complete()
                }
                .buttonStyle(.fabric)
                .keyboardShortcut(.defaultAction)
            }
            .padding(StorySpacing.lg)
        }
    }
}
