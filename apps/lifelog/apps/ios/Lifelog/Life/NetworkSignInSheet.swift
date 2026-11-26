import LifeConnector
import SwiftUI
import UniformTypeIdentifiers
import WebKit

/// A fix card's sign-in (`Check.Option.signsIn`): the network, and the card's title the sheet keeps as its own.
struct SignInAsk: Identifiable, Equatable {
    let network: String
    let title: String
    var id: String { network }
}

/// His sign-in to a messaging network, one bridge step at a time (`NetworkSignIn`, Kit): a form, the network's own page
/// in a web view, or a code to enter in its app. One cream button, doing then done or failed in plain words; done reads
/// the asks again (the card leaves) and closes the sheet. What he types or the page gives is held in memory only.
struct NetworkSignInSheet: View {
    let ask: SignInAsk
    @Environment(LifeStore.self) private var life
    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var scenePhase
    @State private var flow: NetworkSignIn?
    /// The form's values, by field id: in memory, sent once.
    @State private var values: [String: String] = [:]

    private var phase: NetworkSignIn.Phase { flow?.phase ?? .starting }

    var body: some View {
        Group {
            if case .step(let step) = phase, let cookies = step.cookies {
                // The network's own page fills the sheet: it scrolls itself. No words above it: the bridge's
                // instructions for a cookie step are for pasting cookies by hand, which the page does for him.
                SignInWebView(step: cookies) { answers in go { await $0.submit(answers) } }
                    .sheetBars(head: head)
            } else {
                content.sheetScroll(head: head) { button }
            }
        }
        .motion(Motion.standard, value: phase)
        .presentationBackground(Palette.sheet)
        .onAppear {
            flow = life.signIn(ask.network)
            go { await $0.start() }
        }
        // Closed, no held wait goes on asking.
        .onDisappear { flow?.stop() }
        .onChange(of: scenePhase) { _, now in go { await $0.setAway(now != .active) } }
        .onChange(of: phase == .done) { _, isDone in
            guard isDone else { return }
            Task {
                await life.refreshItems()
                try? await Task.sleep(for: .seconds(1))
                dismiss()
            }
        }
    }

    private func go(_ step: @escaping (NetworkSignIn) async -> Void) {
        guard let flow else { return }
        Task { await step(flow) }
    }

    private func head() -> some View { SheetHeader(title: ask.title) { dismiss() } }

    @ViewBuilder private var content: some View {
        VStack(alignment: .leading, spacing: Metrics.Spacing.l) {
            switch phase {
            case .step(let step), .sending(let step):
                instructions(step)
                ForEach(step.fields ?? [], id: \.id) { field in
                    CredentialField(
                        label: field.name, kind: field.type,
                        text: Binding(get: { values[field.id] ?? "" }, set: { values[field.id] = $0 })
                    )
                    .disabled(phase != .step(step))
                    if let about = field.description { Text(about).font(.line).foregroundStyle(Palette.muted) }
                }
            case .waiting(let step):
                instructions(step)
                if let display = step.display { shown(display) }
            case .failed(let why):
                Text(why).font(.bodyStrong).foregroundStyle(Palette.flag)
            case .starting, .done:
                EmptyView()
            }
        }
        .padding(.top, Metrics.Spacing.s)
    }

    /// The one cream button: what the step needs, then doing, then done or Try again.
    @ViewBuilder private var button: some View {
        switch phase {
        case .starting:
            Button("Signing in…") {}.buttonStyle(.pill(.filled, isBusy: true))
        case .step(let step):
            let isFilled = (step.fields ?? []).allSatisfy { !(values[$0.id] ?? "").isEmpty }
            Button("Continue") {
                let answers = values
                values = [:]
                go { await $0.submit(answers) }
            }
            .buttonStyle(.pill(.filled)).disabled(!isFilled)
        case .sending:
            Button("Signing in…") {}.buttonStyle(.pill(.filled, isBusy: true))
        case .waiting:
            Button("Waiting for you…") {}.buttonStyle(.pill(.filled, isBusy: true))
        case .done:
            Button("Signed back in") {}.buttonStyle(.pill(.done))
        case .failed:
            Button("Try again") { go { await $0.start() } }.buttonStyle(.pill(.filled))
        }
    }

    @ViewBuilder private func instructions(_ step: SignInStep) -> some View {
        if let words = step.instructions { AskSentence(markdown: words) }
    }

    /// A code to type in the network's app, big, with Copy; a QR; or emoji.
    @ViewBuilder private func shown(_ display: SignInStep.Display) -> some View {
        if let data = display.data {
            VStack(spacing: Metrics.Spacing.m) {
                if display.type == .qr {
                    QRImage(text: data).accessibilityLabel("Sign-in code")
                } else {
                    Text(data).font(.profileName).monospaced().textSelection(.enabled)
                        .foregroundStyle(Palette.fg)
                }
                if display.type == .code {
                    QuietChip("Copy", symbol: "doc.on.doc") {
                        // This phone only, for a few minutes: never to his other devices.
                        UIPasteboard.general.setItems(
                            [[UTType.plainText.identifier: data]],
                            options: [.localOnly: true, .expirationDate: Date.now.addingTimeInterval(300)])
                    }
                }
            }
            .padding(Metrics.Spacing.l).frame(maxWidth: .infinity)
            .background(Palette.tile, in: .rect(cornerRadius: Metrics.Radius.block))
        }
    }
}

