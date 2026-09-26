# make-bad-deck.ps1 - build a .pptx with KNOWN defects through PowerPoint, for
# `node deck-check.js --live-check`. Each slide carries the defects the live
# check expects to fire; slide 5 is clean and must produce nothing.
#   1 overflow: 30 lines in a body box with autosize off (overflow + off-slide)
#   2 12 pt light-gray body text (font size + contrast)
#   3 blank layout, a picture with no alt text (no title + alt)
#   4 same title as slide 2 (duplicate title)
#   5 white 24 pt text on a dark rectangle, titled (clean)
param([Parameter(Mandatory = $true)][string]$Out)
$ErrorActionPreference = 'Stop'
$wasRunning = [bool](Get-Process POWERPNT -ErrorAction SilentlyContinue)
$app = New-Object -ComObject PowerPoint.Application
$pres = $null
try {
  $pres = $app.Presentations.Add(0)   # WithWindow = msoFalse
  # ppLayoutText = 2, ppLayoutBlank = 12, ppLayoutTitleOnly = 11
  $s1 = $pres.Slides.Add(1, 2)
  $s1.Shapes.Item(1).TextFrame.TextRange.Text = 'Overflow'
  $b = $s1.Shapes.Item(2)
  $b.TextFrame2.AutoSize = 0
  $b.TextFrame.TextRange.Text = (1..30 | ForEach-Object { "Line $_ of text that does not fit" }) -join "`r"

  $s2 = $pres.Slides.Add(2, 2)
  $s2.Shapes.Item(1).TextFrame.TextRange.Text = 'Small and faint'
  $t = $s2.Shapes.Item(2).TextFrame.TextRange
  $t.Text = 'This body text is twelve point and light gray.'
  $t.Font.Size = 12
  $t.Font.Color.RGB = 0xBBBBBB

  $png = Join-Path ([System.IO.Path]::GetDirectoryName($Out)) 'known-bad-pic.png'
  $s1.Export($png, 'PNG', 640, 360)
  $s3 = $pres.Slides.Add(3, 12)
  $pic = $s3.Shapes.AddPicture($png, 0, -1, 100, 100, 400, 225)   # LinkToFile=msoFalse, SaveWithDocument=msoTrue
  $pic.AlternativeText = ''

  $s4 = $pres.Slides.Add(4, 11)
  $s4.Shapes.Item(1).TextFrame.TextRange.Text = 'Small and faint'

  $s5 = $pres.Slides.Add(5, 11)
  $s5.Shapes.Item(1).TextFrame.TextRange.Text = 'Clean slide'
  $panel = $s5.Shapes.AddShape(1, 60, 170, 840, 320)             # msoShapeRectangle
  $panel.Fill.ForeColor.RGB = 0x37291F                           # BGR for #1F2937
  $panel.Line.Visible = 0
  $box = $s5.Shapes.AddTextbox(1, 100, 220, 700, 60)             # msoTextOrientationHorizontal
  $box.TextFrame.TextRange.Text = 'White text on a dark panel'
  $box.TextFrame.TextRange.Font.Size = 24
  $box.TextFrame.TextRange.Font.Color.RGB = 0xFFFFFF

  $pres.SaveAs($Out)
} finally {
  if ($pres) { $pres.Close() }
  if (-not $wasRunning) { $app.Quit() }
  [System.Runtime.InteropServices.Marshal]::ReleaseComObject($app) | Out-Null
}
