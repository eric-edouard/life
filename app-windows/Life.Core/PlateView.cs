namespace Life.Core;

/// How the tray lays the plate out, as the Mac's panel and status window do (Panel.swift, StatusWindow.swift,
/// DayStrip.swift). The watcher decides every tone, word and trouble; this only arranges them.
public static class PlateView
{
    /// The parts the flyout shows at a glance, when the plate has them.
    static readonly string[] Glance = ["nightly", "memory", "tasks", "engine"];

    /// A column shows its first cards, those in trouble always; the quiet rest fold away.
    public const int Shown = 5;

    /// The same plate but for when it was read (every read is a new instant): nothing to draw again.
    public static bool Same(Plate? a, Plate? b) =>
        a is not null && b is not null && Wire.Write(a with { ObservedAt = default }) == Wire.Write(b with { ObservedAt = default });

    public static IReadOnlyList<Card> Troubled(Plate p) => [.. p.Cards.Where(c => p.Trouble.Contains(c.Id))];

    /// The header's pill: "ok", or how many parts to look at (red when anything is broken); "off" with no plate.
    public static (Tone Tone, string Word) Header(Plate? p)
    {
        if (p is null) return (Tone.Idle, "off");
        var n = Troubled(p).Count;
        return n == 0 ? (Tone.Ok, "ok") : (p.Worst == Tone.Bad ? Tone.Bad : Tone.Warn, $"{n} to look at");
    }

    /// The flyout's rows: the parts in trouble first, then the ones at a glance.
    public static IReadOnlyList<Card> Rows(Plate p) =>
        [.. Troubled(p), .. Glance.Where(id => !p.Trouble.Contains(id)).SelectMany(id => p.Cards.Where(c => c.Id == id))];

    public sealed record Column(Group Group, IReadOnlyList<Card> Cards, int Folded);

    /// The status window's columns, left to right as data flows; the machine's own cards go along the bottom.
    public static IReadOnlyList<Column> Columns(Plate p, ISet<string> unfolded) =>
    [
        .. p.Groups.Where(g => g.Id != "mac").Select(g =>
        {
            var cards = p.Cards.Where(c => c.Group == g.Id).ToList();
            var visible = unfolded.Contains(g.Id)
                ? cards
                : [.. cards.Where((c, i) => i < Shown || p.Trouble.Contains(c.Id))];
            return new Column(g, visible, cards.Count - visible.Count);
        }),
    ];

    public static IReadOnlyList<Card> Machine(Plate p) => [.. p.Cards.Where(c => c.Group == "mac")];

    /// A card's headline, when it says more than its word.
    public static string? Headline(Card c) => c.Headline == c.Word ? null : c.Headline;

    /// A sweep's station: done in green, the current one in blue, the rest in the rule's grey (null).
    public static Tone? StationTone(Station s) => s.State switch
    {
        "done" => Tone.Ok,
        "now" => Tone.Busy,
        _ => null,
    };

    /// A fact's value, else when it happened, else "never".
    public static string FactValue(Fact f, DateTimeOffset now) => f.Value ?? (f.At is { } at ? Ago(at, now) : "never");

    /// "3 h ago", "in 2 h": an instant as the plate's facts show it.
    public static string Ago(DateTimeOffset at, DateTimeOffset now)
    {
        var d = now - at;
        var span = d.Duration();
        var amount = span.TotalMinutes < 1 ? "now"
            : span.TotalHours < 1 ? $"{(int)span.TotalMinutes} min"
            : span.TotalDays < 1 ? $"{(int)span.TotalHours} h"
            : $"{(int)span.TotalDays} d";
        return amount == "now" ? "now" : d >= TimeSpan.Zero ? $"{amount} ago" : $"in {amount}";
    }

    public enum Mark { Sleep, Run, Instant }

    /// One tick on the last 24 hours: where it starts and how wide it is, as fractions of the strip.
    public sealed record Bar(Mark Mark, double X, double Width, Tone Tone);

    public static IReadOnlyList<Bar> Day(IEnumerable<Tick> ticks, DateTimeOffset now)
    {
        var from = now.AddDays(-1);
        double X(DateTimeOffset at) => Math.Clamp((at - from).TotalDays, 0, 1);
        return
        [
            .. ticks.Select(t => t.Sleep == true ? new Bar(Mark.Sleep, X(t.At), X(t.End ?? now) - X(t.At), t.Tone)
                : t.End is { } end ? new Bar(Mark.Run, X(t.At), X(end) - X(t.At), t.Tone)
                : new Bar(Mark.Instant, X(t.At), 0, t.Tone)),
        ];
    }
}
