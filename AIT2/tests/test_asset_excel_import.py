import csv
import io
import tempfile
import unittest

from openpyxl import Workbook

import app as app_module
from data_manager import DataManager
from models import InventoryItem, User, hash_password


IMPORT_HEADERS = [
    'Brand *',
    'Model *',
    'Description',
    'Version',
    'Department Code or Name *',
    'Quantity *',
    'Bulk Asset',
    'Primary Serial Numbers',
    'Secondary Serial Numbers',
    'Date of Purchase',
    'Notes',
    'Tags',
    'Default Location',
    'Custom Asset ID Prefix',
]


class AssetTemplateImportTests(unittest.TestCase):
    def setUp(self):
        self.original_data_manager = app_module.get_default_data_manager()
        self.original_signature = app_module._data_snapshot_signature
        self.original_testing = app_module.app.config.get('TESTING')
        self.tempdir = tempfile.TemporaryDirectory()

        self.data_manager = DataManager(self.tempdir.name)
        self.data_manager.setup_data_folder()
        self.data_manager.users = {
            'admin': User('admin', hash_password('pw', 'salt'), 'salt', True, True),
        }
        self.data_manager.logs = []
        self.data_manager.inventory = {
            'A#01': InventoryItem(
                asset_id='A#01',
                brand='Shure',
                model_number='SM58',
                serial_number='OLD-1',
                description='Black microphone',
                is_missing=False,
                maintenance_logs=[],
                department_code='AX',
                default_location='Store',
                current_location='',
            ),
        }
        self.data_manager.save_users()
        self.data_manager.save_logs()
        self.data_manager.save_inventory()

        app_module.app.config['TESTING'] = True
        app_module.set_data_manager_for_testing(self.data_manager)
        app_module.invalidate_cache()
        self.client = app_module.app.test_client()
        with self.client.session_transaction() as session:
            session['user'] = 'admin'
            session['is_admin'] = True

    def tearDown(self):
        app_module.clear_test_data_manager(self.original_data_manager)
        app_module._data_snapshot_signature = self.original_signature
        app_module.app.config['TESTING'] = self.original_testing
        self.tempdir.cleanup()

    def csv_bytes(self, rows):
        output = io.StringIO(newline='')
        writer = csv.writer(output)
        writer.writerow(IMPORT_HEADERS)
        writer.writerows(rows)
        return ('\ufeff' + output.getvalue()).encode('utf-8')

    def workbook_bytes(self, rows):
        workbook = Workbook()
        sheet = workbook.active
        sheet.title = 'Assets'
        sheet.append(['Asset Import Template'])
        sheet.append([])
        sheet.append([])
        sheet.append(IMPORT_HEADERS)
        for row in rows:
            sheet.append(row)
        output = io.BytesIO()
        workbook.save(output)
        return output.getvalue()

    def test_download_template_is_utf8_csv_with_supported_columns(self):
        response = self.client.get('/api/assets/import-template')

        self.assertEqual(response.status_code, 200)
        self.assertIn('text/csv', response.content_type)
        self.assertIn('Asset Import Template.csv', response.headers['Content-Disposition'])
        rows = list(csv.reader(io.StringIO(response.data.decode('utf-8-sig'))))
        self.assertEqual(rows, [IMPORT_HEADERS])
        self.assertNotIn('Asset ID', rows[0])

    def test_preview_accepts_csv_and_modern_excel(self):
        row = [
            'Shure', 'SM58', 'Silver microphone', '', 'AX', 1, 'No',
            'NEW-1', '', '2026-08-14', 'Spare mic', 'wired, vocal',
            'Store', 'MIC',
        ]
        for file_bytes, filename in (
            (self.csv_bytes([row]), 'assets.csv'),
            (self.workbook_bytes([row]), 'assets.xlsx'),
            (self.workbook_bytes([row]), 'assets.xlsm'),
        ):
            with self.subTest(filename=filename):
                response = self.client.post(
                    '/api/assets/import-preview',
                    data={'file': (io.BytesIO(file_bytes), filename)},
                    content_type='multipart/form-data',
                )
                self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
                imported = response.get_json()['data']['rows'][0]
                self.assertEqual(imported['serials'], ['NEW-1'])
                self.assertEqual(imported['assetIdsPreview'], ['MIC#01'])
                self.assertEqual(imported['differentDescriptions'], ['Black microphone'])

    def test_serials_accept_commas_and_excel_numbers_do_not_gain_decimal_suffix(self):
        csv_response = self.client.post(
            '/api/assets/import-preview',
            data={'file': (io.BytesIO(self.csv_bytes([[
                'New', 'Model', '', '', 'AX', 3, 'No',
                '1001, 1002\n1003', '', '', '', '', 'Store', 'SER',
            ]])), 'assets.csv')},
            content_type='multipart/form-data',
        )
        self.assertEqual(csv_response.status_code, 200, csv_response.get_data(as_text=True))
        self.assertEqual(csv_response.get_json()['data']['rows'][0]['serials'], ['1001', '1002', '1003'])

        excel_response = self.client.post(
            '/api/assets/import-preview',
            data={'file': (io.BytesIO(self.workbook_bytes([[
                'New', 'Numeric', '', '', 'AX', 1, 'No',
                12345678.0, '', '', '', '', 'Store', 'NUM',
            ]])), 'assets.xlsx')},
            content_type='multipart/form-data',
        )
        self.assertEqual(excel_response.status_code, 200, excel_response.get_data(as_text=True))
        self.assertEqual(excel_response.get_json()['data']['rows'][0]['serials'], ['12345678'])

    def test_serial_mismatch_and_future_purchase_date_are_warnings_not_blockers(self):
        response = self.client.post(
            '/api/assets/import-preview',
            data={'file': (io.BytesIO(self.csv_bytes([[
                'New', 'Warning Model', '', '', 'AX', 3, 'No',
                'ONLY-ONE', '', '2099-12-31', '', '', 'Store', 'WARN',
            ]])), 'assets.csv')},
            content_type='multipart/form-data',
        )
        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        preview = response.get_json()['data']
        row = preview['rows'][0]
        self.assertEqual(row['validationError'], '')
        self.assertTrue(any('1/3' in warning for warning in row['validationWarnings']))
        self.assertIn('Date of purchase is in the future', row['validationWarnings'])

        created = self.client.post('/api/assets/import', json={
            'rows': [row],
            'planToken': preview['planToken'],
        })
        self.assertEqual(created.status_code, 200, created.get_data(as_text=True))
        self.assertEqual(created.get_json()['data']['inventoryRecordsCreated'], 3)
        self.assertEqual(self.data_manager.inventory['WARN#01'].serial_number, 'ONLY-ONE')
        self.assertEqual(self.data_manager.inventory['WARN#02'].serial_number, '')
        self.assertEqual(self.data_manager.inventory['WARN#03'].date_of_purchase, '2099-12-31')

    def test_preview_resolves_department_name_and_unknown_department_requires_creation(self):
        known_response = self.client.post(
            '/api/assets/import-preview',
            data={'file': (io.BytesIO(self.csv_bytes([[
                'Shure', 'SM58', '', '', 'Audio', 1, 'No', '', '', '', '', '', 'Store', 'KNOWN',
            ]])), 'assets.csv')},
            content_type='multipart/form-data',
        )
        self.assertEqual(known_response.status_code, 200, known_response.get_data(as_text=True))
        known = known_response.get_json()['data']['rows'][0]
        self.assertEqual(known['department'], 'AX')
        self.assertTrue(known['departmentMatched'])

        unknown_response = self.client.post(
            '/api/assets/import-preview',
            data={'file': (io.BytesIO(self.csv_bytes([[
                'CameraCo', 'C1', '', '', 'Camera', 1, 'No', '', '', '', '', '', 'Store', 'CAM',
            ]])), 'assets.csv')},
            content_type='multipart/form-data',
        )
        self.assertEqual(unknown_response.status_code, 200, unknown_response.get_data(as_text=True))
        unknown_preview = unknown_response.get_json()['data']
        row = unknown_preview['rows'][0]
        self.assertFalse(row['departmentMatched'])
        blocked = self.client.post('/api/assets/import', json={
            'rows': [row],
            'planToken': unknown_preview['planToken'],
        })
        self.assertEqual(blocked.status_code, 400)

        row['createDepartment'] = True
        row['newDepartmentCode'] = 'CAM'
        row['newDepartmentName'] = 'Camera'
        replanned_response = self.client.post('/api/assets/import-plan', json={'rows': [row]})
        self.assertEqual(replanned_response.status_code, 200, replanned_response.get_data(as_text=True))
        replanned = replanned_response.get_json()['data']
        created = self.client.post('/api/assets/import', json={
            'rows': replanned['rows'],
            'planToken': replanned['planToken'],
        })
        self.assertEqual(created.status_code, 200, created.get_data(as_text=True))
        self.assertEqual(self.data_manager.inventory['CAM#01'].department_code, 'CAM')

    def test_prefix_plan_reserves_ids_across_rows_and_matches_saved_ids(self):
        rows = [
            {'brand': 'New', 'model': 'One', 'department': 'AX', 'quantity': 1, 'isBulk': False, 'assetIdPrefix': 'IMP'},
            {'brand': 'New', 'model': 'Two', 'department': 'AX', 'quantity': 2, 'isBulk': False, 'assetIdPrefix': 'IMP'},
        ]
        plan = self.client.post('/api/assets/import-plan', json={'rows': rows})
        self.assertEqual(plan.status_code, 200, plan.get_data(as_text=True))
        plan_data = plan.get_json()['data']
        planned = plan_data['rows']
        self.assertEqual(planned[0]['assetIdsPreview'], ['IMP#01'])
        self.assertEqual(planned[1]['assetIdsPreview'], ['IMP#02', 'IMP#03'])

        created = self.client.post('/api/assets/import', json={
            'rows': planned,
            'planToken': plan_data['planToken'],
        })
        self.assertEqual(created.status_code, 200, created.get_data(as_text=True))
        self.assertTrue({'IMP#01', 'IMP#02', 'IMP#03'}.issubset(self.data_manager.inventory))

    def test_bulk_rows_use_automatic_bulk_ids(self):
        rows = [{
            'brand': 'Generic',
            'model': 'DMX-1.5M',
            'description': 'DMX Cable - 1.5m',
            'department': 'LX',
            'quantity': 25,
            'isBulk': True,
            'defaultLocation': 'Store',
            'assetIdPrefix': 'IGNORED',
        }]
        plan_response = self.client.post('/api/assets/import-plan', json={'rows': rows})
        self.assertEqual(plan_response.status_code, 200, plan_response.get_data(as_text=True))
        plan = plan_response.get_json()['data']
        response = self.client.post('/api/assets/import', json={
            'rows': plan['rows'],
            'planToken': plan['planToken'],
        })
        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        self.assertIn('BULK-0001', self.data_manager.inventory)
        self.assertEqual(self.data_manager.inventory['BULK-0001'].quantity, 25)

    def test_blank_serial_positions_are_preserved_through_import(self):
        response = self.client.post(
            '/api/assets/import-preview',
            data={'file': (io.BytesIO(self.csv_bytes([[
                'New', 'Positional', '', '', 'AX', 3, 'No',
                '\nSN-002\nSN-003', '', '', '', '', 'Store', 'POS',
            ]])), 'assets.csv')},
            content_type='multipart/form-data',
        )
        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        preview = response.get_json()['data']
        self.assertEqual(preview['rows'][0]['serials'], ['', 'SN-002', 'SN-003'])

        created = self.client.post('/api/assets/import', json={
            'rows': preview['rows'],
            'planToken': preview['planToken'],
        })
        self.assertEqual(created.status_code, 200, created.get_data(as_text=True))
        self.assertEqual(self.data_manager.inventory['POS#01'].serial_number, '')
        self.assertEqual(self.data_manager.inventory['POS#02'].serial_number, 'SN-002')
        self.assertEqual(self.data_manager.inventory['POS#03'].serial_number, 'SN-003')

    def test_windows_1252_csv_is_not_misread_as_utf16(self):
        output = io.StringIO(newline='')
        writer = csv.writer(output)
        writer.writerow(IMPORT_HEADERS)
        writer.writerow([
            'Acme', 'Windows CSV', 'Caf\u00e9 microphone', '', 'AX', 1, 'No',
            '', '', '', '', '', 'Store', 'WIN',
        ])
        response = self.client.post(
            '/api/assets/import-preview',
            data={'file': (io.BytesIO(output.getvalue().encode('cp1252')), 'assets.csv')},
            content_type='multipart/form-data',
        )
        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        self.assertEqual(
            response.get_json()['data']['rows'][0]['description'],
            'Caf\u00e9 microphone',
        )

    def test_stale_plan_refreshes_ids_before_any_assets_are_created(self):
        plan_response = self.client.post('/api/assets/import-plan', json={'rows': [{
            'brand': 'Acme', 'model': 'Race', 'department': 'AX', 'quantity': 1,
            'isBulk': False, 'assetIdPrefix': 'RACE',
        }]})
        plan = plan_response.get_json()['data']
        self.assertEqual(plan['rows'][0]['assetIdsPreview'], ['RACE#01'])

        self.data_manager.inventory['RACE#01'] = InventoryItem(
            asset_id='RACE#01', brand='Other', model_number='Existing',
            serial_number='', description='', is_missing=False,
            maintenance_logs=[], department_code='AX', default_location='Store',
            current_location='',
        )
        self.data_manager.save_inventory()

        stale = self.client.post('/api/assets/import', json={
            'rows': plan['rows'],
            'planToken': plan['planToken'],
        })
        self.assertEqual(stale.status_code, 409, stale.get_data(as_text=True))
        stale_payload = stale.get_json()
        self.assertEqual(stale_payload['code'], 'asset_import_plan_stale')
        refreshed = stale_payload['data']
        self.assertEqual(refreshed['rows'][0]['assetIdsPreview'], ['RACE#02'])
        self.assertNotIn('RACE#02', self.data_manager.inventory)

        created = self.client.post('/api/assets/import', json={
            'rows': refreshed['rows'],
            'planToken': refreshed['planToken'],
        })
        self.assertEqual(created.status_code, 200, created.get_data(as_text=True))
        self.assertIn('RACE#02', self.data_manager.inventory)

    def test_one_new_department_declaration_resolves_sibling_rows(self):
        rows = [
            {
                'brand': 'CameraCo', 'model': 'C1', 'department': 'Camera',
                'quantity': 1, 'isBulk': False, 'assetIdPrefix': 'CAM',
                'createDepartment': True, 'newDepartmentCode': 'CAM',
                'newDepartmentName': 'Camera',
            },
            {
                'brand': 'CameraCo', 'model': 'C2', 'department': 'CAM',
                'quantity': 1, 'isBulk': False, 'assetIdPrefix': 'CAM2',
            },
        ]
        plan_response = self.client.post('/api/assets/import-plan', json={'rows': rows})
        self.assertEqual(plan_response.status_code, 200, plan_response.get_data(as_text=True))
        plan = plan_response.get_json()['data']
        self.assertTrue(plan['rows'][1]['departmentMatched'])
        self.assertTrue(plan['rows'][1]['departmentWillBeCreated'])

        created = self.client.post('/api/assets/import', json={
            'rows': plan['rows'],
            'planToken': plan['planToken'],
        })
        self.assertEqual(created.status_code, 200, created.get_data(as_text=True))
        self.assertEqual(self.data_manager.inventory['CAM#01'].department_code, 'CAM')
        self.assertEqual(self.data_manager.inventory['CAM2#01'].department_code, 'CAM')

    def test_import_accepts_one_thousand_rows(self):
        rows = [
            {
                'brand': 'Load', 'model': f'Unit {index}', 'department': 'AX',
                'quantity': 1, 'isBulk': False, 'assetIdPrefix': 'LOAD',
            }
            for index in range(1000)
        ]
        plan_response = self.client.post('/api/assets/import-plan', json={'rows': rows})
        self.assertEqual(plan_response.status_code, 200, plan_response.get_data(as_text=True))
        plan = plan_response.get_json()['data']
        self.assertEqual(len(plan['rows']), 1000)

        created = self.client.post('/api/assets/import', json={
            'rows': plan['rows'],
            'planToken': plan['planToken'],
        })
        self.assertEqual(created.status_code, 200, created.get_data(as_text=True))
        self.assertEqual(created.get_json()['data']['inventoryRecordsCreated'], 1000)
        self.assertIn('LOAD#1000', self.data_manager.inventory)

    def test_import_rejects_more_than_one_thousand_source_rows(self):
        rows = [
            {'brand': 'Load', 'model': 'Unit', 'department': 'AX', 'quantity': 1}
            for _ in range(1001)
        ]
        response = self.client.post('/api/assets/import-plan', json={'rows': rows})
        self.assertEqual(response.status_code, 400)
        self.assertIn('at most 1000 rows', response.get_json()['error'])

    def test_plan_rejects_unsafe_expanded_record_count_before_allocating_ids(self):
        rows = [
            {
                'brand': 'Load', 'model': f'Large {index}', 'department': 'AX',
                'quantity': 500, 'isBulk': False, 'assetIdPrefix': f'L{index}',
            }
            for index in range(101)
        ]
        response = self.client.post('/api/assets/import-plan', json={'rows': rows})
        self.assertEqual(response.status_code, 400)
        self.assertIn('more than 50,000 inventory records', response.get_json()['error'])


