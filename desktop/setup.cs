// Gnosis Setup.exe - installs and uninstalls Gnosis for the signed-in owner, no admin rights needed.
//
// Built by `npm run package` (scripts/package.mjs) with the C# compiler that ships with Windows; the
// app folder rides inside it as the payload.zip resource. Install:
//   - stops a running Gnosis (it asks it to quit, as `npm run shortcuts` does);
//   - puts the app in %LOCALAPPDATA%\Programs\Gnosis (Gnosis.exe, his own Node, the app) and keeps
//     his data in %LOCALAPPDATA%\Gnosis\data, which an update never touches;
//   - writes gnosis.ini with the real paths, makes the Start-menu, Desktop and sign-in shortcuts
//     (Gnosis.exe --install), and lists Gnosis in Settings > Apps with an uninstaller;
//   - starts Gnosis.
// Uninstall removes all of that and keeps his data, unless the owner ticks the box to delete it too.
//
// C# 5: no string interpolation, no ?. and no => members.

using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Win32;

namespace GnosisSetup
{
  static class Program
  {
    public const string Name = "Gnosis";
    const string UninstallKey = @"Software\Microsoft\Windows\CurrentVersion\Uninstall\Gnosis";
    public static readonly Color Graphite = Color.FromArgb(0x16, 0x15, 0x14);
    public static readonly Color Ink = Color.FromArgb(0xED, 0xEA, 0xE6);
    public static readonly Color Dim = Color.FromArgb(0xA3, 0x9E, 0x98);
    public static readonly Color Amber = Color.FromArgb(0xEF, 0x9A, 0x4C);

    public static string Local { get { return Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData); } }
    public static string DefaultDir { get { return Path.Combine(Path.Combine(Local, "Programs"), Name); } }
    public static string DataDir { get { return Path.Combine(Path.Combine(Local, Name), "data"); } }

    [STAThread]
    static int Main(string[] args)
    {
      Application.EnableVisualStyles();
      try
      {
        // From Settings > Apps: run the uninstaller from a copy in Temp, so the install folder can go.
        if (Has(args, "--uninstall"))
        {
          var dir = Path.GetDirectoryName(Application.ExecutablePath);
          var copy = Path.Combine(Path.GetTempPath(), "Gnosis Uninstall.exe");
          File.Copy(Application.ExecutablePath, copy, true);
          Process.Start(copy, "--uninstall-from \"" + dir + "\"" + (Has(args, "--quiet") ? " --quiet" : ""));
          return 0;
        }
        var from = Value(args, "--uninstall-from");
        if (from != null) return Uninstaller.Run(from, Has(args, "--quiet"), Has(args, "--delete-data"));

        var options = new Installer.Options();
        options.Dir = Value(args, "--dir") ?? DefaultDir;
        options.Data = Value(args, "--data") ?? DataDir;
        options.ImportData = Value(args, "--import-data");
        options.Shortcuts = !Has(args, "--no-shortcuts");
        options.Startup = !Has(args, "--no-startup");
        options.Register = !Has(args, "--no-register");
        options.Launch = !Has(args, "--no-launch");
        if (Has(args, "--quiet"))
        {
          Installer.Run(options, delegate(string s) { Console.WriteLine(s); });
          return 0;
        }
        Application.Run(new InstallForm(options));
        return 0;
      }
      catch (Exception e)
      {
        if (Has(args, "--quiet")) { Console.Error.WriteLine(e.Message); return 1; }
        MessageBox.Show(e.Message, "Gnosis Setup", MessageBoxButtons.OK, MessageBoxIcon.Error);
        return 1;
      }
    }

    public static bool Has(string[] args, string flag) { return Array.IndexOf(args, flag) >= 0; }

    static string Value(string[] args, string flag)
    {
      var i = Array.IndexOf(args, flag);
      return i >= 0 && i + 1 < args.Length ? args[i + 1] : null;
    }

    public static string Version()
    {
      var lines = ReadResource("version.txt").Split('\n');
      return lines[0].Trim();
    }

    public static int SizeKb()
    {
      var lines = ReadResource("version.txt").Split('\n');
      int kb;
      return lines.Length > 1 && int.TryParse(lines[1].Trim(), out kb) ? kb : 0;
    }

    static string ReadResource(string name)
    {
      using (var s = Assembly.GetExecutingAssembly().GetManifestResourceStream(name))
      using (var r = new StreamReader(s)) return r.ReadToEnd();
    }

