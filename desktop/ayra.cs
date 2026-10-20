// Gnosis on the Windows desktop - Gnosis.exe.
//
// The app itself, and the part of Gnosis that starts with Windows. It
//   - keeps his bridge running in the background, with no console window,
//     and starts it again if it stops;
//   - shows his window (the face, in an Edge WebView2 inside this app) from
//     the tray, the taskbar, the desktop or a hotkey - the hotkey also starts
//     a turn, as Space does in his window;
//   - shows the bubble on the desktop.
//
// His access to the laptop lives in the bridge, not here: this app only
// starts, watches and shows. It opens no port and reads no secrets.
//
// Built by `npm run shortcuts` with the C# compiler that ships with Windows
// (.NET Framework 4), so nothing needs installing. Settings come from ayra.ini
// beside the exe, written by the same script. The compiler is C# 5: no
// string interpolation, no ?. and no => members.

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows.Forms;

namespace Gnosis
{
  static class Program
  {
    // Shared by the exe, its shortcuts and her window, so Windows shows them
    // as one app on the taskbar.
    public const string AppId = "Gnosis.Desk";
    public const string QuitEvent = "Local\\Gnosis.Desk.Quit";
    public const string OpenEvent = "Local\\Gnosis.Desk.Open";

    [STAThread]
    static int Main(string[] args)
    {
      // Before any window: real pixels, so the tray icon is sharp at 125-150%.
      Native.SetProcessDPIAware();
      // Asks the running tray to stop AYRA and close (npm run shortcuts does
      // this with the new build, before it has settings of its own).
      if (Has(args, "--quit")) { Signal(QuitEvent); return 0; }

      Config config;
      try { config = Config.Load(); }
      catch (Exception e) { MessageBox.Show(e.Message, "Gnosis"); return 1; }

      Native.SetCurrentProcessExplicitAppUserModelID(AppId);

      if (Has(args, "--install")) return Shortcuts.Install(config, !Has(args, "--no-startup"));

      bool first;
      using (var mutex = new Mutex(true, "Local\\Gnosis.Desk", out first))
      {
        if (!first)
        {
          // AYRA is already in the tray; a shortcut click only wants her window.
          // The tray opens it, so quick clicks never make two windows.
          if (!Has(args, "--background")) Signal(OpenEvent);
          return 0;
        }
        Application.EnableVisualStyles();
        var tray = new Tray(config, !Has(args, "--background"));
        Application.Run();
        GC.KeepAlive(tray);
        GC.KeepAlive(mutex);
      }
      return 0;
    }

    static bool Has(string[] args, string flag) { return Array.IndexOf(args, flag) >= 0; }

    static void Signal(string name)
    {
      EventWaitHandle e;
      if (EventWaitHandle.TryOpenExisting(name, out e)) { e.Set(); e.Dispose(); }
    }
  }

  // ayra.ini, written by scripts/shortcuts.mjs: key=value, one per line.
  class Config
  {
    public string Exe, Icon, Root, Node, Data, Chrome, FaceUrl, HealthUrl, HearingUrl, TalkUrl, Title, Hotkey, HandsFreeHotkey, TalkHotkey;
    // The bubble on top of every app (AYRA_BUBBLE=off turns it off for good).
    public bool Bubble = true;
    public List<string> ChromeArgs = new List<string>();

    public static Config Load()
    {
      var exe = Application.ExecutablePath;
      var dir = Path.GetDirectoryName(exe);
      var path = Path.Combine(dir, "gnosis.ini");
      if (!File.Exists(path)) throw new Exception("gnosis.ini is missing beside Gnosis.exe. Run `npm run shortcuts` in the Gnosis folder.");
      var c = new Config();
      c.Exe = exe;
      c.Icon = Path.Combine(dir, "ayra.ico");
      c.Hotkey = "ctrl+alt+a";
      c.HandsFreeHotkey = "ctrl+alt+w";
      c.TalkHotkey = "alt+space";
      foreach (var raw in File.ReadAllLines(path, Encoding.UTF8))
      {
        var line = raw.Trim();
        var eq = line.IndexOf('=');
        if (line.Length == 0 || line[0] == '#' || eq < 1) continue;
        var key = line.Substring(0, eq).Trim();
        var value = line.Substring(eq + 1).Trim();
        switch (key)
        {
          case "root": c.Root = value; break;
          case "node": c.Node = value; break;
          case "data": c.Data = value; break;
          case "chrome": c.Chrome = value; break;
          case "chromeArg": c.ChromeArgs.Add(value); break;
          case "face": c.FaceUrl = value; break;
          case "health": c.HealthUrl = value; break;
          case "title": c.Title = value; break;
          case "hotkey": if (value.Length > 0) c.Hotkey = value; break;
          case "handsfree": if (value.Length > 0) c.HandsFreeHotkey = value; break;
          case "talk": if (value.Length > 0) c.TalkHotkey = value; break;
          case "bubble": c.Bubble = value != "off"; break;
        }
      }
      if (c.Root == null || c.Node == null || c.FaceUrl == null || c.HealthUrl == null || c.Title == null)
        throw new Exception("gnosis.ini is incomplete. Run `npm run shortcuts` in the Gnosis folder again.");
      // His data: beside the code in a checkout, in the owner's profile once installed (bridge/paths.mjs).
      if (string.IsNullOrEmpty(c.Data)) c.Data = Path.Combine(c.Root, "data");
      // Push-to-talk or hands-free (bridge/server.mjs /hearing), beside /health.
      c.HearingUrl = c.HealthUrl.Substring(0, c.HealthUrl.LastIndexOf('/')) + "/hearing";
      c.TalkUrl = c.HealthUrl.Substring(0, c.HealthUrl.LastIndexOf('/')) + "/talk";
      return c;
    }
  }

  class Tray
  {
    readonly Config config;
    readonly NotifyIcon icon;
    readonly Bridge bridge;
    readonly Window window;
    readonly HotkeyWindow hotkey;
    // Hands-free (say her name) on or off, from any app.
    readonly HotkeyWindow handsFreeKey;
    // Talk from any app without bringing her window forward: what Space does in it.
    readonly HotkeyWindow talkKey;
    readonly ToolStripMenuItem handsFreeItem;
    // AYRA on top of every app: click to talk (Bubble).
    readonly Bubble bubble;
    readonly ToolStripMenuItem bubbleItem;
    int switching;
    readonly SynchronizationContext ui;
    readonly System.Threading.Timer watch;
    readonly EventWaitHandle quitSignal, openSignal;
    readonly object opening = new object();
    int busy;

    public Tray(Config config, bool openWindow)
    {
      this.config = config;
      var menu = new ContextMenuStrip();
      // Creating the first control installs the WinForms context; capture it so
      // background threads can update the tray safely.
      ui = SynchronizationContext.Current ?? new WindowsFormsSynchronizationContext();
      window = new Window(config, ui);
      bridge = new Bridge(config, Notify);

      menu.Items.Add("Open Gnosis", null, delegate { Open(false); });
      menu.Items.Add("Talk to Gnosis   " + Pretty(config.Hotkey), null, delegate { Open(true); });
      menu.Items.Add("Talk from any app   " + Pretty(config.TalkHotkey), null, delegate { Talk(); });
      handsFreeItem = new ToolStripMenuItem("Hands-free: say Gnosis   " + Pretty(config.HandsFreeHotkey), null, delegate { SwitchHearing(); });
      menu.Items.Add(handsFreeItem);
      if (config.Bubble)
      {
        bubble = new Bubble(config, Talk, SwitchHearing, delegate { Open(false); }, delegate { ShowBubble(false); });
        bubbleItem = new ToolStripMenuItem("Show the bubble", null, delegate { ShowBubble(!bubble.Wanted); });
        bubbleItem.Checked = bubble.Wanted;
        menu.Items.Add(bubbleItem);
      }
      if (config.Chrome != null) menu.Items.Add("Open Chrome (Gnosis)", null, delegate { window.OpenChrome(); });
      menu.Items.Add("Settings", null, delegate { OpenSettings(); });
      menu.Items.Add(new ToolStripSeparator());
      menu.Items.Add("Restart Gnosis", null, delegate { ThreadPool.QueueUserWorkItem(delegate { bridge.Restart(); }); });
      menu.Items.Add("Show log", null, delegate { bridge.ShowLog(); });
      menu.Items.Add(new ToolStripSeparator());
      menu.Items.Add("Quit Gnosis", null, delegate { Quit(); });

      icon = new NotifyIcon();
      icon.Icon = LoadIcon(config.Icon);
      icon.Text = "Gnosis - starting";
      icon.ContextMenuStrip = menu;
      icon.MouseClick += delegate(object s, MouseEventArgs e) { if (e.Button == MouseButtons.Left) Open(false); };
      icon.Visible = true;

      hotkey = new HotkeyWindow(config.Hotkey, delegate { Open(true); });
      if (!hotkey.Valid)
        Notify("AYRA_HOTKEY \"" + config.Hotkey + "\" isn't a key combination Gnosis knows (try ctrl+alt+a), so the hotkey is off.");
      else if (!hotkey.Registered)
        Notify(Pretty(config.Hotkey) + " is already used by another app, so Gnosis's hotkey is off. Set AYRA_HOTKEY and run npm run shortcuts again.");
      handsFreeKey = new HotkeyWindow(config.HandsFreeHotkey, delegate { SwitchHearing(); });
      talkKey = new HotkeyWindow(config.TalkHotkey, delegate { Talk(); });
      if (talkKey.Valid && !talkKey.Registered)
        Notify(Pretty(config.TalkHotkey) + " is already used by another app, so the talk hotkey is off. Set AYRA_TALK_HOTKEY and run npm run shortcuts again.");
      if (handsFreeKey.Valid && !handsFreeKey.Registered)
        Notify(Pretty(config.HandsFreeHotkey) + " is already used by another app, so the hands-free hotkey is off. Set AYRA_HANDSFREE_HOTKEY and run npm run shortcuts again.");

      // Only once the session is really ending: a cancelled shutdown leaves her running.
      Microsoft.Win32.SystemEvents.SessionEnded += delegate { bridge.Stop(); };
      quitSignal = new EventWaitHandle(false, EventResetMode.AutoReset, Program.QuitEvent);
      ThreadPool.RegisterWaitForSingleObject(quitSignal, delegate { ui.Post(delegate { Quit(); }, null); }, null, -1, true);
      openSignal = new EventWaitHandle(false, EventResetMode.AutoReset, Program.OpenEvent);
      ThreadPool.RegisterWaitForSingleObject(openSignal, delegate { Open(false); }, null, -1, false);
      bridge.EnsureRunning();
      watch = new System.Threading.Timer(delegate { Check(); }, null, 3000, 5000);
      if (openWindow) Open(false);
    }

