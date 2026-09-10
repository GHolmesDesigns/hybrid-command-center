# Creates C202-C219 issues and adds them to GHolmesDesigns project 10.
$ErrorActionPreference = 'Stop'
$Repo = 'GHolmesDesigns/hybrid-command-center'
$ProjectOwner = 'GHolmesDesigns'
$ProjectNumber = 10
$ProjectId = 'PVT_kwHOEs58Js4Bi0f_'
$SizeFieldId = 'PVTSSF_lAHOEs58Js4Bi0f_zhhrG78'
$SizeOptions = @{
  S  = 'f7a31f07'
  M  = 'd91a2551'
  L  = 'f3578785'
  XL = '520dbd32'
}
$BodyFile = Join-Path $PSScriptRoot '..\docs\iterations\AGENT_HUB_ISSUE_BODIES_C202-C219.md'
$raw = Get-Content -LiteralPath $BodyFile -Raw -Encoding UTF8

function Get-CardBody {
  param([string]$CardId)
  $marker = '# ' + $CardId + ' '
  $start = $raw.IndexOf($marker)
  if ($start -lt 0) { throw "Could not find section for $CardId" }
  $next = $raw.IndexOf("`n---`n`n# C", $start + $marker.Length)
  if ($next -lt 0) { $next = $raw.Length }
  $section = $raw.Substring($start, $next - $start)
  $firstNewline = $section.IndexOf("`n")
  if ($firstNewline -lt 0) { return $section.Trim() }
  return $section.Substring($firstNewline + 1).Trim()
}

function Ensure-Milestone {
  param([string]$Title, [string]$Description)
  $query = 'repos/' + $Repo + '/milestones?state=all&per_page=100'
  $existing = gh api $query --jq ('.[] | select(.title=="' + $Title + '") | .number')
  if ($existing) { return [int]$existing }
  $num = gh api ('repos/' + $Repo + '/milestones') -f title=$Title -f description=$Description --jq '.number'
  return [int]$num
}

$cards = @(
  @{ Id='C202'; Title='C202 - Conversations reach the operator'; Labels='enhancement,tier-2-ui,size-xxl'; Milestone='Wave 35 - Open the doors'; MilestoneDesc='Agent Hub Wave 35: finish contracts and render Wave 33 (C202-C205).'; Size='XL'; Depends=@(); Blocks=@('C205','C209','C210','C213') }
  @{ Id='C203'; Title='C203 - The memory review queue'; Labels='enhancement,tier-2-ui,size-l'; Milestone='Wave 35 - Open the doors'; MilestoneDesc='Agent Hub Wave 35: finish contracts and render Wave 33 (C202-C205).'; Size='L'; Depends=@(); Blocks=@('C205','C208') }
  @{ Id='C204'; Title='C204 - Presence and current summaries on the Agents page'; Labels='enhancement,tier-2-ui,size-m'; Milestone='Wave 35 - Open the doors'; MilestoneDesc='Agent Hub Wave 35: finish contracts and render Wave 33 (C202-C205).'; Size='M'; Depends=@(); Blocks=@() }
  @{ Id='C205'; Title='C205 - Notifications reach the operator'; Labels='enhancement,tier-3-schema,size-xl'; Milestone='Wave 35 - Open the doors'; MilestoneDesc='Agent Hub Wave 35: finish contracts and render Wave 33 (C202-C205).'; Size='XL'; Depends=@('C203'); Blocks=@('C218') }
  @{ Id='C206'; Title='C206 - Live work sessions become readable'; Labels='enhancement,tier-3-schema,size-l'; Milestone='Wave 36 - What is waiting on me'; MilestoneDesc='Agent Hub Wave 36: live work sessions, operator responses, waiting inbox (C206-C208).'; Size='L'; Depends=@(); Blocks=@('C207','C208') }
  @{ Id='C207'; Title='C207 - Operators answer live work sessions'; Labels='enhancement,tier-3-schema,size-l'; Milestone='Wave 36 - What is waiting on me'; MilestoneDesc='Agent Hub Wave 36: live work sessions, operator responses, waiting inbox (C206-C208).'; Size='L'; Depends=@('C206'); Blocks=@('C208') }
  @{ Id='C208'; Title='C208 - The Waiting on you inbox'; Labels='enhancement,tier-2-ui,size-l'; Milestone='Wave 36 - What is waiting on me'; MilestoneDesc='Agent Hub Wave 36: live work sessions, operator responses, waiting inbox (C206-C208).'; Size='L'; Depends=@('C206','C207'); Blocks=@('C215') }
  @{ Id='C211'; Title='C211 - Stable task detail route'; Labels='enhancement,tier-2-ui,size-l'; Milestone='Wave 37 - Threads bind to the workspace'; MilestoneDesc='Agent Hub Wave 37: scoped discussion and mention handoffs (C211, C209-C210).'; Size='L'; Depends=@(); Blocks=@('C209') }
  @{ Id='C209'; Title='C209 - Discussion on project, client, and task detail'; Labels='enhancement,tier-2-ui,size-xl'; Milestone='Wave 37 - Threads bind to the workspace'; MilestoneDesc='Agent Hub Wave 37: scoped discussion and mention handoffs (C211, C209-C210).'; Size='XL'; Depends=@('C202','C211'); Blocks=@('C210') }
  @{ Id='C210'; Title='C210 - A mention opens a handoff'; Labels='enhancement,tier-3-schema,size-xl'; Milestone='Wave 37 - Threads bind to the workspace'; MilestoneDesc='Agent Hub Wave 37: scoped discussion and mention handoffs (C211, C209-C210).'; Size='XL'; Depends=@('C202','C209'); Blocks=@('C218') }
  @{ Id='C212'; Title='C212 - Agent charter field on directory'; Labels='enhancement,tier-3-schema,size-m'; Milestone='Wave 38 - Hub extensions'; MilestoneDesc='Agent Hub Wave 38 extensions (C212-C219).'; Size='M'; Depends=@(); Blocks=@() }
  @{ Id='C213'; Title='C213 - Lightweight decision tags on conversations'; Labels='enhancement,tier-2-ui,size-l'; Milestone='Wave 38 - Hub extensions'; MilestoneDesc='Agent Hub Wave 38 extensions (C212-C219).'; Size='L'; Depends=@('C202'); Blocks=@() }
  @{ Id='C214'; Title='C214 - Publish confirmation gate'; Labels='enhancement,tier-3-schema,size-xl'; Milestone='Wave 38 - Hub extensions'; MilestoneDesc='Agent Hub Wave 38 extensions (C212-C219).'; Size='XL'; Depends=@(); Blocks=@() }
  @{ Id='C215'; Title='C215 - Scheduled agent runs'; Labels='enhancement,tier-3-schema,size-xl'; Milestone='Wave 38 - Hub extensions'; MilestoneDesc='Agent Hub Wave 38 extensions (C212-C219).'; Size='XL'; Depends=@('C208'); Blocks=@() }
  @{ Id='C216'; Title='C216 - Thread rollup design (no implementation)'; Labels='docs,size-s'; Milestone='Wave 38 - Hub extensions'; MilestoneDesc='Agent Hub Wave 38 extensions (C212-C219).'; Size='S'; Depends=@('C202'); Blocks=@() }
  @{ Id='C217'; Title='C217 - Agent cost records (blocked on provider billing)'; Labels='enhancement,tier-3-schema,size-l,blocked'; Milestone='Wave 38 - Hub extensions'; MilestoneDesc='Agent Hub Wave 38 extensions (C212-C219).'; Size='L'; Depends=@(); Blocks=@() }
  @{ Id='C218'; Title='C218 - Notify mentioned agent on confirmed handoff'; Labels='enhancement,tier-2-ui,size-m'; Milestone='Wave 38 - Hub extensions'; MilestoneDesc='Agent Hub Wave 38 extensions (C212-C219).'; Size='M'; Depends=@('C205','C210'); Blocks=@() }
  @{ Id='C219'; Title='C219 - SSE shell wake-up for authoritative reread'; Labels='enhancement,tier-3-schema,size-l'; Milestone='Wave 38 - Hub extensions'; MilestoneDesc='Agent Hub Wave 38 extensions (C212-C219).'; Size='L'; Depends=@('C202','C205'); Blocks=@() }
)