    // Asks a running Gnosis to stop (Gnosis.exe's quit signal) and waits for it.
    public static void StopGnosis()
    {
      EventWaitHandle e;
      if (EventWaitHandle.TryOpenExisting(@"Local\Gnosis.Desk.Quit", out e)) { e.Set(); e.Dispose(); }
      for (int i = 0; i < 60 && Process.GetProcessesByName("Gnosis").Length > 0; i++) Thread.Sleep(250);
      if (Process.GetProcessesByName("Gnosis").Length > 0)
        throw new Exception("Gnosis is still running. Choose Quit Gnosis in its tray menu, then try again.");
    }

    public static void Register(string dir)
    {
      using (var k = Registry.CurrentUser.CreateSubKey(UninstallKey))
      {
        k.SetValue("DisplayName", Name);
        k.SetValue("DisplayVersion", Version());
        k.SetValue("Publisher", Name);
        k.SetValue("DisplayIcon", Path.Combine(dir, "ayra.ico"));
        k.SetValue("InstallLocation", dir);
        k.SetValue("UninstallString", "\"" + Path.Combine(dir, "Uninstall Gnosis.exe") + "\" --uninstall");
        k.SetValue("QuietUninstallString", "\"" + Path.Combine(dir, "Uninstall Gnosis.exe") + "\" --uninstall --quiet");
        k.SetValue("EstimatedSize", SizeKb(), RegistryValueKind.DWord);
        k.SetValue("NoModify", 1, RegistryValueKind.DWord);
        k.SetValue("NoRepair", 1, RegistryValueKind.DWord);
      }
    }

