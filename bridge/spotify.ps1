# Spotify by its own controls (spotify.mjs): open its search for a query and list the results it
# offers to play, press one result's play button, and say what its window shows as playing.
# Spotify's window gives every result a "Play <title>" button next to a "More options for <title>"
# one, read through UI Automation, so nothing is clicked by position. Prints one line of JSON.
param(
  [Parameter(Mandatory)][ValidateSet('search', 'play', 'now')][string]$Op,
  [string]$Query = '',
  [string]$Name = '',
  [int]$Index = 0
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
$AE = [System.Windows.Automation.AutomationElement]

function Spotify-Window {
  $cond = [System.Windows.Automation.PropertyCondition]::new($AE::ClassNameProperty, 'Chrome_WidgetWin_1')
  foreach ($w in $AE::RootElement.FindAll([System.Windows.Automation.TreeScope]::Children, $cond)) {
    $p = Get-Process -Id $w.Current.ProcessId -ErrorAction SilentlyContinue
    if ($p -and $p.ProcessName -eq 'Spotify' -and $w.Current.Name) { return $w }
  }
  $null
}

function Buttons($win) {
  $cond = [System.Windows.Automation.PropertyCondition]::new($AE::ControlTypeProperty, [System.Windows.Automation.ControlType]::Button)
  $win.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cond)
}

# The results: "Play X" buttons that have a "More options for X" beside them (the sidebar's
# playlists have none), in the order the page shows them.
function Results($win) {
  $all = @(Buttons $win | ForEach-Object { $_.Current.Name })
  $more = @{}
  foreach ($n in $all) { if ($n -like 'More options for *') { $more[($n.Substring(17) -replace '[\x00-\x1f]', ' ')] = $true } }
  $seen = @{}
  $out = @()
  foreach ($n in $all) {
    if ($n -like 'Play *' -and $more.ContainsKey(($n.Substring(5) -replace '[\x00-\x1f]', ' '))) {
      $t = ($n.Substring(5) -replace '[\x00-\x1f]', ' ')
      $seen[$t] = 1 + [int]$seen[$t]
      $out += @{ title = $t; index = $seen[$t] - 1 }
    }
  }
  , $out
}

# Its search box (a combo box, "What do you want to play?") shows the query, with + for spaces.
function Search-Field-Matches($win, $q) {
  $norm = { param($t) (($t -replace '\+', ' ') -replace '\s+', ' ').Trim().ToLowerInvariant() }
  $cond = [System.Windows.Automation.PropertyCondition]::new($AE::ControlTypeProperty, [System.Windows.Automation.ControlType]::ComboBox)
  foreach ($e in $win.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cond)) {
    $vp = $null
    if ($e.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$vp)) {
      if ((& $norm $vp.Current.Value) -eq (& $norm $q)) { return $true }
    }
  }
  $false
}

try {
  if ($Op -eq 'search') {
    Start-Process ('spotify:search:' + [Uri]::EscapeDataString($Query))
    # Spotify may be starting up; its results come a moment after the search box shows the query,
    # and until then the last search's results are still there: wait for a result with a word of
    # this query in it.
    $words = @($Query.ToLowerInvariant() -split '\W+' | Where-Object { $_.Length -ge 3 })
    $deadline = (Get-Date).AddSeconds(20)
    $results = @()
    while ((Get-Date) -lt $deadline) {
      Start-Sleep -Milliseconds 700
      $win = Spotify-Window
      if (-not $win) { continue }
      if (-not (Search-Field-Matches $win $Query)) { continue }
      $results = Results $win
      $fresh = $results | Where-Object { $t = $_.title.ToLowerInvariant(); $words | Where-Object { $t.Contains($_) } }
      if ($results.Count -and ($fresh -or -not $words.Count)) { break }
      $results = @()
    }
    if (-not $win) { throw 'Spotify did not open.' }
    @{ results = @($results | Select-Object -First 40); title = $win.Current.Name } | ConvertTo-Json -Compress -Depth 4
  } elseif ($Op -eq 'play') {
    $win = Spotify-Window
    if (-not $win) { throw 'Spotify is not open.' }
    $i = 0
    $target = $null
    foreach ($b in (Buttons $win)) {
      if ($b.Current.Name -eq "Play $Name") {
        if ($i -eq $Index) { $target = $b; break }
        $i++
      }
    }
    if (-not $target) { throw "There is no play button for ""$Name"" any more." }
    $ip = $null
    if (-not $target.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$ip)) { throw 'That play button cannot be pressed.' }
    $before = $win.Current.Name
    $ip.Invoke()
    # The window's title becomes "Artist - Song" while something plays; when a song was already
    # playing, wait for it to change.
    $deadline = (Get-Date).AddSeconds(6)
    $title = $before
    while ((Get-Date) -lt $deadline) {
      Start-Sleep -Milliseconds 400
      $title = $win.Current.Name
      if ($title -notmatch '^Spotify( Free| Premium)?$' -and $title -ne $before) { break }
    }
    @{ title = $title; before = $before } | ConvertTo-Json -Compress
  } else {
    $win = Spotify-Window
    @{ title = $(if ($win) { $win.Current.Name } else { '' }) } | ConvertTo-Json -Compress
  }
} catch {
  @{ error = "$($_.Exception.Message)" } | ConvertTo-Json -Compress
}
