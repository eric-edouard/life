using Life.Core;
using Xunit;

namespace Life.Tests;

public class PlateTests
{
    static string Fixture(string name) => File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "fixtures", name));

    static Plate Snapshot() => Wire.Read<Plate>(Fixture("snapshot.json")) ?? throw new InvalidDataException("snapshot.json");

    static Card Card(string id, string group = "outputs", Tone tone = Tone.Ok) =>
        new(id, group, id, id, tone, id, []);

    static Plate Plate(Card[] cards, string[] trouble, Tone worst = Tone.Warn) =>
        new(cards, [new("sources", "Sources"), new("outputs", "Outputs"), new("mac", "The Mac")],
            DateTimeOffset.Parse("2026-10-21T15:00:00Z"), [], trouble, worst);

    [Fact]
    public void Life_app_answer_decodes_with_its_sources_and_status_reads()
    {
        var info = Wire.Read<Info>(Fixture("app.json"));
        Assert.NotNull(info);
        Assert.True(info.Started);
        Assert.EndsWith("2026-10-21.html", info.LastReport);
        Assert.Equal(new Status("http://127.0.0.1:46201/", "made-up-key"), info.Status);
        Assert.Equal(3, info.Sources.Count);
        Assert.NotNull(info.Sources[0].Missing);
        Assert.False(info.Sources[2].On);
        Assert.False(info.Reminders.On);
    }

    [Fact]
    public void The_watcher_s_snapshot_decodes_every_card_shape_tone_and_fact()
    {
        var p = Snapshot();
        Assert.Equal(["sources", "capture", "pipeline", "memory", "outputs", "mac"], p.Groups.Select(g => g.Id));
        Assert.Equal(Enum.GetValues<Tone>().Order(), p.Cards.Select(c => c.Tone).Distinct().Order());
        Assert.Equal(Tone.Bad, p.Worst);
        var first = p.Cards[0];
        Assert.Equal(["A made-up line."], first.Content);
        Assert.Equal(first.At, first.Facts[0].At);
        Assert.NotNull(p.Cards.Single(c => c.Id == "lifelog").Ask);
        Assert.Equal(["done", "now", "todo"], p.Cards.Single(c => c.Id == "nightly").Stations!.Select(s => s.State));
        Assert.Contains(p.Cards.SelectMany(c => c.Facts), f => f.Value is null && f.At is null);
        Assert.True(p.Today[2].Sleep);
        Assert.Null(p.Today[1].End);
        // The watcher decided the trouble: the tray recounts nothing.
        Assert.Equal(["lifelog", "backup"], PlateView.Troubled(p).Select(c => c.Id));
    }

    [Fact]
    public void A_card_s_detail_decodes_its_history_and_its_next_pages()
    {
        var d = Wire.Read<Detail>(Fixture("card.json"));
        Assert.NotNull(d);
        Assert.Equal([Tone.Ok, Tone.Bad], d.History.Select(e => e.Tone));
        Assert.Equal("memory.nightly/2026-10-21T02-00-00.000Z", d.History[0].Run);
        Assert.Null(d.History[1].At);
        Assert.Equal(["A made-up line."], d.Log);
        Assert.Equal("2026-10-14T00:00:00.000Z", d.Next.History);
        Assert.Null(d.Next.Log);
    }

    [Fact]
    public void The_window_redraws_only_when_the_plate_says_something_new()
    {
        var p = Snapshot();
        Assert.True(PlateView.Same(p, Snapshot() with { ObservedAt = p.ObservedAt.AddSeconds(3) }));
        Assert.False(PlateView.Same(p, Snapshot() with { Trouble = ["lifelog"] }));
        Assert.False(PlateView.Same(null, p));
    }

    [Fact]
    public void An_answer_in_a_shape_the_tray_does_not_know_is_no_answer()
    {
        Assert.Null(Wire.Read<Plate>("not json"));
        Assert.Null(Wire.Read<Plate>("""{"cards":[],"groups":[],"observedAt":"2026-10-21T15:00:00Z","today":[],"trouble":[],"worst":"purple"}"""));
    }

    [Fact]
    public void The_header_says_ok_how_many_to_look_at_or_off()
    {
        Assert.Equal((Tone.Idle, "off"), PlateView.Header(null));
        Assert.Equal((Tone.Ok, "ok"), PlateView.Header(Plate([Card("tasks")], [])));
        Assert.Equal((Tone.Warn, "1 to look at"), PlateView.Header(Plate([Card("backup", tone: Tone.Warn)], ["backup"])));
        Assert.Equal((Tone.Bad, "2 to look at"),
            PlateView.Header(Plate([Card("a", tone: Tone.Bad), Card("b", tone: Tone.Warn)], ["a", "b"], Tone.Bad)));
    }

    [Fact]
    public void The_flyout_lists_trouble_first_then_the_glance_parts_once()
    {
        var p = Plate([Card("tasks"), Card("engine"), Card("backup", tone: Tone.Warn), Card("nightly", tone: Tone.Bad)],
            ["backup", "nightly"]);
        Assert.Equal(["backup", "nightly", "tasks", "engine"], PlateView.Rows(p).Select(c => c.Id));
    }

    [Fact]
    public void A_column_folds_its_quiet_cards_past_five_but_never_one_in_trouble()
    {
        var cards = Enumerable.Range(0, 8).Select(i => Card($"s{i}", "sources")).Append(Card("mac", "mac")).ToArray();
        var p = Plate(cards, ["s7"]);
        var folded = PlateView.Columns(p, new HashSet<string>());
        Assert.Equal(["sources", "outputs"], folded.Select(c => c.Group.Id));
        Assert.Equal(["s0", "s1", "s2", "s3", "s4", "s7"], folded[0].Cards.Select(c => c.Id));
        Assert.Equal(2, folded[0].Folded);
        Assert.Equal(8, PlateView.Columns(p, new HashSet<string> { "sources" })[0].Cards.Count);
        Assert.Equal(["mac"], PlateView.Machine(p).Select(c => c.Id));
    }

    [Fact]
    public void Instants_read_as_the_plate_s_facts_show_them()
    {
        var now = DateTimeOffset.Parse("2026-10-21T15:00:00Z");
        Assert.Equal("3 h ago", PlateView.Ago(now.AddHours(-3), now));
        Assert.Equal("in 2 h", PlateView.Ago(now.AddHours(2.5), now));
        Assert.Equal("12 min ago", PlateView.Ago(now.AddMinutes(-12), now));
        Assert.Equal("2 d ago", PlateView.Ago(now.AddDays(-2), now));
        Assert.Equal("now", PlateView.Ago(now, now));
        Assert.Equal("never", PlateView.FactValue(new Fact("Last ok"), now));
        Assert.Equal("12", PlateView.FactValue(new Fact("Observations", "12"), now));
    }

    [Fact]
    public void The_last_24_hours_place_runs_marks_and_sleeps_and_clip_to_the_strip()
    {
        var now = DateTimeOffset.Parse("2026-10-21T15:00:00Z");
        var bars = PlateView.Day(
        [
            new Tick(now.AddHours(-12), "nightly", Tone.Ok, now.AddHours(-6)),
            new Tick(now.AddHours(-6), "email", Tone.Teal),
            new Tick(now.AddHours(-30), "asleep", Tone.Idle, now.AddHours(-18), Sleep: true),
        ], now);
        Assert.Equal(new PlateView.Bar(PlateView.Mark.Run, 0.5, 0.25, Tone.Ok), bars[0]);
        Assert.Equal(new PlateView.Bar(PlateView.Mark.Instant, 0.75, 0, Tone.Teal), bars[1]);
        Assert.Equal(PlateView.Mark.Sleep, bars[2].Mark);
        Assert.Equal(0, bars[2].X);
        Assert.Equal(0.25, bars[2].Width, 9);
    }

    [Fact]
    public void A_sweep_s_stations_are_green_done_blue_now_and_grey_ahead()
    {
        Assert.Equal(Tone.Ok, PlateView.StationTone(new("repos", "done")));
        Assert.Equal(Tone.Busy, PlateView.StationTone(new("moments", "now")));
        Assert.Null(PlateView.StationTone(new("pages", "todo")));
    }
}
