import SwiftUI
import QuartzCore

// MARK: - Panel Drag Divider

/// A draggable vertical divider for resizable side panels.
/// Drag left to widen the panel, drag right to narrow it.
/// Replaces both TerminalDragDivider and InspectorDragDivider.
///
/// Uses global coordinate space to prevent oscillation: the divider is an overlay
/// that moves when the panel resizes, which shifts its local coordinate space.
/// Using global coords ensures stable drag tracking regardless of view movement.
struct PanelDragDivider: View {
    @Binding var width: CGFloat
    var minWidth: CGFloat = 250
    var maxWidth: CGFloat = 500

    private static let hitAreaWidth: CGFloat = 8

    @State private var isDragging = false
    @State private var isHovering = false
    @State private var dragStartWidth: CGFloat = 0
    @State private var dragStartX: CGFloat = 0

    var body: some View {
        Rectangle()
            .fill(isDragging ? Color.accentColor.opacity(0.5) : Color.clear)
            .frame(width: Self.hitAreaWidth)
            .overlay {
                Capsule()
                    .fill(isDragging || isHovering ? Color.accentColor.opacity(0.6) : Color(nsColor: .separatorColor))
                    .frame(width: 4, height: 24)
            }
            .contentShape(Rectangle())
            .onHover { hovering in
                guard hovering != isHovering else { return }
                isHovering = hovering
                if hovering {
                    NSCursor.resizeLeftRight.push()
                } else {
                    NSCursor.pop()
                }
            }
            .gesture(
                DragGesture(minimumDistance: 1, coordinateSpace: .global)
                    .onChanged { value in
                        if !isDragging {
                            isDragging = true
                            dragStartWidth = width
                            dragStartX = value.startLocation.x
                        }
                        // Global coords: stable regardless of view movement.
                        // Dragging left (location.x decreases) = widen panel.
                        let deltaX = dragStartX - value.location.x
                        let newWidth = min(max(dragStartWidth + deltaX, minWidth), maxWidth)
                        var transaction = Transaction()
                        transaction.animation = nil
                        transaction.disablesAnimations = true
                        withTransaction(transaction) {
                            width = newWidth
                        }
                    }
                    .onEnded { value in
                        let deltaX = dragStartX - value.location.x
                        let newWidth = min(max(dragStartWidth + deltaX, minWidth), maxWidth)
                        var transaction = Transaction()
                        transaction.animation = nil
                        transaction.disablesAnimations = true
                        withTransaction(transaction) {
                            width = newWidth
                        }
                        isDragging = false
                    }
            )
            .onDisappear {
                if isDragging || isHovering {
                    NSCursor.pop()
                }
                isDragging = false
                isHovering = false
            }
    }
}