    // Her window, off the UI thread: opening may wait for the bridge to start.
    void Open(bool talk)
    {
      ThreadPool.QueueUserWorkItem(delegate
      {
        // One at a time: a second click while she is still opening would open a second window.
        if (!Monitor.TryEnter(opening)) return;
        try { window.Show(talk); }
        catch (Exception e) { Notify(e.Message); }
        finally { Monitor.Exit(opening); }
      });
    }

    // Space, from any app: she listens (or sends what she heard) and answers out
    // loud, without her window coming forward. Opened first when it is closed.
    void Talk()
    {
      ThreadPool.QueueUserWorkItem(delegate
      {
        if (Hearing.Talk(config) == 409)
        {
          int faces = 0;
          Open(false);
          for (int i = 0; i < 40 && faces == 0; i++) { Thread.Sleep(500); Hearing.Get(config, out faces); }
          if (faces > 0) Hearing.Talk(config);
        }
      });
    }

    // His window, with the Settings screen showing (opened first when it is closed).
    void OpenSettings()
    {
      ThreadPool.QueueUserWorkItem(delegate
      {
        Open(false);
        int faces = 0;
        for (int i = 0; i < 40 && faces == 0; i++) { Thread.Sleep(500); Hearing.Get(config, out faces); }
        if (faces > 0) Hearing.Settings(config);
      });
    }

    // Hands-free on or off, without coming back to her window. The face does the
    // switching (and says so); her window must be open, so it is opened first
    // when it isn't, and the switch waits for it to connect.
    void SwitchHearing()
    {
      ThreadPool.QueueUserWorkItem(delegate
      {
        if (Interlocked.Exchange(ref switching, 1) == 1) return;
        try
        {
          int faces;
          if (Hearing.Get(config, out faces) == null) { Notify("Gnosis isn't running yet."); return; }
          if (faces == 0)
          {
            Open(false);
            for (int i = 0; i < 40 && faces == 0; i++) { Thread.Sleep(500); Hearing.Get(config, out faces); }
            if (faces == 0) { Notify("Hands-free needs her window open. Open Gnosis and try again."); return; }
          }
          var mode = Hearing.Post(config, "toggle");
          if (mode != null) ui.Post(delegate { handsFreeItem.Checked = mode == "hands-free"; }, null);
        }
        finally { Interlocked.Exchange(ref switching, 0); }
      });
    }

    // Every few seconds: is she answering? Start her if nobody is running her.
    void Check()
    {
      if (Interlocked.Exchange(ref busy, 1) == 1) return;
      try
      {
        var healthy = Bridge.Healthy(config, 2000);
        if (!healthy && !bridge.Running && !bridge.Waiting && !bridge.Stopping && !bridge.GaveUp) bridge.Start();
        var text = healthy ? "Gnosis - ready"
          : bridge.GaveUp ? "Gnosis - stopped, see the log"
          : bridge.Running ? "Gnosis - starting" : "Gnosis - not running";
        int faces;
        var hearing = healthy ? Hearing.Get(config, out faces) : null;
        ui.Post(delegate
        {
          if (icon.Visible) icon.Text = hearing == "hands-free" ? "Gnosis - hands-free, say Gnosis" : text;
          handsFreeItem.Checked = hearing == "hands-free";
        }, null);
      }
      finally { Interlocked.Exchange(ref busy, 0); }
    }

    // The bubble on or off (remembered, with where it sits).
    void ShowBubble(bool on)
    {
      if (bubble == null) return;
      bubble.SetWanted(on);
      bubbleItem.Checked = on;
    }

    void Notify(string message)
    {
      ui.Post(delegate { if (icon.Visible) icon.ShowBalloonTip(6000, "Gnosis", message, ToolTipIcon.Info); }, null);
    }

    void Quit()
    {
      watch.Dispose();
      hotkey.Dispose();
      handsFreeKey.Dispose();
      talkKey.Dispose();
      if (bubble != null) bubble.Close();
      icon.Visible = false;
      bridge.Stop();
      icon.Dispose();
      Application.Exit();
    }

    static Icon LoadIcon(string path)
    {
      try { return new Icon(path, SystemInformation.SmallIconSize); }
      catch { return SystemIcons.Application; }
    }

    static string Pretty(string spec)
    {
      var parts = spec.Split('+');
      for (int i = 0; i < parts.Length; i++)
        parts[i] = parts[i].Length <= 1 ? parts[i].ToUpperInvariant() : char.ToUpperInvariant(parts[i][0]) + parts[i].Substring(1);
      return string.Join("+", parts);
    }
  }

  // The bridge process (scripts/start.mjs, which builds the face if needed and
  // runs bridge/server.mjs), with no window, its output in data/logs/console.log.
  class Bridge
  {
    const long MaxLog = 5 * 1024 * 1024;
    readonly Config config;
    readonly Action<string> notify;
    readonly object gate = new object();
    readonly object logLock = new object();
    readonly string logPath;
    Process proc;
    DateTime started;
    int failures;
    int written;
    StreamWriter log;
    volatile bool quitting;
    public volatile bool Stopping;
    public volatile bool Waiting;
    // Set after repeated crashes or when node can't start: she is left off
    // (and nobody is pestered every few seconds) until Restart AYRA.
    public volatile bool GaveUp;

    public Bridge(Config config, Action<string> notify)
    {
      this.config = config;
      this.notify = notify;
      logPath = Path.Combine(config.Data, "logs", "console.log");
    }

    public bool Running { get { lock (gate) return proc != null; } }

    public static bool Healthy(Config c, int timeoutMs)
    {
      try
      {
        var req = (HttpWebRequest)WebRequest.Create(c.HealthUrl);
        req.Timeout = timeoutMs;
        req.Proxy = null;
        using (var res = (HttpWebResponse)req.GetResponse()) return res.StatusCode == HttpStatusCode.OK;
      }
      catch { return false; }
    }

    // A copy started from a console (npm start) is left alone; she is only
    // started here when nothing is answering.
    public void EnsureRunning()
    {
      ThreadPool.QueueUserWorkItem(delegate { if (!Healthy(config, 1500)) Start(); });
    }

