"""Refresh structural artifacts with the installed Graphify 0.8.39 CLI, no LLM calls."""
from pathlib import Path, PureWindowsPath
import datetime
import hashlib
import json
import os
import subprocess
import shutil
import stat
import tempfile
import sys

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / '.graphify'
env = dict(os.environ, GRAPHIFY_OUT='.graphify', PYTHONIOENCODING='utf-8')
CHECKOUT_LOCAL_PREFIXES = ('.jeo/', '.omc/', '.omx/', '.ouroboros/', '.zvec-grep/', '.mcp.json',
                           'artifacts/production-workspace-implementation/native-status/',
                           '.state/',
                           'llm-wiki/.graphify/', 'llm-wiki/.state/')


def checkout_local_path(value):
    """Use case-insensitive private namespaces without broadening file matches."""
    filename = str(value or '').replace(chr(92), '/')
    while filename.startswith('./'):
        filename = filename[2:]
    filename = filename.casefold()
    prefixes = CHECKOUT_LOCAL_PREFIXES
    return any(filename == prefix.rstrip('/') or
               (prefix.endswith('/') and filename.startswith(prefix)) for prefix in prefixes)


def exclude_checkout_local_state(graph):
    """Keep canonical source evidence separate from local agent state and copies."""
    prefixes = CHECKOUT_LOCAL_PREFIXES
    excluded = checkout_local_path
    removed = {node['id'] for node in graph['nodes'] if excluded(node.get('source_file'))}
    graph['nodes'] = [node for node in graph['nodes'] if node['id'] not in removed]
    removed_edges = 0
    for field in ('links', 'edges'):
        if field not in graph:
            continue
        edges = graph[field]
        graph[field] = [edge for edge in edges if not excluded(edge.get('source_file'))
                        and edge.get('source') not in removed and edge.get('target') not in removed]
        removed_edges += len(edges) - len(graph[field])
    hyperedges = graph.get('hyperedges', [])
    if 'hyperedges' in graph:
        graph['hyperedges'] = [edge for edge in hyperedges if not excluded(edge.get('source_file'))
                               and not removed.intersection(edge.get('nodes', []))]
    return {'excludedPrefixes': list(prefixes), 'nodesRemoved': len(removed),
            'edgesRemoved': removed_edges,
            'hyperedgesRemoved': len(hyperedges) - len(graph.get('hyperedges', []))}


def load_knowledge_admission(root=ROOT):
    """Reuse the repository's bounded, hash-reviewed admission validator."""
    command = ['node', 'scripts/knowledge.mjs', 'status', '--root', str(root)]
    result = subprocess.run(command, cwd=root, env=env, capture_output=True, text=True,
                            encoding='utf-8', timeout=120)
    try:
        admission = json.loads(result.stdout)
    except (TypeError, json.JSONDecodeError) as error:
        raise ValueError('Knowledge admission did not return valid JSON; refresh blocked') from error
    policy = admission.get('policy') if isinstance(admission, dict) else None
    if (result.returncode or not isinstance(admission, dict) or admission.get('ok') is not True
            or admission.get('scope') != 'admitted-project-knowledge'
            or not isinstance(policy, dict)
            or policy.get('schema') != 'frameforge-knowledge-policy/v1'
            or policy.get('path') != 'harness/knowledge-policy.json'
            or not isinstance(admission.get('entries'), list) or not admission['entries']):
        raise ValueError('Knowledge policy, reviewed sources or managed index failed admission; '
                         'run node scripts/knowledge.mjs status for local diagnostics')
    return admission


