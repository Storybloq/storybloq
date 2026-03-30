import SwiftUI
import Fabric

// MARK: - Sidebar Panel

/// Uniform shell for right-side panels (terminal, inspector).
/// Provides pebble surface styling, a fixed-height top bar with close button,
/// drag divider, and padding. Header, trailing actions, and content are @ViewBuilder slots.
struct SidebarPanel<Header: View, Actions: View, Content: View>: View {
    @Binding var panelWidth: CGFloat
    var minWidth: CGFloat = 250
    var maxWidth: CGFloat = 500
    var showDivider: Bool = true
    var applyLeadingOverlap: Bool = true
    var onClose: (() -> Void)? = nil
    @ViewBuilder var header: () -> Header
    @ViewBuilder var actions: () -> Actions
    @ViewBuilder var content: () -> Content

    var body: some View {
        VStack(spacing: 0) {
            // Uniform 42pt top bar
            HStack {
                header()
                Spacer(minLength: 0)
                actions()
                if let onClose {
                    PanelCloseButton(helpText: "Close", action: onClose)
                }
            }
            .padding(.horizontal, StorySpacing.sm)
            .frame(height: 42)
            .overlay(alignment: .bottom) {
                Rectangle()
                    .fill(StoryTheme.border)
                    .frame(height: 1)
            }

            // Main content
            content()
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .fabricSurface(FabricColors.parchment)
        .clipShape(RoundedRectangle(cornerRadius: FabricSpacing.radiusMd))
        .fabricShadow(.low)
        .overlay(alignment: .leading) {
            if showDivider {
                PanelDragDivider(width: $panelWidth, minWidth: minWidth, maxWidth: maxWidth)
                    .offset(x: -4)
            }
        }
        .padding(StorySpacing.lg)
        .padding(.leading, applyLeadingOverlap ? -FabricSpacing.radiusMd : 0)
    }
}

// Convenience: no actions
extension SidebarPanel where Actions == EmptyView {
    init(
        panelWidth: Binding<CGFloat>,
        minWidth: CGFloat = 250,
        maxWidth: CGFloat = 500,
        showDivider: Bool = true,
        applyLeadingOverlap: Bool = true,
        onClose: (() -> Void)? = nil,
        @ViewBuilder header: @escaping () -> Header,
        @ViewBuilder content: @escaping () -> Content
    ) {
        self._panelWidth = panelWidth
        self.minWidth = minWidth
        self.maxWidth = maxWidth
        self.showDivider = showDivider
        self.applyLeadingOverlap = applyLeadingOverlap
        self.onClose = onClose

        self.header = header
        self.actions = { EmptyView() }
        self.content = content
    }
}

// Convenience: no header, no actions
extension SidebarPanel where Header == EmptyView, Actions == EmptyView {
    init(
        panelWidth: Binding<CGFloat>,
        minWidth: CGFloat = 250,
        maxWidth: CGFloat = 500,
        showDivider: Bool = true,
        applyLeadingOverlap: Bool = true,
        onClose: (() -> Void)? = nil,
        @ViewBuilder content: @escaping () -> Content
    ) {
        self._panelWidth = panelWidth
        self.minWidth = minWidth
        self.maxWidth = maxWidth
        self.showDivider = showDivider
        self.applyLeadingOverlap = applyLeadingOverlap
        self.onClose = onClose

        self.header = { EmptyView() }
        self.actions = { EmptyView() }
        self.content = content
    }
}
