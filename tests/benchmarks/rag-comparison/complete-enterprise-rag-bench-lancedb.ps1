param(
    [Parameter(Mandatory = $true)]
    [int]$EmbeddingPid
)

$ErrorActionPreference = "Stop"
$env:PYTHONUTF8 = "1"
$repository = (Resolve-Path (Join-Path $PSScriptRoot "..\..\..")).Path
$benchmark = Join-Path $repository "target\benchmarks\enterprise-rag-bench"
$vectors = Join-Path $benchmark "ruri-full-corpus-v1"
$inputData = Join-Path $benchmark "ruri-full-corpus-input-v1"
$database = Join-Path $benchmark "lancedb-ruri-full-corpus-v1"
$questions = Join-Path $benchmark "prepared-v3\questions.jsonl"
$goldDocuments = Join-Path $benchmark "prepared-v3\gold-documents.jsonl"
$bm25 = Join-Path $benchmark "bm25-v1\retrieval.jsonl"
$tantivyIndex = Join-Path $benchmark "tantivy-bm25-v1"
$pythonDependencies = @("--with", "lancedb", "--with", "pyarrow", "--with", "numpy", "--with", "tantivy")

Set-Location $repository
while (Get-Process -Id $EmbeddingPid -ErrorAction SilentlyContinue) {
    Start-Sleep -Seconds 15
}

$vectorManifests = Get-ChildItem -LiteralPath $vectors -Filter "shard-*.json"
$embeddedDocuments = ($vectorManifests | ForEach-Object {
    (Get-Content -Raw -LiteralPath $_.FullName | ConvertFrom-Json).rows
} | Measure-Object -Sum).Sum
if ($vectorManifests.Count -ne 52 -or $embeddedDocuments -ne 511962) {
    throw "Embedding did not complete: $($vectorManifests.Count)/52 shards, $embeddedDocuments/511962 documents"
}

& uv run @pythonDependencies python tests/benchmarks/rag-comparison/build-enterprise-rag-bench-lancedb.py `
    --input $inputData --vectors $vectors --database $database --table enterprise_rag_bench_ruri
if ($LASTEXITCODE -ne 0) { throw "LanceDB ingestion failed with exit code $LASTEXITCODE" }

& uv run @pythonDependencies python tests/benchmarks/rag-comparison/run-enterprise-rag-bench-lancedb.py `
    --database $database --table enterprise_rag_bench_ruri --vectors $vectors --questions $questions `
    --gold-documents $goldDocuments --bm25 $bm25 --tantivy-index $tantivyIndex `
    --output (Join-Path $benchmark "lancedb-ruri-flat-v1") --mode flat
if ($LASTEXITCODE -ne 0) { throw "Flat LanceDB evaluation failed with exit code $LASTEXITCODE" }

& uv run @pythonDependencies python tests/benchmarks/rag-comparison/index-enterprise-rag-bench-lancedb.py `
    --database $database --table enterprise_rag_bench_ruri --partitions 256
if ($LASTEXITCODE -ne 0) { throw "LanceDB index creation failed with exit code $LASTEXITCODE" }

foreach ($nprobes in @(5, 20, 80)) {
    & uv run @pythonDependencies python tests/benchmarks/rag-comparison/run-enterprise-rag-bench-lancedb.py `
        --database $database --table enterprise_rag_bench_ruri --vectors $vectors --questions $questions `
        --gold-documents $goldDocuments --bm25 $bm25 --tantivy-index $tantivyIndex `
        --output (Join-Path $benchmark "lancedb-ruri-ann-p$nprobes-v1") --mode ann --nprobes $nprobes
    if ($LASTEXITCODE -ne 0) { throw "ANN LanceDB evaluation failed for nprobes=$nprobes with exit code $LASTEXITCODE" }
}
