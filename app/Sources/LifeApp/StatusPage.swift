import SwiftUI
import WebKit

/// The status page itself, as the watcher serves it on this Mac (`dashboard.ts`), opened with the local key in its
/// cookie: one page for the browser and the app, never a second rendering.
struct StatusPage: NSViewRepresentable {
  let status: Status

  func makeNSView(context: Context) -> WKWebView {
    // Its own store, kept in memory only: the key never lands in a cookie file.
    let config = WKWebViewConfiguration()
    config.websiteDataStore = .nonPersistent()
    let view = WKWebView(frame: .zero, configuration: config)
    guard let url = URL(string: status.url),
      let cookie = HTTPCookie(properties: [
        .domain: url.host ?? "127.0.0.1", .path: "/", .name: "life_local", .value: status.key,
        HTTPCookiePropertyKey("HttpOnly"): "TRUE",
      ])
    else { return view }
    view.configuration.websiteDataStore.httpCookieStore.setCookie(cookie) {
      view.load(URLRequest(url: url))
    }
    return view
  }

  func updateNSView(_ view: WKWebView, context: Context) {}
}
