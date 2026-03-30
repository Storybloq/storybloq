import SwiftUI
import Fabric

// MARK: - Dependency Step View

/// Reusable row showing a single tool's status, version, and action buttons.
struct DependencyStepView: View {
    let result: ToolScanResult
    /// The specific tool currently being installed, if any. Spinner shows only for this tool.
    let installingTool: ToolDefinition?
    var onInstall: (() -> Void)?
    var onOpenLink: (() -> Void)?
    var onCopyCommand: (() -> Void)?

    /// Whether any install is in progress (disables all install buttons).
    private var anyInstalling: Bool { installingTool != nil }

    /// Whether THIS specific tool is being installed (shows spinner on this row).
    private var isThisToolInstalling: Bool { installingTool == result.tool }

    var body: some View {
        HStack(spacing: StorySpacing.md) {
            // Status icon
            Image(systemName: result.isFound ? "checkmark.circle.fill" : "circle")
                .foregroundStyle(result.isFound ? StoryTheme.ok : StoryTheme.textTertiary)
                .font(.title3)

            // Tool info
            VStack(alignment: .leading, spacing: 2) {
                Text(result.tool.displayName)
                    .fabricLabel()
                if let version = result.version {
                    Text(version)
                        .font(.caption)
                        .foregroundStyle(StoryTheme.textSecondary)
                } else if !result.isFound {
                    Text("Not found")
                        .font(.caption)
                        .foregroundStyle(StoryTheme.err)
                }
            }

            Spacer()

            // Action buttons
            if !result.isFound {
                if isThisToolInstalling {
                    ProgressView()
                        .controlSize(.small)
                } else if result.tool.installCommand != nil {
                    Button("Copy Command") {
                        onCopyCommand?()
                    }
                    .buttonStyle(.fabricGhost)
                    .controlSize(.small)

                    Button("Install Now") {
                        onInstall?()
                    }
                    .buttonStyle(.fabric)
                    .controlSize(.small)
                    .disabled(anyInstalling)
                } else if result.tool.installURL != nil {
                    Button("Open Download Page") {
                        onOpenLink?()
                    }
                    .buttonStyle(.fabric)
                    .controlSize(.small)
                }
            }
        }
        .padding(StorySpacing.sm)
    }
}
