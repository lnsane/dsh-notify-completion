#requires -Version 5.1
<#
  Windows notification shim for the dsh-notify-completion plugin.

  Pure ASCII on purpose: every user-visible string arrives base64-encoded in
  -PayloadBase64, so this file never depends on how a PowerShell host guesses a
  file's encoding, and no quotemark or newline in a session title can be
  misparsed as command-line syntax.

  Tiers, best first:
    1. Windows Runtime toast, posted under an HKCU-registered AppUserModelId
       (no shortcut and no extra module required).
    2. BurntToast module, when the WinRT path is unavailable.
    3. A WScript.Shell message box that closes itself after the payload's
       fallbackSeconds.

  Exit code 0 means "a notification was actually shown".
#>
[CmdletBinding()]
param(
    # UTF-8 JSON, base64-encoded:
    # { title, message, appId, appName, fallbackSeconds, silent }.
    [string]$PayloadBase64,

    # Manual-use alternatives to -PayloadBase64 (tests and hand checks).
    [string]$Title,
    [string]$Message,

    # AppUserModelId registered under HKCU when missing.
    [string]$AppId = 'DeepSeek.Harness.CompletionNotify',
    [string]$AppName = 'DeepSeek Harness',

    # Seconds before the WScript.Shell fallback closes itself (0 = wait forever).
    [int]$FallbackSeconds = 10,

    # Skip the HKCU registration (used by tests that must not touch the registry).
    [switch]$NoRegister,

    # Post the toast without its default sound.
    [switch]$Silent,

    # Print the tier that actually delivered the notification (for diagnosis).
    [switch]$Diagnostic
)

$ErrorActionPreference = 'Stop'

# --------------------------------------------------------------------------
# Payload
# --------------------------------------------------------------------------
# Base64 keeps the transport ASCII-only; the JSON inside is decoded as UTF-8 so
# non-Latin session titles survive intact.
if ($PayloadBase64) {
    try {
        $json = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($PayloadBase64))
        $payload = $json | ConvertFrom-Json
    }
    catch {
        [Console]::Error.WriteLine('notify-windows: -PayloadBase64 is not valid base64 JSON')
        exit 2
    }

    if ($payload.title) { $Title = [string]$payload.title }
    if ($payload.message) { $Message = [string]$payload.message }
    if ($payload.appId) { $AppId = [string]$payload.appId }
    if ($payload.appName) { $AppName = [string]$payload.appName }
    if ($payload.silent) { $Silent = [bool]$payload.silent }
    $decodedFallback = 0
    if ($null -ne $payload.fallbackSeconds -and [int]::TryParse([string]$payload.fallbackSeconds, [ref]$decodedFallback)) {
        $FallbackSeconds = $decodedFallback
    }
}

if (-not $Title) { $Title = $AppName }
if (-not $Message) { $Message = '' }

# --------------------------------------------------------------------------
# AppUserModelId registration
# --------------------------------------------------------------------------
# A Win32 process may only post a toast for an AppUserModelId that Windows can
# resolve to a display name. HKCU\Software\Classes\AppUserModelId\<id> is the
# documented registration for desktop apps and is per-user, so no elevation.
function Register-NotifyAppId {
    param([string]$Id, [string]$DisplayName)

    try {
        $key = "HKCU:\Software\Classes\AppUserModelId\$Id"
        if (-not (Test-Path -LiteralPath $key)) {
            New-Item -Path $key -Force | Out-Null
        }
        New-ItemProperty -LiteralPath $key -Name 'DisplayName' -Value $DisplayName -PropertyType String -Force | Out-Null
        return $true
    }
    catch {
        return $false
    }
}

# --------------------------------------------------------------------------
# Tier 1: Windows Runtime toast
# --------------------------------------------------------------------------
function Send-WinRtToast {
    param([string]$Id, [string]$ToastTitle, [string]$ToastMessage)

    try {
        [void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
        [void][Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime]
    }
    catch {
        return $false
    }

    try {
        # LoadXml needs the text escaped; Escape() is the exact inverse of the
        # entity forms the toast schema accepts.
        $esc = [System.Security.SecurityElement]
        $safeTitle = $esc::Escape($ToastTitle)
        $safeMessage = $esc::Escape($ToastMessage)

        $body = "<text>$safeTitle</text>"
        if ($safeMessage) { $body += "`n      <text>$safeMessage</text>" }

        # A toast with no <audio> element plays the default sound; <audio silent>
        # suppresses it without changing the visual.
        $audio = if ($script:Silent) { '<audio silent="true" />' } else { '<audio src="ms-winsoundevent:Notification.Default" />' }

        $xmlText = @"
<toast activationType="protocol" scenario="default">
  <visual>
    <binding template="ToastGeneric">
      $body
    </binding>
  </visual>
  $audio
</toast>
"@

        $xml = New-Object Windows.Data.Xml.Dom.XmlDocument
        $xml.LoadXml($xmlText)
        $toast = New-Object Windows.UI.Notifications.ToastNotification $xml
        $notifier = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($Id)
        $notifier.Show($toast)
        return $true
    }
    catch {
        return $false
    }
}

# --------------------------------------------------------------------------
# Tier 2: BurntToast
# --------------------------------------------------------------------------
function Send-BurntToast {
    param([string]$ToastTitle, [string]$ToastMessage)

    if (-not (Get-Module -ListAvailable -Name BurntToast)) { return $false }
    try {
        Import-Module BurntToast -ErrorAction Stop
        if ($ToastMessage) {
            New-BurntToastNotification -Text $ToastTitle, $ToastMessage -ErrorAction Stop | Out-Null
        }
        else {
            New-BurntToastNotification -Text $ToastTitle -ErrorAction Stop | Out-Null
        }
        return $true
    }
    catch {
        return $false
    }
}

# --------------------------------------------------------------------------
# Tier 3: self-closing message box
# --------------------------------------------------------------------------
function Send-MessageBox {
    param([string]$BoxTitle, [string]$BoxMessage, [int]$Seconds)

    try {
        $shell = New-Object -ComObject WScript.Shell
        # 64 = information icon, 4096 = always on top.
        [void]$shell.Popup($BoxMessage, $Seconds, $BoxTitle, 64 -bor 4096)
        return $true
    }
    catch {
        return $false
    }
}

# --------------------------------------------------------------------------
# Dispatch
# --------------------------------------------------------------------------
if (-not $NoRegister) {
    $registered = Register-NotifyAppId -Id $AppId -DisplayName $AppName
    if ($Diagnostic) { Write-Output "register-appid=$registered" }
}

if (Send-WinRtToast -Id $AppId -ToastTitle $Title -ToastMessage $Message) {
    if ($Diagnostic) { Write-Output 'tier=winrt-toast' }
    exit 0
}
if (Send-BurntToast -ToastTitle $Title -ToastMessage $Message) {
    if ($Diagnostic) { Write-Output 'tier=burnttoast' }
    exit 0
}
if (Send-MessageBox -BoxTitle $Title -BoxMessage $Message -Seconds $FallbackSeconds) {
    if ($Diagnostic) { Write-Output 'tier=messagebox' }
    exit 0
}

# Nothing could be shown; report it so the caller can log or surface the reason.
if ($Diagnostic) { Write-Output 'tier=none' }
[Console]::Error.WriteLine('notify-windows: every notification tier failed')
exit 1