$milestoneTitles = $cards | ForEach-Object { $_.Milestone } | Select-Object -Unique
$milestoneNums = @{}
foreach ($mt in $milestoneTitles) {
  $desc = ($cards | Where-Object { $_.Milestone -eq $mt } | Select-Object -First 1).MilestoneDesc
  $milestoneNums[$mt] = Ensure-Milestone -Title $mt -Description $desc
  Write-Host ('Milestone: ' + $mt + ' (#' + $milestoneNums[$mt] + ')')
}

$issueByCard = @{}
$tempDir = Join-Path $env:TEMP ('agent-hub-issues-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Path $tempDir | Out-Null

try {
  foreach ($card in $cards) {
    $body = Get-CardBody -CardId $card.Id
    $bodyPath = Join-Path $tempDir ($card.Id + '.md')
    [System.IO.File]::WriteAllText($bodyPath, $body, [System.Text.UTF8Encoding]::new($false))

    $issueUrl = gh issue create --repo $Repo --title $card.Title --label $card.Labels --milestone $card.Milestone --body-file $bodyPath
    $issueNum = [int]($issueUrl -replace '.*/issues/(\d+).*', '$1')
    $issueByCard[$card.Id] = $issueNum
    Write-Host ('Created ' + $card.Id + ' -> #' + $issueNum)

    $itemJson = gh project item-add $ProjectNumber --owner $ProjectOwner --url $issueUrl --format json
    $itemId = ($itemJson | ConvertFrom-Json).id
    if ($card.Size -and $SizeOptions.ContainsKey($card.Size)) {
      gh project item-edit --project-id $ProjectId --id $itemId --field-id $SizeFieldId --single-select-option-id $SizeOptions[$card.Size] | Out-Null
    }
  }

  foreach ($card in $cards) {
    $num = $issueByCard[$card.Id]
    $depLines = @()
    foreach ($d in $card.Depends) {
      if ($issueByCard.ContainsKey($d)) {
        $depLines += ('- Depends on #' + $issueByCard[$d] + ' (' + $d + ')')
      }
    }
    foreach ($b in $card.Blocks) {
      if ($issueByCard.ContainsKey($b)) {
        $depLines += ('- Blocks #' + $issueByCard[$b] + ' (' + $b + ')')
      }
    }
    if ($depLines.Count -gt 0) {
      $comment = "## Linked dependencies`n`n" + ($depLines -join "`n")
      gh issue comment $num --repo $Repo --body $comment | Out-Null
    }
  }

  Write-Host ''
  Write-Host '=== Summary ==='
  foreach ($card in $cards) {
    Write-Host ($card.Id + ' -> #' + $issueByCard[$card.Id] + ' | ' + $card.Title)
  }
  Write-Host ''
  Write-Host ('Project: https://github.com/users/' + $ProjectOwner + '/projects/' + $ProjectNumber)
}
finally {
  Remove-Item -LiteralPath $tempDir -Recurse -Force -ErrorAction SilentlyContinue
}
