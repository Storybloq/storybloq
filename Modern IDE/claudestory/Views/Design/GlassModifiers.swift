import SwiftUI
import Fabric

// MARK: - Smooth Appearance Modifier

struct SmoothAppearanceModifier: ViewModifier {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var isVisible = false

    func body(content: Content) -> some View {
        content
            .opacity(isVisible ? 1 : 0)
            .scaleEffect(isVisible ? 1 : 0.97)
            .offset(y: isVisible ? 0 : 6)
            .onAppear {
                if reduceMotion {
                    isVisible = true
                } else {
                    withAnimation(.easeOut(duration: FabricAnimation.smooth)) {
                        isVisible = true
                    }
                }
            }
    }
}

extension View {
    /// Adds a smooth fade-in, scale, and upward slide animation on appear.
    func smoothAppearance() -> some View {
        modifier(SmoothAppearanceModifier())
    }
}

// MARK: - Preview

#Preview("Smooth Appearance") {
    VStack(spacing: FabricSpacing.lg) {
        FabricCard {
            Text("Card with smooth appearance")
                .fabricBody()
        }
        .smoothAppearance()
    }
    .padding(30)
    .frame(width: 400, height: 200)
    .background(StoryTheme.base)
}