def test_asset_import_review_ui_is_compact_categorized_and_editable():
    from pathlib import Path

    root = Path(__file__).resolve().parents[1]
    template = (root / 'templates' / 'index.html').read_text(encoding='utf-8')
    script = (root / 'static' / 'js' / 'app.js').read_text(encoding='utf-8')

    assert 'Download Template' in template
    assert 'Upload Template' in template
    assert '.csv,text/csv,.xlsx,.xlsm,.xls' in template
    assert 'id="assetImportModal"' in template
    assert 'Review, edit, or remove rows before anything is added to inventory.' in template
    assert "function updateAssetImportRow(" in script
    assert "function removeAssetImportRow(" in script
    assert "function assetImportRowWarnings(" in script
    assert "serials.filter(serial => String(serial || '').trim()).length" in script
    assert "function assetImportDepartmentResolution(" in script
    assert "function setAssetImportDepartmentCreation(" in script
    assert "function refreshAssetImportPlan(" in script
    assert "{ key: 'error', title: 'Needs attention'" in script
    assert "{ key: 'warning', title: 'Warnings'" in script
    assert "{ key: 'ready', title: 'Ready'" in script
    assert 'Asset ID preview:' in script
    assert 'Exact Asset ID' not in script
    assert "'/api/assets/import-preview'" in script
    assert "'/api/assets/import-plan'" in script
    assert "'/api/assets/import'" in script
