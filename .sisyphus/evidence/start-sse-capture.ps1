$auth = [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes("opencode:udm+vUr9S9Y/WBbN1cVPUBDxmMwwFJHZTmiV3jvo57I="))
$job = Start-Job -ScriptBlock {
    param($authHeader)
    curl.exe -N -H "Accept: text/event-stream" -H "Authorization: Basic $authHeader" "http://127.0.0.1:42217/event" -o ".sisyphus/evidence/sse-capture-raw.txt"
} -ArgumentList $auth
$job.Id | Out-File ".sisyphus/evidence/curl-job-id.txt" -NoNewline
Write-Host "Started job ID: $($job.Id)"
