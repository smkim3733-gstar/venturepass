// Fixed program only. No source names, IDs, user paths or command fragments enter this script.
// Windows.Media.Ocr uses the installed Korean language pack, with no GPU PDF renderer/cache.
export const windowsOcrScript = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$taskBase = (Get-Location).Path
$utf8 = New-Object System.Text.UTF8Encoding($false)
$outputPath = Join-Path $taskBase 'output.json'
$timer = [System.Diagnostics.Stopwatch]::StartNew()
$script:totalCharacters = 0
function Check-Time {
    if ($timer.ElapsedMilliseconds -ge 115000) { throw 'OCR_TIMEOUT' }
}
try {
    Add-Type -AssemblyName System.Runtime.WindowsRuntime
    [void][Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
    [void][Windows.Storage.Streams.IRandomAccessStream, Windows.Storage.Streams, ContentType = WindowsRuntime]
    [void][Windows.Storage.Streams.InMemoryRandomAccessStream, Windows.Storage.Streams, ContentType = WindowsRuntime]
    [void][Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType = WindowsRuntime]
    [void][Windows.Graphics.Imaging.SoftwareBitmap, Windows.Graphics.Imaging, ContentType = WindowsRuntime]
    [void][Windows.Graphics.Imaging.BitmapTransform, Windows.Graphics.Imaging, ContentType = WindowsRuntime]
    [void][Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
    [void][Windows.Media.Ocr.OcrResult, Windows.Foundation, ContentType = WindowsRuntime]
    [void][Windows.Globalization.Language, Windows.Globalization, ContentType = WindowsRuntime]
    $asTaskMethod = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
        $_.Name -eq 'AsTask' -and $_.IsGenericMethod -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq ('IAsyncOperation' + [char]96 + '1')
    } | Select-Object -First 1
    function Await-WinRt($operation, [Type]$resultType) {
        Check-Time
        $task = $asTaskMethod.MakeGenericMethod($resultType).Invoke($null, @($operation))
        $remaining = [Math]::Min(30000, 115000 - $timer.ElapsedMilliseconds)
        if ($remaining -le 0 -or -not $task.Wait([int]$remaining)) { throw 'OCR_TIMEOUT' }
        return $task.Result
    }
    $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage((New-Object Windows.Globalization.Language('ko')))
    if ($null -eq $engine) { throw 'OCR_LANGUAGE_UNAVAILABLE' }
    $limit = [Math]::Min(2200, [Windows.Media.Ocr.OcrEngine]::MaxImageDimension)
    function Read-Image($stream) {
        $bitmap = $null
        try {
            $stream.Seek(0)
            $decoder = Await-WinRt ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
            $width = [double]$decoder.PixelWidth
            $height = [double]$decoder.PixelHeight
            if ($width -lt 1 -or $height -lt 1 -or $width * $height -gt 20000000 -or $width -gt 20000 -or $height -gt 20000) { throw 'OCR_IMAGE_LIMIT' }
            if ($decoder.FrameCount -ne 1) { throw 'OCR_MULTIFRAME_UNSUPPORTED' }
            $scale = [Math]::Min(1.0, $limit / [Math]::Max($width, $height))
            $transform = New-Object Windows.Graphics.Imaging.BitmapTransform
            $transform.ScaledWidth = [uint32][Math]::Max(1, [Math]::Floor($width * $scale))
            $transform.ScaledHeight = [uint32][Math]::Max(1, [Math]::Floor($height * $scale))
            $bitmap = Await-WinRt ($decoder.GetSoftwareBitmapAsync([Windows.Graphics.Imaging.BitmapPixelFormat]::Bgra8, [Windows.Graphics.Imaging.BitmapAlphaMode]::Premultiplied, $transform, [Windows.Graphics.Imaging.ExifOrientationMode]::RespectExifOrientation, [Windows.Graphics.Imaging.ColorManagementMode]::DoNotColorManage)) ([Windows.Graphics.Imaging.SoftwareBitmap])
            if ($bitmap.PixelWidth -gt $limit -or $bitmap.PixelHeight -gt $limit) { throw 'OCR_IMAGE_LIMIT' }
            $result = Await-WinRt ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
            $text = ($result.Lines | ForEach-Object { $_.Text }) -join [Environment]::NewLine
            $script:totalCharacters += $text.Length
            if ($script:totalCharacters -gt 100000) { throw 'OCR_OUTPUT_LIMIT' }
            return $text
        } finally {
            if ($null -ne $bitmap) { $bitmap.Dispose() }
        }
    }
    $pages = New-Object 'System.Collections.Generic.List[object]'
    $isPdf = [System.IO.File]::Exists((Join-Path $taskBase 'input.pdf'))
    if ($isPdf) {
        $rendered = [System.IO.File]::ReadAllText((Join-Path $taskBase 'rendered.json'), $utf8) | ConvertFrom-Json
        if ($rendered.pages -isnot [int] -or $rendered.pages -lt 1 -or $rendered.pages -gt 20) { throw 'OCR_PAGE_LIMIT' }
        for ($index = 1; $index -le $rendered.pages; $index++) {
            Check-Time
            $stream = $null
            try {
                $imagePath = Join-Path $taskBase ('page-' + $index + '.png')
                $file = Await-WinRt ([Windows.Storage.StorageFile]::GetFileFromPathAsync($imagePath)) ([Windows.Storage.StorageFile])
                $stream = Await-WinRt ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
                $text = Read-Image $stream
                $pages.Add(@{ pageNumber = $index; text = [string]$text })
            } finally {
                if ($null -ne $stream) { $stream.Dispose() }
            }
        }
    } else {
        $stream = $null
        try {
            $file = Await-WinRt ([Windows.Storage.StorageFile]::GetFileFromPathAsync((Join-Path $taskBase 'input.img'))) ([Windows.Storage.StorageFile])
            $stream = Await-WinRt ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
            $pages.Add(@{ pageNumber = 1; text = [string](Read-Image $stream) })
        } finally {
            if ($null -ne $stream) { $stream.Dispose() }
        }
    }
    Check-Time
    [System.IO.File]::WriteAllText($outputPath, (@{ pages = @($pages.ToArray()) } | ConvertTo-Json -Depth 5 -Compress), $utf8)
    exit 0
} catch {
    $knownCodes = @('OCR_LANGUAGE_UNAVAILABLE', 'OCR_TIMEOUT', 'OCR_PAGE_LIMIT', 'OCR_IMAGE_LIMIT', 'OCR_OUTPUT_LIMIT', 'OCR_MULTIFRAME_UNSUPPORTED')
    $code = if ($knownCodes -contains $_.Exception.Message) { $_.Exception.Message } else { 'OCR_FAILED' }
    [System.IO.File]::WriteAllText($outputPath, (@{ failureCode = $code } | ConvertTo-Json -Compress), $utf8)
    exit 1
}
`;

/** CPU rendering in a separate bounded Node process; PDF data never becomes code or a URL. */
export const pdfRenderScript = String.raw`
const fs = require('node:fs');
const path = require('node:path');
globalThis.fetch = async () => { throw new Error('NETWORK_DISABLED'); };
const { PDFParse } = require(process.env.VENTURE_OCR_PDF_MODULE);
const root = __dirname;
let parser;
(async () => {
  try {
    const data = fs.readFileSync(path.join(root, 'input.pdf'));
    if (!data.length || data.length > 12 * 1024 * 1024) throw new Error('OCR_FAILED');
    parser = new PDFParse({ data: new Uint8Array(data), isEvalSupported: false, useWorkerFetch: false, maxImageSize: 20000000, canvasMaxAreaInBytes: 20000000, verbosity: 0 });
    const info = await parser.getInfo();
    if (!Number.isInteger(info.total) || info.total < 1 || info.total > 20) throw new Error('OCR_PAGE_LIMIT');
    const dimensions = await parser.getInfo({ parsePageInfo: true });
    if (dimensions.pages.length !== info.total) throw new Error('OCR_FAILED');
    let totalBytes = 0;
    for (let index = 0; index < info.total; index++) {
      const { width, height, pageNumber } = dimensions.pages[index];
      if (pageNumber !== index + 1 || !Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) throw new Error('OCR_IMAGE_LIMIT');
      const image = await parser.getScreenshot({ partial: [pageNumber], scale: 2200 / Math.max(width, height), imageBuffer: true, imageDataUrl: false });
      const page = image.pages[0];
      if (image.pages.length !== 1 || !page || page.width < 1 || page.height < 1 || page.width > 2200 || page.height > 2200) throw new Error('OCR_IMAGE_LIMIT');
      totalBytes += page.data.byteLength;
      if (page.data.byteLength > 20 * 1024 * 1024 || totalBytes > 120 * 1024 * 1024) throw new Error('OCR_IMAGE_LIMIT');
      fs.writeFileSync(path.join(root, 'page-' + pageNumber + '.png'), page.data, { flag: 'wx', mode: 0o600 });
    }
    fs.writeFileSync(path.join(root, 'rendered.json'), JSON.stringify({ pages: info.total }), { flag: 'wx', mode: 0o600 });
  } catch (error) {
    const allowed = ['OCR_PAGE_LIMIT', 'OCR_IMAGE_LIMIT'];
    fs.writeFileSync(path.join(root, 'output.json'), JSON.stringify({ failureCode: allowed.includes(error?.message) ? error.message : 'OCR_FAILED' }), { flag: 'wx', mode: 0o600 });
    process.exitCode = 1;
  } finally {
    if (parser) await parser.destroy();
  }
})().catch(() => { process.exitCode = 1; });
`;
