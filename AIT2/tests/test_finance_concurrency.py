import unittest

from finance_concurrency import FinanceMergeConflict, three_way_merge


class FinanceConcurrencyTests(unittest.TestCase):
    def test_separate_documents_merge(self):
        base = {
            'documents': [
                {'id': 'quote-1', 'notes': '', 'documentVersion': 1},
                {'id': 'quote-2', 'notes': '', 'documentVersion': 1},
            ],
        }
        local = {
            'documents': [
                {'id': 'quote-1', 'notes': 'Local', 'documentVersion': 2},
                base['documents'][1],
            ],
        }
        remote = {
            'documents': [
                base['documents'][0],
                {'id': 'quote-2', 'notes': 'Remote', 'documentVersion': 2},
            ],
        }

        merged = three_way_merge(base, local, remote)
        by_id = {row['id']: row for row in merged['documents']}

        self.assertEqual(by_id['quote-1']['notes'], 'Local')
        self.assertEqual(by_id['quote-2']['notes'], 'Remote')

    def test_separate_lines_in_one_document_merge(self):
        base = {
            'id': 'quote-1',
            'documentVersion': 1,
            'lineItems': [
                {'id': 'line-a', 'quantity': 1, 'description': 'A'},
                {'id': 'line-b', 'quantity': 1, 'description': 'B'},
            ],
        }
        local = {
            **base,
            'documentVersion': 2,
            'lineItems': [
                {'id': 'line-a', 'quantity': 2, 'description': 'A'},
                base['lineItems'][1],
            ],
        }
        remote = {
            **base,
            'documentVersion': 2,
            'lineItems': [
                base['lineItems'][0],
                {'id': 'line-b', 'quantity': 3, 'description': 'B'},
            ],
        }

        merged = three_way_merge(base, local, remote)
        by_id = {row['id']: row for row in merged['lineItems']}

        self.assertEqual(by_id['line-a']['quantity'], 2)
        self.assertEqual(by_id['line-b']['quantity'], 3)

    def test_same_line_field_conflicts(self):
        base = {'lineItems': [{'id': 'line-a', 'quantity': 1}]}
        local = {'lineItems': [{'id': 'line-a', 'quantity': 2}]}
        remote = {'lineItems': [{'id': 'line-a', 'quantity': 3}]}

        with self.assertRaises(FinanceMergeConflict):
            three_way_merge(base, local, remote)


if __name__ == '__main__':
    unittest.main()
