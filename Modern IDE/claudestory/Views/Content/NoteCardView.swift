import SwiftUI
import Fabric

// MARK: - Note Card View

/// Grid card for note preview in the notes list.
struct NoteCardView: View {
    let note: Note
    let onTap: () -> Void

    @State private var isHovered = false

    private var displayTitle: String {
        if let title = note.title, !title.isEmpty {
            return title
        }
        return "\(note.updatedDate) — \(note.id)"
    }

    var body: some View {
        FabricCard {
            VStack(alignment: .leading, spacing: FabricSpacing.sm) {
                // Title
                Text(displayTitle)
                    .fabricTypography(.label)
                    .fabricInk(.primary)
                    .lineLimit(1)

                // Content preview
                Text(String(note.content.prefix(80)))
                    .fabricTypography(.caption)
                    .foregroundStyle(FabricColors.inkSecondary)
                    .lineLimit(3)

                // Tags
                if !note.tags.isEmpty {
                    FabricFlowLayout(spacing: FabricSpacing.xs) {
                        ForEach(note.tags.prefix(3), id: \.self) { tag in
                            FabricChip(String(tag.prefix(20)), accent: .sage)
                        }
                        if note.tags.count > 3 {
                            Text("+\(note.tags.count - 3)")
                                .fabricTypography(.caption)
                                .foregroundStyle(FabricColors.inkTertiary)
                        }
                    }
                }

                // Date
                Text(note.updatedDate)
                    .fabricTypography(.monoSmall)
                    .foregroundStyle(FabricColors.inkTertiary)
            }
        }
        .scaleEffect(isHovered ? 1.02 : 1.0)
        .animation(.smooth(duration: 0.15), value: isHovered)
        .onHover { isHovered = $0 }
        .onTapGesture { onTap() }
    }
}