/// The network's sign-in page with no stored data (`WKWebsiteDataStore.nonPersistent()`, gone with the sheet). Once its
/// URL matches the step's pattern, its cookies, local storage, the requests it made and `extractJs`'s result are read
/// (`SignInCatch`) until every required field has a value; then `caught` gets them, once. Nothing is logged.
private struct SignInWebView: UIViewRepresentable {
    let step: SignInStep.Cookies
    let caught: ([String: String]) -> Void

    func makeCoordinator() -> Catcher { Catcher(step: step, caught: caught) }

    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        let catcher = context.coordinator
        if step.fields.contains(where: { $0.sources.contains { [.requestHeader, .requestBody].contains($0.type) } }) {
            configuration.userContentController.addUserScript(
                WKUserScript(source: Catcher.requestHook, injectionTime: .atDocumentStart, forMainFrameOnly: false))
            configuration.userContentController.add(catcher, name: Catcher.handler)
        }
        let view = WKWebView(frame: .zero, configuration: configuration)
        view.customUserAgent = step.userAgent
        view.navigationDelegate = catcher
        view.uiDelegate = catcher
        catcher.view = view
        catcher.watch = view.observe(\.url) { _, _ in Task { @MainActor in await catcher.check() } }
        view.load(URLRequest(url: step.url))
        return view
    }

    func updateUIView(_ view: WKWebView, context: Context) {}

    static func dismantleUIView(_ view: WKWebView, coordinator: Catcher) {
        view.configuration.userContentController.removeAllScriptMessageHandlers()
        coordinator.watch = nil
    }

    @MainActor final class Catcher: NSObject, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
        static let handler = "signIn"
        /// Sees every fetch and XHR the page makes: its URL, the headers its script set and a text body.
        static let requestHook = """
            (() => {
              const post = (url, headers, body) => { try { window.webkit.messageHandlers.signIn.postMessage(
                { url: String(url), headers, body: typeof body === 'string' ? body : null }); } catch (e) {} };
              const plain = (h) => { const o = {}; if (!h) return o;
                if (h instanceof Headers) h.forEach((v, k) => { o[k] = v; });
                else if (Array.isArray(h)) h.forEach(([k, v]) => { o[k] = v; }); else Object.assign(o, h); return o; };
              const fetched = window.fetch;
              window.fetch = function (input, init) {
                try { const req = input instanceof Request ? input : null;
                  post(new URL(req ? req.url : input, location.href).href,
                    plain((init && init.headers) || (req && req.headers)), init && init.body); } catch (e) {}
                return fetched.apply(this, arguments);
              };
              const X = XMLHttpRequest.prototype, open = X.open, set = X.setRequestHeader, send = X.send;
              X.open = function (m, u) { this.__u = new URL(u, location.href).href; this.__h = {}; return open.apply(this, arguments); };
              X.setRequestHeader = function (k, v) { if (this.__h) this.__h[k] = v; return set.apply(this, arguments); };
              X.send = function (b) { post(this.__u, this.__h || {}, b); return send.apply(this, arguments); };
            })();
            """

        let step: SignInStep.Cookies
        let caught: ([String: String]) -> Void
        weak var view: WKWebView?
        var watch: NSKeyValueObservation?
        private var found = SignInCatch()
        private var isChecking = false
        private var isDone = false

        init(step: SignInStep.Cookies, caught: @escaping ([String: String]) -> Void) {
            (self.step, self.caught) = (step, caught)
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { Task { await check() } }

        /// A page that opens a window (a "sign in with" pop-up) opens it here, in the same page.
        func webView(
            _ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
            for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures
        ) -> WKWebView? {
            webView.load(navigationAction.request)
            return nil
        }

        func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
            guard let body = message.body as? [String: Any], let url = body["url"] as? String,
                step.fields.contains(where: { $0.sources.contains { SignInCatch.matches(url, $0.requestUrlRegex) } })
            else { return }
            let headers = (body["headers"] as? [String: Any] ?? [:]).mapValues { "\($0)" }
            found.requests.append(.init(url: url, headers: headers, body: body["body"] as? String))
            Task { await check() }
        }

        /// Once the page is where the bridge waits for it, reads what it holds; done when every required field has one.
        func check() async {
            guard !isDone, !isChecking, let view, let url = view.url?.absoluteString,
                SignInCatch.matches(url, step.waitForUrlPattern)
            else { return }
            isChecking = true
            defer { isChecking = false }
            found.cookies = await view.configuration.websiteDataStore.httpCookieStore.allCookies()
                .map { .init(name: $0.name, domain: $0.domain, value: $0.value) }
            let names = step.fields.flatMap(\.sources).filter { $0.type == .localStorage }.map(\.name)
            if !names.isEmpty,
                let stored = try? await view.callAsyncJavaScript(
                    "const o = {}; for (const n of names) { const v = localStorage.getItem(n); if (v !== null) o[n] = v; } return o;",
                    arguments: ["names": names], contentWorld: .page) as? [String: Any]
            {
                found.localStorage = stored.mapValues { "\($0)" }
            }
            if let js = step.extractJs,
                let extracted = try? await view.callAsyncJavaScript(
                    "return await (\(js));", contentWorld: .page) as? [String: Any]
            {
                found.extracted = extracted.mapValues { "\($0)" }
            }
            guard !isDone, let answers = found.answers(for: step) else { return }
            isDone = true
            found = SignInCatch()
            caught(answers)
        }
    }
}
