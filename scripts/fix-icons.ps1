Add-Type -AssemblyName System.Drawing

Add-Type -TypeDefinition @"
using System;
using System.Drawing;
using System.Drawing.Imaging;

public static class AegisIconTool {
  public static void KeyWhite(string sourcePath, string targetPath) {
    using (var source = new Bitmap(sourcePath))
    using (var bmp = new Bitmap(source.Width, source.Height, PixelFormat.Format32bppArgb)) {
      using (var g = Graphics.FromImage(bmp)) {
        g.CompositingMode = System.Drawing.Drawing2D.CompositingMode.SourceCopy;
        g.DrawImage(source, 0, 0, source.Width, source.Height);
      }
      for (int y = 0; y < bmp.Height; y++) {
        for (int x = 0; x < bmp.Width; x++) {
          Color c = bmp.GetPixel(x, y);
          int min = Math.Min(c.R, Math.Min(c.G, c.B));
          if (min >= 242) {
            bmp.SetPixel(x, y, Color.Transparent);
          } else if (min >= 228) {
            int alpha = Math.Max(0, (242 - min) * 18);
            bmp.SetPixel(x, y, Color.FromArgb(Math.Min(255, alpha), c.R, c.G, c.B));
          }
        }
      }
      bmp.Save(targetPath, ImageFormat.Png);
    }
  }

  public static void Resize(string sourcePath, string targetPath, int size) {
    using (var source = new Bitmap(sourcePath))
    using (var bmp = new Bitmap(size, size, PixelFormat.Format32bppArgb))
    using (var g = Graphics.FromImage(bmp)) {
      g.CompositingMode = System.Drawing.Drawing2D.CompositingMode.SourceCopy;
      g.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.HighQualityBicubic;
      g.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.HighQuality;
      g.PixelOffsetMode = System.Drawing.Drawing2D.PixelOffsetMode.HighQuality;
      g.DrawImage(source, 0, 0, size, size);
      bmp.Save(targetPath, ImageFormat.Png);
    }
  }
}
"@ -ReferencedAssemblies System.Drawing

$root = Split-Path -Parent $PSScriptRoot
$assets = Join-Path $root 'assets'
$build = Join-Path $root 'build'
New-Item -ItemType Directory -Force -Path $build | Out-Null

$master = Join-Path $assets 'icon.png'
$temp = Join-Path $build 'icon-clean.png'
[AegisIconTool]::KeyWhite($master, $temp)

[AegisIconTool]::Resize($temp, $master, 1024)
[AegisIconTool]::Resize($temp, (Join-Path $assets 'bot-avatar.png'), 512)
[AegisIconTool]::Resize($temp, (Join-Path $assets 'server-icon.png'), 512)
[AegisIconTool]::Resize($temp, (Join-Path $root 'renderer\aegis.png'), 256)
[AegisIconTool]::Resize($temp, (Join-Path $root 'server\public\icon.png'), 256)

$sizes = @(16, 24, 32, 48, 64, 128, 256)
$payloads = @()
foreach ($size in $sizes) {
  $path = Join-Path $build ("ico-" + $size + ".png")
  [AegisIconTool]::Resize($temp, $path, $size)
  $payloads += ,[System.IO.File]::ReadAllBytes($path)
}

$stream = New-Object System.IO.MemoryStream
$writer = New-Object System.IO.BinaryWriter($stream)
$writer.Write([UInt16]0)
$writer.Write([UInt16]1)
$writer.Write([UInt16]$sizes.Count)
$offset = 6 + (16 * $sizes.Count)
for ($index = 0; $index -lt $sizes.Count; $index++) {
  $size = $sizes[$index]
  $writer.Write([Byte]$(if ($size -ge 256) { 0 } else { $size }))
  $writer.Write([Byte]$(if ($size -ge 256) { 0 } else { $size }))
  $writer.Write([Byte]0)
  $writer.Write([Byte]0)
  $writer.Write([UInt16]1)
  $writer.Write([UInt16]32)
  $writer.Write([UInt32]$payloads[$index].Length)
  $writer.Write([UInt32]$offset)
  $offset += $payloads[$index].Length
}
foreach ($payload in $payloads) { $writer.Write($payload) }
$writer.Flush()
[System.IO.File]::WriteAllBytes((Join-Path $build 'icon.ico'), $stream.ToArray())
$writer.Dispose()
$stream.Dispose()

Remove-Item -Force $temp
Get-ChildItem $build -Filter 'ico-*.png' | Remove-Item -Force
Write-Output "Aegis icons rebuilt from one transparent master."
