"""Offline regression for exact-record normalization without running Graphify."""
import ast
import json
from pathlib import Path
import unittest

source = ast.parse(Path(__file__).with_name('refresh.py').read_text(encoding='utf-8'))
function = next(node for node in source.body if isinstance(node, ast.FunctionDef)
                and node.name == 'normalize_edges')
namespace = {'json': json}
exec(compile(ast.Module(body=[function], type_ignores=[]), 'refresh.py', 'exec'), namespace)
normalize_edges = namespace['normalize_edges']


class NormalizationTest(unittest.TestCase):
    def test_key_order_duplicates_removed_but_metadata_kept(self):
        first = {'source': 'a', 'target': 'b', 'metadata': {'line': 2, 'kind': 'call'}}
        reordered = {'metadata': {'kind': 'call', 'line': 2}, 'target': 'b', 'source': 'a'}
        different = {'source': 'a', 'target': 'b', 'metadata': {'line': 3, 'kind': 'call'}}
        graph = {'nodes': [{'id': 'a'}], 'links': [first, reordered, different]}
        audit = normalize_edges(graph)
        self.assertEqual(graph['links'], [first, different])
        self.assertEqual(graph['nodes'], [{'id': 'a'}])
        self.assertEqual(audit['exactDuplicatesRemoved'], 1)
        self.assertEqual(normalize_edges(graph)['exactDuplicatesRemoved'], 0)

    def test_edges_field_and_nested_order(self):
        graph = {'edges': [{'a': [1, 2]}, {'a': [2, 1]}, {'a': [1, 2]}]}
        normalize_edges(graph)
        self.assertEqual(graph['edges'], [{'a': [1, 2]}, {'a': [2, 1]}])


if __name__ == '__main__':
    unittest.main()
