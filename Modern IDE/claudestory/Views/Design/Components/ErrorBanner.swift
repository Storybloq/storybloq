import SwiftUI
import Fabric

// MARK: - Error Banner

struct ErrorBanner: View {
    let warnings: [LoadWarning]
    var onFixAll: (() -> Void)?
    @State private var isExpanded = false

    private var hasFixableWarnings: Bool {
        warnings.contains { $0.fixable }
    }

    var body: some View {
        FabricErrorBanner(
            "\(warnings.count) warning\(warnings.count == 1 ? "" : "s")",
            warnings: warnings.map { warning in
                FabricErrorBanner.Warning(
                    title: warning.file,
                    subtitle: warning.message
                )
            },
            accent: .madder,
            isExpanded: $isExpanded
        )
        .overlay(alignment: .bottomTrailing) {
            if isExpanded && hasFixableWarnings, let onFixAll {
                Button {
                    onFixAll()
                } label: {
                    HStack(spacing: FabricSpacing.xs) {
                        Image(systemName: "wand.and.stars")
                            .font(.system(size: 11))
                        Text("Fix All")
                            .fabricTypography(.caption)
                    }
                    .padding(.horizontal, FabricSpacing.sm)
                    .padding(.vertical, FabricSpacing.xs)
                }
                .buttonStyle(.plain)
                .foregroundStyle(FabricAccent.madder.foreground)
                .padding(.trailing, FabricSpacing.md)
                .padding(.bottom, FabricSpacing.sm)
            }
        }
    }
}

// MARK: - Preview

#Preview("ErrorBanner") {
    let singleWarning = [
        LoadWarning(file: "tickets/T-099.json", message: "Invalid JSON: missing 'title' field")
    ]
    let multipleWarnings = [
        LoadWarning(file: "tickets/T-099.json", message: "Invalid JSON: missing 'title' field"),
        LoadWarning(file: "tickets/T-100.json", message: "Unknown ticket type: 'epic'"),
        LoadWarning(file: "issues/ISS-050.json", message: "Unexpected value for severity"),
        LoadWarning(file: "roadmap.json", message: "Phase 'p6' referenced but not defined"),
        LoadWarning(file: "handovers/readme.txt", message: "Handover filename does not start with YYYY-MM-DD date prefix.", fixable: true),
    ]

    VStack(spacing: StorySpacing.md) {
        ErrorBanner(warnings: singleWarning)
        ErrorBanner(warnings: multipleWarnings) { /* preview fix */ }
    }
    .padding(StorySpacing.lg)
    .frame(width: 400)
    .background(StoryTheme.base)
}
