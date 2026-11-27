# Making the aura smooth (26 Nov 2026)

Research only. Code read: `Lifelog/Edge/EdgeView.swift` on main and in PR #1400 (`~/Work/life-v41-ds`), its one
use in `RootView.swift`, the prototype's edge CSS (`docs/design/2026-11-23-chat-first/2026-11-25-app-v4.html`) and `docs/brand.md`.

## Why it lags

The aura is a `TimelineView(.animation)` that rebuilds, every display frame, on the main thread:

- **10 full-screen shapes per frame**: `layers()` draws 5 `ContainerRelativeShape().strokeBorder(...)`, 3 of them filled
  with an `AngularGradient`, and it is called twice (the 2.5 pt line and the glow), so 6 conic gradients a frame.
- **The gradients are painted by the CPU.** Without `.drawingGroup()`, SwiftUI rasterises a gradient-filled stroke with
  CoreGraphics into a backing store. A `sample` of the harness below shows the main thread's time in
  `argb32_shade_conic_RGB` and `atan2f` (one arctangent per pixel per gradient), not in SwiftUI or in the blur.
- **A full-screen blur of content that changes every frame** (`.blur(radius: glow)`, 6–28 pt in PR #1400): an
  offscreen pass the render server redoes every frame, because its input changed. Then `.opacity(0.7)` on that group.
- **Invisible layers are still drawn**: at rest the blue layers have opacity 0, at work the cream ones; all 10 are
  rasterised anyway.
- **It runs on the main thread**, so anything else there (the thread streaming in, Markdown parsing, a sheet) freezes
  the aura too. A `TimelineView` cannot tick when the main thread is busy.
- **Capped at 60 Hz**: the app's Info.plist has no `CADisableMinimumFrameDurationOnPhone`, so on a ProMotion iPhone the
  aura moves at 60 Hz beside 120 Hz scrolling.
- PR #1400 also dropped `paused: state == .still`, so with no Mac it now redraws 60 times a second to show a still ring.

Not the cause: `RootView` re-evaluating (EdgeView's input is a 4-case enum; the `TimelineView` content is isolated).

## Measured (simulator, so read with care)

A one-file harness (`scratchpad/aura/main.swift`, not committed): PR #1400's `EdgeView` copied verbatim over a
200-line `ScrollView`, Release-style `-O`, iPhone 18 Pro Max simulator, iOS 27.2 (the booted 18 Pro was in use by
another session). A `CADisplayLink` on the main thread counts frames; CPU is the app's own `getrusage`.

| Variant | Main-thread fps | Hitches / 5 s | Worst frame | App CPU |
|---|---|---|---|---|
| No aura | 60 | 0 | 16.7 ms | 0.6 % |
| **Today's EdgeView, working** | **5** | 25 | 219 ms | **95 %** |
| Today's EdgeView, rest | 7.6 | 39 | 139 ms | 92 % |
| Same, plus `.drawingGroup()` | 60 | 0 | 16.7 ms | 10–12 % |
| Core Animation layers (sketch below) | 60 | 0 | 16.7 ms | 0.7–1 % |

What this shows: the per-frame CPU rasterisation of conic gradients is the dominant cost, by far; moving it to the GPU
(`.drawingGroup()`) or off the app entirely (Core Animation) removes it. What it cannot show: the phone's GPU and
thermal behaviour, the render server's real cost of the blur, and true 120 Hz (the simulator runs at 60, and
`xctrace --template 'Animation Hitches'` answers "Hitches is not supported on this platform"). The "busy main thread"
runs (40 ms block every 15 frames) can't separate the aura from the meter itself, since both sit on the main thread;
by construction the Core Animation aura keeps turning through those blocks and the TimelineView one freezes. Confirm
on the phone with `xctrace record --template 'Animation Hitches' --device <phone> --attach lifelog`.

## Options (current practice, iOS 27)

1. **`.drawingGroup()` on the TimelineView's ZStack** — one line, ~10× less CPU in the harness. Still a main-thread
   tick and a per-frame blur; still freezes when the main thread stalls. A stopgap.
2. **Metal shader** (`.colorEffect` / `.layerEffect` on one full-screen rectangle, time from `TimelineView`): draws the
   ring as a signed-distance rounded rectangle with an analytic glow (`exp(-d/glow)`), so no blur pass at all, and the
   knobs are shader arguments. GPU-cheap, but still ticked by the main thread every frame (WWDC26 "Compose advanced
   graphics effects with SwiftUI" uses exactly this TimelineView pattern), so it shares the stall problem.
3. **Core Animation layers** (recommended): the ring's shape never moves; only where the light sits on it turns. So:
   a `CAGradientLayer` of type `.conic`, spun by a `CABasicAnimation` on `transform.rotation.z` with
   `repeatCount = .infinity`, masked by a ring image drawn once, and for the glow, the same ring blurred once (Core
   Image) as the mask. The render server runs the rotation; the app does nothing per frame, the blur never reruns, and
   a busy main thread doesn't touch it. `CAAnimation.preferredFrameRateRange` plus the Info.plist key lets it run at
   120 Hz where wanted, or lower (30–60) to save battery for slow idle lights.
4. MeshGradient / `CAEmitterLayer`: wrong shape for a thin ring; no gain.

## Recommendation: Core Animation, behind the same `EdgeView` API

A `UIViewRepresentable` (`AuraLayerView`) with, per light (two cream lights, the blue arc): one conic gradient layer
spinning forever, under two masks (the 2.5 pt line, the pre-blurred glow). `EdgeView(state:aura:)` keeps its signature;
`updateUIView` maps the knobs:

- **colour, brightness** → the gradient's `colors` (one colour only, as now: `ink(state)`), set inside a
  `CATransaction` with a 1 s duration so a state change cross-fades, as the clock's glide does today.
- **speed** → the spin layer's `speed`, re-anchored so the angle never jumps
  (`timeOffset = convertTime(now, from: nil); beginTime = now; speed = new`). A step in speed, not a 1 s ramp; if the
  ramp matters, animate between two spins' opacities.
- **glow** → which pre-blurred mask is shown; masks are cached per width (a band has few distinct values; render once
  on first use, ~ms each).
- **state cross-fade** → layer `opacity` (rest lights vs working arc), animated 1 s; a layer at opacity 0 is removed
  from rendering with `isHidden` after the fade.
- **still / Reduce Motion / background** → `layer.speed = 0` (the light freezes where it is; no work at all). Core
  Animation already stops when the app is backgrounded.
- **voice light** (the speaking pool) → a `CAGradientLayer(.radial)` whose opacity follows.
- Corner radius: the screen's, as `ContainerRelativeShape` gives today (read it once from the window).

```swift
// One light: spins on the render server, masked by a ring drawn once.
func light(in bounds: CGRect, mask: CGImage, colour: CGColor, period: CFTimeInterval) -> CALayer {
    let holder = CALayer(); holder.frame = bounds
    let side = hypot(bounds.width, bounds.height)
    let spin = CAGradientLayer(); spin.type = .conic
    spin.bounds = CGRect(x: 0, y: 0, width: side, height: side); spin.position = CGPoint(x: bounds.midX, y: bounds.midY)
    spin.startPoint = CGPoint(x: 0.5, y: 0.5); spin.endPoint = CGPoint(x: 0.5, y: 0)
    spin.colors = [UIColor.clear.cgColor, colour, UIColor.clear.cgColor, UIColor.clear.cgColor]
    spin.locations = [0, 0.15, 0.33, 1]
    let turn = CABasicAnimation(keyPath: "transform.rotation.z")
    turn.byValue = 2 * Double.pi; turn.duration = period; turn.repeatCount = .infinity
    turn.preferredFrameRateRange = CAFrameRateRange(minimum: 30, maximum: 120, preferred: 60)
    spin.add(turn, forKey: "turn")
    holder.addSublayer(spin)
    let m = CALayer(); m.frame = bounds; m.contents = mask; holder.mask = m   // mask: the ring, blurred once for the glow
    return holder
}
```

The harness's `AuraLayerView` is a working version of this for one light (about 60 lines).

**Cost to build**: one file replacing `EdgeView`'s body and `EdgeClock` (the clock goes; `AuraSetting` and
`AuraBands` stay as they are), roughly 150 lines, plus `CADisableMinimumFrameDurationOnPhone` in the Info.plist and a
look check against today's frames on the phone. A morning on Sonnet; strict paths aren't touched.

**Expected result**: per-frame app work goes from ~95 % of a core (simulator) to ~0, blur passes from one per frame to
one per glow width ever; the lights keep turning through main-thread stalls, at up to 120 Hz on the phone. Battery:
lower than today, since the app thread no longer wakes each frame; cap idle at 60 Hz (or 30) through
`preferredFrameRateRange` if Instruments' Power Profiler shows the 120 Hz cost matters.

If a one-line fix is wanted first: `.drawingGroup()` on the ZStack inside the `TimelineView`, and restore
`paused: reduceMotion || state == .still`.

## Sources

- [Compose advanced graphics effects with SwiftUI, WWDC26](https://developer.apple.com/videos/play/wwdc2026/322/)
- [Optimizing iPhone and iPad apps to support ProMotion displays](https://developer.apple.com/documentation/quartzcore/optimizing-iphone-and-ipad-apps-to-support-promotion-displays)
- [Explore UI animation hitches and the render loop, Apple tech talk](https://developer.apple.com/videos/play/tech-talks/10855)
- [Hacking with Swift: Metal shaders with layer effects](https://www.hackingwithswift.com/quick-start/swiftui/how-to-add-metal-shaders-to-swiftui-views-using-layer-effects)
- [Developer forums: why a CADisplayLink runs slow without the Info.plist key](https://www.developer.apple.com/forums/thread/792011)
