# Automating a real iPhone through iPhone Mirroring, locally and remotely

Explanation: how an agent on the Mac can drive a real iPhone, what already exists on GitHub, and whether it can work
while the owner and the phone are away from the Mac. Research of 27 and 28 Nov 2026. Nothing is installed yet.

## How the existing tools drive it

```
agent → screenshot of the iPhone Mirroring window → OCR or a vision model finds "Weather" at (400, 468)
      → a low-level mouse event (CGEvent) at (400, 468) → screenshot again to check
```

The iPhone Mirroring window is a video stream. macOS accessibility sees no buttons inside it, so AppleScript
`click` and accessibility-based tools fail silently. Only HID-level events (CGEvent mouse and keys) reach the phone.
Apple offers no automation API for it ([Apple forum](https://developer.apple.com/forums/thread/756714)).

Keyboard shortcuts help: ⌘1 Home Screen, ⌘2 App Switcher, Shift-scroll for horizontal swipes. Notification Center and
Control Center have none, and edge swipes to open them are unreliable
([Apple forum](https://developer.apple.com/forums/thread/838252)).

Generic computer use works only in full-screen mode (screenshots and real clicks, which take the Mac's screen). The
background `app_*` tools rely on the accessibility tree, which this window lacks. The dedicated tools below are better.

## Tools on GitHub

| Tool | How | State on 27 Nov 2026 |
|---|---|---|
| [phone-harness](https://github.com/phone-harness/phone-harness) | CLI and skill for Claude Code and Codex; find text, tap it. Also Android over adb | 6.1k stars, active, MIT |
| [mirroir-mcp](https://github.com/jfarcand/mirroir-mcp) | MCP server, 33 tools; records a flow and replays it with no model call | 430 stars, active |
| [iphone-use](https://mcpservers.org/servers/leeguooooo/iphone-use) | No Mirroring: an XCTest runner on the phone gives the real accessibility tree | 529 stars, active |
| [wda-iphone-use](https://github.com/Qizhan7/wda-iphone-use) | No Mirroring: WebDriverAgent on the phone, reachable over Wi-Fi or Tailscale | 35 stars, active |
| [iphoneclaw](https://github.com/noedgeai/iphoneclaw), [iphone-mirror-mcp](https://mcpservers.org/servers/nickatnight96/iphone-mirror-mcp) | Same idea as mirroir-mcp, smaller | small |
| [iPhoneMirroringInject](https://github.com/Kyle-Ye/iPhoneMirroringInject) | Needs SIP and AMFI off | avoid |

## Why iPhone Mirroring cannot work remotely

Apple's requirements ([Apple](https://support.apple.com/120421)): the iPhone is locked and near the Mac, both have
Bluetooth and Wi-Fi on, and both use the same Apple Account. A session drops when the phone is unlocked or picked up.

The link is Continuity: Bluetooth LE advertisements announce the devices, then a peer-to-peer Wi-Fi link (AWDL) or
the local network carries the stream, found by Bonjour ([USENIX 2021](https://www.usenix.org/system/files/sec21-stute.pdf)).
None of it crosses the internet, and a VPN such as Tailscale does not carry Bonjour or AWDL
([vpncentral](https://vpncentral.com/how-to-fix-iphone-mirroring-not-working-with-vpn/)).

Relaying it is not practical. The proximity check is a radio check: a relay would need a radio box beside the phone
and one beside the Mac, forwarding Bluetooth LE and AWDL frames with tight timing, through encryption keyed to the
Apple Account. That is a relay attack on Apple's proximity check; no public project does it for Mirroring, and any
iOS or macOS update could break it. Even working, the phone would have to stay locked, so the owner could not use it
while the agent does.

## What works remotely

1. Leave a spare iPhone next to the Mac, permanently mirrored, signed in to the apps the agent needs. The agent runs
   on the Mac, so it works from anywhere the Mac is reachable (Tailscale, the Claude app's remote sessions). The
   carried phone stays free. This is the simplest setup and uses phone-harness or mirroir-mcp as they are.
2. Drive the carried phone itself with WebDriverAgent over Tailscale
   ([wda-iphone-use](https://github.com/Qizhan7/wda-iphone-use), with
   [pymobiledevice3](https://github.com/doronz88/pymobiledevice3)'s network tunnel). It works on mobile data, but the
   phone must be unlocked with Auto-Lock off, the runner app's signature expires (7 days on a free developer account,
   a year on a paid one), and iOS may stop the runner in the background. Fragile for a phone in a pocket.
3. A hosted phone ([Phone Harness Cloud](https://phone-harness.com)). Costs money, and it is not the owner's own phone
   or accounts.

Next: try option 1 with phone-harness on a spare iPhone beside the Mac.