    public void Start()
    {
      lock (gate)
      {
        if (proc != null || Stopping || GaveUp || quitting) return;
        OpenLog();
        // --supervised: start.mjs stops when its input closes (see StopProcess).
        var psi = new ProcessStartInfo(config.Node, "scripts\\start.mjs --supervised");
        psi.WorkingDirectory = config.Root;
        psi.EnvironmentVariables["GNOSIS_DATA"] = config.Data;
        psi.UseShellExecute = false;
        psi.CreateNoWindow = true;
        psi.RedirectStandardInput = true;
        psi.RedirectStandardOutput = true;
        psi.RedirectStandardError = true;
        psi.StandardOutputEncoding = Encoding.UTF8;
        psi.StandardErrorEncoding = Encoding.UTF8;
        var p = new Process();
        p.StartInfo = psi;
        p.EnableRaisingEvents = true;
        p.OutputDataReceived += delegate(object s, DataReceivedEventArgs e) { Write(e.Data); };
        p.ErrorDataReceived += delegate(object s, DataReceivedEventArgs e) { Write(e.Data); };
        p.Exited += delegate { Exited(p); };
        try { p.Start(); }
        catch (Exception e)
        {
          Write("--- could not start node (" + config.Node + "): " + e.Message);
          GaveUp = true;
          notify("Gnosis could not start (" + e.Message + "). Run npm run shortcuts in the Gnosis folder, then choose Restart Gnosis.");
          return;
        }
        p.BeginOutputReadLine();
        p.BeginErrorReadLine();
        proc = p;
        started = DateTime.Now;
        Write("--- Gnosis started by Gnosis.exe at " + started.ToString("yyyy-MM-dd HH:mm:ss"));
      }
    }

    void Exited(Process p)
    {
      int wait;
      lock (gate)
      {
        if (p != proc) return;
        proc = null;
        Write("--- Gnosis stopped (exit " + ExitCode(p) + ") at " + DateTime.Now.ToString("HH:mm:ss"));
        if (Stopping) return;
        // Quick repeated crashes back off and then stop, rather than spin.
        failures = (DateTime.Now - started).TotalSeconds < 60 ? failures + 1 : 1;
        if (failures >= 5)
        {
          GaveUp = true;
          notify("Gnosis keeps stopping, so she has been left off. Open the log from the tray menu, then choose Restart Gnosis.");
          return;
        }
        wait = Math.Min(60, 1 << failures);
        Waiting = true;
      }
      ThreadPool.QueueUserWorkItem(delegate
      {
        Thread.Sleep(wait * 1000);
        Waiting = false;
        if (!Stopping && !GaveUp && !Healthy(config, 1500)) Start();
      });
    }

    public void Restart()
    {
      if (quitting) return;
      bool external;
      lock (gate) external = proc == null && Healthy(config, 1500);
      if (external)
      {
        notify("Gnosis was started from a console window. Close that window, and she will start here by herself.");
        return;
      }
      Stopping = true;
      StopProcess();
      lock (gate) { failures = 0; GaveUp = false; }
      Stopping = false;
      Start(); // does nothing if Quit came in meanwhile
    }

    // For good: Quit, sign-out, npm run shortcuts.
    public void Stop()
    {
      quitting = true;
      Stopping = true;
      StopProcess();
    }

    // Closing start.mjs's input asks it to stop, and it stops only its own
    // server — never a Chrome window she opened, which a whole-tree kill would
    // take down with every tab in it. Forced only if it won't go.
    void StopProcess()
    {
      Process p;
      lock (gate) p = proc;
      if (p == null) return;
      try { p.StandardInput.Close(); } catch { }
      if (!WaitExit(p, 8000))
      {
        // start.mjs and the node it started; nothing further down the tree.
        foreach (var pid in Native.ChildrenOf(p.Id, "node.exe")) KillPid(pid);
        try { p.Kill(); } catch { }
        WaitExit(p, 3000);
      }
      lock (gate) if (proc == p) proc = null;
      Write("--- Gnosis stopped by Gnosis.exe at " + DateTime.Now.ToString("HH:mm:ss"));
    }

    static bool WaitExit(Process p, int ms)
    {
      try { return p.WaitForExit(ms); } catch { return true; }
    }

    static void KillPid(int pid)
    {
      try { using (var q = Process.GetProcessById(pid)) q.Kill(); } catch { }
    }

    public void ShowLog()
    {
      if (File.Exists(logPath)) Process.Start("notepad.exe", "\"" + logPath + "\"");
    }

    void OpenLog()
    {
      lock (logLock)
      {
        try
        {
          Directory.CreateDirectory(Path.GetDirectoryName(logPath));
          if (log == null || TooBig()) Reopen();
        }
        catch { log = null; }
      }
    }

    bool TooBig()
    {
      try { return File.Exists(logPath) && new FileInfo(logPath).Length > MaxLog; } catch { return false; }
    }

    // A fresh console.log, the previous one kept as console.old.log. Called
    // with logLock held.
    void Reopen()
    {
      if (log != null) { try { log.Dispose(); } catch { } log = null; }
      if (TooBig())
      {
        var old = Path.Combine(Path.GetDirectoryName(logPath), "console.old.log");
        if (File.Exists(old)) File.Delete(old);
        File.Move(logPath, old);
      }
      log = new StreamWriter(new FileStream(logPath, FileMode.Append, FileAccess.Write, FileShare.ReadWrite | FileShare.Delete), new UTF8Encoding(false));
      log.AutoFlush = true;
    }

    static readonly Regex Ansi = new Regex("\x1b\\[[0-9;]*m");

    void Write(string line)
    {
      if (line == null) return;
      lock (logLock)
      {
        if (log == null) return;
        try
        {
          log.WriteLine(Ansi.Replace(line, ""));
          // One run can last weeks on an always-on laptop, so the size is checked as it goes.
          if (++written % 500 == 0 && log.BaseStream.Length > MaxLog) Reopen();
        }
        catch { }
      }
    }

    static string ExitCode(Process p)
    {
      try { return p.ExitCode.ToString(); } catch { return "?"; }
    }
  }

  // His window: the face in an Edge WebView2 inside this app, so Gnosis is one app with one taskbar
  // icon and needs no Chrome window (the owner, 2026-10-20: "make it into a good windows app").
  // When WebView2 can't start (no runtime), it falls back to a Chrome app window as before.
  class Window
  {
    readonly Config config;
    readonly SynchronizationContext ui;
    FaceForm form;
    volatile IntPtr handle = IntPtr.Zero;
    volatile bool useChrome;
    public Window(Config config, SynchronizationContext ui) { this.config = config; this.ui = ui; }

    public IntPtr Find()
    {
      var h = handle;
      if (h != IntPtr.Zero && Native.IsWindowVisible(h)) return h;
      return useChrome ? FindChrome() : IntPtr.Zero;
    }

    IntPtr FindChrome()
    {
      IntPtr found = IntPtr.Zero;
      Native.EnumWindows(delegate(IntPtr h, IntPtr l)
      {
        if (!Native.IsWindowVisible(h)) return true;
        var cls = new StringBuilder(64);
        Native.GetClassName(h, cls, cls.Capacity);
        if (cls.ToString() != "Chrome_WidgetWin_1") return true;
        var title = new StringBuilder(256);
        Native.GetWindowText(h, title, title.Capacity);
        if (title.ToString() != config.Title) return true;
        found = h;
        return false;
      }, IntPtr.Zero);
      return found;
    }

    // Brings his window forward, opening it if it isn't open. `talk` then presses Space in it, which
    // starts a turn without the wake word. Called off the UI thread: opening may wait for the bridge.
    public void Show(bool talk)
    {
      var h = Find();
      if (h == IntPtr.Zero)
      {
        // The bridge serves his face; when he is still starting, wait for it.
        var ready = false;
        for (int i = 0; i < 120 && !(ready = Bridge.Healthy(config, 1000)); i++) Thread.Sleep(500);
        if (!ready) throw new Exception("Gnosis isn't answering yet, so his window wasn't opened. Try again in a minute, or open the log from the tray menu.");
        if (useChrome) { OpenInChrome(); return; }
        ui.Send(delegate { Open(); }, null);
        for (int i = 0; i < 40 && (h = Find()) == IntPtr.Zero; i++) Thread.Sleep(100);
        if (h == IntPtr.Zero) return;
      }
      ui.Send(delegate
      {
        var f = form;
        if (f != null && !f.IsDisposed && f.WindowState == FormWindowState.Minimized) f.WindowState = FormWindowState.Normal;
      }, null);
      Focus(h);
      if (talk)
      {
        // The hotkey's own keys are still held; Space must arrive alone.
        Native.WaitForModifiersUp(1500);
        if (Native.GetForegroundWindow() == h) Native.Tap(0x20);
      }
    }

    // On the UI thread.
    void Open()
    {
      if (form != null && !form.IsDisposed) { form.Show(); return; }
      var f = new FaceForm(config, delegate(string why)
      {
        // WebView2 didn't start: Chrome from now on.
        useChrome = true;
        handle = IntPtr.Zero;
        ThreadPool.QueueUserWorkItem(delegate { try { OpenInChrome(); } catch { } });
      });
      f.FormClosed += delegate { handle = IntPtr.Zero; form = null; };
      form = f;
      f.Show();
      handle = f.Handle;
    }

