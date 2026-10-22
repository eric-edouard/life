using Life.Core;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Windows.ApplicationModel.DataTransfer;

namespace Life.Tray;

/// Life's status (StatusWindow.swift, OpenCard.swift): the parts flowing left to right as data does, the machine along
/// the bottom, the last 24 hours above; a card opens over the plate with its facts, his words when shown, the sentence
/// for Claude, its history and its log, each paging back. The plate is read every 3 s while the window is open.
sealed class StatusWindow : Window
{
    readonly Supervisor supervisor;
    readonly Grid root = new();
    readonly HashSet<string> unfolded = [];
    readonly DispatcherTimer timer = new() { Interval = TimeSpan.FromSeconds(3) };
    Plate? plate;
    Card? opened;
    bool showContent = true;
    (List<Entry> History, List<string> Log, Next Next)? detail;

    public StatusWindow(Supervisor supervisor)
    {
        this.supervisor = supervisor;
        Title = "Life";
        root.Background = Ui.Brush("Page");
        Content = root;
        AppWindow.Resize(new(1200, 820));
        timer.Tick += async (_, _) => await Read();
        timer.Start();
        Closed += (_, _) => timer.Stop();
        _ = Read();
    }

    async Task Read()
    {
        var read = supervisor.Reads is { } reads ? await reads.Plate() : null;
        // Drawn again only when it says something new, so scrolling, a selection and "Copied" stay.
        if (PlateView.Same(read, plate)) return;
        plate = read;
        Draw();
    }

    void Draw()
    {
        root.Children.Clear();
        if (plate is null)
        {
            root.Children.Add(Center(Ui.Muted("Not answering", 18)));
            return;
        }
        root.Children.Add(Overview(plate));
        if (opened is { } card)
        {
            root.Children.Add(new Grid { Background = Ui.Brush("Page"), Opacity = 0.65 });
            root.Children.Add(Center(Open(plate.Cards.FirstOrDefault(c => c.Id == card.Id) ?? card)));
        }
    }

    static Border Center(UIElement e) => new()
    {
        Child = e, HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Center,
    };

    UIElement Overview(Plate p)
    {
        var show = new CheckBox { Content = Ui.Muted("Show content"), IsChecked = showContent };
        show.Click += (_, _) =>
        {
            showContent = show.IsChecked == true;
            Draw();
        };
        var top = Ui.Row(14);
        if (PlateView.Troubled(p).Count > 0)
        {
            var (tone, word) = PlateView.Header(p);
            top.Children.Add(Ui.Pill(tone, word));
        }
        top.Children.Add(show);
        top.Children.Add(Ui.Pill(Tone.Ok, p.ObservedAt.ToLocalTime().ToString("T")));
        top.HorizontalAlignment = HorizontalAlignment.Right;

        var columns = new Grid { ColumnSpacing = 22 };
        foreach (var column in PlateView.Columns(p, unfolded))
        {
            columns.ColumnDefinitions.Add(new() { Width = new GridLength(1, GridUnitType.Star) });
            var col = Ui.Column(8, Ui.Ends(Ui.Label(column.Group.Name), Ui.Muted(column.Cards.Count + column.Folded + "", 10.5, mono: true)));
            foreach (var card in column.Cards)
                col.Children.Add(Ui.Tile(card, p.Trouble.Contains(card.Id), p.ObservedAt, () => OpenCard(card)));
            var open = unfolded.Contains(column.Group.Id);
            if (column.Folded > 0 || open && column.Cards.Count > PlateView.Shown)
            {
                var more = new HyperlinkButton { Content = Ui.Muted(open ? "Fewer" : $"+{column.Folded}", 11, mono: true) };
                more.Click += (_, _) =>
                {
                    if (!unfolded.Remove(column.Group.Id)) unfolded.Add(column.Group.Id);
                    Draw();
                };
                col.Children.Add(more);
            }
            Grid.SetColumn(col, columns.ColumnDefinitions.Count - 1);
            columns.Children.Add(col);
        }

        var machine = Ui.Row(22, Ui.Label(p.Groups.FirstOrDefault(g => g.Id == "mac")?.Name ?? "The Mac"));
        foreach (var card in PlateView.Machine(p))
        {
            var b = new HyperlinkButton { Content = Ui.Row(6, Ui.Dot(card.Tone, 7), Ui.Text(card.Name, 12.5), Ui.Muted(card.Word)) };
            b.Click += (_, _) => OpenCard(card);
            machine.Children.Add(b);
        }

        var page = new Grid { Padding = new Thickness(44, 12, 44, 22), RowSpacing = 18 };
        foreach (var h in new[] { GridLength.Auto, GridLength.Auto, GridLength.Auto, new GridLength(1, GridUnitType.Star), GridLength.Auto })
            page.RowDefinitions.Add(new() { Height = h });
        UIElement[] rows =
        [
            top,
            Ui.Column(10, Ui.Label(p.ObservedAt.ToLocalTime().ToString("dddd d MMMM")), Ui.Text("Life", 40, bold: true)),
            Ui.Day(p, 44),
            new ScrollViewer { Content = columns },
            new Border { Child = machine, BorderBrush = Ui.Brush("Rule"), BorderThickness = new Thickness(0, 1, 0, 0), Padding = new Thickness(0, 14, 0, 0) },
        ];
        for (var i = 0; i < rows.Length; i++)
        {
            Grid.SetRow((FrameworkElement)rows[i], i);
            page.Children.Add(rows[i]);
        }
        return page;
    }

