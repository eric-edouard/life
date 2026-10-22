using Microsoft.UI.Windowing;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Windows.Graphics;

namespace Life.Tray;

/// The panel over the tray icon: one section per program the tray runs, each reading its own JSON (Life's from its
/// helper and watcher; lifelog's host joins as a section of its own), then the tray's menu. It hides when it loses
/// focus, like a flyout.
sealed class TrayPanel : Window
{
    const int PanelWidth = 380, PanelHeight = 560;
    readonly Sections.LifeSection life;

    public TrayPanel(Supervisor supervisor, Action openStatus, Action openSettings, Action quit)
    {
        life = new Sections.LifeSection(supervisor, openStatus);
        Title = "Life";
        Content = new Grid
        {
            Background = Ui.Brush("Page"),
            Children =
            {
                new ScrollViewer
                {
                    Content = Ui.Column(0, life, Menu(supervisor, openSettings, quit)),
                },
            },
        };
        if (AppWindow.Presenter is OverlappedPresenter p)
        {
            p.IsResizable = false;
            p.IsMaximizable = false;
            p.IsMinimizable = false;
            p.IsAlwaysOnTop = true;
            p.SetBorderAndTitleBar(true, false);
        }
        AppWindow.IsShownInSwitchers = false;
        Activated += (_, e) =>
        {
            if (e.WindowActivationState == WindowActivationState.Deactivated) AppWindow.Hide();
        };
    }

    public void Toggle()
    {
        if (AppWindow.IsVisible)
        {
            AppWindow.Hide();
            return;
        }
        // Above the notification area: the work area's bottom right corner.
        var work = DisplayArea.GetFromWindowId(AppWindow.Id, DisplayAreaFallback.Primary).WorkArea;
        var scale = (Content.XamlRoot?.RasterizationScale) ?? 1;
        var size = new SizeInt32((int)(PanelWidth * scale), (int)(PanelHeight * scale));
        AppWindow.MoveAndResize(new RectInt32(work.X + work.Width - size.Width - 12, work.Y + work.Height - size.Height - 12, size.Width, size.Height));
        Activate();
        _ = life.Refresh();
    }

    static StackPanel Menu(Supervisor supervisor, Action openSettings, Action quit)
    {
        var menu = Ui.Column(2);
        menu.Padding = new Thickness(6);
        menu.BorderBrush = Ui.Brush("Rule");
        menu.BorderThickness = new Thickness(0, 1, 0, 0);
        void Item(string text, Action act)
        {
            var b = new Button
            {
                Content = Ui.Text(text, 14),
                Background = Ui.Brush("Page"),
                BorderThickness = new Thickness(0),
                HorizontalAlignment = HorizontalAlignment.Stretch,
                HorizontalContentAlignment = HorizontalAlignment.Left,
            };
            b.Click += (_, _) => act();
            menu.Children.Add(b);
        }
        Item("Last report", () =>
        {
            if (supervisor.Info?.LastReport is { } report) App.Open(report);
        });
        Item("Settings…", openSettings);
        Item("Quit", quit);
        return menu;
    }
}
