import Foundation

struct ConsoleLine: Identifiable {
    enum Kind { case input, output, error, system }
    let id = UUID()
    let text: String
    let kind: Kind
}

@MainActor
final class ConsoleViewModel: ObservableObject {

    @Published private(set) var lines: [ConsoleLine] = []
    @Published var input: String = ""
    @Published private(set) var isReady = false
    @Published private(set) var isBusy = false

    private var history: [String] = []
    private var historyCursor: Int = 0
    private let session = URLSession(configuration: .ephemeral)

    init() {
        append("Node.js console — sandboxed to this app's Documents folder.\nWaiting for the runtime to come up…", kind: .system)
        Task { await waitUntilReady() }
    }

    // MARK: - Startup

    private func waitUntilReady() async {
        let healthURL = NodeBridge.baseURL.appendingPathComponent("health")
        for _ in 0..<200 { // ~30s timeout
            if let (data, response) = try? await session.data(from: healthURL),
               let http = response as? HTTPURLResponse, http.statusCode == 200 {
                isReady = true
                if let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                   let version = obj["node"] as? String {
                    append("ready — \(version), jailed to Documents ✅", kind: .system)
                } else {
                    append("ready ✅", kind: .system)
                }
                return
            }
            try? await Task.sleep(nanoseconds: 150_000_000)
        }
        append("Node runtime never came up. Check Xcode's console log for errors.", kind: .error)
    }

    // MARK: - Running commands

    func run() {
        let code = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !code.isEmpty, isReady, !isBusy else { return }

        if code == ".clear" {
            lines.removeAll()
            input = ""
            return
        }

        history.append(code)
        historyCursor = history.count
        append("> " + code, kind: .input)
        input = ""
        isBusy = true

        Task {
            await execute(code)
            isBusy = false
        }
    }

    private func execute(_ code: String) async {
        var request = URLRequest(url: NodeBridge.baseURL.appendingPathComponent("run"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.timeoutInterval = 30
        request.httpBody = try? JSONSerialization.data(withJSONObject: ["code": code])

        do {
            let (data, _) = try await session.data(for: request)
            let obj: [String: Any] = (try? JSONSerialization.jsonObject(with: data) as? [String: Any]) ?? [:]
            if let output = obj["output"] as? String, !output.isEmpty {
                append(output, kind: .output)
            }
            if let error = obj["error"] as? String {
                append(error, kind: .error)
            }
        } catch {
            append("Request to the Node runtime failed: \(error.localizedDescription)", kind: .error)
        }
    }

    func reset() {
        guard isReady else { return }
        Task {
            var request = URLRequest(url: NodeBridge.baseURL.appendingPathComponent("reset"))
            request.httpMethod = "POST"
            _ = try? await session.data(for: request)
            lines.removeAll()
            append("Context reset — all variables cleared.", kind: .system)
        }
    }

    // MARK: - History

    func historyUp() {
        guard !history.isEmpty, historyCursor > 0 else { return }
        historyCursor -= 1
        input = history[historyCursor]
    }

    func historyDown() {
        guard !history.isEmpty else { return }
        if historyCursor < history.count - 1 {
            historyCursor += 1
            input = history[historyCursor]
        } else {
            historyCursor = history.count
            input = ""
        }
    }

    private func append(_ text: String, kind: ConsoleLine.Kind) {
        lines.append(ConsoleLine(text: text, kind: kind))
    }
}
