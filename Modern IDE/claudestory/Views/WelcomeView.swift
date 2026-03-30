import SwiftUI
import Fabric

// MARK: - Welcome View

/// Shown when no projects are open. Provides "Open Project..." button
/// and a list of recent projects from the bookmark store.
struct WelcomeView: View {
    @Environment(AppCoordinator.self) private var coordinator
    @Environment(\.openWindow) private var openWindow
    @Environment(\.dismissWindow) private var dismissWindow

    @State private var wizardViewModel: DependencyWizardViewModel?

    var body: some View {
        Group {
            if coordinator.dependencyScanState == .ready && coordinator.dependencyStatus.needsWizard {
                wizardContent
            } else if coordinator.dependencyScanState == .scanning {
                ProgressView("Checking dependencies...")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .fabricSurface(StoryTheme.base)
            } else {
                welcomeContent
            }
        }
        .onChange(of: coordinator.dependencyStatus) { _, newStatus in
            if newStatus.needsWizard {
                if wizardViewModel == nil {
                    createWizardViewModel()
                } else {
                    // Sync existing wizard with updated status (e.g., after re-check)
                    wizardViewModel?.status = newStatus
                }
            } else {
                wizardViewModel = nil
            }
        }
        .onAppear {
            if coordinator.dependencyStatus.needsWizard && wizardViewModel == nil {
                createWizardViewModel()
            }
        }
    }

    // MARK: - Wizard

    private var wizardContent: some View {
        Group {
            if let vm = wizardViewModel {
                DependencyWizardView(viewModel: vm)
            } else {
                ProgressView()
            }
        }
    }

    private func createWizardViewModel() {
        let vm = DependencyWizardViewModel(status: coordinator.dependencyStatus, coordinator: coordinator)
        vm.onComplete = {
            wizardViewModel = nil
        }
        vm.onLimitedMode = {
            // coordinator.acknowledgeLimitedMode() already called by VM
            // needsWizard → false triggers onChange cleanup (avoids single-frame flash)
        }
        wizardViewModel = vm
    }

    // MARK: - Welcome Content

    private var welcomeContent: some View {
        VStack(spacing: StorySpacing.xl) {
            // Header
            VStack(spacing: StorySpacing.sm) {
                Image(systemName: "hammer.circle")
                    .font(.system(size: 48))
                    .foregroundStyle(StoryTheme.accent)
                Text("claudestory")
                    .fabricTitle()
                Text("Agentic development framework")
                    .fabricCaption()
            }

            // Open project button
            Button("Open Project...") {
                Task { await openProject() }
            }
            .controlSize(.large)

            // Recent projects
            if !coordinator.bookmarkStore.recents.isEmpty {
                VStack(alignment: .leading, spacing: StorySpacing.xs) {
                    Text("Recent Projects")
                        .fabricCaption()
                        .padding(.horizontal, StorySpacing.sm)

                    ForEach(coordinator.bookmarkStore.recents.prefix(10)) { recent in
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
                    }
                }
                .frame(maxWidth: 350)
            }
        }
        .padding(StorySpacing.xl)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .fabricSurface(StoryTheme.base)
        .toolbarBackground(StoryTheme.base, for: .windowToolbar)
        .toolbarBackgroundVisibility(.visible, for: .windowToolbar)
    }

    // MARK: - Actions

    private func openProject() async {
        guard let canonical = await coordinator.openProjectFromPicker() else { return }
        openWindow(id: "project", value: canonical)
        dismissWindow(id: "welcome")
    }

    private func openRecent(_ recent: ProjectBookmarkStore.RecentProject) {
        coordinator.registerOpening(
            url: URL(fileURLWithPath: recent.canonicalPath),
            displayName: recent.displayName
        )
        openWindow(id: "project", value: recent.canonicalPath)
        dismissWindow(id: "welcome")
    }
}
