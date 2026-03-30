import SwiftUI
import Fabric

// MARK: - Type Badge

struct TypeBadge: View {
    private let text: String

    init(type: TicketType) {
        text = type.displayName
    }

    var body: some View {
        FabricBadge(text)
    }
}

// MARK: - Preview

#Preview("TypeBadge") {
    HStack(spacing: StorySpacing.xs) {
        TypeBadge(type: .task)
        TypeBadge(type: .feature)
        TypeBadge(type: .chore)
    }
    .padding(StorySpacing.lg)
    .background(StoryTheme.base)
}
