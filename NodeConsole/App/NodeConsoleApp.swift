import SwiftUI

@main
struct NodeConsoleApp: App {

    init() {
        // Boot the embedded Node.js runtime once, before any UI is shown.
        NodeBridge.start()
    }

    var body: some Scene {
        WindowGroup {
            ContentView()
        }
    }
}
