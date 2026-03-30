import SwiftUI
import Fabric

// MARK: - Markdown Preview Box

/// Renders markdown content inside a container that matches FabricTextEditor's styling.
/// Same font, padding, background, inner shadow, border, and height constraints.
struct MarkdownPreviewBox: View {
    let text: String
    let placeholder: String
    let minHeight: CGFloat

    private var shape: RoundedRectangle {
        FabricSpacing.shape(radius: FabricSpacing.radiusSm)
    }

    var body: some View {
        Group {
            if text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                Text(placeholder)
                    .foregroundStyle(FabricColors.inkTertiary)
                    .padding(.leading, 6)
                    .padding(.top, 8)
                    .frame(maxWidth: .infinity, alignment: .topLeading)
            } else {
                StoryMarkdownView(text)
                    .foregroundStyle(FabricColors.inkPrimary)
                    .frame(maxWidth: .infinity, alignment: .topLeading)
            }
        }
        .font(.system(size: 17, weight: .regular))
        .tracking(-0.08)
        .padding(8)
        .frame(minHeight: minHeight, alignment: .topLeading)
        .background { shape.fill(FabricColors.parchment) }
        .fabricInnerShadow(shape, .shallow)
        .overlay {
            shape.strokeBorder(
                FabricColors.inkTertiary.opacity(0.15),
                lineWidth: 0.5
            )
        }
    }
}