    void OpenInChrome()
    {
      if (config.Chrome == null) throw new Exception("His window needs the Microsoft Edge WebView2 Runtime (or Chrome). Install it from Microsoft, then open Gnosis again.");
      var args = new List<string>(config.ChromeArgs);
      args.Add("--app=" + config.FaceUrl);
      args.Add("--window-size=960,720");
      Launch(config.Chrome, args);
      for (int i = 0; i < 80; i++)
      {
        Thread.Sleep(250);
        var h = FindChrome();
        if (h == IntPtr.Zero) continue;
        Group(h);
        Focus(h);
        return;
      }
    }

    public void OpenChrome()
    {
      if (config.Chrome != null) Launch(config.Chrome, config.ChromeArgs);
    }

    static void Launch(string exe, List<string> args)
    {
      var quoted = new List<string>();
      foreach (var a in args) quoted.Add(a.IndexOf(' ') >= 0 ? "\"" + a + "\"" : a);
      // Through the shell: Chrome gets none of this app's handles.
      var psi = new ProcessStartInfo(exe, string.Join(" ", quoted.ToArray()));
      psi.UseShellExecute = true;
      Process.Start(psi);
    }

    static void Focus(IntPtr h)
    {
      if (Native.IsIconic(h)) Native.ShowWindow(h, 9); // SW_RESTORE
      if (Native.SetForegroundWindow(h)) return;
      // Windows hands the focus over only from the app in front, so borrow
      // its input queue for the moment it takes.
      var front = Native.GetForegroundWindow();
      var me = Native.GetCurrentThreadId();
      var them = Native.GetWindowThreadProcessId(front, IntPtr.Zero);
      Native.AttachThreadInput(me, them, true);
      Native.SetForegroundWindow(h);
      Native.BringWindowToTop(h);
      Native.AttachThreadInput(me, them, false);
    }

    // Gives a Chrome window Gnosis's taskbar identity, so it sits under the pinned Gnosis icon and
    // relaunches through Gnosis.exe if pinned itself. (His own window has it already: same process.)
    void Group(IntPtr h)
    {
      IPropertyStore store = null;
      try
      {
        var iid = typeof(IPropertyStore).GUID;
        if (Native.SHGetPropertyStoreForWindow(h, ref iid, out store) != 0 || store == null) return;
        // The relaunch properties must be set before the id.
        Props.Set(store, Props.RelaunchCommand, "\"" + config.Exe + "\"");
        Props.Set(store, Props.RelaunchDisplayName, "Gnosis");
        Props.Set(store, Props.RelaunchIcon, config.Icon);
        Props.Set(store, Props.AppId, Program.AppId);
      }
      catch { }
      finally { if (store != null) Marshal.ReleaseComObject(store); }
    }
  }

  // The window his face lives in: a plain Windows window with the WebView2 filling it, in Gnosis's
  // graphite while the page loads. Only his own face is shown in it; links open in the browser.
  class FaceForm : Form
  {
    static readonly Color Graphite = Color.FromArgb(0x16, 0x15, 0x14);
    readonly Config config;
    readonly Microsoft.Web.WebView2.WinForms.WebView2 view;
    readonly Action<string> failed;
    readonly string origin;

    public FaceForm(Config config, Action<string> failed)
    {
      this.config = config;
      this.failed = failed;
      var u = new Uri(config.FaceUrl);
      origin = u.Scheme + "://" + u.Authority;
      Text = config.Title;
      try { Icon = new Icon(config.Icon, 32, 32); } catch { }
      BackColor = Graphite;
      StartPosition = FormStartPosition.CenterScreen;
      AutoScaleMode = AutoScaleMode.None;
      var scale = Native.Scale();
      ClientSize = new Size((int)(960 * scale), (int)(700 * scale));
      MinimumSize = new Size((int)(420 * scale), (int)(480 * scale));

      view = new Microsoft.Web.WebView2.WinForms.WebView2();
      view.Dock = DockStyle.Fill;
      view.DefaultBackgroundColor = Graphite;
      var props = new Microsoft.Web.WebView2.WinForms.CoreWebView2CreationProperties();
      props.UserDataFolder = Path.Combine(config.Data, "webview2");
      // His voice plays the moment he speaks, as it did in Chrome after the first click.
      props.AdditionalBrowserArguments = "--autoplay-policy=no-user-gesture-required";
      view.CreationProperties = props;
      view.CoreWebView2InitializationCompleted += Ready;
      Controls.Add(view);
      view.Source = new Uri(config.FaceUrl);
    }

    protected override void OnHandleCreated(EventArgs e)
    {
      base.OnHandleCreated(e);
      Native.DarkTitleBar(Handle);
    }

    void Ready(object sender, Microsoft.Web.WebView2.Core.CoreWebView2InitializationCompletedEventArgs e)
    {
      if (!e.IsSuccess)
      {
        var why = e.InitializationException != null ? e.InitializationException.Message : "WebView2 didn't start";
        BeginInvoke((Action)delegate { Close(); failed(why); });
        return;
      }
      var core = view.CoreWebView2;
      core.Settings.IsStatusBarEnabled = false;
      core.Settings.IsZoomControlEnabled = false;
      core.Settings.AreDefaultContextMenusEnabled = false;
      core.Settings.IsPasswordAutosaveEnabled = false;
      core.Settings.IsGeneralAutofillEnabled = false;
      // The microphone (and the camera for look_through_camera) for his own face, without a prompt;
      // anything else, or any other page, is refused.
      core.PermissionRequested += delegate(object s, Microsoft.Web.WebView2.Core.CoreWebView2PermissionRequestedEventArgs p)
      {
        var own = p.Uri.StartsWith(origin, StringComparison.OrdinalIgnoreCase);
        var kind = p.PermissionKind;
        var wanted = kind == Microsoft.Web.WebView2.Core.CoreWebView2PermissionKind.Microphone
          || kind == Microsoft.Web.WebView2.Core.CoreWebView2PermissionKind.Camera
          || kind == Microsoft.Web.WebView2.Core.CoreWebView2PermissionKind.Notifications;
        p.State = own && wanted ? Microsoft.Web.WebView2.Core.CoreWebView2PermissionState.Allow : Microsoft.Web.WebView2.Core.CoreWebView2PermissionState.Deny;
        p.Handled = true;
      };
      // Links (sources, research) open in the owner's browser, never inside his window.
      core.NewWindowRequested += delegate(object s, Microsoft.Web.WebView2.Core.CoreWebView2NewWindowRequestedEventArgs n)
      {
        n.Handled = true;
        OpenOutside(n.Uri);
      };
      core.NavigationStarting += delegate(object s, Microsoft.Web.WebView2.Core.CoreWebView2NavigationStartingEventArgs n)
      {
        if (n.Uri.StartsWith(origin, StringComparison.OrdinalIgnoreCase) || n.Uri.StartsWith("about:", StringComparison.OrdinalIgnoreCase)) return;
        n.Cancel = true;
        OpenOutside(n.Uri);
      };
      // Gnosis's own name in the title, not the page's.
      core.DocumentTitleChanged += delegate { Text = config.Title; };
    }

    static void OpenOutside(string uri)
    {
      if (!uri.StartsWith("http://", StringComparison.OrdinalIgnoreCase) && !uri.StartsWith("https://", StringComparison.OrdinalIgnoreCase)) return;
      try
      {
        var psi = new ProcessStartInfo(uri);
        psi.UseShellExecute = true;
        Process.Start(psi);
      }
      catch { }
    }
  }

  // The bridge's /hearing: which way the face listens, and the switch. AYRA.exe
  // is the only caller: it sends x-ayra and no Origin (see server.mjs).
  static class Hearing
  {
    public static string Get(Config c, out int faces)
    {
      faces = 0;
      try
      {
        var req = (HttpWebRequest)WebRequest.Create(c.HearingUrl);
        req.Timeout = 2000;
        req.Proxy = null;
        req.Headers["x-ayra"] = "tray";
        using (var res = (HttpWebResponse)req.GetResponse())
        using (var r = new StreamReader(res.GetResponseStream()))
        {
          var body = r.ReadToEnd();
          var f = Regex.Match(body, "\"faces\":(\\d+)");
          if (f.Success) faces = int.Parse(f.Groups[1].Value);
          return Mode(body);
        }
      }
      catch { return null; }
    }