    public static void Unregister()
    {
      try { Registry.CurrentUser.DeleteSubKeyTree(UninstallKey, false); } catch { }
    }
  }

  static class Installer
  {
    public class Options
    {
      public string Dir, Data, ImportData;
      public bool Shortcuts = true, Startup = true, Register = true, Launch = true;
    }

    public static void Run(Options o, Action<string> say)
    {
      say("Stopping Gnosis if it's running…");
      Program.StopGnosis();

      say("Copying Gnosis…");
      Directory.CreateDirectory(o.Dir);
      // An update replaces the program files; his data lives elsewhere and is never touched.
      foreach (var sub in new[] { "app", "runtime" })
      {
        var p = Path.Combine(o.Dir, sub);
        if (Directory.Exists(p)) Directory.Delete(p, true);
      }
      using (var s = Assembly.GetExecutingAssembly().GetManifestResourceStream("payload.zip"))
      using (var zip = new ZipArchive(s, ZipArchiveMode.Read))
      {
        foreach (var entry in zip.Entries)
        {
          var target = Path.GetFullPath(Path.Combine(o.Dir, entry.FullName));
          if (!target.StartsWith(Path.GetFullPath(o.Dir), StringComparison.OrdinalIgnoreCase)) continue;
          if (entry.FullName.EndsWith("/") || entry.FullName.EndsWith("\\")) { Directory.CreateDirectory(target); continue; }
          Directory.CreateDirectory(Path.GetDirectoryName(target));
          entry.ExtractToFile(target, true);
        }
      }

      say("Setting up his data folder…");
      Directory.CreateDirectory(o.Data);
      if (o.ImportData != null && Directory.Exists(o.ImportData) && Directory.GetFileSystemEntries(o.Data).Length == 0)
        CopyData(o.ImportData, o.Data);

      var template = Path.Combine(o.Dir, "gnosis.ini.template");
      var ini = File.ReadAllText(template)
        .Replace("{INSTALL}", o.Dir.TrimEnd('\\'))
        .Replace("{DATA}", o.Data.TrimEnd('\\'))
        .Replace("{LOCALAPPDATA}", Program.Local);
      var chrome = FindChrome();
      ini = chrome != null ? ini.Replace("{CHROME}", chrome) : RemoveChrome(ini);
      File.WriteAllText(Path.Combine(o.Dir, "gnosis.ini"), ini);
      File.Delete(template);

      var uninstaller = Path.Combine(o.Dir, "Uninstall Gnosis.exe");
      if (!string.Equals(Path.GetFullPath(Application.ExecutablePath), Path.GetFullPath(uninstaller), StringComparison.OrdinalIgnoreCase))
        File.Copy(Application.ExecutablePath, uninstaller, true);

      var exe = Path.Combine(o.Dir, "Gnosis.exe");
      if (o.Shortcuts)
      {
        say("Adding Gnosis to the Start menu…");
        var p = Process.Start(new ProcessStartInfo(exe, o.Startup ? "--install" : "--install --no-startup") { UseShellExecute = false, CreateNoWindow = true });
        p.WaitForExit(20000);
      }
      if (o.Register) Program.Register(o.Dir);
      if (o.Launch)
      {
        say("Starting Gnosis…");
        Process.Start(new ProcessStartInfo(exe) { UseShellExecute = true, WorkingDirectory = o.Dir });
      }
      say("Gnosis is installed.");
    }

    // His memory, reminders, skills and the rest from an earlier copy; not the logs or window cache.
    static void CopyData(string from, string to)
    {
      foreach (var dir in Directory.GetDirectories(from))
      {
        var name = Path.GetFileName(dir);
        if (name == "logs" || name == "webview2") continue;
        Directory.CreateDirectory(Path.Combine(to, name));
        CopyData(dir, Path.Combine(to, name));
      }
      foreach (var f in Directory.GetFiles(from)) File.Copy(f, Path.Combine(to, Path.GetFileName(f)), true);
    }

    static string FindChrome()
    {
      var candidates = new[]
      {
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), @"Google\Chrome\Application\chrome.exe"),
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), @"Google\Chrome\Application\chrome.exe"),
        Path.Combine(Program.Local, @"Google\Chrome\Application\chrome.exe"),
      };
      foreach (var c in candidates) if (File.Exists(c)) return c;
      return null;
    }

    static string RemoveChrome(string ini)
    {
      var lines = ini.Split(new[] { "\r\n" }, StringSplitOptions.None);
      var kept = new System.Collections.Generic.List<string>();
      foreach (var l in lines) if (!l.StartsWith("chrome=") && !l.StartsWith("chromeArg=")) kept.Add(l);
      return string.Join("\r\n", kept.ToArray());
    }
  }

  static class Uninstaller
  {
    public static int Run(string dir, bool quiet, bool deleteData)
    {
      if (!quiet)
      {
        var ask = new UninstallForm();
        if (ask.ShowDialog() != DialogResult.OK) return 0;
        deleteData = ask.DeleteData;
      }
      Program.StopGnosis();
      var desktop = Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory);
      var programs = Environment.GetFolderPath(Environment.SpecialFolder.Programs);
      var startup = Environment.GetFolderPath(Environment.SpecialFolder.Startup);
      // Only shortcuts that point into this install: a copy run from somewhere else (a code checkout)
      // keeps its own. "Chrome (Gnosis)" points at Chrome, so it goes only beside a Gnosis shortcut
      // of this install.
      foreach (var folder in new[] { desktop, programs })
      {
        if (!Ours(Path.Combine(folder, "Gnosis.lnk"), dir)) continue;
        Remove(Path.Combine(folder, "Gnosis.lnk"));
        Remove(Path.Combine(folder, "Chrome (Gnosis).lnk"));
      }
      if (Ours(Path.Combine(startup, "Gnosis.lnk"), dir)) Remove(Path.Combine(startup, "Gnosis.lnk"));
      Program.Unregister();
      for (int i = 0; i < 10; i++)
      {
        try { if (Directory.Exists(dir)) Directory.Delete(dir, true); break; }
        catch { Thread.Sleep(500); }
      }
      // Only his data folder (memory, reminders, skills, sessions, logs): never his Chrome profile
      // beside it, which holds the owner's sign-ins.
      if (deleteData)
      {
        try { if (Directory.Exists(Program.DataDir)) Directory.Delete(Program.DataDir, true); } catch { }
      }
      if (!quiet) MessageBox.Show("Gnosis has been uninstalled." + (deleteData ? "" : " His memory and skills are kept, for if you install him again."), "Gnosis");
      return 0;
    }

    // A shortcut's target is stored in it as plain text too, so the install folder shows in its bytes.
    static bool Ours(string link, string dir)
    {
      try { return File.Exists(link) && File.ReadAllText(link).IndexOf(dir, StringComparison.OrdinalIgnoreCase) >= 0; }
      catch { return false; }
    }

    static void Remove(string f)
    {
      try { if (File.Exists(f)) File.Delete(f); } catch { }
    }
  }

  // The installer's one window: what it does, a sign-in checkbox, Install, then progress.
  class InstallForm : Form
  {
    readonly Installer.Options options;
    readonly Label status;
    readonly Button go;
    readonly CheckBox startup;

    public InstallForm(Installer.Options options)
    {
      this.options = options;
      Text = "Install Gnosis";
      try { Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch { }
      BackColor = Program.Graphite;
      ForeColor = Program.Ink;
      Font = new Font("Segoe UI", 10f);
      FormBorderStyle = FormBorderStyle.FixedDialog;
      MaximizeBox = false;
      StartPosition = FormStartPosition.CenterScreen;
      ClientSize = new Size(480, 270);

      var title = new Label { Text = "Gnosis", Font = new Font("Segoe UI Semibold", 20f), AutoSize = true, Location = new Point(28, 22) };
      var about = new Label
      {
        Text = "Your assistant on this laptop. Installs for you only, in your user folder; no admin rights needed. " +
          "His memory, reminders and skills are kept in your profile and survive updates.",
        ForeColor = Program.Dim, Location = new Point(30, 70), Size = new Size(420, 60),
      };
      startup = new CheckBox { Text = "Start Gnosis when I sign in", Checked = options.Startup, AutoSize = true, Location = new Point(30, 140) };
      status = new Label { Text = "Version " + Program.Version(), ForeColor = Program.Dim, AutoSize = true, Location = new Point(30, 222) };
      go = new Button
      {
        Text = "Install", Size = new Size(120, 38), Location = new Point(332, 210),
        BackColor = Program.Amber, ForeColor = Program.Graphite, FlatStyle = FlatStyle.Flat,
      };
      go.FlatAppearance.BorderSize = 0;
      go.Click += delegate { Install(); };
      Controls.AddRange(new Control[] { title, about, startup, status, go });
      AcceptButton = go;
    }

    void Install()
    {
      go.Enabled = false;
      startup.Enabled = false;
      options.Startup = startup.Checked;
      var t = new Thread(delegate()
      {
        try
        {
          Installer.Run(options, delegate(string s) { BeginInvoke((Action)delegate { status.Text = s; }); });
          BeginInvoke((Action)delegate { go.Text = "Close"; go.Enabled = true; go.Click += delegate { Close(); }; });
        }
        catch (Exception e)
        {
          BeginInvoke((Action)delegate
          {
            status.Text = "Not installed.";
            MessageBox.Show(this, e.Message, "Gnosis Setup", MessageBoxButtons.OK, MessageBoxIcon.Error);
            go.Enabled = true;
            startup.Enabled = true;
          });
        }
      });
      t.IsBackground = true;
      t.Start();
    }
  }

  class UninstallForm : Form
  {
    readonly CheckBox delete;
    public bool DeleteData { get { return delete.Checked; } }

    public UninstallForm()
    {
      Text = "Uninstall Gnosis";
      BackColor = Program.Graphite;
      ForeColor = Program.Ink;
      Font = new Font("Segoe UI", 10f);
      FormBorderStyle = FormBorderStyle.FixedDialog;
      MaximizeBox = false;
      MinimizeBox = false;
      StartPosition = FormStartPosition.CenterScreen;
      ClientSize = new Size(460, 200);
      var text = new Label { Text = "Remove Gnosis from this laptop?", Font = new Font("Segoe UI Semibold", 13f), AutoSize = true, Location = new Point(26, 22) };
      delete = new CheckBox
      {
        Text = "Also delete his memory, reminders and skills (this can't be undone)", Checked = false,
        Location = new Point(28, 74), Size = new Size(410, 44), ForeColor = Program.Dim,
      };
      var ok = new Button { Text = "Uninstall", DialogResult = DialogResult.OK, Size = new Size(110, 36), Location = new Point(206, 140), BackColor = Program.Amber, ForeColor = Program.Graphite, FlatStyle = FlatStyle.Flat };
      ok.FlatAppearance.BorderSize = 0;
      var cancel = new Button { Text = "Cancel", DialogResult = DialogResult.Cancel, Size = new Size(110, 36), Location = new Point(326, 140), FlatStyle = FlatStyle.Flat, ForeColor = Program.Ink };
      Controls.AddRange(new Control[] { text, delete, ok, cancel });
      AcceptButton = cancel;
      CancelButton = cancel;
    }
  }
}
