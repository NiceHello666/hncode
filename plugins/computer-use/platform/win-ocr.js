// The Windows OCR backend: read text that no control tree exposes.
//
// WHY THIS EXISTS
// ---------------
// The control tree is the better route when it has anything, but some windows have none: a game, a
// canvas, a chat pane drawn by hand, an image on screen. Screenshots let a model LOOK at those, but
// reading a word off a picture gives it no way to click that word — the pixel is in the image, not
// on the screen.
//
// Windows.Media.Ocr is part of the operating system, so there is nothing to install. It returns a
// bounding box per word, and this backend converts each box back to SCREEN coordinates, which is
// what makes the result actionable: the model can read "发送" and then click it.
//
// THE COORDINATE ARITHMETIC IS THE WHOLE POINT, and it has two steps that are easy to get wrong:
//   1. the image is upscaled before recognition (small text, and CJK especially, recognises far
//      better at 2x), so every box must be DIVIDED by the scale to return to image pixels;
//   2. the image is a crop of the window, so the window's own origin must be ADDED back.
// Skipping either yields boxes that look plausible and click the wrong place.
import path from 'node:path';
import { run, have, unsupported, shotPath, intArg } from './util.js';

const isWin = process.platform === 'win32';

/** Whether this machine can run the OCR engine at all. */
export async function ocrAvailable() {
  if (!isWin) return false;
  return (await have('pwsh')) || (await have('powershell'));
}

/**
 * The PowerShell that recognises text in an image file.
 *
 * WinRT types are reached through `[Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType=WindowsRuntime]`
 * because PowerShell 5.1 and 7 do not have the projection loaded by default. `AsTask` bridges the
 * WinRT async operation to something PowerShell can wait on — without it the call returns an
 * IAsyncOperation that is never awaited and the result is empty.
 */
