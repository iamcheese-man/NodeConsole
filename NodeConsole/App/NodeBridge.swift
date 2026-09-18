import Foundation
import nodejs_ios

/// Boots the embedded Node.js runtime (via the `nodejs-ios` / nodejs-mobile
/// framework) and hands it two things on the command line:
///   argv[2] = the app's Documents directory (the only path Node is allowed
///             to touch — enforced on the JS side in main.js)
///   argv[3] = the loopback port the JS side should listen on
///
/// The Swift UI never talks to Node in-process; it talks to a tiny HTTP
/// server that main.js starts on 127.0.0.1. That keeps the bridge dead
/// simple (no custom native module / JSI plumbing needed) and keeps the
/// whole thing off any real network interface.
enum NodeBridge {

    static let port: UInt16 = 8842

    private static var didStart = false
    private static let engineQueue = DispatchQueue(label: "com.example.nodeconsole.node-engine", qos: .userInitiated)

    static var documentsDirectory: URL {
        FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
    }

    static var baseURL: URL {
        URL(string: "http://127.0.0.1:\(port)")!
    }

    static func start() {
        guard !didStart else { return }
        didStart = true

        guard let scriptURL = Bundle.main.url(
            forResource: "main",
            withExtension: "js",
            subdirectory: "nodejs-project"
        ) else {
            fatalError("nodejs-project/main.js not found in app bundle — check the Resources folder reference in Xcode.")
        }

        // Make sure Documents actually exists before Node tries to use it as its jail root.
        try? FileManager.default.createDirectory(at: documentsDirectory, withIntermediateDirectories: true)

        engineQueue.async {
            NodeRunner.startEngine(arguments: [
                "node",
                scriptURL.path,
                documentsDirectory.path,
                String(port),
            ])
        }
    }
}
