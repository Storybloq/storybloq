import SwiftUI
import Fabric

// MARK: - Terminal Tab Bar

/// Compact tab bar for terminal tabs. Positioned above TerminalToolbar.
/// Tab selection routes through `onSelect` callback (not a binding) because
/// switching has side effects (cancel old restartTask, auto-restart exited tabs).
struct TerminalTabBar: View {
    let tabs: [TerminalTab]
    var activeTabID: UUID?
    var canAddTab: Bool = true
    var onSelect: ((UUID) -> Void)?
    var onClose: ((UUID) -> Void)?
    var onAdd: (() -> Void)?
    @Namespace private var tabIndicator

    var body: some View {
        HStack(spacing: 0) {
            // Tab pills
            ForEach(tabs) { tab in
                TerminalTabPill(
                    tab: tab,
                    isSelected: tab.id == activeTabID,
                    showClose: tabs.count > 1,
                    namespace: tabIndicator,
                    onSelect: { onSelect?(tab.id) },
                    onClose: { onClose?(tab.id) }
                )
            }

            // Add tab button
            Button {
                onAdd?()
            } label: {
                Image(systemName: "plus")
                    .font(.system(size: 10, weight: .medium))
                    .frame(width: 20, height: 20)
            }
            .buttonStyle(.plain)
            .foregroundStyle(canAddTab ? StoryTheme.textSecondary : StoryTheme.textTertiary)
            .disabled(!canAddTab)
            .help(canAddTab ? "New terminal tab" : "Maximum \(TerminalTabManager.maxTabs) tabs")
            .accessibilityLabel("New terminal tab")
            .padding(.leading, StorySpacing.xs)
        }
    }
}

// MARK: - Terminal Tab Pill

private struct TerminalTabPill: View {
    let tab: TerminalTab
    let isSelected: Bool
    let showClose: Bool
    var namespace: Namespace.ID
    let onSelect: () -> Void
    let onClose: () -> Void

    @State private var isHovered = false

    var body: some View {
        HStack(spacing: 0) {
            // Tab selection button — proper Button for accessibility + keyboard focus.
            // Close button is a separate sibling to avoid nested-button issues.
            Button(action: onSelect) {
                VStack(spacing: 0) {
                    HStack(spacing: StorySpacing.xs) {
                        // Status dot — accesses tab.session.processState for
                        // correct @Observable tracking through nested objects
                        Circle()
                            .fill(statusColor)
                            .frame(width: 5, height: 5)

                        Text(tab.label)
                            .fabricMonoCaption()
                            .lineLimit(1)
                    }
                    .padding(.horizontal, StorySpacing.sm)
                    .padding(.vertical, StorySpacing.xs)

                    // Underline indicator (matchedGeometryEffect for smooth animation)
                    Rectangle()
                        .fill(isSelected ? StoryTheme.accent : .clear)
                        .frame(height: 2)
                        .matchedGeometryEffect(
                            id: "tab-underline",
                            in: namespace,
                            isSource: isSelected
                        )
                }
            }
            .buttonStyle(.plain)
            .accessibilityLabel(tab.label)
            .accessibilityAddTraits(isSelected ? .isSelected : [])

            // Close button on hover (only when 2+ tabs) — separate from select button
            if showClose && isHovered {
                Button {
                    onClose()
                } label: {
                    Image(systemName: "xmark")
                        .font(.system(size: 8, weight: .medium))
                        .foregroundStyle(StoryTheme.textTertiary)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Close \(tab.label)")
            }
        }
        .foregroundStyle(isSelected ? StoryTheme.accent : StoryTheme.textSecondary)
        .background(
            RoundedRectangle(cornerRadius: FabricSpacing.radiusSm)
                .fill(isHovered && !isSelected ? StoryTheme.surfaceAlt : .clear)
                .padding(.horizontal, StorySpacing.xxs)
                .padding(.top, StorySpacing.xxs)
        )
        .onHover { hovering in
            isHovered = hovering
        }
    }

    private var statusColor: Color {
        switch tab.session.processState {
        case .running: StoryTheme.ok
        case .launching: StoryTheme.warn
        case .failed: StoryTheme.err
        default: StoryTheme.mute
        }
    }
}
