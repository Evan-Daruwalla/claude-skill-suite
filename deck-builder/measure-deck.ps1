# measure-deck.ps1 - measure a .pptx through the installed PowerPoint (COM) and
# write what the checker needs as UTF-8 JSON. Optional PNG render per slide.
#
# Called by deck-check.js; not meant to be run by hand. PowerPoint does the
# layout, so text heights are PowerPoint's own (TextRange2.BoundHeight), not an
# estimate. The deck is opened read-only with no window. PowerPoint is quit
# ONLY if this script started it, so an open PowerPoint session is left alone.
#
# Colors: COM returns RGB as a Long in BGR order (R + G*256 + B*65536). They
# are passed through raw; deck-check.js converts them.
param(
  [Parameter(Mandatory = $true)][string]$Deck,
  [Parameter(Mandatory = $true)][string]$Out,
  [string]$Renders = '',
  [int]$RenderWidth = 1600
)
$ErrorActionPreference = 'Stop'

function Get-FillInfo($fill) {
  # Type 1 = solid. Anything else (picture, gradient, pattern, texture) cannot
  # be reduced to one color, so the checker treats it as unknown.
  try {
    if ($fill.Visible -ne -1) { return @{ visible = $false } }
    return @{ visible = $true; type = [int]$fill.Type; rgb = [int]$fill.ForeColor.RGB; transparency = [double]$fill.Transparency }
  } catch { return @{ visible = $true; type = -1 } }
}

function Get-BackgroundFill($slide) {
  # Walk slide -> layout -> master until something does not follow its parent.
  if ($slide.FollowMasterBackground -ne -1) { return Get-FillInfo $slide.Background.Fill }
  $layout = $slide.CustomLayout
  if ($layout.FollowMasterBackground -ne -1) { return Get-FillInfo $layout.Background.Fill }
  return Get-FillInfo $slide.Master.Background.Fill
}

function Get-Runs($tr2) {
  $runs = @()
  $n = $tr2.Runs().Count
  for ($i = 1; $i -le $n; $i++) {
    $r = $tr2.Runs($i, 1)
    if (-not $r.Text.Trim()) { continue }
    $runs += @{
      text = [string]$r.Text
      size = [double]$r.Font.Size
      name = [string]$r.Font.Name
      bold = ($r.Font.Bold -eq -1)
      rgb  = [int]$r.Font.Fill.ForeColor.RGB
    }
  }
  return ,$runs
}

function Measure-Shape($sh, $slideIndex) {
  $m = @{
    name = [string]$sh.Name; type = [int]$sh.Type; z = [int]$sh.ZOrderPosition
    left = [double]$sh.Left; top = [double]$sh.Top; width = [double]$sh.Width; height = [double]$sh.Height
    fill = $null; isTitle = $false; hasText = $false; isPicture = $false; hasChart = $false
    alt = ''; decorative = $false
  }
  try { $m.alt = [string]$sh.AlternativeText } catch {}
  try { $m.decorative = ($sh.Decorative -eq -1) } catch {}
  try { $m.fill = Get-FillInfo $sh.Fill } catch {}
  if ($sh.Type -eq 14) {
    # ppPlaceholderTitle = 1, ppPlaceholderCenterTitle = 3; slide number 13, footer 15, date 16
    $pt = [int]$sh.PlaceholderFormat.Type
    $m.phType = $pt
    $m.isTitle = ($pt -eq 1 -or $pt -eq 3)
  }
  $m.isPicture = ($sh.Type -in 11, 13, 28)
  try { $m.hasChart = ($sh.HasChart -eq -1) } catch {}
  if ($sh.HasTextFrame -eq -1 -and $sh.TextFrame2.HasText -eq -1) {
    $tr = $sh.TextFrame2.TextRange
    $m.hasText = $true
    $m.text = [string]$tr.Text
    $m.autoSize = [int]$sh.TextFrame2.AutoSize
    $m.boundTop = [double]$tr.BoundTop; $m.boundLeft = [double]$tr.BoundLeft
    $m.boundHeight = [double]$tr.BoundHeight; $m.boundWidth = [double]$tr.BoundWidth
    $m.runs = Get-Runs $tr
  }
  if ($sh.HasTable -eq -1) {
    # Table cells: font sizes and colors only. Cells grow to fit, so no overflow check.
    $cells = @()
    $t = $sh.Table
    for ($r = 1; $r -le $t.Rows.Count; $r++) {
      for ($c = 1; $c -le $t.Columns.Count; $c++) {
        $cs = $t.Cell($r, $c).Shape
        if ($cs.TextFrame2.HasText -eq -1) {
          $cells += @{ row = $r; col = $c; fill = (Get-FillInfo $cs.Fill); runs = (Get-Runs $cs.TextFrame2.TextRange) }
        }
      }
    }
    $m.tableCells = $cells
  }
  return $m
}

