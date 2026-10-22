using Life.Core;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;

namespace Life.Tray.Sections;

/// Life's section of the panel (Panel.swift): how Life stands at a glance (the parts in trouble, the night, the memory,
/// the tasks, the engine, the last 24 hours) and its actions. It reads Life's JSON only: the helper's `app` and the
/// watcher's plate.
sealed class LifeSection(Supervisor supervisor, Action openStatus) : UserControl
{
    string? code;

    public async Task Refresh()
    {
        await supervisor.Refresh();
        var plate = supervisor.Reads is { } reads ? await reads.Plate() : null;
        Content = supervisor.Info?.Started == true
            ? Ui.Column(0, Header(plate), plate is null ? Pad(Ui.Muted("Not answering", 14)) : Glance(plate), Actions())
            : Pad(Ui.Text("Not set up", 16, bold: true));
    }

    static Border Pad(UIElement e) => new() { Child = e, Padding = new Thickness(16) };

    static Border Header(Plate? plate)
    {
        var (tone, word) = PlateView.Header(plate);
        return Pad(Ui.Ends(Ui.Text("Life", 22, bold: true), Ui.Pill(tone, word)));
    }

    /// The parts in trouble first, then the ones at a glance, one ruled row each; then the last 24 hours.
    UIElement Glance(Plate plate)
    {
        var rows = Ui.Column(0);
        foreach (var card in PlateView.Rows(plate))
        {
            var row = new Button
            {
                Content = Ui.Ends(
                    Ui.Row(10, Ui.Dot(card.Tone, 7), Ui.Column(1, Ui.Text(card.Name, 14, bold: true),
                        PlateView.Headline(card) is { } h ? Ui.Muted(h) : null)),
                    Ui.Pill(card.Tone, card.Word)),
                Background = Ui.Brush("Page"),
                BorderBrush = Ui.Brush("Rule"),
                BorderThickness = new Thickness(0, rows.Children.Count == 0 ? 0 : 1, 0, 0),
                CornerRadius = new CornerRadius(0),
                Padding = new Thickness(14, 9, 14, 9),
                HorizontalAlignment = HorizontalAlignment.Stretch,
                HorizontalContentAlignment = HorizontalAlignment.Stretch,
            };
            row.Click += (_, _) => openStatus();
            rows.Children.Add(row);
        }
        return Ui.Column(0,
            new Border
            {
                Child = rows, CornerRadius = Ui.Panel, BorderBrush = Ui.Brush("Rule"), BorderThickness = new Thickness(1),
                Margin = new Thickness(12, 0, 12, 0),
            },
            Pad(Ui.Column(8, Ui.Label("24 h"), Ui.Day(plate, 26))));
    }

    UIElement Actions()
    {
        var pair = Ui.Button("Pair an app", async () =>
        {
            code = (await Helper.Run("pair")).Out;
            await Refresh();
        });
        var buttons = new Grid { ColumnSpacing = 8 };
        buttons.ColumnDefinitions.Add(new() { Width = new GridLength(1, GridUnitType.Star) });
        buttons.ColumnDefinitions.Add(new() { Width = new GridLength(1, GridUnitType.Star) });
        Grid.SetColumn(pair, 1);
        buttons.Children.Add(Ui.Button("Status", openStatus, primary: true));
        buttons.Children.Add(pair);
        return new Border
        {
            Padding = new Thickness(16, 0, 16, 14),
            Child = Ui.Column(8, buttons,
                code is null ? null : Ui.Ends(Ui.Text(code, 13, mono: true, bold: true), Ui.Muted("5 min", 11, mono: true))),
        };
    }
}
