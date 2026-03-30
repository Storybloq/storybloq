import SwiftUI

@main
struct Modern_IDEApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @State private var coordinator = AppCoordinator()

    var body: some Scene {
        WindowGroup(id: "project", for: String.self) { $path in
            ProjectSceneView(canonicalPath: $path)
                .environment(coordinator)
        } defaultValue: {
            ""
        }
        .windowStyle(.automatic)
        .windowToolbarStyle(.unifiedCompact)
        .windowResizability(.contentMinSize)
        .defaultSize(width: 1100, height: 750)
        .commands {
            CommandGroup(replacing: .newItem) {
                OpenProjectCommand()
                    .environment(coordinator)
            }
        }

        Window("Welcome", id: "welcome") {
            WelcomeView()
                .environment(coordinator)
                // App-level welcome auto-show: when last project closes,
                // shouldShowWelcome becomes true → open welcome window.
                .onChange(of: coordinator.shouldShowWelcome) { _, shouldShow in
                    if shouldShow {
                        // WelcomeView is already inside the welcome Window scene.
                        // No action needed — the Window is visible when this view exists.
                        // If the window was closed by the user, we'd need openWindow,
                        // but Window scenes can't be closed by the user (no close button).
                    }
                }
        }
        .restorationBehavior(.disabled)
        .defaultSize(width: 500, height: 450)
        .windowResizability(.contentSize)

        Settings {
            SettingsView()
                .environment(coordinator)
        }
    }
}

// MARK: - Open Project Command

/// Cmd+N: opens a directory picker, validates, and opens a new project window.
/// Uses shared openProjectFromPicker() flow on AppCoordinator.
private struct OpenProjectCommand: View {
    @Environment(AppCoordinator.self) private var coordinator
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        Button("Open Project...") {
            Task { await openProject() }
        }
        .keyboardShortcut("n", modifiers: .command)
    }

    private func openProject() async {
        guard let canonical = await coordinator.openProjectFromPicker() else { return }
        openWindow(id: "project", value: canonical)
    }
}