$deckPath = (Resolve-Path -LiteralPath $Deck).Path
$wasRunning = [bool](Get-Process POWERPNT -ErrorAction SilentlyContinue)
$app = New-Object -ComObject PowerPoint.Application
$pres = $null
try {
  # ReadOnly = msoTrue (-1), Untitled = msoFalse (0), WithWindow = msoFalse (0)
  $pres = $app.Presentations.Open($deckPath, -1, 0, 0)
  $W = [double]$pres.PageSetup.SlideWidth; $H = [double]$pres.PageSetup.SlideHeight
  $installed = @{}
  Add-Type -AssemblyName System.Drawing
  foreach ($f in (New-Object System.Drawing.Text.InstalledFontCollection).Families) { $installed[$f.Name] = $true }
  $fontsUsed = @()
  for ($i = 1; $i -le $pres.Fonts.Count; $i++) {
    $fn = [string]$pres.Fonts.Item($i).Name
    $fontsUsed += @{ name = $fn; installed = [bool]$installed[$fn] }
  }
  $slides = @()
  foreach ($s in $pres.Slides) {
    $shapes = @()
    foreach ($sh in $s.Shapes) {
      if ($sh.Type -eq 6) {
        # Group: measure members; they share the group's z position.
        foreach ($g in $sh.GroupItems) { $gm = Measure-Shape $g $s.SlideIndex; $gm.z = [int]$sh.ZOrderPosition; $gm.group = [string]$sh.Name; $shapes += $gm }
      } else {
        $shapes += Measure-Shape $sh $s.SlideIndex
      }
    }
    $title = ''
    if ($s.Shapes.HasTitle -eq -1) { $title = [string]$s.Shapes.Title.TextFrame.TextRange.Text }
    $notes = ''
    try { $notes = [string]$s.NotesPage.Shapes.Placeholders(2).TextFrame.TextRange.Text } catch {}
    $render = ''
    if ($Renders) {
      New-Item -ItemType Directory -Force -Path $Renders | Out-Null
      $render = Join-Path $Renders ('slide-{0:D2}.png' -f $s.SlideIndex)
      $s.Export($render, 'PNG', $RenderWidth, [int]($RenderWidth * $H / $W))
    }
    $slides += @{ index = [int]$s.SlideIndex; hasTitle = ($s.Shapes.HasTitle -eq -1); title = $title; notes = $notes; background = (Get-BackgroundFill $s); shapes = $shapes; render = $render }
  }
  $result = @{ deck = $deckPath; slideWidth = $W; slideHeight = $H; fonts = $fontsUsed; slides = $slides; measuredWith = ('PowerPoint ' + $app.Version) }
  $json = $result | ConvertTo-Json -Depth 12
  [System.IO.File]::WriteAllText($Out, $json, (New-Object System.Text.UTF8Encoding($false)))
} finally {
  if ($pres) { $pres.Close() }
  if (-not $wasRunning) { $app.Quit() }
  [System.Runtime.InteropServices.Marshal]::ReleaseComObject($app) | Out-Null
}
