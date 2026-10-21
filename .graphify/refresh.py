"""Refresh structural artifacts with the installed Graphify 0.8.39 CLI, no LLM calls."""
from pathlib import Path
import datetime
import hashlib
import json
import os
import subprocess

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / '.graphify'
env = dict(os.environ, GRAPHIFY_OUT='.graphify', PYTHONIOENCODING='utf-8')
commands = [
    ['graphify', '--version'],
    ['graphify', 'update', '.', '--no-cluster'],
    ['graphify', 'tree', '--graph', '.graphify/graph.json', '--output', '.graphify/graph.html',
     '--root', '.', '--label', 'FrameForge structural code graph'],
]


def exclude_checkout_local_state(graph):
    """Keep canonical source evidence separate from local agent state and copies."""
    prefixes = ('.jeo/', '.omc/', '.omx/', 'llm-wiki/.graphify/', 'llm-wiki/.state/')
    def excluded(value):
        filename = str(value or '').replace(chr(92), '/')
        if filename.startswith('./'):
            filename = filename[2:]
        return any(filename == prefix.rstrip('/') or filename.startswith(prefix) for prefix in prefixes)
    removed = {node['id'] for node in graph['nodes'] if excluded(node.get('source_file'))}
    graph['nodes'] = [node for node in graph['nodes'] if node['id'] not in removed]
    field = 'links' if 'links' in graph else 'edges'
    edges = graph.get(field, [])
    graph[field] = [edge for edge in edges if not excluded(edge.get('source_file'))
                    and edge.get('source') not in removed and edge.get('target') not in removed]
    return {'excludedPrefixes': list(prefixes), 'nodesRemoved': len(removed),
            'edgesRemoved': len(edges) - len(graph[field])}


def normalize_edges(graph):
    """Keep the first full record; metadata differences remain separate edges."""
    field = 'links' if 'links' in graph else 'edges'
    records = graph.get(field, [])
    seen = set()
    unique = []
    for record in records:
        key = json.dumps(record, sort_keys=True, ensure_ascii=False, separators=(',', ':'))
        if key not in seen:
            seen.add(key)
            unique.append(record)
    graph[field] = unique
    return {'raw': len(records), 'exactUnique': len(unique),
            'exactDuplicatesRemoved': len(records) - len(unique),
            'remainingDuplicates': 0,
            'method': 'stable JSON of the whole edge record; distinct metadata preserved'}


receipt = {'observedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
           'mode': 'native deterministic code extraction; semantic enrichment not run', 'commands': []}
for command in commands:
    if command[1] == 'tree':
        graph_path = OUT / 'graph.json'
        graph = json.loads(graph_path.read_text(encoding='utf-8'))
        receipt['checkoutLocalStateAudit'] = exclude_checkout_local_state(graph)
        receipt['edgeRecordAudit'] = normalize_edges(graph)
        temporary = graph_path.with_suffix('.json.tmp')
        temporary.write_text(json.dumps(graph, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
        temporary.replace(graph_path)
    result = subprocess.run(command, cwd=ROOT, env=env, capture_output=True, text=True,
                            encoding='utf-8', timeout=120)
    receipt['commands'].append({'command': command, 'exitCode': result.returncode,
                                'output': (result.stdout + result.stderr).replace(str(ROOT), '<repo>')})
    if result.returncode:
        (OUT / 'verification.json').write_text(json.dumps(receipt, indent=2) + '\n', encoding='utf-8')
        raise SystemExit(result.returncode)
graph = json.loads((OUT / 'graph.json').read_text(encoding='utf-8'))
paths = sorted({n.get('source_file', '') for n in graph['nodes'] if n.get('source_file')})
unsafe = [p for p in paths if Path(p).is_absolute() or '..' in Path(p).parts
          or p.replace('\\', '/').split('/')[0] in {'data', 'ops', '.env'}]
if unsafe:
    raise SystemExit('Graph contains excluded or nonportable source paths')
receipt.update(nodes=len(graph['nodes']), edges=len(graph.get('links', graph.get('edges', []))),
               sourceFiles=paths, portableSourcePaths=True,
               graphSha256=hashlib.sha256((OUT / 'graph.json').read_bytes()).hexdigest(),
               limitations=['scope command and newer update flags unavailable in installed version',
                            'No semantic descriptions, provider calls or model-evaluated relationship claims',
                            'Native tree HTML loads D3 from its CDN for interactive rendering'])
(OUT / 'verification.json').write_text(json.dumps(receipt, indent=2) + '\n', encoding='utf-8')
(OUT / 'scope.json').write_text(json.dumps({'mode': 'source paths observed in native AST output',
    'excluded': ['data/', 'ops/', '.env', 'private media', 'credentials'] + receipt['checkoutLocalStateAudit']['excludedPrefixes'], 'files': paths}, indent=2) + '\n', encoding='utf-8')
report = f'''# FrameForge structural graph

Native Graphify code extraction: **{receipt['nodes']} nodes, {receipt['edges']} edges**.

The installed native CLI can accumulate exact duplicate edge records. This refresh
normalized {receipt['edgeRecordAudit']['raw']} native records to
{receipt['edgeRecordAudit']['exactUnique']} whole-record-unique edges, removing
{receipt['edgeRecordAudit']['exactDuplicatesRemoved']} exact duplicates before HTML
export. Stable sorted-key JSON identifies equality of the entire record; edges
with different metadata remain separate. graph.json, this report and graph.html
all derive from the normalized artifact. No duplicate records remain.

Before normalization/export, checkout-local agent state and generated vault metadata
are removed with their incident or locally sourced edges. This refresh removed
{receipt['checkoutLocalStateAudit']['nodesRemoved']} nodes and
{receipt['checkoutLocalStateAudit']['edgesRemoved']} edges from these noncanonical
paths. The exclusion audit is retained in verification.json; canonical source
relationships with distinct metadata remain intact.

This is a deterministic AST graph, not an LLM semantic graph. Extraction and
interactive tree export were executed through the installed Graphify CLI.
No provider key or model call was required. The current corpus is listed in
[scope.json](scope.json); command exit codes and graph hash are in
[verification.json](verification.json).

Open [graph.html](graph.html) for the native interactive tree. Its D3 dependency
loads from a CDN. [graph.json](graph.json) is the portable machine-readable artifact.
The code graph is separate from private live episode data and the curated
[project wiki](../llm-wiki/index.md).

The installed 0.8.39 CLI rejected `scope` and newer `update --no-description`
flags. Its `export html` succeeded even though omitted from help. A one-time
`cluster-only --no-label` run produced placeholder Community N labels; that
historical output is under `clustered/` and is not automatically refreshed.
Use current graph.json and this report for current counts.

Refresh with `python .graphify/refresh.py`. No hooks or shared skills are installed.
'''
(OUT / 'GRAPH_REPORT.md').write_text(report, encoding='utf-8')
print(json.dumps({'ok': True, 'nodes': receipt['nodes'], 'edges': receipt['edges'], 'sourceFiles': len(paths)}))
