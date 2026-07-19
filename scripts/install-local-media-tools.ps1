chcp 65001 > $null
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::InputEncoding  = [System.Text.Encoding]::UTF8
$OutputEncoding           = [System.Text.Encoding]::UTF8
$PSDefaultParameterValues['*:Encoding'] = 'UTF8'

function Install-LocalMediaTools {
    param(
        [Parameter(Mandatory = $true, Position = 0)]
        [string]$SourceDirectory,
        [Parameter(Mandatory = $true, Position = 1)]
        [string]$InstallDirectory,
        [Parameter(Position = 2)]
        [string]$ThumbnailerPath
    )

    $source = (Resolve-Path -LiteralPath $SourceDirectory -ErrorAction Stop).Path
    $install = (Resolve-Path -LiteralPath $InstallDirectory -ErrorAction Stop).Path
    $destination = Join-Path $install 'sidecars'
    New-Item -ItemType Directory -Force -LiteralPath $destination | Out-Null

    $required = @{
        'ffmpeg.exe'  = 'ffmpeg-x86_64-pc-windows-msvc.exe'
        'ffprobe.exe' = 'ffprobe-x86_64-pc-windows-msvc.exe'
    }
    foreach ($entry in $required.GetEnumerator()) {
        $sourceFile = Join-Path $source $entry.Key
        if (-not (Test-Path -LiteralPath $sourceFile -PathType Leaf)) {
            throw "找不到用户已下载的 $($entry.Key)：$sourceFile"
        }
        Copy-Item -LiteralPath $sourceFile -Destination (Join-Path $destination $entry.Value) -Force
    }

    if ($ThumbnailerPath) {
        $thumbnailer = (Resolve-Path -LiteralPath $ThumbnailerPath -ErrorAction Stop).Path
        Copy-Item -LiteralPath $thumbnailer -Destination (Join-Path $destination 'ffmpegthumbnailer-x86_64-pc-windows-msvc.exe') -Force
    }

    Write-Host "媒体工具已复制到：$destination"
    Write-Host '脚本未下载或分发二进制文件；请自行保留来源、哈希和许可证信息。'
}

Install-LocalMediaTools @args
