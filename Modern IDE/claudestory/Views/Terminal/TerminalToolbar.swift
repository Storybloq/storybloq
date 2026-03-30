import SwiftUI
import Fabric

// MARK: - Terminal Toolbar

struct TerminalToolbar: View {
    let session: TerminalSession
    var onRestart: (() -> Void)?
    var onReset: (() -> Void)?
    var body: some View {
        HStack(spacing: StorySpacing.sm) {
            Image(systemName: "terminal.fill")
                .foregroundStyle(StoryTheme.accent)

            Text("Terminal")
                .fabricMonoSmall()

            statusIndicator

            Spacer()

            if session.processState == .running {
                Button {
                    onReset?()
                } label: {
                    Image(systemName: "arrow.counterclockwise")
                }
                .buttonStyle(.borderless)
                .help("Reset terminal")
            }

            // Restart button — only show after explicit stop or failure
            if case .failed = session.processState {
                Button {
                    onRestart?()
                } label: {
                    Image(systemName: "play.fill")
                }
                .buttonStyle(.borderless)
                .help("Retry")
            }
        }
        .padding(.horizontal, StorySpacing.md)
        .padding(.vertical, StorySpacing.xs)
        .background(StoryTheme.surfaceAlt)
    }

    @ViewBuilder
    private var statusIndicator: some View {
        switch session.processState {
        case .idle:
            Text("Ready")
                .fabricMonoCaption()
                .foregroundStyle(StoryTheme.textTertiary)
        case .launching:
            HStack(spacing: StorySpacing.xxs) {
                ProgressView()
                    .controlSize(.mini)
                Text("Starting...")
                    .fabricMonoCaption()
                    .foregroundStyle(StoryTheme.textSecondary)
            }
        case .running:
            HStack(spacing: StorySpacing.xxs) {
                Circle()
                    .fill(StoryTheme.ok)
                    .frame(width: 6, height: 6)
                Text("Running")
                    .fabricMonoCaption()
                    .foregroundStyle(StoryTheme.textSecondary)
            }
        case .exited:
            HStack(spacing: StorySpacing.xxs) {
                ProgressView()
                    .controlSize(.mini)
                Text("Restarting...")
                    .fabricMonoCaption()
                    .foregroundStyle(StoryTheme.textSecondary)
            }
        case .terminating:
            HStack(spacing: StorySpacing.xxs) {
                ProgressView()
                    .controlSize(.mini)
                Text("Stopping...")
                    .fabricMonoCaption()
                    .foregroundStyle(StoryTheme.textSecondary)
            }
        case .failed(let message):
            HStack(spacing: StorySpacing.xxs) {
                Circle()
                    .fill(StoryTheme.err)
                    .frame(width: 6, height: 6)
                Text(message)
                    .lineLimit(1)
                    .fabricMonoCaption()
                    .foregroundStyle(StoryTheme.textSecondary)
            }
        }
    }
}
