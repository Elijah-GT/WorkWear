# serial_bridge.ps1: send a USB-connected helmet's data to the server, no Wi-Fi needed.
# Needs SERIAL_BRIDGE 1 in config.h. The firmware prints "@telemetry {json}" and "@event {json}"
# lines (exact docs/PROTOCOL.md bodies); this posts each one to the matching route.
# Other lines (status, "# FALL ALERT") are shown here as they arrive.
#
#   powershell -ExecutionPolicy Bypass -File firmware\serial_bridge.ps1 [-Port COM7] [-Server http://localhost:8000]
#
# Close the Arduino Serial Monitor first: only one program can open the port.
param(
  [string]$Port = "COM7",
  [string]$Server = "http://localhost:8000",
  [int]$Baud = 115200
)

$routes = @{ "@telemetry" = "/api/telemetry"; "@event" = "/api/event" }
$sp = New-Object System.IO.Ports.SerialPort $Port, $Baud
$sp.ReadTimeout = 1000
$sp.NewLine = "`n"
$sp.DtrEnable = $false  # opening the port must not reset the ESP32
$sp.RtsEnable = $false
$sp.Open()
Write-Host "Bridge: $Port -> $Server (Ctrl+C to stop)"
$sent = 0
try {
  while ($true) {
    try { $line = $sp.ReadLine().Trim() } catch [System.TimeoutException] { continue }
    if (-not $line) { continue }
    $space = $line.IndexOf(" ")
    $tag = if ($space -gt 0) { $line.Substring(0, $space) } else { "" }
    if (-not $routes.ContainsKey($tag)) {
      Write-Host $line
      continue
    }
    $body = $line.Substring($space + 1)
    try {
      Invoke-RestMethod -Method Post -Uri ($Server + $routes[$tag]) -ContentType "application/json" -Body $body -TimeoutSec 3 | Out-Null
      $sent++
      if ($tag -eq "@event") { Write-Host "Bridge: fall event sent to the server" -ForegroundColor Red }
      elseif ($sent % 30 -eq 0) { Write-Host "Bridge: $sent messages sent" }
    } catch {
      Write-Host "Bridge: $tag not sent: $($_.Exception.Message)" -ForegroundColor Yellow
    }
  }
} finally {
  $sp.Close()
}
