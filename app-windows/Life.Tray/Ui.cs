using Life.Core;
using Microsoft.UI.Text;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using Microsoft.UI.Xaml.Shapes;
using Windows.UI.Text;

namespace Life.Tray;

/// The brand's pieces (Brand.xaml) as the tray draws them, after the Mac's Brand.swift, Pill.swift and CardTile.swift.
static class Ui
{
    static object R(string key) => Application.Current.Resources[key];

    public static Brush Brush(string key) => (Brush)R(key);
    public static Brush Color(Tone tone) => Brush($"Tone{tone}");
    public static FontFamily Serif => (FontFamily)R("Serif");
    public static FontFamily Mono => (FontFamily)R("Mono");
    public static CornerRadius Control => (CornerRadius)R("ControlRadius");
    public static CornerRadius Panel => (CornerRadius)R("PanelRadius");

    public static TextBlock Text(string text, double size = 13, bool mono = false, bool bold = false, string brush = "Ink") => new()
    {
        Text = text,
        FontFamily = mono ? Mono : Serif,
        FontSize = size,
        FontWeight = bold ? FontWeights.SemiBold : FontWeights.Normal,
        Foreground = Brush(brush),
        TextTrimming = TextTrimming.CharacterEllipsis,
        IsTextSelectionEnabled = mono,
    };

    public static TextBlock Muted(string text, double size = 12.5, bool mono = false) => Text(text, size, mono, brush: "Muted");

    public static TextBlock Label(string text) => new() { Text = text.ToUpperInvariant(), Style = (Style)R("Label") };

    public static TextBlock Caption(string text) => new() { Text = text, Style = (Style)R("Caption") };

    public static Ellipse Dot(Tone tone, double size = 8) => new() { Width = size, Height = size, Fill = Color(tone) };

    /// A status: a dot in its colour, the word beside it in mono, in ink.
    public static StackPanel Pill(Tone tone, string word) => Row(6, Dot(tone), Text(word, 11, mono: true));

    public static StackPanel Row(double spacing, params UIElement[] children)
    {
        var row = new StackPanel { Orientation = Orientation.Horizontal, Spacing = spacing, VerticalAlignment = VerticalAlignment.Center };
        foreach (var c in children) row.Children.Add(c);
        return row;
    }

    public static StackPanel Column(double spacing, params UIElement?[] children)
    {
        var col = new StackPanel { Spacing = spacing };
        foreach (var c in children) if (c is not null) col.Children.Add(c);
        return col;
    }

    /// Two ends of a line: the left fills, the right keeps its size.
    public static Grid Ends(FrameworkElement left, FrameworkElement right)
    {
        var g = new Grid { ColumnSpacing = 8 };
        g.ColumnDefinitions.Add(new() { Width = new GridLength(1, GridUnitType.Star) });
        g.ColumnDefinitions.Add(new() { Width = GridLength.Auto });
        Grid.SetColumn(right, 1);
        g.Children.Add(left);
        g.Children.Add(right);
        return g;
    }

    public static Button Button(string text, Action click, bool primary = false)
    {
        var b = new Button
        {
            Content = Text(text, 13.5, bold: true, brush: primary ? "Page" : "Ink"),
            Background = Brush(primary ? "Ink" : "Surface"),
            CornerRadius = Control,
            HorizontalAlignment = HorizontalAlignment.Stretch,
            Padding = new Thickness(12, 8, 12, 8),
        };
        b.Click += (_, _) => click();
        return b;
    }

    /// A card on the plate: its name and state, its headline, when it happened, a running sweep's stations; in trouble,
    /// a short stripe in its colour.
    public static UIElement Tile(Card card, bool trouble, DateTimeOffset now, Action open)
    {
        var body = Column(6,
            Ends(Text(card.Name, 14, bold: true), Pill(card.Tone, card.Word)),
            PlateView.Headline(card) is { } h ? Muted(h) : null,
            card.At is { } at ? Muted(PlateView.Ago(at, now), 10.5, mono: true) : null,
            card.Stations is { Count: > 0 } s ? Stations(s) : null);
        var grid = new Grid();
        grid.Children.Add(body);
        if (trouble)
        {
            grid.Children.Add(new Rectangle
            {
                Width = 3, RadiusX = 1.5, RadiusY = 1.5, Fill = Color(card.Tone),
                HorizontalAlignment = HorizontalAlignment.Left, Margin = new Thickness(-12, 2, 0, 2),
            });
        }
        var b = new Button
        {
            Content = grid,
            Background = Brush("Page"),
            BorderBrush = Brush("Rule"),
            BorderThickness = new Thickness(1),
            CornerRadius = Control,
            Padding = new Thickness(12, 11, 12, 11),
            HorizontalAlignment = HorizontalAlignment.Stretch,
            HorizontalContentAlignment = HorizontalAlignment.Stretch,
        };
        b.Click += (_, _) => open();
        return b;
    }

    static Grid Stations(IReadOnlyList<Station> stations)
    {
        var g = new Grid { ColumnSpacing = 3 };
        for (var i = 0; i < stations.Count; i++)
        {
            g.ColumnDefinitions.Add(new() { Width = new GridLength(1, GridUnitType.Star) });
            var bar = new Rectangle
            {
                Height = 3, RadiusX = 1.5, RadiusY = 1.5,
                Fill = PlateView.StationTone(stations[i]) is { } t ? Color(t) : Brush("Rule"),
            };
            Grid.SetColumn(bar, i);
            g.Children.Add(bar);
        }
        return g;
    }

    /// The last 24 hours: runs as bars, emails and failures as marks, sleeps as a muted band, now at the right edge.
    public static UIElement Day(Plate plate, double height)
    {
        var canvas = new Canvas { Height = height, Background = Brush("Surface") };
        var border = new Border { Child = canvas, CornerRadius = Control, Height = height };
        void Draw()
        {
            canvas.Children.Clear();
            var w = canvas.ActualWidth;
            foreach (var bar in PlateView.Day(plate.Today, plate.ObservedAt))
            {
                var (mw, mh, fill) = bar.Mark switch
                {
                    PlateView.Mark.Sleep => (Math.Max(2, bar.Width * w), height, Brush("Rule")),
                    PlateView.Mark.Run => (Math.Max(3, bar.Width * w), height * 0.36, Color(bar.Tone)),
                    _ => (2.0, height * 0.64, Color(bar.Tone)),
                };
                var r = new Rectangle { Width = mw, Height = mh, Fill = fill, RadiusX = bar.Mark == PlateView.Mark.Run ? 3 : 0, RadiusY = bar.Mark == PlateView.Mark.Run ? 3 : 0 };
                Canvas.SetLeft(r, bar.X * w);
                Canvas.SetTop(r, (height - mh) / 2);
                canvas.Children.Add(r);
            }
            var nowLine = new Rectangle { Width = 2, Height = height, Fill = Brush("Ink") };
            Canvas.SetLeft(nowLine, Math.Max(0, w - 2));
            canvas.Children.Add(nowLine);
        }
        canvas.SizeChanged += (_, _) => Draw();
        return border;
    }
}
