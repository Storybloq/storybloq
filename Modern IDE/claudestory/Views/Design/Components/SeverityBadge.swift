import SwiftUI
import Fabric

// MARK: - Severity Badge

struct SeverityBadge: View {
    private let text: String
    private let accent: FabricAccent?

    init(severity: IssueSeverity) {
        text = severity.displayName
        switch severity {
        case .critical: accent = .madder
        case .high: accent = .ochre
        case .medium: accent = .indigo
        case .low: accent = nil
        }
    }

    var body: some View {
        FabricBadge(text, accent: accent)
    }
}

// MARK: - Preview

#Preview("SeverityBadge") {
    HStack(spacing: StorySpacing.xs) {
        SeverityBadge(severity: .critical)
        SeverityBadge(severity: .high)
        SeverityBadge(severity: .medium)
        SeverityBadge(severity: .low)
    }
    .padding(StorySpacing.lg)
    .background(StoryTheme.base)
}