def exclude_unadmitted_wiki(graph, admission):
    """Admit exact reviewed bodies only; evidence pointers never grant admission."""
    admitted = {entry['path'] for entry in admission['entries']}

    def excluded(value):
        filename = str(value or '').replace(chr(92), '/')
        while filename.startswith('./'):
            filename = filename[2:]
        wiki = filename.casefold() == 'llm-wiki' or filename.casefold().startswith('llm-wiki/')
        return wiki and filename not in admitted

    removed = {node['id'] for node in graph['nodes'] if excluded(node.get('source_file'))}
    graph['nodes'] = [node for node in graph['nodes'] if node['id'] not in removed]
    removed_edges = 0
    for field in ('links', 'edges'):
        if field not in graph:
            continue
        records = graph[field]
        graph[field] = [record for record in records if not excluded(record.get('source_file'))
                        and record.get('source') not in removed and record.get('target') not in removed]
        removed_edges += len(records) - len(graph[field])
    hyperedges = graph.get('hyperedges', [])
    if 'hyperedges' in graph:
        graph['hyperedges'] = [record for record in hyperedges if not excluded(record.get('source_file'))
                               and not removed.intersection(record.get('nodes', []))]
    return {'nodesRemoved': len(removed), 'edgesRemoved': removed_edges,
            'hyperedgesRemoved': len(hyperedges) - len(graph.get('hyperedges', [])),
            'admittedFiles': sorted(admitted),
            'navigation': 'index.md, log.md and vault instructions excluded in full; no captured titles retained',
            'evidenceBoundary': 'provenance.evidence paths are pointers, not admitted graph sources'}


def source_scope(graph):
    """Hash every retained source without widening admission or changing records."""
    records = list(graph['nodes'])
    for field in ('links', 'edges', 'hyperedges'):
        records.extend(graph.get(field, []))
    paths = sorted({record['source_file'] for record in records if record.get('source_file')})
    hashes = []
    for path in paths:
        filename = path.replace(chr(92), '/')
        while filename.startswith('./'):
            filename = filename[2:]
        parts = filename.split('/')
        if (Path(filename).is_absolute() or PureWindowsPath(filename).drive or '..' in parts
                or parts[0].casefold() in {'data', 'ops', '.env'} or checkout_local_path(filename)):
            raise ValueError('Graph contains excluded or nonportable source paths')
        target = ROOT
        for part in parts:
            target = target / part
            metadata = target.lstat()
            if (stat.S_ISLNK(metadata.st_mode)
                    or getattr(metadata, 'st_file_attributes', 0) & stat.FILE_ATTRIBUTE_REPARSE_POINT):
                raise ValueError('Symlink or reparse aliases cannot be structural graph evidence')
        if not target.resolve().is_relative_to(ROOT) or not stat.S_ISREG(metadata.st_mode):
            raise ValueError('Graph source is missing or escapes the repository')
        digest = hashlib.sha256()
        with target.open('rb') as source:
            for chunk in iter(lambda: source.read(65536), b''):
                digest.update(chunk)
        hashes.append({'path': path, 'sha256': digest.hexdigest()})
    return paths, hashes


def normalize_edges(graph):
    """Keep the first full record within each native edge collection."""
    audits = {}
    for field in [name for name in ('links', 'edges') if name in graph] or ['edges']:
        records = graph.get(field, [])
        seen = set()
        unique = []
        for record in records:
            key = json.dumps(record, sort_keys=True, ensure_ascii=False, separators=(',', ':'))
            if key not in seen:
                seen.add(key)
                unique.append(record)
        graph[field] = unique
        audits[field] = {'raw': len(records), 'exactUnique': len(unique),
                         'exactDuplicatesRemoved': len(records) - len(unique)}
    return {'raw': sum(audit['raw'] for audit in audits.values()),
            'exactUnique': sum(audit['exactUnique'] for audit in audits.values()),
            'exactDuplicatesRemoved': sum(audit['exactDuplicatesRemoved'] for audit in audits.values()),
            'remainingDuplicates': 0, 'collections': audits,
            'method': 'stable JSON of each whole record within each native collection; distinct metadata preserved'}


PUBLIC_ARTIFACTS = ('graph.json', 'graph.html', 'scope.json', 'GRAPH_REPORT.md', 'verification.json')


def file_sha256(path):
    digest = hashlib.sha256()
    with path.open('rb') as source:
        for chunk in iter(lambda: source.read(65536), b''):
            digest.update(chunk)
    return digest.hexdigest()


def sync_directory(path):
    """Flush rename metadata where the platform exposes directory fsync."""
    if os.name != 'nt':
        handle = os.open(path, os.O_RDONLY | getattr(os, 'O_DIRECTORY', 0))
        try:
            os.fsync(handle)
        finally:
            os.close(handle)


def durable_copy(source, destination):
    with source.open('rb') as reader, destination.open('wb') as writer:
        shutil.copyfileobj(reader, writer, length=65536)
        writer.flush()
        os.fsync(writer.fileno())
    sync_directory(destination.parent)