    public static string Post(Config c, string mode)
    {
      try
      {
        var req = (HttpWebRequest)WebRequest.Create(c.HearingUrl);
        req.Method = "POST";
        req.Timeout = 3000;
        req.Proxy = null;
        req.ContentType = "application/json";
        req.Headers["x-ayra"] = "tray";
        var bytes = Encoding.UTF8.GetBytes("{\"mode\":\"" + mode + "\"}");
        using (var w = req.GetRequestStream()) w.Write(bytes, 0, bytes.Length);
        using (var res = (HttpWebResponse)req.GetResponse())
        using (var r = new StreamReader(res.GetResponseStream())) return Mode(r.ReadToEnd());
      }
      catch { return null; }
    }

    // POST /talk: the HTTP status (409: her window isn't open), or 0 when unreachable.
    public static int Talk(Config c) { return Press(c, c.TalkUrl); }

    // The tray's Settings item: his window shows its Settings screen.
    public static int Settings(Config c) { return Press(c, c.TalkUrl.Substring(0, c.TalkUrl.LastIndexOf('/')) + "/settings-open"); }

    static int Press(Config c, string url)
    {
      try
      {
        var req = (HttpWebRequest)WebRequest.Create(url);
        req.Method = "POST";
        req.Timeout = 3000;
        req.Proxy = null;
        req.ContentLength = 0;
        req.Headers["x-ayra"] = "tray";
        using (var res = (HttpWebResponse)req.GetResponse()) return (int)res.StatusCode;
      }
      catch (WebException e)
      {
        var res = e.Response as HttpWebResponse;
        return res == null ? 0 : (int)res.StatusCode;
      }
      catch { return 0; }
    }

    static string Mode(string body)
    {
      var m = Regex.Match(body, "\"mode\":\"([a-z-]+)\"");
      return m.Success ? m.Groups[1].Value : null;
    }
  }

  class HotkeyWindow : NativeWindow, IDisposable
  {
    const int WM_HOTKEY = 0x0312;
    readonly Action onPress;
    public readonly bool Valid, Registered;

    public HotkeyWindow(string spec, Action onPress)
    {
      this.onPress = onPress;
      var cp = new CreateParams();
      cp.Parent = new IntPtr(-3); // HWND_MESSAGE: never shown
      CreateHandle(cp);
      uint mods, key;
      Valid = Parse(spec, out mods, out key);
      Registered = Valid && Native.RegisterHotKey(Handle, 1, mods | 0x4000, key); // MOD_NOREPEAT
    }

    protected override void WndProc(ref Message m)
    {
      if (m.Msg == WM_HOTKEY) onPress();
      base.WndProc(ref m);
    }

    public void Dispose()
    {
      if (Registered) Native.UnregisterHotKey(Handle, 1);
      DestroyHandle();
    }

    // "ctrl+alt+a", "win+shift+space", "ctrl+f12".
    public static bool Parse(string spec, out uint mods, out uint key)
    {
      mods = 0;
      key = 0;
      foreach (var raw in spec.ToLowerInvariant().Split('+'))
      {
        var part = raw.Trim();
        if (part == "ctrl" || part == "control") mods |= 2;
        else if (part == "alt") mods |= 1;
        else if (part == "shift") mods |= 4;
        else if (part == "win") mods |= 8;
        else if (part == "space") key = 0x20;
        else if (part.Length == 1 && char.IsLetterOrDigit(part[0])) key = char.ToUpperInvariant(part[0]);
        else if (part.Length >= 2 && part[0] == 'f')
        {
          int n;
          if (!int.TryParse(part.Substring(1), out n) || n < 1 || n > 24) return false;
          key = (uint)(0x6F + n);
        }
        else return false;
      }
      return mods != 0 && key != 0;
    }
  }

  // A borderless window drawn with per-pixel alpha (smooth round edges, a soft
  // glow) that stays on top and never takes the focus from the owner's app:
  // the base of the bubble and its caption.
  class LayeredForm : Form
  {
    const int WS_EX_TOPMOST = 0x8, WS_EX_TOOLWINDOW = 0x80, WS_EX_LAYERED = 0x80000, WS_EX_NOACTIVATE = 0x08000000;
    const int WM_MOUSEACTIVATE = 0x21, MA_NOACTIVATE = 3;

    public LayeredForm()
    {
      FormBorderStyle = FormBorderStyle.None;
      ShowInTaskbar = false;
      StartPosition = FormStartPosition.Manual;
      TopMost = true;
    }

    protected override CreateParams CreateParams
    {
      get
      {
        var cp = base.CreateParams;
        cp.ExStyle |= WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_LAYERED | WS_EX_NOACTIVATE;
        return cp;
      }
    }

    protected override bool ShowWithoutActivation { get { return true; } }

    protected override void WndProc(ref Message m)
    {
      // A click must not pull the focus out of the owner's app.
      if (m.Msg == WM_MOUSEACTIVATE) { m.Result = (IntPtr)MA_NOACTIVATE; return; }
      base.WndProc(ref m);
    }

    // Puts a 32-bit ARGB picture on screen as this window, at its location.
    public void Present(Bitmap bmp)
    {
      if (!IsHandleCreated) return;
      IntPtr screen = Gdi.GetDC(IntPtr.Zero), mem = Gdi.CreateCompatibleDC(screen), hbmp = IntPtr.Zero, old = IntPtr.Zero;
      try
      {
        hbmp = bmp.GetHbitmap(Color.FromArgb(0));
        old = Gdi.SelectObject(mem, hbmp);
        var size = new Gdi.SIZE(bmp.Width, bmp.Height);
        var src = new Gdi.POINT(0, 0);
        var dst = new Gdi.POINT(Left, Top);
        var blend = new Gdi.BLENDFUNCTION { BlendOp = 0, BlendFlags = 0, SourceConstantAlpha = 255, AlphaFormat = 1 };
        Gdi.UpdateLayeredWindow(Handle, screen, ref dst, ref size, mem, ref src, 0, ref blend, 2);
      }
      finally
      {
        if (old != IntPtr.Zero) Gdi.SelectObject(mem, old);
        if (hbmp != IntPtr.Zero) Gdi.DeleteObject(hbmp);
        Gdi.DeleteDC(mem);
        Gdi.ReleaseDC(IntPtr.Zero, screen);
      }
    }
  }

  // The bubble: Gnosis himself, on the desktop.
  //   - only while the desktop is in front (the owner, 2026-10-18: AYRA's bubble sat on top of every
  //     app; Gnosis's stays on the desktop and steps away when an app is in front)
  //   - it is the mascot, drawn in the pose for what he is doing (desktop/mascot, npm run mascot);
  //     his mouth moves while he speaks, and a soft amber glow shows he is busy
  //   - a click is Space (POST /talk): he listens, sends, or stops and listens
  //   - one line beside it: what he heard, or what he is saying
  //   - drag it anywhere; right-click for hands-free, his window, hiding it
  // His state comes from the bridge's /face (tray only), polled 5 times a second.
  class Bubble : LayeredForm
  {
    readonly Config config;
    readonly Action talk, switchHearing, openWindow, hideMe;
    readonly Caption caption;
    readonly ContextMenuStrip menu;
    readonly ToolStripMenuItem handsFreeItem;
    readonly System.Windows.Forms.Timer anim;
    readonly Dictionary<string, Bitmap> frames;
    readonly int body, pad;
    readonly float scale;
    readonly string place;
    string phase = "offline", text = "", who = "", by = "", hearing = "push";
    int faces;
    DateTime flashUntil = DateTime.MinValue, lastBusy = DateTime.MinValue, lastDraw = DateTime.MinValue;
    readonly DateTime started = DateTime.Now;
    bool dragging, down, onDesktop, wanted = true;
    Point grab;
    volatile bool closing;

    public Bubble(Config config, Action talk, Action switchHearing, Action openWindow, Action hideMe)
    {
      this.config = config;
      this.talk = talk;
      this.switchHearing = switchHearing;
      this.openWindow = openWindow;
      this.hideMe = hideMe;
      using (var g = Graphics.FromHwnd(IntPtr.Zero)) scale = g.DpiX / 96f;
      body = (int)(96 * scale);
      pad = (int)(10 * scale);
      // His pictures are 192 × 252: the bubble keeps that shape.
      Size = new Size(body + 2 * pad, (int)(body * 252f / 192f) + 2 * pad);
      frames = LoadFrames(Path.Combine(config.Root, "desktop", "mascot"));
      place = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Gnosis", "bubble.txt");
      Location = Restore();
      caption = new Caption(scale);

      menu = new ContextMenuStrip();
      handsFreeItem = new ToolStripMenuItem("Hands-free: say Gnosis", null, delegate { switchHearing(); });
      menu.Items.Add(handsFreeItem);
      menu.Items.Add("Open Gnosis's window", null, delegate { openWindow(); });
      menu.Items.Add(new ToolStripSeparator());
      menu.Items.Add("Hide the bubble", null, delegate { hideMe(); });

      anim = new System.Windows.Forms.Timer();
      anim.Interval = 33;
      anim.Tick += delegate
      {
        // 30 frames a second while something is happening; 4 when she is resting.
        if (!Busy(phase) && DateTime.Now > flashUntil && (DateTime.Now - lastDraw).TotalMilliseconds < 250) return;
        Draw();
      };
      anim.Start();
      // A window that has never been shown has no handle, and the poll's updates need one.
      CreateHandle();
      var poll = new Thread(Poll);
      poll.IsBackground = true;
      poll.Start();
    }

