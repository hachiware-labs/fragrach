param(
    [Parameter(Mandatory = $true)]
    [int]$RetrievalPipelinePid
)

$ErrorActionPreference = "Stop"
$env:PYTHONUTF8 = "1"
$repository = (Resolve-Path (Join-Path $PSScriptRoot "..\..\..")).Path
$benchmark = Join-Path $repository "target\benchmarks\enterprise-rag-bench"
$questions = Join-Path $benchmark "prepared-v3\questions.jsonl"
$goldDocuments = Join-Path $benchmark "prepared-v3\gold-documents.jsonl"
$obligations = Join-Path $benchmark "query-obligations-v1.jsonl"
$flatRun = Join-Path $benchmark "lancedb-ruri-flat-v1"
$selectedRetrieval = Join-Path $benchmark "strongest-exact-retrieval-v1"
$fragrachDossiers = Join-Path $benchmark "adaptive-dossiers-strongest-v1"
$vanillaDossiers = Join-Path $benchmark "vanilla-dossiers-strongest-v1"
$pythonDependencies = @("--with", "lancedb", "--with", "pyarrow", "--with", "numpy", "--with", "tantivy")

Set-Location $repository
while (Get-Process -Id $RetrievalPipelinePid -ErrorAction SilentlyContinue) {
    Start-Sleep -Seconds 15
}
if (-not (Test-Path -LiteralPath (Join-Path $flatRun "report.json"))) {
    throw "Full-corpus flat retrieval did not complete"
}

& uv run @pythonDependencies python tests/benchmarks/rag-comparison/select-enterprise-rag-bench-retrieval.py `
    --input $flatRun --output $selectedRetrieval
if ($LASTEXITCODE -ne 0) { throw "Retrieval selection failed with exit code $LASTEXITCODE" }
$selection = Get-Content -Raw -LiteralPath (Join-Path $selectedRetrieval "report.json") | ConvertFrom-Json
$retrievalCondition = $selection.selected_condition

& uv run @pythonDependencies python tests/benchmarks/rag-comparison/compile-enterprise-rag-bench-adaptive-dossiers.py `
    --questions $questions --gold-documents $goldDocuments --obligations $obligations `
    --retrieval (Join-Path $selectedRetrieval "retrieval.jsonl") --retrieval-condition $retrievalCondition `
    --output $fragrachDossiers
if ($LASTEXITCODE -ne 0) { throw "Fragrach dossier compilation failed with exit code $LASTEXITCODE" }
$fragrachReport = Get-Content -Raw -LiteralPath (Join-Path $fragrachDossiers "report.json") | ConvertFrom-Json
$selectedPolicy = $fragrachReport.selected_policy
$policyReport = $fragrachReport.candidate_matrix.PSObject.Properties[$selectedPolicy].Value
$contextBudget = $policyReport.mean_characters.development

& uv run @pythonDependencies python tests/benchmarks/rag-comparison/compile-enterprise-rag-bench-vanilla-dossiers.py `
    --questions $questions --gold-documents $goldDocuments `
    --retrieval (Join-Path $selectedRetrieval "retrieval.jsonl") --retrieval-condition $retrievalCondition `
    --context-budget $contextBudget --output $vanillaDossiers
if ($LASTEXITCODE -ne 0) { throw "Vanilla dossier compilation failed with exit code $LASTEXITCODE" }

function Invoke-AnswerRun {
    param(
        [Parameter(Mandatory = $true)][string]$RunName,
        [Parameter(Mandatory = $true)][string]$ReaderContract
    )
    $offsets = @(0, 23, 46, 69)
    $limits = @(23, 23, 23, 22)
    $processes = @()
    for ($index = 0; $index -lt $offsets.Count; $index += 1) {
        $offset = $offsets[$index]
        $output = Join-Path $benchmark "$RunName-shard-$offset"
        $stdout = Join-Path $benchmark "$RunName-shard-$offset.stdout.log"
        $stderr = Join-Path $benchmark "$RunName-shard-$offset.stderr.log"
        $arguments = @(
            "tests/benchmarks/rag-comparison/run-enterprise-rag-bench-answers.mjs",
            "--output", $output,
            "--offset", [string]$offset,
            "--limit", [string]$limits[$index],
            "--concurrency", "2",
            "--reader-contract", $ReaderContract,
            "--dossiers", (Join-Path $vanillaDossiers "budget.jsonl"),
            "--dossiers", (Join-Path $fragrachDossiers "retrieval.jsonl"),
            "--dossiers", (Join-Path $vanillaDossiers "full.jsonl")
        )
        $processes += Start-Process -FilePath (Get-Command node).Source -ArgumentList $arguments `
            -WorkingDirectory $repository -WindowStyle Hidden -RedirectStandardOutput $stdout `
            -RedirectStandardError $stderr -PassThru
    }
    $processes | Wait-Process
    foreach ($process in $processes) {
        $process.Refresh()
        if ($process.ExitCode -ne 0) {
            throw "$RunName answer shard failed: pid=$($process.Id), exit=$($process.ExitCode)"
        }
    }
    & node tests/benchmarks/rag-comparison/merge-enterprise-rag-bench-answers.mjs `
        --input-prefix "$RunName-shard-" --output (Join-Path $benchmark $RunName)
    if ($LASTEXITCODE -ne 0) { throw "$RunName answer merge failed with exit code $LASTEXITCODE" }
    $rescored = Join-Path $benchmark "$RunName-local"
    & uv run @pythonDependencies python tests/benchmarks/rag-comparison/rescore-enterprise-rag-bench-answers.py `
        --answers (Join-Path $benchmark "$RunName\answers.jsonl") `
        --dossiers (Join-Path $vanillaDossiers "budget.jsonl") `
        --dossiers (Join-Path $fragrachDossiers "retrieval.jsonl") `
        --dossiers (Join-Path $vanillaDossiers "full.jsonl") `
        --questions $questions --gold-documents $goldDocuments --output $rescored
    if ($LASTEXITCODE -ne 0) { throw "$RunName evidence rescore failed with exit code $LASTEXITCODE" }
}

Invoke-AnswerRun -RunName "answers-strongest-base-v1" -ReaderContract "base-v1"
Invoke-AnswerRun -RunName "answers-strongest-checklist-v1" -ReaderContract "position-checklist-v1"

& uv run @pythonDependencies python tests/benchmarks/rag-comparison/compare-enterprise-rag-bench-strong-baselines.py `
    --base-answers (Join-Path $benchmark "answers-strongest-base-v1-local\answers.jsonl") `
    --checklist-answers (Join-Path $benchmark "answers-strongest-checklist-v1-local\answers.jsonl") `
    --vanilla-report (Join-Path $vanillaDossiers "report.json") `
    --fragrach-report (Join-Path $fragrachDossiers "report.json") `
    --output (Join-Path $benchmark "strongest-retrieval-comparison-v1")
if ($LASTEXITCODE -ne 0) { throw "Strong-baseline comparison failed with exit code $LASTEXITCODE" }
