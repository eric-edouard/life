/// Limitless Pendant BLE wire protocol. Codec only: no I/O. See `docs/pendant.md`.
public enum PendantGATT {
    public static let service = "632DE001-604C-446B-A80F-7963E950F3FB"
    /// Phone → Pendant commands. Write with response.
    public static let control = "632DE002-604C-446B-A80F-7963E950F3FB"
    /// Pendant → phone fragments. Notify.
    public static let data = "632DE003-604C-446B-A80F-7963E950F3FB"
    public static let batteryService = "180F"
    public static let batteryLevel = "2A19"
}
