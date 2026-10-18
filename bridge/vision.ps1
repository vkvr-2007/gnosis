# Gnosis's eyes on the laptop (vision.mjs): a picture of the screen or a part of it, and a mouse
# click at a point.
# Prints one line of JSON.
param(
  [Parameter(Mandatory)][ValidateSet('screen', 'click')][string]$Op,
  [int]$X = 0,
  [int]$Y = 0,
  [string]$Region = '',
  [ValidateSet('left', 'double', 'right')][string]$Button = 'left'
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
Add-Type -Namespace GnosisVision -Name Native -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
[DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
[DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint x, uint y, uint data, UIntPtr extra);
'@
# Real pixels, not the scaled ones, so a point on the picture is the same point for the mouse.
[void][GnosisVision.Native]::SetProcessDPIAware()

function Screen-Shot {
  $b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
  # A part of the screen (left,top,width,height), enlarged up to twice, for a closer look.
  if ($Region) { $p = $Region -split ',' | ForEach-Object { [int]$_ }; $b = [System.Drawing.Rectangle]::new($p[0], $p[1], $p[2], $p[3]) }
  $bmp = [System.Drawing.Bitmap]::new($b.Width, $b.Height)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($b.Left, $b.Top, 0, 0, $bmp.Size)
  $g.Dispose()
  $scale = [Math]::Min($(if ($Region) { 2.0 } else { 1.0 }), 1400.0 / $b.Width)
  $w = [int]($b.Width * $scale); $h = [int]($b.Height * $scale)
  $out = [System.Drawing.Bitmap]::new($w, $h)
  $g = [System.Drawing.Graphics]::FromImage($out)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.DrawImage($bmp, 0, 0, $w, $h)
  $bmp.Dispose()
  $g.Dispose()
  $ms = [System.IO.MemoryStream]::new()
  $out.Save($ms, [System.Drawing.Imaging.ImageFormat]::Jpeg)
  $out.Dispose()
  @{ jpeg = [Convert]::ToBase64String($ms.ToArray()); width = $b.Width; height = $b.Height; left = $b.Left; top = $b.Top }
}

function Mouse-Click {
  $n = [GnosisVision.Native]
  [void]$n::SetCursorPos($X, $Y)
  Start-Sleep -Milliseconds 60
  $down, $up = if ($Button -eq 'right') { 8, 16 } else { 2, 4 }
  $times = if ($Button -eq 'double') { 2 } else { 1 }
  for ($i = 0; $i -lt $times; $i++) {
    $n::mouse_event($down, 0, 0, 0, [UIntPtr]::Zero)
    $n::mouse_event($up, 0, 0, 0, [UIntPtr]::Zero)
    if ($times -gt 1) { Start-Sleep -Milliseconds 80 }
  }
  @{ x = $X; y = $Y; button = $Button }
}

try {
  $result = if ($Op -eq 'screen') { Screen-Shot } else { Mouse-Click }
  $result | ConvertTo-Json -Compress
} catch {
  @{ error = "$($_.Exception.Message)" } | ConvertTo-Json -Compress
}
