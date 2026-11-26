import SwiftUI

/// A sign-in's field (`NetworkSignInSheet`): what he types into a network's own login. The one field that is never a
/// `DictationField`: dictation sends his sound to the Mac, and a password or code must go nowhere but its step. The
/// phone's autofill fills it by its content type; its text lives in the sheet's memory only.
struct CredentialField: View {
    let label: String
    /// The bridge's field type (`email`, `password`, `phone_number`, `2fa_code`, `username`, …).
    let kind: String?
    @Binding var text: String

    var body: some View {
        Group {
            if kind == "password" {
                SecureField(label, text: $text)
            } else {
                TextField(label, text: $text).keyboardType(keyboard)
            }
        }
        .textContentType(contentType)
        .textInputAutocapitalization(.never).autocorrectionDisabled()
        .font(.body15).foregroundStyle(Palette.fg)
        .padding(.horizontal, Metrics.Spacing.l + Metrics.Spacing.xs)
        .frame(minHeight: 48)
        .background(Palette.tile, in: .capsule)
    }

    private var contentType: UITextContentType? {
        switch kind {
        case "email": .emailAddress
        case "password": .password
        case "phone_number": .telephoneNumber
        case "2fa_code", "token": .oneTimeCode
        case "username": .username
        default: nil
        }
    }

    private var keyboard: UIKeyboardType {
        switch kind {
        case "email": .emailAddress
        case "phone_number": .phonePad
        case "2fa_code": .numberPad
        default: .default
        }
    }
}