    public bool Wanted { get { return wanted; } }

    // His pictures, one per state (scripts/mascot.mjs): sleep, idle, wave, listen, think, work, talk,
    // talk2 (mouth nearly shut), oops. A missing one falls back to idle.
    static Dictionary<string, Bitmap> LoadFrames(string dir)
    {
      var all = new Dictionary<string, Bitmap>();
      foreach (var name in new[] { "sleep", "idle", "wave", "listen", "think", "work", "talk", "talk2", "oops" })
      {
        try
        {
          var file = Path.Combine(dir, name + ".png");
          if (File.Exists(file)) using (var img = Image.FromFile(file)) all[name] = new Bitmap(img);
        }
        catch { }
      }
      return all;
    }

    Bitmap Frame(double t)
    {
      string name;
      if (phase == "offline" || phase == "boot") name = "sleep";
      else if (phase == "waking") name = "wave";
      else if (phase == "listening") name = "listen";
      else if (phase == "thinking") name = "think";
      else if (phase == "tooling") name = "work";
      else if (phase == "speaking") name = (int)(t * 6) % 2 == 0 ? "talk" : "talk2"; // his mouth moving
      else name = "idle";
      Bitmap b;
      if (frames.TryGetValue(name, out b)) return b;
      return frames.TryGetValue("idle", out b) ? b : null;
    }

    // The old round face, from the icon file: used only if his pictures are missing.
    static Bitmap LoadFace(string path)
    {
      try
      {
        var b = File.ReadAllBytes(path);
        int count = BitConverter.ToUInt16(b, 4), best = -1, bestSize = 0;
        for (int i = 0; i < count; i++)
        {
          int e = 6 + 16 * i, size = b[e] == 0 ? 256 : b[e];
          if (size > bestSize) { bestSize = size; best = e; }
        }
        if (best < 0) return null;
        int length = BitConverter.ToInt32(b, best + 8), offset = BitConverter.ToInt32(b, best + 12);
        using (var ms = new MemoryStream(b, offset, length))
        using (var img = Image.FromStream(ms)) return new Bitmap(img);
      }
      catch
      {
        try { using (var ico = new Icon(path, 64, 64)) return ico.ToBitmap(); }
        catch { return null; }
      }
    }

    public void SetWanted(bool on)
    {
      wanted = on;
      Save();
      Arrange();
    }

    protected override void OnHandleCreated(EventArgs e)
    {
      base.OnHandleCreated(e);
      Draw();
    }

    protected override void OnFormClosed(FormClosedEventArgs e)
    {
      closing = true;
      anim.Stop();
      caption.Close();
      base.OnFormClosed(e);
    }

    // -- the owner's hands -------------------------------------------------

    protected override void OnMouseDown(MouseEventArgs e)
    {
      if (e.Button == MouseButtons.Left) { down = true; dragging = false; grab = e.Location; }
      base.OnMouseDown(e);
    }

    protected override void OnMouseMove(MouseEventArgs e)
    {
      if (down && !dragging && (Math.Abs(e.X - grab.X) > 4 * scale || Math.Abs(e.Y - grab.Y) > 4 * scale)) dragging = true;
      if (dragging)
      {
        Location = new Point(Left + e.X - grab.X, Top + e.Y - grab.Y);
        Draw();
      }
      base.OnMouseMove(e);
    }

    protected override void OnMouseUp(MouseEventArgs e)
    {
      if (e.Button == MouseButtons.Left && down)
      {
        down = false;
        if (dragging) { dragging = false; Save(); }
        else talk();
      }
      else if (e.Button == MouseButtons.Right)
      {
        handsFreeItem.Checked = hearing == "hands-free";
        menu.Show(Cursor.Position);
      }
      base.OnMouseUp(e);
    }

    // -- her state ---------------------------------------------------------

    void Poll()
    {
      var url = config.HealthUrl.Substring(0, config.HealthUrl.LastIndexOf('/')) + "/face";
      while (!closing)
      {
        string body = null;
        try
        {
          var req = (HttpWebRequest)WebRequest.Create(url);
          req.Timeout = 800;
          req.Proxy = null;
          req.Headers["x-ayra"] = "tray";
          using (var res = (HttpWebResponse)req.GetResponse())
          using (var r = new StreamReader(res.GetResponseStream(), Encoding.UTF8)) body = r.ReadToEnd();
        }
        catch { body = null; }
        var desk = DesktopInFront();
        try
        {
          if (!closing && IsHandleCreated) BeginInvoke((Action)delegate { Take(body, desk); });
        }
        catch { }
        Thread.Sleep(200);
      }
    }

    static string Field(string body, string name)
    {
      var m = Regex.Match(body, "\"" + name + "\":\"((?:\\\\.|[^\"\\\\])*)\"");
      if (!m.Success) return "";
      try { return Regex.Unescape(m.Groups[1].Value); }
      catch { return m.Groups[1].Value; }
    }

    void Take(string body, bool desk)
    {
      var was = phase;
      var wasBy = by;
      if (body == null) { phase = "offline"; text = ""; who = ""; by = ""; faces = 0; }
      else
      {
        phase = Field(body, "phase");
        text = Field(body, "text");
        who = Field(body, "who");
        by = Field(body, "by");
        hearing = Field(body, "hearing");
        var f = Regex.Match(body, "\"faces\":(\\d+)");
        faces = f.Success ? int.Parse(f.Groups[1].Value) : 0;
        if (faces == 0) phase = "offline";
      }
      if (Busy(phase)) lastBusy = DateTime.Now;
      // Her name heard: a flash, so the owner knows at once that she heard.
      if (phase == "listening" && by == "name" && (was != "listening" || wasBy != "name")) flashUntil = DateTime.Now.AddMilliseconds(700);
      onDesktop = desk;
      Arrange();
    }

    static bool Busy(string p) { return p == "waking" || p == "listening" || p == "thinking" || p == "tooling" || p == "speaking"; }

    // Shown or hidden, and the caption beside it.
    void Arrange()
    {
      var show = wanted && onDesktop;
      if (show && !Visible) { Show(); Draw(); }
      if (!show && Visible) Hide();
      // The last answer stays a few seconds after she finishes, then fades.
      var recent = (DateTime.Now - lastBusy).TotalSeconds < 5;
      var line = show && text.Length > 0 && (Busy(phase) || (phase == "dormant" && recent)) ? text : "";
      if (line.Length == 0 && show && phase == "listening") line = by == "name" ? "Yes? I'm listening." : "Listening...";
      caption.Say(line, who == "you", Bounds);
    }

    // Him, in the pose for what he is doing; a soft amber glow behind him while he is busy.
    void Draw()
    {
      if (!Visible || !IsHandleCreated) return;
      lastDraw = DateTime.Now;
      var t = (DateTime.Now - started).TotalSeconds;
      var amber = Color.FromArgb(239, 154, 76);
      float glow = 0f;
      if (phase == "listening" || phase == "waking") glow = 0.45f + 0.25f * (float)Math.Abs(Math.Sin(t * 3));
      else if (phase == "thinking" || phase == "tooling") glow = 0.35f + 0.2f * (float)Math.Abs(Math.Sin(t * 2));
      else if (phase == "speaking") glow = 0.4f;
      else if (hearing == "hands-free" && phase == "dormant") glow = 0.12f;
      if (DateTime.Now < flashUntil) glow = 1f; // his name heard

      using (var bmp = new Bitmap(Width, Height, System.Drawing.Imaging.PixelFormat.Format32bppArgb))
      using (var g = Graphics.FromImage(bmp))
      {
        g.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.AntiAlias;
        g.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.HighQualityBicubic;
        var area = new Rectangle(pad, pad, Width - 2 * pad, Height - 2 * pad);
        if (glow > 0)
        {
          using (var path = new System.Drawing.Drawing2D.GraphicsPath())
          {
            path.AddEllipse(area.Left - pad, area.Top + area.Height / 6, area.Width + 2 * pad, area.Height);
            using (var brush = new System.Drawing.Drawing2D.PathGradientBrush(path))
            {
              brush.CenterColor = Color.FromArgb((int)(150 * Math.Min(1f, glow)), amber);
              brush.SurroundColors = new[] { Color.FromArgb(0, amber) };
              g.FillPath(brush, path);
            }
          }
        }
        var frame = Frame(t);
        if (frame != null)
        {
          g.DrawImage(frame, area);
          if (phase == "offline")
            using (var veil = new SolidBrush(Color.FromArgb(70, 14, 16, 19)))
              g.FillRectangle(veil, area);
        }
        else
        {
          // No pictures (npm run mascot not run): the old round face.
          var disc = new Rectangle(pad, pad, Width - 2 * pad, Width - 2 * pad);
          using (var b = new SolidBrush(Color.FromArgb(235, 14, 16, 19))) g.FillEllipse(b, disc);
          var face = LoadFace(config.Icon);
          if (face != null) using (face) g.DrawImage(face, Rectangle.Inflate(disc, -(int)(3 * scale), -(int)(3 * scale)));
        }
        Present(bmp);
      }
    }