def publication_journal(transaction, journal):
    temporary = transaction / 'journal.json.tmp'
    with temporary.open('w', encoding='utf-8') as writer:
        writer.write(json.dumps(journal, indent=2) + '\n')
        writer.flush()
        os.fsync(writer.fileno())
    temporary.replace(transaction / 'journal.json')
    sync_directory(transaction)


def cleanup_publication(transaction, output):
    lock = output / '.refresh-publication.lock'
    if lock.exists():
        if lock.read_text(encoding='utf-8').strip() != str(transaction.resolve()):
            raise ValueError('Publication lock belongs to another transaction; recovery retained')
        lock.unlink()
        sync_directory(output)
    for name in PUBLIC_ARTIFACTS + ('journal.json.tmp',):
        (transaction / name).unlink(missing_ok=True)
    (transaction / 'journal.json').unlink()
    transaction.rmdir()
    sync_directory(transaction.parent)


def recover_publication(transaction, output=OUT, *, rollback_committed=False):
    """Restore a failed/interrupted generation from hash-checked private snapshots."""
    transaction = Path(transaction)
    output = Path(output)
    journal = json.loads((transaction / 'journal.json').read_text(encoding='utf-8'))
    if (not isinstance(journal, dict) or journal.get('schema') != 'frameforge-graph-publication/v1'
            or journal.get('output') != str(output.resolve())
            or journal.get('state') not in {'prepared', 'rollback-incomplete', 'rolled-back', 'committed'}
            or not isinstance(journal.get('prior'), list)
            or any(not isinstance(item, dict) for item in journal['prior'])
            or [item.get('name') for item in journal['prior']] != list(PUBLIC_ARTIFACTS)):
        raise ValueError('Invalid publication recovery journal; snapshots retained without changing exports')
    restore_previous = rollback_committed or journal['state'] in {'prepared', 'rollback-incomplete'}
    for item in journal['prior']:
        if not isinstance(item.get('existed'), bool):
            raise ValueError('Invalid publication recovery entry; snapshots retained')
        if (restore_previous and item['existed']
                and file_sha256(transaction / item['name']) != item.get('sha256')):
            raise ValueError('Publication recovery snapshot hash mismatch; exports were not changed')
    if rollback_committed and journal['state'] == 'committed':
        journal['state'] = 'rollback-incomplete'
        publication_journal(transaction, journal)
    if restore_previous:
        failures = []
        for item in reversed(journal['prior']):
            destination = output / item['name']
            temporary = output / ('.' + item['name'] + '.rollback')
            try:
                if item['existed']:
                    durable_copy(transaction / item['name'], temporary)
                    temporary.replace(destination)
                    sync_directory(output)
                    if file_sha256(destination) != item['sha256']:
                        raise ValueError('Restored publication bytes did not match their snapshot')
                elif destination.exists():
                    destination.unlink()
                    sync_directory(output)
            except (OSError, ValueError):
                failures.append(item['name'])
            finally:
                try:
                    temporary.unlink(missing_ok=True)
                except OSError:
                    failures.append(item['name'])
        if failures:
            journal.update(state='rollback-incomplete', failedRestores=failures)
            publication_journal(transaction, journal)
            raise ValueError('Publication rollback incomplete; private snapshots retained at ' + str(transaction))
        journal['state'] = 'rolled-back'
        publication_journal(transaction, journal)
    state = journal['state']
    cleanup_publication(transaction, output)
    return {'ok': True, 'state': state}