    async void OpenCard(Card card)
    {
        opened = card;
        detail = null;
        Draw();
        if (supervisor.Reads is { } reads && await reads.Detail(card.Id) is { } d && opened?.Id == card.Id)
        {
            detail = ([.. d.History], [.. d.Log], d.Next);
            Draw();
        }
    }

    /// The next page of one list, back through the whole log.
    async void More(string id, string before, bool history)
    {
        if (detail is not { } now || supervisor.Reads is not { } reads || await reads.Detail(id, before) is not { } d) return;
        if (history) now.History.AddRange(d.History);
        else now.Log.AddRange(d.Log);
        detail = (now.History, now.Log, history ? now.Next with { History = d.Next.History } : now.Next with { Log = d.Next.Log });
        Draw();
    }

    UIElement Open(Card card)
    {
        var close = new Button { Content = Ui.Text("Close", 12) };
        close.Click += (_, _) =>
        {
            opened = null;
            Draw();
        };
        var facts = new VariableSizedWrapGrid { Orientation = Orientation.Horizontal, ItemWidth = 160, ItemHeight = 62 };
        foreach (var f in card.Facts)
        {
            facts.Children.Add(new Border
            {
                BorderBrush = Ui.Brush("Rule"), BorderThickness = new Thickness(0, 1, 0, 0), Padding = new Thickness(0, 9, 12, 0),
                Child = Ui.Column(3, Ui.Text(PlateView.FactValue(f, plate!.ObservedAt), 17, mono: true), Ui.Muted(f.Label, 12)),
            });
        }
        var body = Ui.Column(22,
            Ui.Ends(Ui.Column(6, Ui.Label(plate!.Groups.FirstOrDefault(g => g.Id == card.Group)?.Name ?? card.Group), Ui.Text(card.Name, 36, bold: true), Ui.Muted(card.Headline, 15)),
                Ui.Row(10, Ui.Pill(card.Tone, card.Word), close)),
            facts,
            showContent && card.Content is { Count: > 0 } lines ? Box(Ui.Column(6, [.. lines.Select(l => Selectable(l, 14))])) : null,
            showContent && card.Ask is { } ask ? Ask(ask) : null,
            Ui.Column(8, Ui.Label("History"), History(card.Id)),
            Ui.Column(8, Ui.Label("Log"), Log(card.Id)));
        return new Border
        {
            Width = 720, MaxHeight = 700, Background = Ui.Brush("Page"), CornerRadius = Ui.Panel,
            BorderBrush = Ui.Brush("Rule"), BorderThickness = new Thickness(1),
            Child = new ScrollViewer { Content = body, Padding = new Thickness(34, 30, 34, 30) },
        };
    }

    static TextBlock Selectable(string text, double size, bool mono = false)
    {
        var t = Ui.Text(text, size, mono);
        t.IsTextSelectionEnabled = true;
        t.TextWrapping = TextWrapping.Wrap;
        return t;
    }

    static Border Box(UIElement e) => new() { Child = e, Padding = new Thickness(12), Background = Ui.Brush("Surface"), CornerRadius = Ui.Control };

    static Border Ask(string ask)
    {
        var copy = new Button { Content = Ui.Text("Copy", 12) };
        copy.Click += (_, _) =>
        {
            var data = new DataPackage();
            data.SetText(ask);
            Clipboard.SetContent(data);
            copy.Content = Ui.Text("Copied", 12);
        };
        return Box(Ui.Column(8, Ui.Label("For Claude"), Selectable(ask, 14), copy));
    }

    UIElement History(string id)
    {
        if (detail is not { } d) return Ui.Muted("Reading…", 13);
        if (d.History.Count == 0) return Ui.Muted("Nothing in 7 days", 13);
        var list = Ui.Column(0);
        foreach (var e in d.History)
        {
            list.Children.Add(new Border
            {
                BorderBrush = Ui.Brush("Rule"), BorderThickness = new Thickness(0, 1, 0, 0), Padding = new Thickness(0, 10, 0, 10),
                Child = Ui.Column(4,
                    Ui.Ends(Ui.Row(12, Ui.Dot(e.Tone, 7), Ui.Text(e.Title, 14, bold: true)),
                        Ui.Row(10, Ui.Muted(e.Sub ?? "", 11, mono: true), Ui.Muted(e.At is { } at ? PlateView.Ago(at, plate!.ObservedAt) : "", 11, mono: true))),
                    showContent && e.Content is { } c ? Selectable(c, 12.5) : null),
            });
        }
        if (d.Next.History is { } before) list.Children.Add(OlderButton(() => More(id, before, history: true)));
        return list;
    }

    UIElement Log(string id)
    {
        if (!showContent) return Ui.Muted("Hidden", 13);
        if (detail is not { } d) return Ui.Muted("Reading…", 13);
        if (d.Log.Count == 0) return Ui.Muted("Nothing in 7 days", 13);
        return Ui.Column(10, Box(Selectable(string.Join("\n", d.Log), 11, mono: true)),
            d.Next.Log is { } before ? OlderButton(() => More(id, before, history: false)) : null);
    }

    static Button OlderButton(Action more)
    {
        var b = new Button { Content = Ui.Text("Older", 12) };
        b.Click += (_, _) => more();
        return b;
    }
}
