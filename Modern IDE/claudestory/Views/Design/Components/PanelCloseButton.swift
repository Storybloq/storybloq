import SwiftUI

// MARK: - Panel Close Button

/// Shared panel action button for consistent styling across sidebars.
/// Defaults to xmark icon. Pass a custom systemImage for other actions.
struct PanelCloseButton: View {
    var systemImage: String = "xmark"
    let helpText: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: systemImage)
                .font(.system(size: 12, weight: .medium))
                .frame(width: 24, height: 24)
        }
        .buttonStyle(.plain)
        .foregroundStyle(StoryTheme.textTertiary)
        .help(helpText)
        .accessibilityLabel(helpText)
    }
}
