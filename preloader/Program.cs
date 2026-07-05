using System.Diagnostics;
using System.Runtime.InteropServices;

namespace CallerFlash.Preloader;

static class Program
{
    [STAThread]
    static void Main(string[] args)
    {
        var pid = ParseArg(args, "--parent-pid");
        var installer = ParseArg(args, "--installer");
        var installDir = ParseArg(args, "--installdir");
        var appPath = ParseArg(args, "--app");

        if (installer == null || installDir == null || appPath == null)
        {
            MessageBox.Show("Missing required arguments.", "CallerFlash Update", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return;
        }

        ApplicationConfiguration.Initialize();
        Application.Run(new InstallerForm(pid, installer, installDir, appPath));
    }

    static string? ParseArg(string[] args, string key)
    {
        for (int i = 0; i < args.Length - 1; i++)
            if (args[i].Equals(key, StringComparison.OrdinalIgnoreCase))
                return args[i + 1];
        return null;
    }
}

public class InstallerForm : Form
{
    private readonly string? _parentPidStr;
    private readonly string _installer;
    private readonly string _installDir;
    private readonly string _appPath;
    private Label _statusLabel;
    private System.Windows.Forms.Timer _animationTimer;
    private int _dotCount;

    public InstallerForm(string? parentPidStr, string installer, string installDir, string appPath)
    {
        _parentPidStr = parentPidStr;
        _installer = installer;
        _installDir = installDir;
        _appPath = appPath;

        Text = "CallerFlash Update";
        FormBorderStyle = FormBorderStyle.FixedSingle;
        MaximizeBox = false;
        MinimizeBox = false;
        StartPosition = FormStartPosition.CenterScreen;
        ClientSize = new Size(360, 160);
        BackColor = Color.FromArgb(26, 26, 46);
        ForeColor = Color.White;
        ShowInTaskbar = true;
        TopMost = true;

        var titleLabel = new Label
        {
            Text = "CallerFlash",
            Font = new Font("Segoe UI", 18, FontStyle.Bold),
            ForeColor = Color.FromArgb(96, 205, 255),
            TextAlign = ContentAlignment.MiddleCenter,
            Dock = DockStyle.Top,
            Height = 50,
            Padding = new Padding(0, 16, 0, 0),
        };

        _statusLabel = new Label
        {
            Text = "Installing update\u2026",
            Font = new Font("Segoe UI", 11, FontStyle.Regular),
            ForeColor = Color.FromArgb(200, 200, 200),
            TextAlign = ContentAlignment.MiddleCenter,
            Dock = DockStyle.Fill,
            Padding = new Padding(20, 0, 20, 30),
        };

        Controls.Add(_statusLabel);
        Controls.Add(titleLabel);

        _animationTimer = new System.Windows.Forms.Timer { Interval = 400 };
        _animationTimer.Tick += (_, _) =>
        {
            _dotCount = (_dotCount + 1) % 4;
            _statusLabel.Text = "Installing update" + new string('.', _dotCount);
        };
        _animationTimer.Start();

        Shown += OnShown;
    }

    private async void OnShown(object? sender, EventArgs e)
    {
        await Task.Run(() =>
        {
            // Wait for parent process (the main app) to exit
            if (_parentPidStr != null && int.TryParse(_parentPidStr, out var parentPid))
            {
                try
                {
                    var parent = Process.GetProcessById(parentPid);
                    parent.WaitForExit();
                    Thread.Sleep(1000);
                }
                catch (ArgumentException) { }
            }

            // Run NSIS installer silently
            var psi = new ProcessStartInfo
            {
                FileName = _installer,
                Arguments = $"/S /D=\"{_installDir}\"",
                UseShellExecute = false,
                CreateNoWindow = true,
            };
            var proc = Process.Start(psi);
            proc?.WaitForExit();

            Thread.Sleep(500);
        });

        // Launch the updated app
        try
        {
            Process.Start(new ProcessStartInfo { FileName = _appPath, UseShellExecute = true });
        }
        catch { }

        Close();
    }
}
