using System;
using System.Diagnostics;
using System.Drawing;
using System.Threading;
using System.Windows.Forms;

class InstallerForm : Form
{
    private string parentPidStr;
    private string installerPath;
    private string installDir;
    private string appPath;
    private Label statusLabel;
    private System.Windows.Forms.Timer animTimer;
    private int dot;

    public InstallerForm(string[] args)
    {
        parentPidStr = GetArg(args, "--parent-pid");
        installerPath = GetArg(args, "--installer");
        installDir = GetArg(args, "--installdir");
        appPath = GetArg(args, "--app");

        if (installerPath == null || installDir == null || appPath == null)
        {
            MessageBox.Show("Missing required arguments.", "CallerFlash Update", MessageBoxButtons.OK, MessageBoxIcon.Error);
            Environment.Exit(1);
        }

        Text = "CallerFlash Update";
        FormBorderStyle = FormBorderStyle.FixedSingle;
        MaximizeBox = false;
        MinimizeBox = false;
        StartPosition = FormStartPosition.CenterScreen;
        ClientSize = new Size(360, 140);
        BackColor = Color.FromArgb(26, 26, 46);
        ForeColor = Color.White;
        ShowInTaskbar = true;
        TopMost = true;

        Label title = new Label();
        title.Text = "CallerFlash";
        title.Font = new Font("Segoe UI", 18, FontStyle.Bold);
        title.ForeColor = Color.FromArgb(96, 205, 255);
        title.TextAlign = ContentAlignment.MiddleCenter;
        title.Dock = DockStyle.Top;
        title.Height = 50;
        title.Padding = new Padding(0, 16, 0, 0);

        statusLabel = new Label();
        statusLabel.Text = "Installing update\u2026";
        statusLabel.Font = new Font("Segoe UI", 11);
        statusLabel.ForeColor = Color.FromArgb(200, 200, 200);
        statusLabel.TextAlign = ContentAlignment.MiddleCenter;
        statusLabel.Dock = DockStyle.Fill;
        statusLabel.Padding = new Padding(20, 0, 20, 30);

        Controls.Add(statusLabel);
        Controls.Add(title);

        animTimer = new System.Windows.Forms.Timer();
        animTimer.Interval = 400;
        animTimer.Tick += OnAnimTick;
        animTimer.Start();

        this.Shown += OnShown;
    }

    private void OnAnimTick(object sender, EventArgs e)
    {
        dot = (dot + 1) % 4;
        statusLabel.Text = "Installing update" + new string('.', dot);
    }

    private void OnShown(object sender, EventArgs e)
    {
        animTimer.Stop();
        statusLabel.Text = "Installing update...";

        ThreadPool.QueueUserWorkItem(delegate
        {
            DoInstall();

            try
            {
                Process.Start(appPath);
            }
            catch { }

            this.BeginInvoke(new Action(Close));
        });
    }

    private void DoInstall()
    {
        if (parentPidStr != null)
        {
            int pid;
            if (int.TryParse(parentPidStr, out pid))
            {
                try
                {
                    Process p = Process.GetProcessById(pid);
                    p.WaitForExit();
                    Thread.Sleep(1000);
                }
                catch { }
            }
        }

        ProcessStartInfo psi = new ProcessStartInfo();
        psi.FileName = installerPath;
        psi.Arguments = "/S /D=\"" + installDir + "\"";
        psi.UseShellExecute = false;
        psi.CreateNoWindow = true;
        Process proc = Process.Start(psi);
        if (proc != null) proc.WaitForExit();
        Thread.Sleep(500);
    }

    static string GetArg(string[] args, string key)
    {
        for (int i = 0; i < args.Length - 1; i++)
            if (string.Equals(args[i], key, StringComparison.OrdinalIgnoreCase))
                return args[i + 1];
        return null;
    }

    [STAThread]
    static void Main(string[] args)
    {
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        Application.Run(new InstallerForm(args));
    }
}