def publish_artifacts(staging, output=OUT, recovery_root=None):
    """Publish five existing paths with durable rollback, not atomic reader visibility."""
    staging, output = Path(staging), Path(output)
    recovery_root = Path(recovery_root) if recovery_root is not None else ROOT / 'data' / 'harness-audit' / 'graphify-publication'
    output.mkdir(parents=True, exist_ok=True)
    recovery_root.mkdir(parents=True, exist_ok=True)
    if output.stat().st_dev != recovery_root.stat().st_dev or output.stat().st_dev != staging.stat().st_dev:
        raise ValueError('Publication, staging and recovery snapshots must share one filesystem')
    for name in PUBLIC_ARTIFACTS:
        candidate, previous = staging / name, output / name
        if not candidate.is_file() or candidate.is_symlink() or previous.is_symlink():
            raise ValueError('Publication requires five regular staged artifacts and unaliased destinations')
        with candidate.open('r+b') as reader:
            os.fsync(reader.fileno())
    lock = output / '.refresh-publication.lock'
    transaction = None
    prepared = False
    try:
        writer = lock.open('x', encoding='utf-8')
    except FileExistsError as error:
        raise ValueError('Publication is locked; recover its private transaction before refreshing') from error
    try:
        with writer:
            transaction = Path(tempfile.mkdtemp(prefix='publication-', dir=recovery_root))
            writer.write(str(transaction.resolve()) + '\n')
            writer.flush()
            os.fsync(writer.fileno())
        sync_directory(output)
        prior = []
        for name in PUBLIC_ARTIFACTS:
            previous = output / name
            item = {'name': name, 'existed': previous.exists()}
            if item['existed']:
                durable_copy(previous, transaction / name)
                item['sha256'] = file_sha256(transaction / name)
            prior.append(item)
        journal = {'schema': 'frameforge-graph-publication/v1', 'output': str(output.resolve()),
                   'state': 'prepared', 'prior': prior}
        publication_journal(transaction, journal)
        prepared = True
        for name in PUBLIC_ARTIFACTS:
            (staging / name).replace(output / name)
            sync_directory(output)
        journal['state'] = 'committed'
        publication_journal(transaction, journal)
    except Exception as error:
        if prepared:
            try:
                recover_publication(transaction, output, rollback_committed=True)
            except Exception as recovery_error:
                raise ValueError('Publication failed and recovery is incomplete; retain ' + str(transaction)
                                 + ' and run --recover-publication before refreshing') from recovery_error
        else:
            if transaction is not None:
                shutil.rmtree(transaction)
            lock.unlink()
            sync_directory(output)
        raise ValueError('Publication failed; previous artifact bytes and receipt were preserved') from error
    try:
        cleanup_publication(transaction, output)
    except (OSError, ValueError):
        return {'ok': True, 'cleanup': 'pending', 'recovery': str(transaction)}
    return {'ok': True, 'cleanup': 'complete'}


