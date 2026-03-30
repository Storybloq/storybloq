import SwiftUI
import Fabric

// MARK: - Empty State

/// Centered placeholder for empty sections.
/// Delegates to FabricEmptyState which includes built-in fade animation.
/// Consumers should NOT wrap EmptyState in additional appearance animations.
struct EmptyState: View {
    let icon: String
    let title: String
    var subtitle: String? = nil

    var body: some View {
        FabricEmptyState(systemImage: icon, title: title, subtitle: subtitle)
    }
}

// MARK: - Preview

#Preview("EmptyState") {
    VStack(spacing: FabricSpacing.xl) {
        EmptyState(
            icon: "ticket.fill",
            title: "No Tickets",
            subtitle: "Create a ticket to get started"
        )
        Divider()
        EmptyState(
            icon: "doc.text.fill",
            title: "No Handovers"
        )
    }
    .padding(StorySpacing.lg)
    .frame(width: 400, height: 400)
    .background(StoryTheme.base)
}