    // -- where it sits -----------------------------------------------------

    Point Restore()
    {
      var area = Screen.PrimaryScreen.WorkingArea;
      var fallback = new Point(area.Right - Width - (int)(16 * scale), area.Bottom - Height - (int)(16 * scale));
      try
      {
        if (!File.Exists(place)) return fallback;
        var parts = File.ReadAllText(place).Trim().Split(' ');
        var p = new Point(int.Parse(parts[0]), int.Parse(parts[1]));
        if (parts.Length > 2) wanted = parts[2] != "hidden";
        // Still on a screen that is plugged in?
        foreach (var s in Screen.AllScreens)
          if (s.WorkingArea.IntersectsWith(new Rectangle(p, Size))) return p;
      }
      catch { }
      return fallback;
    }

    void Save()
    {
      try
      {
        Directory.CreateDirectory(Path.GetDirectoryName(place));
        File.WriteAllText(place, Left + " " + Top + " " + (wanted ? "shown" : "hidden"));
      }
      catch { }
    }

    // Is the desktop in front? (Progman and WorkerW are the desktop; after Win+D, or with everything
    // minimised, one of them has the focus.) The taskbar, the Start menu and the tray keep whatever
    // was decided before, so clicking the tray icon doesn't make him blink away.
    bool lastDesk;
    bool DesktopInFront()
    {
      try
      {
        var h = Native.GetForegroundWindow();
        if (h == IntPtr.Zero) return lastDesk;
        var cls = new StringBuilder(64);
        Native.GetClassName(h, cls, cls.Capacity);
        var c = cls.ToString();
        if (c == "Progman" || c == "WorkerW") return lastDesk = true;
        if (c == "Shell_TrayWnd" || c == "Shell_SecondaryTrayWnd" || c == "NotifyIconOverflowWindow" ||
            c == "Windows.UI.Core.CoreWindow" || c == "TopLevelWindowForOverflowXamlIsland") return lastDesk;
        return lastDesk = false;
      }
      catch { return lastDesk; }
    }
  }

  // The line beside the bubble: what she heard (grey) or what she is saying (white).
  class Caption : LayeredForm
  {
    readonly float scale;
    readonly Font font;
    string shown = "";
    bool mine;
    Rectangle anchor;

    public Caption(float scale)
    {
      this.scale = scale;
      font = new Font("Segoe UI", 10f);
    }

    public void Say(string line, bool yours, Rectangle bubble)
    {
      if (line == shown && yours == mine && bubble == anchor) return;
      shown = line;
      mine = yours;
      anchor = bubble;
      if (line.Length == 0) { if (Visible) Hide(); return; }
      var maxW = (int)(420 * scale);
      Size need;
      var flags = TextFormatFlags.SingleLine | TextFormatFlags.NoPrefix;
      using (var g = Graphics.FromHwnd(IntPtr.Zero))
      {
        need = TextRenderer.MeasureText(g, line, font, new Size(int.MaxValue, 1000), flags);
        // Too long for one line: keep the newest words — while she talks, the
        // end of the sentence is the part being said.
        var cut = 0;
        var whole = line;
        while (need.Width > maxW && cut < whole.Length - 8)
        {
          cut += 4;
          var rest = whole.Substring(cut);
          var space = rest.IndexOf(' ');
          if (space > 0 && space < 12) rest = rest.Substring(space + 1);
          line = "…" + rest.TrimStart('…');
          need = TextRenderer.MeasureText(g, line, font, new Size(int.MaxValue, 1000), flags);
        }
      }
      int padX = (int)(12 * scale), padY = (int)(7 * scale);
      var w = Math.Min(maxW, need.Width) + 2 * padX;
      var h = need.Height + 2 * padY;
      // Beside the bubble, towards the middle of the screen.
      var area = Screen.FromRectangle(bubble).WorkingArea;
      var left = bubble.Left + bubble.Width / 2 > area.Left + area.Width / 2 ? bubble.Left - w + (int)(4 * scale) : bubble.Right - (int)(4 * scale);
      var top = bubble.Top + (bubble.Height - h) / 2;
      Bounds = new Rectangle(Math.Max(area.Left, Math.Min(left, area.Right - w)), Math.Max(area.Top, top), w, h);
      if (!Visible) Show();
      using (var bmp = new Bitmap(w, h, System.Drawing.Imaging.PixelFormat.Format32bppArgb))
      using (var g = Graphics.FromImage(bmp))
      {
        g.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.AntiAlias;
        g.TextRenderingHint = System.Drawing.Text.TextRenderingHint.AntiAliasGridFit;
        using (var path = Rounded(new Rectangle(0, 0, w - 1, h - 1), (int)(10 * scale)))
        using (var b = new SolidBrush(Color.FromArgb(230, 12, 18, 28)))
        using (var edge = new Pen(Color.FromArgb(90, 56, 189, 248)))
        {
          g.FillPath(b, path);
          g.DrawPath(edge, path);
        }
        var colour = mine ? Color.FromArgb(170, 185, 200) : Color.FromArgb(240, 245, 250);
        using (var brush = new SolidBrush(colour))
        using (var fmt = new StringFormat(StringFormatFlags.NoWrap))
        {
          fmt.Trimming = StringTrimming.EllipsisCharacter;
          g.DrawString(line, font, brush, new RectangleF(padX, padY - 1, w - 2 * padX, h - 2 * padY + 2), fmt);
        }
        Present(bmp);
      }
    }

    static System.Drawing.Drawing2D.GraphicsPath Rounded(Rectangle r, int radius)
    {
      var d = radius * 2;
      var p = new System.Drawing.Drawing2D.GraphicsPath();
      p.AddArc(r.Left, r.Top, d, d, 180, 90);
      p.AddArc(r.Right - d, r.Top, d, d, 270, 90);
      p.AddArc(r.Right - d, r.Bottom - d, d, d, 0, 90);
      p.AddArc(r.Left, r.Bottom - d, d, d, 90, 90);
      p.CloseFigure();
      return p;
    }
  }