def main():
    receipt = {'observedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
               'mode': 'native deterministic structural extraction; semantic verification not run',
               'commands': [], 'ok': False}
    OUT.mkdir(parents=True, exist_ok=True)
    try:
        if (OUT / '.refresh-publication.lock').exists():
            raise ValueError('Publication recovery is pending; use the private transaction path in .refresh-publication.lock')
        admission = load_knowledge_admission()
        receipt['knowledgeAdmission'] = {'policy': admission['policy'], 'entries': admission['entries'],
                                         'corpusBytes': admission['corpusBytes'],
                                         'validationCommand': ['node', 'scripts/knowledge.mjs', 'status'],
                                         'historicalBoundary': 'Reports remain historical; graph extraction does not prove runtime readiness'}
        with tempfile.TemporaryDirectory(prefix='.native-refresh-', dir=OUT) as directory:
            staging = Path(directory)
            graph_path = staging / 'graph.json'
            native_env = dict(env, GRAPHIFY_OUT=str(staging))
            native_commands = [['graphify', '--version'], ['graphify', 'update', str(ROOT), '--no-cluster']]
            for command in native_commands:
                result = subprocess.run(command, cwd=staging, env=native_env, capture_output=True,
                                        text=True, encoding='utf-8', timeout=120)
                receipt['commands'].append({'command': [part.replace(str(ROOT), '<repo>') for part in command],
                                            'cwd': str(staging).replace(str(ROOT), '<repo>'),
                                            'exitCode': result.returncode,
                                            'output': (result.stdout + result.stderr).replace(str(ROOT), '<repo>')
                                            if command[1] == '--version' else
                                            'Native output withheld: local extraction can mention rejected inputs'})
                if result.returncode:
                    raise ValueError('Native Graphify command failed; filtered artifacts were not published')
            current = load_knowledge_admission()
            if (current['policy'] != admission['policy'] or current['entries'] != admission['entries']):
                raise ValueError('Knowledge policy or reviewed sources changed during extraction; refresh blocked')
            graph = json.loads(graph_path.read_text(encoding='utf-8'))
            native_counts = {'nodes': len(graph['nodes']),
                             'edges': sum(len(graph.get(field, [])) for field in ('links', 'edges'))}
            receipt['checkoutLocalStateAudit'] = exclude_checkout_local_state(graph)
            receipt['wikiAdmissionAudit'] = exclude_unadmitted_wiki(graph, admission)
            receipt['edgeRecordAudit'] = normalize_edges(graph)
            paths, hashes = source_scope(graph)
            admitted_hashes = {entry['path']: entry['sha256'] for entry in admission['entries']}
            for source in hashes:
                filename = source['path'].replace(chr(92), '/')
                while filename.startswith('./'):
                    filename = filename[2:]
                if filename in admitted_hashes and source['sha256'] != admitted_hashes[filename]:
                    raise ValueError('Admitted graph source changed after validation; refresh blocked')
            graph_path.write_text(json.dumps(graph, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
            command = ['graphify', 'tree', '--graph', str(graph_path), '--output', str(staging / 'graph.html'),
                       '--root', '.', '--label', 'FrameForge admitted structural graph']
            result = subprocess.run(command, cwd=staging, env=native_env, capture_output=True, text=True,
                                    encoding='utf-8', timeout=120)
            receipt['commands'].append({'command': [part.replace(str(ROOT), '<repo>') for part in command],
                                        'cwd': str(staging).replace(str(ROOT), '<repo>'),
                                        'exitCode': result.returncode,
                                        'output': 'Native tree export of the filtered graph'})
            if result.returncode:
                raise ValueError('Native filtered tree export failed; artifacts were not published')
            receipt.update(nodes=len(graph['nodes']), edges=sum(len(graph.get(field, [])) for field in ('links', 'edges')),
                           sourceFiles=paths, sourceFileHashes=hashes, nativeUnfilteredCounts=native_counts,
                           portableSourcePaths=True, graphSha256=hashlib.sha256(graph_path.read_bytes()).hexdigest(),
                           limitations=['scope command and newer update flags unavailable in installed version',
                                        'Native extraction still scans rejected local inputs before final filtering; no CPU or token savings claimed',
                                        'Unfiltered native graph/report/cache are temporary local intermediates, never shared exports',
                                        'Relative native graphify-out manifest writes are confined by staged cwd and absolute source-root argument',
                                        'No semantic descriptions, provider calls or model-evaluated relationship claims',
                                        'Native tree HTML loads D3 from its CDN for interactive rendering'])
            scope = {'mode': 'retained native structural source paths after privacy and exact knowledge admission',
                     'excluded': ['data/', 'ops/', '.env', 'private media', 'credentials',
                                  'all llm-wiki paths except exact reviewed policy entries']
                                 + receipt['checkoutLocalStateAudit']['excludedPrefixes'],
                     'policy': admission['policy'], 'admittedWikiFiles': receipt['wikiAdmissionAudit']['admittedFiles'],
                     'files': paths, 'sourceFileHashes': hashes}
            (staging / 'scope.json').write_text(json.dumps(scope, indent=2) + '\n', encoding='utf-8')
            report = render_report(receipt)
            (staging / 'GRAPH_REPORT.md').write_text(report, encoding='utf-8')
            final_admission = load_knowledge_admission()
            if (final_admission['policy'] != admission['policy']
                    or final_admission['entries'] != admission['entries']):
                raise ValueError('Knowledge policy or reviewed sources changed before publication; refresh blocked')
            receipt.update(ok=True, publication={'mode': 'five existing paths with fsynced rollback snapshots and journal',
                                                'receiptIncluded': True,
                                                'readerVisibility': 'not an atomic multi-file reader switch; failed publication restores prior bytes',
                                                'recovery': 'python .graphify/refresh.py --recover-publication <private-transaction>'})
            (staging / 'verification.json').write_text(json.dumps(receipt, indent=2) + '\n', encoding='utf-8')
            publication = publish_artifacts(staging)
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        receipt.update(ok=False, error=str(error).replace(str(ROOT), '<repo>'))
        failure_directory = ROOT / 'data' / 'harness-audit'
        try:
            failure_directory.mkdir(parents=True, exist_ok=True)
            handle, filename = tempfile.mkstemp(prefix='graphify-refresh-failure-', suffix='.json', dir=failure_directory)
            with os.fdopen(handle, 'w', encoding='utf-8') as writer:
                writer.write(json.dumps(receipt, indent=2) + '\n')
                writer.flush()
                os.fsync(writer.fileno())
            sync_directory(failure_directory)
            detail = '; private failure receipt: ' + str(Path(filename).relative_to(ROOT))
        except OSError as receipt_error:
            detail = '; private failure receipt unavailable: ' + str(receipt_error).replace(str(ROOT), '<repo>')
        raise SystemExit(receipt['error'] + detail) from error
    print(json.dumps({'ok': True, 'nodes': receipt['nodes'], 'edges': receipt['edges'],
                      'sourceFiles': len(paths), 'publication': publication}))


def render_report(receipt):
    return f'''# FrameForge structural graph

Native Graphify structural extraction after admission: **{receipt['nodes']} nodes, {receipt['edges']} edges**.

The installed native CLI can accumulate exact duplicate edge records. This refresh
normalized {receipt['edgeRecordAudit']['raw']} native records to
{receipt['edgeRecordAudit']['exactUnique']} whole-record-unique edges within their native
collections, removing {receipt['edgeRecordAudit']['exactDuplicatesRemoved']} exact
duplicates before HTML export. Stable sorted-key JSON identifies equality of the entire
record within each collection; edges with different metadata remain separate. graph.json,
this report and graph.html all derive from the normalized artifact. No exact duplicate
records remain within either native collection.

Before normalization/export, checkout-local agent state and generated vault metadata
are removed with their incident or locally sourced edges. This refresh removed
{receipt['checkoutLocalStateAudit']['nodesRemoved']} nodes and
{receipt['checkoutLocalStateAudit']['edgesRemoved']} edges from these noncanonical
paths. The exclusion audit is retained in verification.json; canonical source
relationships with distinct metadata remain intact.

Exact reviewed authored wiki bodies are admitted through `harness/knowledge-policy.json`.
This refresh removed {receipt['wikiAdmissionAudit']['nodesRemoved']} unadmitted wiki nodes and
{receipt['wikiAdmissionAudit']['edgesRemoved']} incident or locally sourced edges. Raw captures,
prompt/query stubs, caches, operational state and all index/log/instruction bodies are
excluded. Provenance evidence paths do not admit their target bodies. Reports remain
historical references, never current readiness or goal-completion authority.

This is a deterministic structural graph, not semantic verification. Extraction and
interactive tree export use the installed Graphify CLI; no provider or model call is
required. The native extractor still scans rejected local inputs before final filtering;
no extraction CPU or billed-token savings are claimed. Unfiltered native artifacts and
caches stay in temporary local staging; only filtered graph/report/tree are published.
The native command receives an absolute source root and a staged working directory, so
the installed CLI's relative `graphify-out/manifest.json` also stays local to staging.
The retained source scope and source hashes are in [scope.json](scope.json); admission
policy/hash, reviewed file hashes, removed counts and command exit codes are in
[verification.json](verification.json).

Publication covers graph.json, graph.html, scope.json, this report and verification.json
as one rollback-protected generation. Fsynced private snapshots and a journal preserve
the previous bytes on ordinary publication failure; this is not atomic multi-file reader
visibility. If restoration itself fails or the process is interrupted, publication is
blocked by `.refresh-publication.lock`. Its private transaction path can be recovered
with `python .graphify/refresh.py --recover-publication <private-transaction>`; snapshots
remain private until recovery completes. Failed attempts never overwrite the previous
shared receipt and are recorded separately under private `data/harness-audit/`.

Open [graph.html](graph.html) for the native interactive tree. Its D3 dependency
loads from a CDN. [graph.json](graph.json) is the portable machine-readable artifact.
Only explicitly reviewed project knowledge joins the code graph. Private live episode
data and unadmitted vault content are not shared structural evidence.

The installed 0.8.39 CLI rejected `scope` and newer `update --no-description`
flags. Its `export html` succeeded even though omitted from help. A one-time
`cluster-only --no-label` run produced placeholder Community N labels; that
historical output is under `clustered/` and is not automatically refreshed.
Use current graph.json and this report for current counts.

Refresh with `python .graphify/refresh.py`. No hooks or shared skills are installed.
'''


if __name__ == '__main__':
    if len(sys.argv) == 3 and sys.argv[1] == '--recover-publication':
        print(json.dumps(recover_publication(Path(sys.argv[2]))))
    elif len(sys.argv) != 1:
        raise SystemExit('Usage: python .graphify/refresh.py [--recover-publication <private-transaction>]')
    else:
        main()
