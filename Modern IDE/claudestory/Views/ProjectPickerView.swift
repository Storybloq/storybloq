import SwiftUI
import Fabric

// MARK: - Project Picker View

/// Shown when a window has no project selected (blank/empty path).
/// No ProjectViewModel, FileWatcher, or terminals are created in this phase.
///
/// Shows recent projects from the bookmark store for quick access (T-073).
/// Clicking a recent resolves its bookmark (handling renames/moves) and
/// delegates to the parent via `onPick`. Stale entries are pruned on click
/// via `resolveBookmark`, which triggers an @Observable re-render.
struct ProjectPickerView: View {
    var onPick: ((URL) -> Void)?
    var onCancel: (() -> Void)?

    @Environment(AppCoordinator.self) private var coordinator
    @AppStorage(AppSettings.Key.experimentalFeatures) private var experimentalFeatures = false
    @State private var isPickerOpen = false
    @State private var isOpeningRecent = false

    var body: some View {
        VStack(spacing: StorySpacing.lg) {
            Image(systemName: "tray.2")
                .font(.system(size: 40))
                .foregroundStyle(FabricColors.inkTertiary)
            VStack(spacing: StorySpacing.xs) {
                Text("Open a claudestory project")
                    .fabricTitle()
                Text("Select a project directory")
                    .fabricCaption()
            }

            // Recent projects (prefix 8: picker is more compact than WelcomeView's 10)
            if !coordinator.bookmarkStore.recents.isEmpty {
                ScrollView {
                    VStack(alignment: .leading, spacing: StorySpacing.xs) {
                        Text("Recent Projects")
                            .fabricCaption()
                            .padding(.horizontal, StorySpacing.sm)

                        ForEach(coordinator.bookmarkStore.recents.prefix(8)) { recent in
                            Button {
                                openRecent(recent)
                            } label: {
                                HStack {
                                    Image(systemName: "folder")
                                        .foregroundStyle(FabricColors.inkSecondary)
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(recent.displayName)
                                            .foregroundStyle(FabricColors.inkPrimary)
                                        Text(recent.canonicalPath)
                                            .font(.caption2)
                                            .foregroundStyle(FabricColors.inkTertiary)
                                            .lineLimit(1)
                                            .truncationMode(.middle)
                                    }
                                    Spacer()
                                }
                                .padding(.horizontal, StorySpacing.sm)
                                .padding(.vertical, StorySpacing.xs)
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                            .disabled(isPickerOpen)
                        }
                    }
                }
                .frame(maxWidth: 350, maxHeight: 280)
                .scrollIndicators(.hidden)
            }

            Button("Choose Directory...") {
                Task { await chooseDirectory() }
            }
            .controlSize(.large)
            .disabled(isPickerOpen)
        }
        .smoothAppearance()
        .toolbar {
            ToolbarItem(placement: .automatic) {
                TextField("Search tickets, issues...", text: .constant(""))
                    .textFieldStyle(.plain)
                    .padding(.leading, 14)
                    .padding(.trailing, 8)
                    .padding(.vertical, 4)
                    .background(FabricColors.burlap.opacity(0.5), in: Capsule())
                    .frame(width: 220)
                    .padding(.trailing, 12)
                    .disabled(true)
            }
            if experimentalFeatures {
                ToolbarItem(placement: .primaryAction) {
                    Button {} label: { Image(systemName: "bolt.fill") }
                        .help("Auto Work").disabled(true)
                }
                ToolbarItem(placement: .primaryAction) {
                    Button {} label: { Image(systemName: "wand.and.stars") }
                        .help("Resume Work").disabled(true)
                }
            }
            ToolbarItem(placement: .primaryAction) {
                Button {} label: { Image(systemName: "note.text") }
                    .help("Notes").disabled(true)
            }
            if experimentalFeatures {
                ToolbarItem(placement: .primaryAction) {
                    Button {} label: { Image(systemName: "terminal") }
                        .help("Terminal").disabled(true)
                }
            }
        }
        .toolbarBackground(StoryTheme.base, for: .windowToolbar)
        .toolbarBackgroundVisibility(.visible, for: .windowToolbar)
    }

    // MARK: - Actions

    private func openRecent(_ recent: ProjectBookmarkStore.RecentProject) {
        guard !isOpeningRecent else { return }
        isOpeningRecent = true
        defer { isOpeningRecent = false }
        // Resolve bookmark — handles moved/renamed dirs, prunes stale entries.
        // If nil, entry was pruned from store; @Observable removes the row.
        if let resolvedURL = coordinator.bookmarkStore.resolveBookmark(for: recent.canonicalPath) {
            onPick?(resolvedURL)
        }
    }

    private func chooseDirectory() async {
        isPickerOpen = true
        defer { isPickerOpen = false }

        do {
            let url = try await ProjectIdentityService.showDirectoryPicker()
            onPick?(url)
        } catch ProjectRootError.userCancelled {
            onCancel?()
        } catch {
            // Unexpected error from NSOpenPanel — shouldn't happen
        }
    }
}
