# Teach mode's recorder (teach.mjs), ported from Gnosis v1 (gnosis/teach/recorder.py): watches the
# owner's mouse and keyboard and prints one JSON line per event until "stop" arrives on its input.
#   click — the control under the pointer, by its name in the accessibility tree (not its position),
#           with its type, window and app;
#   text  — a typed character; never in a password field (a "skipped" line instead);
#   key   — Enter, Tab, arrows, F-keys, and anything with Ctrl, Alt or Win ("ctrl+s").
# Nothing is recorded while a password manager is in front.
param([string]$Skip = 'keepass|1password|bitwarden|lastpass|dashlane')
$ErrorActionPreference = 'Stop'

Add-Type -ReferencedAssemblies UIAutomationClient, UIAutomationTypes, WindowsBase, System.Windows.Forms -TypeDefinition @'
using System;
using System.Collections.Concurrent;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows.Automation;

public static class GnosisTeach {
  delegate IntPtr HookProc(int code, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] static extern IntPtr SetWindowsHookEx(int id, HookProc fn, IntPtr mod, uint thread);
  [DllImport("user32.dll")] static extern bool UnhookWindowsHookEx(IntPtr h);
  [DllImport("user32.dll")] static extern IntPtr CallNextHookEx(IntPtr h, int code, IntPtr w, IntPtr l);
  [DllImport("kernel32.dll")] static extern IntPtr GetModuleHandle(string name);
  [DllImport("user32.dll")] static extern short GetAsyncKeyState(int vk);
  [DllImport("user32.dll")] static extern short GetKeyState(int vk);
  [DllImport("user32.dll")] static extern int ToUnicode(uint vk, uint scan, byte[] state, StringBuilder buf, int size, uint flags);
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();

  [StructLayout(LayoutKind.Sequential)] struct MSLL { public int x, y; public uint data, flags, time; public IntPtr extra; }
  [StructLayout(LayoutKind.Sequential)] struct KBLL { public uint vk, scan, flags, time; public IntPtr extra; }

  static readonly HookProc mouseProc = MouseHook, keyProc = KeyHook;
  static readonly BlockingCollection<object[]> queue = new BlockingCollection<object[]>();
  static Regex skip;
  public static volatile bool Stop;

  static bool Down(int vk) { return (GetAsyncKeyState(vk) & 0x8000) != 0; }

  static IntPtr MouseHook(int code, IntPtr w, IntPtr l) {
    if (code >= 0 && (int)w == 0x201) {  // WM_LBUTTONDOWN
      var m = (MSLL)Marshal.PtrToStructure(l, typeof(MSLL));
      queue.Add(new object[] { "click", m.x, m.y });
    }
    return CallNextHookEx(IntPtr.Zero, code, w, l);
  }

  static string Special(uint vk) {
    switch (vk) {
      case 0x0D: return "enter"; case 0x09: return "tab"; case 0x1B: return "esc"; case 0x08: return "backspace";
      case 0x2E: return "delete"; case 0x25: return "left"; case 0x26: return "up"; case 0x27: return "right";
      case 0x28: return "down"; case 0x24: return "home"; case 0x23: return "end"; case 0x21: return "pageup";
      case 0x22: return "pagedown";
    }
    if (vk >= 0x70 && vk <= 0x7B) return "f" + (vk - 0x6F);
    return null;
  }

  static IntPtr KeyHook(int code, IntPtr w, IntPtr l) {
    if (code >= 0 && ((int)w == 0x100 || (int)w == 0x104)) {  // WM_KEYDOWN, WM_SYSKEYDOWN
      var k = (KBLL)Marshal.PtrToStructure(l, typeof(KBLL));
      uint vk = k.vk;
      bool isMod = (vk >= 0xA0 && vk <= 0xA5) || vk == 0x10 || vk == 0x11 || vk == 0x12 || vk == 0x5B || vk == 0x5C;
      if (!isMod) {
        bool ctrl = Down(0x11), alt = Down(0x12), win = Down(0x5B) || Down(0x5C), shift = Down(0x10);
        string special = Special(vk);
        if (ctrl || alt || win) {
          string name = special ?? (vk >= 0x30 && vk <= 0x5A ? ((char)vk).ToString().ToLower() : null);
          if (name != null) {
            var sb = new StringBuilder();
            if (ctrl) sb.Append("ctrl+"); if (alt) sb.Append("alt+"); if (shift) sb.Append("shift+"); if (win) sb.Append("win+");
            queue.Add(new object[] { "key", sb.Append(name).ToString() });
          }
        } else if (special != null) {
          queue.Add(new object[] { "key", special });
        } else {
          var state = new byte[256];
          if (shift) state[0x10] = 0x80;
          if ((GetKeyState(0x14) & 1) != 0) state[0x14] = 0x01;  // Caps Lock
          var buf = new StringBuilder(4);
          if (ToUnicode(vk, k.scan, state, buf, 4, 4) > 0 && !char.IsControl(buf[0])) queue.Add(new object[] { "char", buf.ToString() });
        }
      }
    }
    return CallNextHookEx(IntPtr.Zero, code, w, l);
  }