const OCR_SCRIPT = (file, originX, originY) => `
# Force UTF-8 on the way out, BEFORE anything is written.
#
# The recognised text is exactly what this must not mangle: Chinese arrives as "锟斤拷" without it,
# because the console's codepage (GBK here) encodes the stream and every CJK line is destroyed. The
# boxes would still be right and the words unreadable.
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
  $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1'
})[0]
function Await($op, $type) {
  $t = $asTaskGeneric.MakeGenericMethod($type).Invoke($null, @($op))
  $t.Wait(-1) | Out-Null
  return $t.Result
}

[Windows.Storage.StorageFile, Windows.Storage, ContentType=WindowsRuntime] | Out-Null
[Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType=WindowsRuntime] | Out-Null
[Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType=WindowsRuntime] | Out-Null

# A language-specific engine first, then the user profile: a profile with no OCR language
# installed returns null, and TryCreateFromLanguage then TryCreateFromUserProfileLanguages
# is the order that finds an engine whenever one exists.
$eng = $null
foreach ($tag in @('zh-CN', 'en-US')) {
  try { $eng = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage((New-Object Windows.Globalization.Language $tag)) } catch { }
  if ($null -ne $eng) { break }
}
if ($null -eq $eng) {
  try { $eng = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages() } catch { }
}
if ($null -eq $eng) { Write-Output '__CUERR__no OCR engine (no OCR language pack installed)'; exit }

$file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync('${file.replace(/'/g, "''")}')) ([Windows.Storage.StorageFile])
$stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
$decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
$swBitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])

# --- scale before recognising -------------------------------------------------
#
# TWO RULES, both measured rather than assumed:
#
#   SMALL images are upscaled 2x. The engine reads small glyphs poorly, and CJK worst of all:
#   at native size a 12px chat line came back with a common character misread as a near-identical
#   one. Doubling the pixels before recognition is what fixes that class of error.
#
#   LARGE images are downscaled to OcrEngine.MaxImageDimension. Without this the engine refuses
#   or silently crops anything oversized.
#
# The scale factor is carried out to the caller, where every box is divided by it, and it is
# reported so two calls can be compared when quality differs.
Add-Type -AssemblyName System.Drawing
$scale = 1.0
$ow = $swBitmap.PixelWidth
$oh = $swBitmap.PixelHeight
$maxDim = [Windows.Media.Ocr.OcrEngine]::MaxImageDimension

$needResize = $false
if ($ow -gt $maxDim -or $oh -gt $maxDim) {
  $scale = [Math]::Min([double]$maxDim / $ow, [double]$maxDim / $oh)
  $needResize = $true
} elseif ($ow * $oh -le 1500000) {
  $scale = 2.0
  $needResize = $true
}

if ($needResize) {
  # Via a PNG, because System.Drawing cannot be handed a WinRT SoftwareBitmap directly.
  $tmp = Join-Path $env:TEMP ('hncode-ocr-scale-' + [Guid]::NewGuid().ToString('N') + '.png')
  # GetFileFromPathAsync requires the file to EXIST — it looks the path up rather than creating it —
  # and returns null for a missing one, which then fails three lines later as a null dereference.
  [System.IO.File]::WriteAllBytes($tmp, @())
  [Windows.Graphics.Imaging.BitmapEncoder, Windows.Graphics.Imaging, ContentType=WindowsRuntime] | Out-Null
  $encFile = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($tmp)) ([Windows.Storage.StorageFile])
  $encStream = Await ($encFile.OpenAsync([Windows.Storage.FileAccessMode]::ReadWrite)) ([Windows.Storage.Streams.IRandomAccessStream])
  $encoder = Await ([Windows.Graphics.Imaging.BitmapEncoder]::CreateAsync([Windows.Graphics.Imaging.BitmapEncoder]::PngEncoderId, $encStream)) ([Windows.Graphics.Imaging.BitmapEncoder])
  $encoder.SetSoftwareBitmap($swBitmap)
  # FlushAsync returns an IAsyncACTION, not an IAsyncOperation<T>, so the generic Await above cannot
  # take it — and .AsTask() is not a method on the returned COM object either. The conversion is an
  # extension method on System.WindowsRuntimeSystemExtensions, reached explicitly by its parameter
  # type.
  $asTaskAction = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
    $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncAction'
  })[0]
  $asTaskAction.Invoke($null, @($encoder.FlushAsync())).Wait(-1) | Out-Null
  $encStream.Dispose()

  $nw = [Math]::Max(1, [int][Math]::Round($ow * $scale))
  $nh = [Math]::Max(1, [int][Math]::Round($oh * $scale))
  $src = [System.Drawing.Image]::FromFile($tmp)
  $dst = New-Object System.Drawing.Bitmap $nw, $nh
  $g = [System.Drawing.Graphics]::FromImage($dst)
  # HighQualityBicubic, not the default: on an upscale the default NearestNeighbor produces
  # blocky glyphs that the engine reads worse than the original.
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.DrawImage($src, 0, 0, $nw, $nh)
  $src.Dispose()
  $scaled = Join-Path $env:TEMP ('hncode-ocr-scaled-' + [Guid]::NewGuid().ToString('N') + '.png')
  $dst.Save($scaled, [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $dst.Dispose()

  $sf = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($scaled)) ([Windows.Storage.StorageFile])
  $ss = Await ($sf.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
  $sd = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($ss)) ([Windows.Graphics.Imaging.BitmapDecoder])
  $swBitmap = Await ($sd.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
  Remove-Item $tmp, $scaled -Force -ErrorAction SilentlyContinue
}

Write-Output ("#scale" + [char]9 + $scale)
$res = Await ($eng.RecognizeAsync($swBitmap)) ([Windows.Media.Ocr.OcrResult])

Write-Output ('#lang' + "\`t" + $eng.RecognizerLanguage.LanguageTag)
# Each line, then each word, with the box in SCREEN pixels:
#   img/scale + origin  — undo the upscale, add the crop's position on screen.
foreach ($line in $res.Lines) {
  $txt = ''
  foreach ($w in $line.Words) { $txt += $w.Text }
  Write-Output ('#line' + "\`t" + ($txt -replace "\`t", ' '))
  foreach ($w in $line.Words) {
    $r = $w.BoundingRect
    $cx = [int][Math]::Round((($r.X + $r.Width / 2) / $scale)) + ${originX}
    $cy = [int][Math]::Round((($r.Y + $r.Height / 2) / $scale)) + ${originY}
    $x  = [int][Math]::Round(($r.X / $scale)) + ${originX}
    $y  = [int][Math]::Round(($r.Y / $scale)) + ${originY}
    $ww = [Math]::Max(1, [int][Math]::Round(($r.Width / $scale)))
    $hh = [Math]::Max(1, [int][Math]::Round(($r.Height / $scale)))
    Write-Output ('#w' + "\`t" + ($w.Text -replace "\`t", ' ') + "\`t" + $x + "\`t" + $y + "\`t" + $ww + "\`t" + $hh + "\`t" + $cx + "\`t" + $cy)
  }
}
`;

