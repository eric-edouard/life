using System.Diagnostics;
using System.Windows.Input;
using H.NotifyIcon;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media.Imaging;
using Microsoft.Windows.AppNotifications;
using Microsoft.Windows.AppNotifications.Builder;

namespace Life.Tray;

/// The tray app: runs Life (`Supervisor`), shows how it stands under its icon, and opens Settings, which is also the
/// first run's setup until the owner's data exists. One per user: a second launch ends at once.
public partial class App : Application
{
    readonly Supervisor supervisor = new();
    Mutex? one;
    TaskbarIcon? tray;
    TrayPanel? panel;
    StatusWindow? status;
    SettingsWindow? settings;

    public App()
    {
        InitializeComponent();
        // A tray app lives on with no window open; Quit ends it.
        DispatcherShutdownMode = DispatcherShutdownMode.OnExplicitShutdown;
    }

    protected override async void OnLaunched(LaunchActivatedEventArgs args)
    {
        one = new Mutex(true, @"Local\Life.Tray", out var first);
        if (!first)
        {
            Exit();
            return;
        }
        AppNotificationManager.Default.NotificationInvoked += (_, e) =>
        {
            if (e.Arguments.TryGetValue("report", out var path)) Open(path);
        };
        AppNotificationManager.Default.Register();
        supervisor.Reported += path => AppNotificationManager.Default.Show(
            new AppNotificationBuilder().AddArgument("report", path).AddText("Life").AddText("A new report").BuildNotification());

        panel = new TrayPanel(supervisor, ShowStatus, ShowSettings, Quit);
        tray = new TaskbarIcon
        {
            ToolTipText = "Life",
            IconSource = new BitmapImage(new Uri("ms-appx:///Assets/Life.ico")),
            NoLeftClickDelay = true,
            LeftClickCommand = new Command(panel.Toggle),
            ContextMenuMode = ContextMenuMode.SecondWindow,
            ContextFlyout = Menu(("Status", ShowStatus), ("Settings…", ShowSettings), ("Quit", Quit)),
        };
        tray.ForceCreate(enablesEfficiencyMode: false);

        await supervisor.Start();
        if (supervisor.Info?.Started == false) ShowSettings();
    }

    static MenuFlyout Menu(params (string Text, Action Do)[] items)
    {
        var menu = new MenuFlyout();
        foreach (var (text, act) in items) menu.Items.Add(new MenuFlyoutItem { Text = text, Command = new Command(act) });
        return menu;
    }

    void ShowStatus()
    {
        if (status is null)
        {
            status = new StatusWindow(supervisor);
            status.Closed += (_, _) => status = null;
        }
        status.Activate();
    }

    void ShowSettings()
    {
        if (settings is null)
        {
            settings = new SettingsWindow(supervisor);
            settings.Closed += (_, _) => settings = null;
        }
        settings.Activate();
    }

    void Quit()
    {
        supervisor.Stop();
        tray?.Dispose();
        AppNotificationManager.Default.Unregister();
        Exit();
    }

    /// A file or a link, in its own app.
    public static void Open(string target) => Process.Start(new ProcessStartInfo(target) { UseShellExecute = true });

    sealed class Command(Action act) : ICommand
    {
        public event EventHandler? CanExecuteChanged { add { } remove { } }
        public bool CanExecute(object? parameter) => true;
        public void Execute(object? parameter) => act();
    }
}