  static class Gdi
  {
    [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; public POINT(int x, int y) { X = x; Y = y; } }
    [StructLayout(LayoutKind.Sequential)] public struct SIZE { public int W, H; public SIZE(int w, int h) { W = w; H = h; } }
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential, Pack = 1)] public struct BLENDFUNCTION { public byte BlendOp, BlendFlags, SourceConstantAlpha, AlphaFormat; }
    [DllImport("user32.dll")] public static extern IntPtr GetDC(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern int ReleaseDC(IntPtr hWnd, IntPtr hdc);
    [DllImport("gdi32.dll")] public static extern IntPtr CreateCompatibleDC(IntPtr hdc);
    [DllImport("gdi32.dll")] public static extern bool DeleteDC(IntPtr hdc);
    [DllImport("gdi32.dll")] public static extern IntPtr SelectObject(IntPtr hdc, IntPtr obj);
    [DllImport("gdi32.dll")] public static extern bool DeleteObject(IntPtr obj);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
    [DllImport("user32.dll")] public static extern bool UpdateLayeredWindow(IntPtr hwnd, IntPtr hdcDst, ref POINT pptDst, ref SIZE psize, IntPtr hdcSrc, ref POINT pptSrc, int crKey, ref BLENDFUNCTION pblend, int dwFlags);
  }

  static class Shortcuts
  {
    // Desktop and Start-menu shortcuts for AYRA and her Chrome, and AYRA in
    // the Startup folder unless asked not to. Printed so `npm run shortcuts`
    // can show what it made.
    public static int Install(Config config, bool startup)
    {
      var desktop = Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory);
      var programs = Environment.GetFolderPath(Environment.SpecialFolder.Programs);
      var startupDir = Environment.GetFolderPath(Environment.SpecialFolder.Startup);
      var about = "Gnosis - your assistant";
      foreach (var dir in new[] { desktop, programs })
      {
        Make(Path.Combine(dir, "Gnosis.lnk"), config.Exe, "", config.Root, config.Icon, Program.AppId, about);
        if (config.Chrome != null)
          Make(Path.Combine(dir, "Chrome (Gnosis).lnk"), config.Chrome, JoinArgs(config.ChromeArgs), config.Root, config.Chrome, null, "Chrome, signed in as you, that Gnosis can drive");
      }
      var login = Path.Combine(startupDir, "Gnosis.lnk");
      if (startup) Make(login, config.Exe, "--background", config.Root, config.Icon, Program.AppId, about);
      else if (File.Exists(login)) { File.Delete(login); Console.WriteLine("removed " + login); }
      return 0;
    }

    static string JoinArgs(List<string> args)
    {
      var quoted = new List<string>();
      foreach (var a in args) quoted.Add(a.IndexOf(' ') >= 0 ? "\"" + a + "\"" : a);
      return string.Join(" ", quoted.ToArray());
    }

    static void Make(string path, string target, string args, string workDir, string icon, string appId, string description)
    {
      var link = (IShellLinkW)new CShellLink();
      try
      {
        link.SetPath(target);
        link.SetArguments(args);
        link.SetWorkingDirectory(workDir);
        link.SetIconLocation(icon, 0);
        link.SetDescription(description);
        if (appId != null)
        {
          var store = (IPropertyStore)link;
          Props.Set(store, Props.AppId, appId);
          store.Commit();
        }
        ((IPersistFile)link).Save(path, true);
        Console.WriteLine("made " + path);
      }
      finally { Marshal.ReleaseComObject(link); }
    }
  }

  static class Props
  {
    static readonly Guid AppUserModel = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3");
    public static readonly PropertyKey RelaunchCommand = new PropertyKey(AppUserModel, 2);
    public static readonly PropertyKey RelaunchIcon = new PropertyKey(AppUserModel, 3);
    public static readonly PropertyKey RelaunchDisplayName = new PropertyKey(AppUserModel, 4);
    public static readonly PropertyKey AppId = new PropertyKey(AppUserModel, 5);

    public static void Set(IPropertyStore store, PropertyKey key, string value)
    {
      var v = new PropVariant();
      v.vt = 31; // VT_LPWSTR
      v.p = Marshal.StringToCoTaskMemUni(value);
      try { store.SetValue(ref key, ref v); }
      finally { Marshal.FreeCoTaskMem(v.p); }
    }
  }

  [StructLayout(LayoutKind.Sequential, Pack = 4)]
  struct PropertyKey
  {
    public Guid FormatId;
    public uint PropertyId;
    public PropertyKey(Guid formatId, uint propertyId) { FormatId = formatId; PropertyId = propertyId; }
  }

  [StructLayout(LayoutKind.Sequential)]
  struct PropVariant
  {
    public ushort vt;
    public ushort reserved1, reserved2, reserved3;
    public IntPtr p;
    public IntPtr p2;
  }

  [ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IPropertyStore
  {
    [PreserveSig] int GetCount(out uint count);
    [PreserveSig] int GetAt(uint index, out PropertyKey key);
    [PreserveSig] int GetValue(ref PropertyKey key, out PropVariant value);
    [PreserveSig] int SetValue(ref PropertyKey key, ref PropVariant value);
    [PreserveSig] int Commit();
  }

  [ComImport, Guid("00021401-0000-0000-C000-000000000046")]
  class CShellLink { }

  [ComImport, Guid("000214F9-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IShellLinkW
  {
    void GetPath([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder file, int max, IntPtr data, uint flags);
    void GetIDList(out IntPtr pidl);
    void SetIDList(IntPtr pidl);
    void GetDescription([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder name, int max);
    void SetDescription([MarshalAs(UnmanagedType.LPWStr)] string name);
    void GetWorkingDirectory([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder dir, int max);
    void SetWorkingDirectory([MarshalAs(UnmanagedType.LPWStr)] string dir);
    void GetArguments([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder args, int max);
    void SetArguments([MarshalAs(UnmanagedType.LPWStr)] string args);
    void GetHotkey(out short hotkey);
    void SetHotkey(short hotkey);
    void GetShowCmd(out int show);
    void SetShowCmd(int show);
    void GetIconLocation([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder path, int max, out int index);
    void SetIconLocation([MarshalAs(UnmanagedType.LPWStr)] string path, int index);
    void SetRelativePath([MarshalAs(UnmanagedType.LPWStr)] string path, uint reserved);
    void Resolve(IntPtr hwnd, uint flags);
    void SetPath([MarshalAs(UnmanagedType.LPWStr)] string file);
  }

  static class Native
  {
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc proc, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("dwmapi.dll")] static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int value, int size);
    [DllImport("user32.dll")] static extern uint GetDpiForSystem();

    // His window's title bar in Windows' dark style, to match the graphite face.
    public static void DarkTitleBar(IntPtr h)
    {
      int on = 1;
      try { DwmSetWindowAttribute(h, 20, ref on, 4); } catch { } // DWMWA_USE_IMMERSIVE_DARK_MODE
    }

    // The display's scale (1.0 at 100%, 1.25 at 125%…): this app sizes in real pixels.
    public static float Scale()
    {
      try { return GetDpiForSystem() / 96f; } catch { return 1f; }
    }
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr hWnd, StringBuilder name, int max);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int max);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int cmd);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, IntPtr pid);
    [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint from, uint to, bool attach);
    [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] public static extern bool RegisterHotKey(IntPtr hWnd, int id, uint mods, uint key);
    [DllImport("user32.dll")] public static extern bool UnregisterHotKey(IntPtr hWnd, int id);
    [DllImport("user32.dll")] static extern void keybd_event(byte key, byte scan, uint flags, UIntPtr extra);
    [DllImport("user32.dll")] static extern short GetAsyncKeyState(int key);
    [DllImport("shell32.dll")] public static extern int SHGetPropertyStoreForWindow(IntPtr hWnd, ref Guid iid, out IPropertyStore store);
    [DllImport("shell32.dll", CharSet = CharSet.Unicode)] public static extern int SetCurrentProcessExplicitAppUserModelID(string appId);
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
    [DllImport("kernel32.dll")] static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool Process32FirstW(IntPtr snapshot, ref ProcessEntry entry);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool Process32NextW(IntPtr snapshot, ref ProcessEntry entry);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct ProcessEntry
    {
      public uint dwSize, cntUsage, th32ProcessID;
      public IntPtr th32DefaultHeapID;
      public uint th32ModuleID, cntThreads, th32ParentProcessID;
      public int pcPriClassBase;
      public uint dwFlags;
      [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string szExeFile;
    }

    // The processes named `exe` whose parent is `parent` - one level only.
    public static List<int> ChildrenOf(int parent, string exe)
    {
      var found = new List<int>();
      var snapshot = CreateToolhelp32Snapshot(2, 0); // TH32CS_SNAPPROCESS
      if (snapshot == IntPtr.Zero || snapshot == new IntPtr(-1)) return found;
      try
      {
        var e = new ProcessEntry();
        e.dwSize = (uint)Marshal.SizeOf(typeof(ProcessEntry));
        for (var ok = Process32FirstW(snapshot, ref e); ok; ok = Process32NextW(snapshot, ref e))
          if (e.th32ParentProcessID == parent && string.Equals(e.szExeFile, exe, StringComparison.OrdinalIgnoreCase))
            found.Add((int)e.th32ProcessID);
      }
      finally { CloseHandle(snapshot); }
      return found;
    }

    [DllImport("user32.dll")] static extern uint MapVirtualKey(uint code, uint mapType);

    // With its real scan code: Chrome reports a key without one as no key at
    // all (KeyboardEvent.code ""), and her window listens for code "Space".
    public static void Tap(byte key)
    {
      var scan = (byte)MapVirtualKey(key, 0); // MAPVK_VK_TO_VSC
      keybd_event(key, scan, 0, UIntPtr.Zero);
      keybd_event(key, scan, 2, UIntPtr.Zero); // KEYEVENTF_KEYUP
    }

    // Ctrl, Alt, Shift and the Windows keys all released, or the time is up.
    public static void WaitForModifiersUp(int timeoutMs)
    {
      var keys = new[] { 0x11, 0x12, 0x10, 0x5B, 0x5C };
      var until = DateTime.Now.AddMilliseconds(timeoutMs);
      while (DateTime.Now < until)
      {
        var held = false;
        foreach (var k in keys) if ((GetAsyncKeyState(k) & 0x8000) != 0) held = true;
        if (!held) return;
        Thread.Sleep(20);
      }
    }
  }
}