/** Parse the tab-separated lines the script emits. */
export function parseOcr(text) {
  const lines = [];
  let lang = '';
  // The script's own scaling factor, decided once it has seen the image.
  let scale = 1;
  let current = null;
  for (const raw of String(text).split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (!line.startsWith('#')) continue;
    const f = line.split('\t');
    if (f[0] === '#lang') { lang = f[1] || ''; continue; }
    if (f[0] === '#scale') { scale = Number(f[1]) || 1; continue; }
    if (f[0] === '#line') { current = { text: f[1] || '', words: [] }; lines.push(current); continue; }
    if (f[0] === '#w' && current) {
      current.words.push({
        text: f[1] || '',
        x: Number(f[2]), y: Number(f[3]), width: Number(f[4]), height: Number(f[5]),
        cx: Number(f[6]), cy: Number(f[7]),
      });
    }
  }
  return { lang, lines, scale };
}

/**
 * Recognise text in a PNG, returning words with SCREEN coordinates.
 *
 * `origin` is where the image sits on the virtual desktop. The scale factor is NOT a parameter: the
 * script decides it after seeing the image (2x for a small one, a fit-to-limit reduction for a large
 * one) and reports it back, so the box arithmetic stays inside one place instead of being duplicated
 * between caller and script.
 */
export async function ocrImage(file, { originX = 0, originY = 0 } = {}) {
  if (!isWin) return unsupported('OCR on Windows only');
  // WINDOWS POWERSHELL 5.1, not pwsh. The WinRT projection is absent from PowerShell 7: loading
  // Windows.Media.Ocr.OcrEngine there fails with "Unable to find type", while 5.1 loads it and
  // reports the engine's language (measured: zh-Hans-CN). Preferring pwsh because it starts
  // faster would make this capability silently unavailable on every machine.
  const exe = (await have('powershell')) ? 'powershell' : 'pwsh';
  const script = OCR_SCRIPT(file, Math.round(originX), Math.round(originY));
  const wrapped = `try {\n${script}\n} catch { Write-Output ("__CUERR__" + $_.Exception.Message) }`;
  const out = await run(exe, ['-NoProfile', '-NonInteractive', '-Command', wrapped], {
    timeoutMs: 120000, maxBuffer: 32 * 1024 * 1024,
  });
  const err = /__CUERR__(.*)/.exec(out);
  if (err) return { error: err[1].trim() };
  const parsed = parseOcr(out);
  const words = parsed.lines.flatMap((l) => l.words);
  return {
    lang: parsed.lang,
    scale: parsed.scale,
    lines: parsed.lines.map((l) => ({ text: l.text, words: l.words })),
    words,
    text: parsed.lines.map((l) => l.text).join('\n'),
  };
}

export { isWin };
