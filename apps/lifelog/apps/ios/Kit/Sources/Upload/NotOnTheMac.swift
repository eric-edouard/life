import Capture
import Foundation

/// What is held back from the owner's Mac now: audio still on the Pendant, and audio on this phone that the server has
/// not been sent. "On your Mac, everything up to 14:02", the Replace refusal and its cost line all read this, never
/// `lastCaughtUp`, which only says the Pendant reached the phone.
public struct NotOnTheMac: Sendable, Equatable {
    /// Pages the Pendant still holds that this phone has not saved, from a recent report; `nil` when the Pendant has
    /// not reported lately (out of reach, or never), so what it holds is not known.
    public var pendantPages: UInt64?
    /// What those pages come to, once the app has measured enough audio to say.
    public var pendantDuration: Duration?
    /// Speech saved on this phone that the server does not have yet.
    public var phoneDuration: Duration
    /// The uploader has not said where it stands (no server paired, or before its first pass).
    public var isPhoneUnknown: Bool

    /// Nothing is held back that is known: all of it is on the Mac. Not claimed while either side is unknown.
    public var isEmpty: Bool {
        !isPendantUnknown && !isPhoneUnknown && (pendantPages ?? 0) == 0 && phoneDuration == .zero
    }

    public var isPendantUnknown: Bool { pendantPages == nil }

    /// A report of the Pendant's backlog counts as recent within one connection's silence limit.
    public static let backlogRecentFor = Double(CaptureConfiguration.stallTimeout.components.seconds)
}

/// The phone's side reaches as far as its newest stored audio, analyzed or not (`UploadStatus.storedThrough`): audio
/// saved and not yet analyzed counts as not sent.
public func whatIsNotOnTheMac(backlog: Observed<Backlog>?, uploads: UploadStatus?, now: Date) -> NotOnTheMac {
    let recent = backlog.flatMap { now.timeIntervalSince($0.at) <= NotOnTheMac.backlogRecentFor ? $0.value : nil }
    var phone = uploads?.unsent ?? .zero
    // Sent short of what is stored is audio the server lacks even when the last pass measured none.
    if phone == .zero, let uploads, let sent = uploads.sentThrough,
        let reach = [uploads.heardThrough, uploads.storedThrough].compactMap({ $0 }).max(), sent < reach
    {
        phone = .seconds(reach.timeIntervalSince(sent))
    }
    // Heard but never sent anything is unknown too: the phone cannot say where the Mac's copy reaches.
    let isUnknown = uploads == nil || (uploads?.sentThrough == nil && uploads?.heardThrough != nil)
    return NotOnTheMac(
        pendantPages: recent?.pages, pendantDuration: recent?.estimatedDuration, phoneDuration: phone,
        isPhoneUnknown: isUnknown)
}