  static string Json(string s) {
    var sb = new StringBuilder("\"");
    foreach (char c in s ?? "") {
      if (c == '"' || c == '\\') sb.Append('\\').Append(c);
      else if (c < 0x20) sb.Append("\\u").Append(((int)c).ToString("x4"));
      else sb.Append(c);
    }
    return sb.Append('"').ToString();
  }

  static void Emit(string line) { Console.Out.WriteLine(line); Console.Out.Flush(); }

  static AutomationElement TopOf(AutomationElement el) {
    var walker = TreeWalker.ControlViewWalker;
    var root = AutomationElement.RootElement;
    var cur = el;
    for (int i = 0; i < 60 && cur != null; i++) {
      var parent = walker.GetParent(cur);
      if (parent == null || Automation.Compare(parent, root)) return cur;
      cur = parent;
    }
    return cur;
  }

  static string AppOf(AutomationElement el) {
    try { return Process.GetProcessById(el.Current.ProcessId).ProcessName; } catch { return ""; }
  }

  static string lastSkip = "";
  static void Skipped(string reason) {
    if (reason == lastSkip) return;
    lastSkip = reason;
    Emit("{\"kind\":\"skipped\",\"reason\":" + Json(reason) + "}");
  }

  static void Work() {
    foreach (var item in queue.GetConsumingEnumerable()) {
      try {
        string kind = (string)item[0];
        AutomationElement focused = null;
        try { focused = AutomationElement.FocusedElement; } catch { }
        string focusApp = focused != null ? AppOf(focused) : "";
        if (focusApp != "" && skip.IsMatch(focusApp)) { Skipped("Skipped " + focusApp); continue; }
        if (kind == "click") {
          var el = AutomationElement.FromPoint(new System.Windows.Point((int)item[1], (int)item[2]));
          var top = TopOf(el);
          string app = AppOf(el);
          if (skip.IsMatch(app)) { Skipped("Skipped " + app); continue; }
          string name = (el.Current.Name ?? "").Trim();
          if (name.Length > 80) name = name.Substring(0, 80);
          lastSkip = "";
          Emit("{\"kind\":\"click\",\"app\":" + Json(app) + ",\"window\":" + Json(top != null ? top.Current.Name : "") +
               ",\"name\":" + Json(name) + ",\"type\":" + Json(el.Current.ControlType.ProgrammaticName.Replace("ControlType.", "")) +
               ",\"automationId\":" + Json(el.Current.AutomationId) + "}");
        } else if (kind == "char") {
          if (focused != null && focused.Current.IsPassword) { Skipped("Typing in a password field wasn't recorded"); continue; }
          string window = "";
          try { var top = TopOf(focused); window = top != null ? top.Current.Name : ""; } catch { }
          lastSkip = "";
          Emit("{\"kind\":\"text\",\"text\":" + Json((string)item[1]) + ",\"app\":" + Json(focusApp) + ",\"window\":" + Json(window) + "}");
        } else {
          string window = "";
          try { var top = TopOf(focused); window = top != null ? top.Current.Name : ""; } catch { }
          lastSkip = "";
          Emit("{\"kind\":\"key\",\"combo\":" + Json((string)item[1]) + ",\"app\":" + Json(focusApp) + ",\"window\":" + Json(window) + "}");
        }
      } catch {
        // A control that vanished mid-lookup just isn't recorded.
      }
    }
  }

  public static void Run(string skipPattern) {
    skip = new Regex(skipPattern, RegexOptions.IgnoreCase);
    SetProcessDPIAware();
    var worker = new Thread(Work) { IsBackground = true };
    worker.SetApartmentState(ApartmentState.MTA);
    worker.Start();
    new Thread(() => {
      while (true) {
        string line = Console.In.ReadLine();
        if (line == null || line.Trim() == "stop") { Stop = true; return; }
      }
    }) { IsBackground = true }.Start();
    IntPtr mod = GetModuleHandle(null);
    IntPtr mh = SetWindowsHookEx(14, mouseProc, mod, 0);  // WH_MOUSE_LL
    IntPtr kh = SetWindowsHookEx(13, keyProc, mod, 0);    // WH_KEYBOARD_LL
    Emit("{\"kind\":\"ready\"}");
    // The hooks are called through this thread's message queue, so it keeps pumping until told to stop.
    while (!Stop) { System.Windows.Forms.Application.DoEvents(); Thread.Sleep(5); }
    UnhookWindowsHookEx(mh);
    UnhookWindowsHookEx(kh);
    queue.CompleteAdding();
    worker.Join(5000);
    Emit("{\"kind\":\"end\"}");
  }
}
'@

[GnosisTeach]::Run($Skip)
