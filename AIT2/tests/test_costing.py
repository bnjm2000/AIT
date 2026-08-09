import json
import os
import tempfile
import unittest

import app as app_module
from data_manager import DataManager
from models import InventoryItem, User, hash_password
from workforce import event_assignments, load_workforce, save_workforce


class CostingFeatureTests(unittest.TestCase):
    def setUp(self):
        self.original_manager = app_module.get_default_data_manager()
        self.original_signature = app_module._data_snapshot_signature
        self.original_testing = app_module.app.config.get('TESTING')
        self.original_registry_file = app_module.COMPANY_REGISTRY_FILE
        self.original_registry_cache = app_module._company_registry_cache
        self.tempdir = tempfile.TemporaryDirectory()

        app_module.COMPANY_REGISTRY_FILE = os.path.join(
            self.tempdir.name, 'Companies.json'
        )
        app_module._company_registry_cache = None
        company = app_module._new_company_record('TEST', 'Costing Test')
        app_module._save_company_registry({
            'defaultCompany': 'TEST',
            'companies': {'TEST': company},
            'userCompanies': {
                'owner': 'TEST', 'admin': 'TEST', 'sales': 'TEST',
                'viewer': 'TEST',
            },
            'superAdmins': ['owner'],
        })
        self.manager = DataManager(self.tempdir.name)
        self.manager.setup_data_folder()
        self.manager.users = {
            'owner': self.make_user('owner', 'owner', True),
            'admin': self.make_user('admin', 'admin', True),
            'sales': self.make_user('sales', 'user', True),
            'viewer': self.make_user('viewer', 'user', False),
        }
        self.manager.inventory = {
            'AX#01': InventoryItem(
                asset_id='AX#01',
                brand='L-Acoustics',
                model_number='SB18',
                serial_number='SN-1',
                description='Subwoofer',
                is_missing=False,
                maintenance_logs=[],
                department_code='AX',
            )
        }
        self.manager.save_users()
        self.manager.save_inventory()
        app_module.app.config['TESTING'] = True
        app_module.set_data_manager_for_testing(self.manager)
        self.client = app_module.app.test_client()

    def tearDown(self):
        app_module.clear_test_data_manager(self.original_manager)
        app_module._data_snapshot_signature = self.original_signature
        app_module.app.config['TESTING'] = self.original_testing
        app_module.COMPANY_REGISTRY_FILE = self.original_registry_file
        app_module._company_registry_cache = self.original_registry_cache
        self.tempdir.cleanup()

    @staticmethod
    def make_user(username, role, sales):
        return User(
            username,
            hash_password('pw', f'{username}-salt'),
            f'{username}-salt',
            True,
            role=role,
            has_sales_access=sales,
        )

    def login(self, username):
        user = self.manager.users[username]
        with self.client.session_transaction() as session:
            session.clear()
            session['user'] = username
            session['role'] = user.role
            session['is_admin'] = user.is_admin
            session['is_super_admin'] = username == 'owner'
            session['has_sales_access'] = user.has_sales_access
            session['is_active'] = True
            session['company_code'] = 'TEST'

    def create_costing(self, **overrides):
        payload = {'projectName': 'Launch Project', **overrides}
        response = self.client.post('/api/costings', json=payload)
        self.assertEqual(response.status_code, 201, response.get_data(as_text=True))
        return response.get_json()['data']

    def test_page_and_api_are_owner_only(self):
        self.login('owner')
        page = self.client.get('/costing')
        self.assertEqual(page.status_code, 200)
        self.assertIn(b'costing.js', page.data)
        self.assertEqual(self.client.get('/costing/example-costing').status_code, 200)
        self.assertEqual(self.client.get('/api/costings').status_code, 200)

        self.login('admin')
        self.assertEqual(self.client.get('/costing').status_code, 302)
        self.assertEqual(self.client.get('/api/costings').status_code, 403)

        self.login('sales')
        self.assertEqual(self.client.get('/costing').status_code, 302)
        self.assertEqual(self.client.get('/costing/example-costing').status_code, 302)
        self.assertEqual(self.client.get('/api/costings').status_code, 403)

        self.login('viewer')
        page = self.client.get('/costing')
        self.assertEqual(page.status_code, 302)
        self.assertTrue(page.headers['Location'].endswith('/events'))
        self.assertEqual(self.client.get('/api/costings').status_code, 403)

    def test_every_quotation_has_same_owner_costing_and_owner_can_view_it(self):
        self.login('owner')
        quotation_response = self.client.post('/api/quotations', json={
            'projectName': 'Paired Project',
            'eventLocation': 'Hall A',
            'lineItems': [{
                'description': 'Projector',
                'department': 'Video',
                'quantity': 2,
                'days': 3,
                'unitPrice': 100,
            }],
        })
        self.assertEqual(
            quotation_response.status_code, 201,
            quotation_response.get_data(as_text=True),
        )
        quotation = quotation_response.get_json()['data']
        self.assertTrue(quotation['sourceCostingId'])

        owner_costings = self.client.get('/api/costings').get_json()['data']
        paired = next(
            row for row in owner_costings
            if row['id'] == quotation['sourceCostingId']
        )
        self.assertEqual(paired['salespersonUsername'], 'owner')
        self.assertEqual(paired['convertedQuotationId'], quotation['id'])
        self.assertEqual(paired['eventLocation'], 'Hall A')

        self.login('sales')
        self.assertEqual(self.client.get('/api/costings').status_code, 403)
        self.login('admin')
        self.assertEqual(self.client.get('/api/costings').status_code, 403)
        self.login('owner')
        all_costings = self.client.get('/api/costings').get_json()['data']
        self.assertIn(quotation['sourceCostingId'], {row['id'] for row in all_costings})
        self.assertEqual(
            self.client.get('/api/costings', query_string={'mine': '1'})
            .get_json()['data'][0]['id'],
            quotation['sourceCostingId'],
        )

        reassigned = self.client.put(
            f"/api/quotations/{quotation['id']}",
            json={'salesperson': 'sales', 'salespersonUsername': 'sales'},
        )
        self.assertEqual(reassigned.status_code, 200, reassigned.get_data(as_text=True))
        self.login('sales')
        self.assertEqual(self.client.get('/api/costings').status_code, 403)

        quotation_update = self.client.put(
            f"/api/quotations/{quotation['id']}",
            json={'eventLocation': 'Hall B'},
        )
        self.assertEqual(quotation_update.status_code, 200)
        self.login('owner')
        costing_detail = self.client.get(
            f"/api/costings/{quotation['sourceCostingId']}"
        ).get_json()['data']
        self.assertEqual(costing_detail['eventLocation'], 'Hall B')
        costing_detail['eventLocation'] = 'Hall C'
        costing_update = self.client.put(
            f"/api/costings/{quotation['sourceCostingId']}",
            json=costing_detail,
        )
        self.assertEqual(costing_update.status_code, 200)
        refreshed_quote = self.client.get(
            f"/api/quotations/{quotation['id']}"
        ).get_json()['data']
        self.assertEqual(refreshed_quote['eventLocation'], 'Hall C')

    def test_schema_migration_backfills_costing_for_existing_quotation(self):
        finance_path = os.path.join(self.tempdir.name, app_module.FINANCE_FILENAME)
        with open(finance_path, 'w', encoding='utf-8') as finance_file:
            json.dump({
                'version': 12,
                'documents': [{
                    'id': 'legacy-quotation',
                    'type': 'quotation',
                    'number': 'QT-2026-001-01',
                    'projectName': 'Existing Project',
                    'status': 'draft',
                    'salesperson': 'sales',
                    'salespersonUsername': 'sales',
                    'createdBy': 'sales',
                    'lineItems': [{
                        'id': 'legacy-line',
                        'description': 'Existing speaker',
                        'department': 'Audio',
                        'quantity': 1,
                        'days': 1,
                        'unitPrice': 250,
                        'total': 250,
                    }],
                }],
            }, finance_file)

        self.login('sales')
        quotation = self.client.get('/api/quotations/legacy-quotation').get_json()['data']
        self.assertEqual(self.client.get('/api/costings').status_code, 403)
        self.login('owner')
        costings = self.client.get('/api/costings').get_json()['data']
        self.assertEqual(len(costings), 1)
        self.assertEqual(costings[0]['projectName'], 'Existing Project')
        self.assertEqual(costings[0]['salespersonUsername'], 'sales')
        self.assertEqual(quotation['sourceCostingId'], costings[0]['id'])

    def test_vendor_lookups_do_not_block_initial_costing_list(self):
        source_path = os.path.join(
            os.path.dirname(app_module.__file__), 'static', 'js', 'costing.js'
        )
        with open(source_path, encoding='utf-8') as source_file:
            source = source_file.read()
        loader = source[source.index('function loadCosting()'):source.index(
            'async function costingLoadLookups()'
        )]
        self.assertLess(
            loader.index('costingLoadList()'),
            loader.index('costingLoadLookups()'),
        )
        self.assertNotIn('await costingLoadLookups()', loader)
        self.assertIn("id=\"costingListResults\"", source)
        self.assertIn('costingListSortControl()', source)
        self.assertIn("showAppForm({", source)
        self.assertNotIn('<select class="finance-input costing-sort"', source)

    def test_unconfirmed_vendor_edits_flow_back_to_costing(self):
        self.login('owner')
        costing = self.create_costing(
            eventLocation='Marina Bay Sands',
            lineItems=[{
                'id': 'rental-line',
                'description': 'Wireless microphone',
                'category': 'Audio',
                'quantity': 2,
                'multiplier': 3,
                'vendorName': 'Rental House',
                'itemCost': 20,
                'targetMarginPercent': 20,
                'salePrice': 144,
                'remarks': 'Confirm frequency band',
                'isCustom': True,
            }],
            categoryAdjustments=[{'category': 'Audio', 'amount': -4}],
        )
        self.assertEqual(costing['totals']['cost'], 120)
        self.assertEqual(costing['totals']['sale'], 140)
        self.assertEqual(costing['totals']['profit'], 20)

        workforce = load_workforce(self.manager.data_folder)
        vendor = next(row for row in workforce['vendors'] if row['name'] == 'Rental House')
        self.assertEqual(vendor['costingRentals'][0]['amount'], 120)

        changed = self.client.put(
            f"/api/workforce/vendors/{vendor['id']}",
            json={
                'name': vendor['name'],
                'memberIds': [],
                'notes': vendor.get('notes', ''),
                'active': True,
                'costingRentals': [{
                    **vendor['costingRentals'][0],
                    'amount': 135,
                }],
            },
        )
        self.assertEqual(changed.status_code, 200, changed.get_data(as_text=True))

        response = self.client.get(f"/api/costings/{costing['id']}")
        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        refreshed = response.get_json()['data']
        self.assertEqual(refreshed['lineItems'][0]['costTotal'], 135)
        self.assertEqual(refreshed['lineItems'][0]['itemCost'], 22.5)
        self.assertEqual(refreshed['vendorDiscrepancies'], [])

    def test_stale_event_reference_does_not_trigger_vendor_review(self):
        self.login('owner')
        created = self.client.post('/api/quotations', json={
            'projectName': 'Costing Without Event',
            'lineItems': [{
                'id': 'vendor-line',
                'description': 'Audio rental',
                'department': 'Audio',
                'quantity': 1,
                'days': 1,
                'total': 100,
            }],
        })
        self.assertEqual(created.status_code, 201, created.get_data(as_text=True))
        quotation = created.get_json()['data']
        costing_id = quotation['sourceCostingId']

        with app_module._finance_lock:
            finance_data = app_module._load_finance_data()
            stored_quote = next(
                row for row in finance_data['documents']
                if row.get('id') == quotation['id']
            )
            stored_quote['eventId'] = 987654
            app_module._save_finance_data(finance_data)

        response = self.client.get(f'/api/costings/{costing_id}')
        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        self.assertEqual(response.get_json()['data']['vendorDiscrepancies'], [])

    def test_lump_sum_total_preserves_derived_unit_cost_precision(self):
        self.login('owner')
        costing = self.create_costing(lineItems=[{
            'id': 'lump-sum-line',
            'description': 'Lump sum equipment package',
            'category': 'Audio',
            'quantity': 3,
            'multiplier': 1,
            'vendorName': 'Package Vendor',
            'itemCost': 33.333333,
            'targetMarginPercent': 20,
            'salePrice': 120,
            'isCustom': True,
        }])
        line = costing['lineItems'][0]
        self.assertEqual(line['itemCost'], 33.333333)
        self.assertEqual(line['costTotal'], 100)

        suggestion = self.client.post('/api/costings/cost-suggestion', json={
            'line': {
                'description': line['description'],
                'vendorName': 'Package Vendor',
            }
        })
        self.assertEqual(suggestion.status_code, 200)
        self.assertEqual(suggestion.get_json()['data']['itemCost'], 33.333333)

    def test_costing_line_controls_expose_requested_steps_and_editable_total(self):
        script_path = os.path.join(
            os.path.dirname(app_module.__file__), 'static', 'js', 'costing.js',
        )
        with open(script_path, 'r', encoding='utf-8') as script_file:
            source = script_file.read()
        self.assertIn('aria-label="Quantity" type="number" min="0" step="1"', source)
        self.assertIn("step=\".5\" value=\"${costingAttr(line.multiplier)}\"", source)
        self.assertIn('data-line-cost-total aria-label="Cost total"', source)
        self.assertIn('function costingLineCostTotal(index, value)', source)
        self.assertIn('function costingFormatMoneyInput(input)', source)
        self.assertIn('onblur="costingFormatMoneyInput(this)"', source)
        self.assertIn('finance-add-row finance-add-row-expanded costing-add-item', source)
        self.assertIn('<main class="costing-line-workspace">', source)
        self.assertIn('id="costingAddCategoryInput"', source)
        self.assertIn('costingShowAddCategorySuggestions', source)
        self.assertIn('costingToggleCategory', source)
        self.assertIn('function costingCategoryDefaults(category', source)
        self.assertIn('multiplier: defaults.multiplier', source)
        self.assertIn('targetMarginPercent: defaults.targetMarginPercent', source)
        self.assertIn('function costingDragLineStart(event, index)', source)
        self.assertIn('function costingDropCategory(event, encodedCategory)', source)
        self.assertIn('function costingSetSummaryGrouping(grouping)', source)
        self.assertIn('data-costing-summary-group="vendor"', source)
        self.assertIn("String(line.vendorName || '').trim() || 'Unassigned'", source)
        self.assertIn('value="${costingAttr(line.salePrice.toFixed(2))}"', source)
        self.assertIn('divisor ? totalSale / divisor : totalSale', source)
        self.assertIn('sale.value = line.salePrice.toFixed(2)', source)
        self.assertIn('function costingVendorManagementMarkup(', source)
        self.assertIn("placeholder=\"Unassigned\"", source)
        self.assertIn("updateAppDetailHistory(`/costing/${encodeURIComponent(id)}`", source)
        self.assertIn('finance-drag-handle costing-line-drag-handle', source)
        self.assertNotIn('onclick="costingAddCategory()"', source)
        self.assertNotIn('+ Category', source)

        css_path = os.path.join(
            os.path.dirname(app_module.__file__), 'static', 'css', 'costing.css',
        )
        with open(css_path, 'r', encoding='utf-8') as css_file:
            css_source = css_file.read()
        category_header_css = css_source.split(
            '.costing-category-header {', 1,
        )[1].split('}', 1)[0]
        self.assertIn('border-bottom: 0;', category_header_css)
        self.assertNotIn('.costing-header-menu > summary::after', css_source)
        self.assertIn(
            '.costing-header-menu > summary { list-style: none; cursor: pointer; }',
            css_source,
        )

    def test_costing_deep_link_and_plan_vendor_card_sources(self):
        app_script_path = os.path.join(
            os.path.dirname(app_module.__file__), 'static', 'js', 'app.js',
        )
        with open(app_script_path, 'r', encoding='utf-8') as script_file:
            source = script_file.read()
        self.assertIn("return { kind: 'costing', id: decodeURIComponent(match[1]) }", source)
        self.assertIn("costingOpen(costingRoute.id, { updateHistory: false })", source)
        render = source[source.index('function renderPlanPage()'):source.index(
            'async function loadPlanPage()'
        )]
        self.assertIn('renderPlanVendorManagementCard()', render)
        self.assertNotIn('renderPlanTemplatesCard()', render)
        self.assertIn('/vendor-management', source)
        self.assertIn('function planOpenVendorManagement()', source)
        self.assertIn('class="vendor-management-open"', source)

        costing_script_path = os.path.join(
            os.path.dirname(app_module.__file__), 'static', 'js', 'costing.js',
        )
        with open(costing_script_path, 'r', encoding='utf-8') as script_file:
            costing_source = script_file.read()
        self.assertIn('function costingOpenVendorManagement()', costing_source)
        self.assertNotIn('<span>Summarise by</span>', costing_source)
        self.assertIn('<header><h3>Summary</h3><div class="costing-summary-grouping"', costing_source)

    def test_cost_memory_and_inventory_rename_refresh(self):
        self.login('owner')
        costing = self.create_costing(lineItems=[{
            'description': 'L-Acoustics SB18 Subwoofer',
            'catalogKey': 'inventory:ax|l-acoustics|sb18',
            'sourceAssetIds': ['AX#01'],
            'brand': 'L-Acoustics',
            'model': 'SB18',
            'departmentCode': 'AX',
            'category': 'Audio',
            'vendorName': 'Rental House',
            'itemCost': 88,
            'quantity': 1,
            'multiplier': 1,
            'salePrice': 105.60,
        }])
        suggestion = self.client.post('/api/costings/cost-suggestion', json={
            'line': {
                'description': 'anything',
                'catalogKey': costing['lineItems'][0]['catalogKey'],
                'sourceAssetIds': ['AX#01'],
                'vendorName': 'Rental House',
            }
        })
        self.assertEqual(suggestion.status_code, 200)
        self.assertEqual(suggestion.get_json()['data']['itemCost'], 88)

        self.manager.inventory['AX#01'].model_number = 'KS28'
        self.manager.inventory['AX#01'].description = 'Touring subwoofer'
        self.manager.save_inventory()
        refreshed = self.client.get(f"/api/costings/{costing['id']}").get_json()['data']
        self.assertEqual(refreshed['lineItems'][0]['model'], 'KS28')
        self.assertIn('Touring subwoofer', refreshed['lineItems'][0]['description'])
        self.assertEqual(refreshed['lineItems'][0]['sourceAssetIds'], ['AX#01'])

    def test_conversion_carries_sale_fields_adjustment_and_inventory_links_only(self):
        self.login('owner')
        costing = self.create_costing(
            eventLocation='Marina Bay Sands',
            lineItems=[{
                'id': 'linked-line',
                'catalogKey': 'inventory:ax|l-acoustics|sb18',
                'sourceAssetIds': ['AX#01'],
                'brand': 'L-Acoustics',
                'model': 'SB18',
                'description': 'L-Acoustics SB18 Subwoofer',
                'departmentCode': 'AX',
                'category': 'Audio',
                'quantity': 2,
                'multiplier': 3,
                'multiplierLabel': 'Day',
                'vendorName': 'Rental House',
                'itemCost': 100,
                'targetMarginPercent': 20,
                'salePrice': 720,
                'remarks': 'Internal note must not leave costing',
            }],
            categoryAdjustments=[{'category': 'Audio', 'amount': -20}],
        )
        response = self.client.post(
            f"/api/costings/{costing['id']}/convert-to-quotation", json={}
        )
        self.assertEqual(response.status_code, 201, response.get_data(as_text=True))
        quotation = response.get_json()['data']
        self.assertEqual(quotation['sourceCostingId'], costing['id'])
        self.assertEqual(quotation['projectName'], 'Launch Project')
        self.assertEqual(quotation['eventLocation'], 'Marina Bay Sands')
        self.assertEqual(quotation['totals']['netSubtotal'], 700)
        line = quotation['lineItems'][0]
        self.assertEqual((line['quantity'], line['days'], line['total']), (2, 3, 720))
        self.assertEqual(line['sourceAssetIds'], ['AX#01'])
        self.assertNotIn('remarks', line)
        self.assertNotIn('vendorName', line)
        self.assertNotIn('itemCost', line)
        self.assertEqual(quotation['adjustments'][0]['amount'], -20)

    def test_linked_quotation_and_costing_reconcile_line_items_both_ways(self):
        self.login('owner')
        created = self.client.post('/api/quotations', json={
            'projectName': 'Linked Line Project',
            'lineItems': [{
                'id': 'shared-a',
                'description': 'Speaker A',
                'department': 'Audio',
                'quantity': 2,
                'days': 1,
                'totalMode': 'amount',
                'total': 200,
            }, {
                'id': 'remove-b',
                'description': 'Speaker B',
                'department': 'Audio',
                'quantity': 1,
                'days': 1,
                'totalMode': 'amount',
                'total': 100,
            }],
        })
        self.assertEqual(created.status_code, 201, created.get_data(as_text=True))
        quotation = created.get_json()['data']
        costing = self.client.get(
            f"/api/costings/{quotation['sourceCostingId']}"
        ).get_json()['data']
        self.assertEqual(costing['status'], 'linked')

        first_cost_line = next(
            row for row in costing['lineItems'] if row['id'] == 'shared-a'
        )
        first_cost_line.update({
            'vendorName': 'Rental House',
            'itemCost': 40,
            'remarks': 'Preserve this internal note',
        })
        saved_costing = self.client.put(
            f"/api/costings/{costing['id']}", json=costing,
        )
        self.assertEqual(
            saved_costing.status_code, 200, saved_costing.get_data(as_text=True)
        )

        quotation['lineItems'] = [
            {**quotation['lineItems'][0], 'quantity': 3, 'total': 330},
            {
                'id': 'added-c',
                'description': 'Microphone C',
                'department': 'Audio',
                'quantity': 1,
                'days': 2,
                'totalMode': 'amount',
                'total': 180,
            },
        ]
        quote_update = self.client.put(
            f"/api/quotations/{quotation['id']}", json=quotation,
        )
        self.assertEqual(quote_update.status_code, 200, quote_update.get_data(as_text=True))
        costing = self.client.get(f"/api/costings/{costing['id']}").get_json()['data']
        self.assertEqual(
            [row['id'] for row in costing['lineItems']], ['shared-a', 'added-c']
        )
        preserved = costing['lineItems'][0]
        self.assertEqual((preserved['quantity'], preserved['salePrice']), (3, 330))
        self.assertEqual(preserved['vendorName'], 'Rental House')
        self.assertEqual(preserved['itemCost'], 40)
        self.assertEqual(preserved['remarks'], 'Preserve this internal note')

        costing['lineItems'] = [
            costing['lineItems'][1],
            {
                'id': 'added-d',
                'description': 'Lighting D',
                'category': 'Lighting',
                'quantity': 4,
                'multiplier': 2,
                'vendorName': 'Self',
                'itemCost': 0,
                'salePrice': 480,
            },
        ]
        costing_update = self.client.put(
            f"/api/costings/{costing['id']}", json=costing,
        )
        self.assertEqual(
            costing_update.status_code, 200, costing_update.get_data(as_text=True)
        )
        quotation = self.client.get(
            f"/api/quotations/{quotation['id']}"
        ).get_json()['data']
        self.assertEqual(
            [row['id'] for row in quotation['lineItems']], ['added-c', 'added-d']
        )
        added = quotation['lineItems'][1]
        self.assertEqual((added['quantity'], added['days'], added['total']), (4, 2, 480))
        self.assertNotIn('vendorName', added)
        self.assertNotIn('itemCost', added)

    def test_accepting_linked_quotation_syncs_costing_vendor_total(self):
        self.login('owner')
        created = self.client.post('/api/quotations', json={
            'projectName': 'Confirmed Rental Project',
            'lineItems': [{
                'id': 'rental-item',
                'description': 'Rental console',
                'department': 'Audio',
                'quantity': 2,
                'days': 3,
                'totalMode': 'amount',
                'total': 900,
            }],
        })
        self.assertEqual(created.status_code, 201, created.get_data(as_text=True))
        quotation = created.get_json()['data']
        costing = self.client.get(
            f"/api/costings/{quotation['sourceCostingId']}"
        ).get_json()['data']
        costing['lineItems'][0].update({
            'vendorName': 'Event Rental Co',
            'itemCost': 75,
        })
        saved = self.client.put(
            f"/api/costings/{costing['id']}", json=costing,
        )
        self.assertEqual(saved.status_code, 200, saved.get_data(as_text=True))

        accepted = self.client.put(
            f"/api/quotations/{quotation['id']}", json={'status': 'accepted'},
        )
        self.assertEqual(accepted.status_code, 200, accepted.get_data(as_text=True))
        accepted_quote = accepted.get_json()['data']
        self.assertTrue(accepted_quote['eventId'])
        workforce = load_workforce(self.manager.data_folder)
        vendor = next(
            row for row in workforce['vendors']
            if row['name'] == 'Event Rental Co'
        )
        rental = next(
            row for row in vendor['costingRentals']
            if row['costingId'] == costing['id']
        )
        self.assertEqual(rental['amount'], 450)
        assignment = next(
            row for row in event_assignments(workforce, accepted_quote['eventId'])
            if row.get('vendorId') == vendor['id']
        )
        self.assertEqual(assignment['department'], 'AX')
        self.assertEqual(assignment['providerType'], 'service')
        self.assertEqual(assignment['serviceName'], 'Audio')
        self.assertEqual(assignment['serviceCost'], 450)
        self.assertEqual(assignment['sourceCostingId'], costing['id'])

        changed = self.client.put(
            f"/api/events/{accepted_quote['eventId']}/workforce/assignments/{assignment['id']}",
            json={
                'department': assignment['department'],
                'subprojectId': assignment['subprojectId'],
                'providerType': 'service',
                'workDates': assignment['workDates'],
                'days': assignment['days'],
                'serviceName': assignment['serviceName'],
                'serviceCost': 500,
            },
        )
        self.assertEqual(changed.status_code, 200, changed.get_data(as_text=True))
        event_linked_costing = self.client.get(
            f"/api/costings/{costing['id']}"
        ).get_json()['data']
        self.assertEqual(event_linked_costing['lineItems'][0]['costTotal'], 450)
        self.assertEqual(event_linked_costing['vendorDiscrepancies'][0]['actualAmount'], 500)
        self.assertEqual(event_linked_costing['vendorDiscrepancies'][0]['expectedAmount'], 450)

    def test_workforce_vendor_ui_hides_internal_costing_rentals(self):
        source_path = os.path.join(
            os.path.dirname(app_module.__file__),
            'static', 'js', 'workforce-admin.js',
        )
        with open(source_path, encoding='utf-8') as source_file:
            source = source_file.read()
        self.assertNotIn('Costing-linked rentals', source)
        self.assertNotIn('costing rental', source)
        self.assertNotIn('data-costing-rental-index', source)

    def test_vendor_management_controls_event_plan_loans(self):
        self.login('owner')
        created = self.client.post('/api/quotations', json={
            'projectName': 'Vendor Plan Project',
            'lineItems': [{
                'id': 'speaker-line',
                'catalogKey': 'inventory:ax|l-acoustics|sb18|subwoofer',
                'sourceAssetIds': ['AX#01'],
                'brand': 'L-Acoustics',
                'model': 'SB18',
                'description': 'L-Acoustics SB18 Subwoofer',
                'department': 'Audio',
                'departmentCode': 'AX',
                'quantity': 4,
                'days': 1,
                'totalMode': 'amount',
                'total': 800,
            }],
        })
        quotation = created.get_json()['data']
        costing = self.client.get(
            f"/api/costings/{quotation['sourceCostingId']}"
        ).get_json()['data']
        self_line = costing['lineItems'][0]
        self_line['quantity'] = 2
        self_line['salePrice'] = 400
        vendor_line = {
            **self_line,
            'id': 'vendor-speakers',
            'quantity': 2,
            'vendorName': 'Rental House',
            'vendorId': '',
            'itemCost': 100,
            'salePrice': 400,
        }
        costing['lineItems'] = [self_line, vendor_line]
        saved = self.client.put(
            f"/api/costings/{costing['id']}", json=costing
        )
        self.assertEqual(saved.status_code, 200, saved.get_data(as_text=True))
        saved_costing = saved.get_json()['data']
        self.assertEqual(saved_costing['vendorManagement'][0]['mode'], 'dry-hire')

        accepted = self.client.put(
            f"/api/quotations/{quotation['id']}", json={'status': 'accepted'}
        )
        self.assertEqual(accepted.status_code, 200, accepted.get_data(as_text=True))
        event_id = accepted.get_json()['data']['eventId']
        event = self.manager.events[event_id]
        loans = [
            app_module._parse_custom_marker(ref)
            for ref in event.prepared_items
            if app_module._parse_custom_marker(ref)
        ]
        self.assertEqual([(row['company'], row['quantity']) for row in loans], [
            ('Rental House', 2),
        ])
        model_markers = [
            app_module._parse_model_marker(ref)
            for ref in event.prepared_items
            if app_module._parse_model_marker(ref)
        ]
        self.assertEqual(sum(int(row['quantity']) for row in model_markers), 2)

        key = self.client.get(
            f"/api/costings/{costing['id']}"
        ).get_json()['data']['vendorManagement'][0]['key']
        outsourced = self.client.put(
            f'/api/events/{event_id}/vendor-management',
            json={'key': key, 'mode': 'outsourced'},
        )
        self.assertEqual(outsourced.status_code, 200, outsourced.get_data(as_text=True))
        self.assertEqual(outsourced.get_json()['data'][0]['mode'], 'outsourced')
        event = self.manager.events[event_id]
        self.assertFalse(any(
            (app_module._parse_custom_marker(ref) or {}).get('company') == 'Rental House'
            for ref in event.prepared_items
        ))
        self.assertEqual(
            self.client.get(f'/api/events/{event_id}').get_json()['data']['vendorManagement'][0]['mode'],
            'outsourced',
        )

    def test_subprojects_and_split_sources_stay_segregated_but_quote_combines(self):
        self.login('owner')
        created = self.client.post('/api/quotations', json={
            'projectName': 'Multi-room Project',
            'subprojects': [
                {'id': 'main', 'name': 'Ballroom'},
                {'id': 'breakout', 'name': 'Breakout Room'},
            ],
            'lineItems': [{
                'id': 'ballroom-speaker',
                'catalogKey': 'inventory:ax|l-acoustics|sb18',
                'sourceAssetIds': ['AX#01'],
                'description': 'L-Acoustics SB18 Subwoofer',
                'department': 'Audio',
                'departmentCode': 'AX',
                'subprojectId': 'main',
                'quantity': 4,
                'days': 1,
                'totalMode': 'amount',
                'total': 400,
            }, {
                'id': 'breakout-speaker',
                'catalogKey': 'inventory:ax|l-acoustics|sb18',
                'sourceAssetIds': ['AX#01'],
                'description': 'L-Acoustics SB18 Subwoofer',
                'department': 'Audio',
                'departmentCode': 'AX',
                'subprojectId': 'breakout',
                'quantity': 2,
                'days': 1,
                'totalMode': 'amount',
                'total': 240,
            }],
        })
        self.assertEqual(created.status_code, 201, created.get_data(as_text=True))
        quotation = created.get_json()['data']
        costing = self.client.get(
            f"/api/costings/{quotation['sourceCostingId']}"
        ).get_json()['data']
        self.assertEqual(
            [(row['id'], row['name']) for row in costing['subprojects']],
            [('main', 'Ballroom'), ('breakout', 'Breakout Room')],
        )
        ballroom = next(
            row for row in costing['lineItems']
            if row['subprojectId'] == 'main'
        )
        ballroom.update({
            'id': 'self-split',
            'quotationLineId': 'ballroom-speaker',
            'quantity': 3,
            'salePrice': 300,
            'vendorName': 'Self',
        })
        vendor_split = {
            **ballroom,
            'id': 'vendor-split',
            'quantity': 2,
            'salePrice': 260,
            'vendorName': 'Rental House',
            'vendorId': '',
            'vendorType': 'vendor',
            'itemCost': 50,
        }
        costing['lineItems'] = [ballroom, vendor_split] + [
            row for row in costing['lineItems'] if row['subprojectId'] == 'breakout'
        ]
        response = self.client.put(
            f"/api/costings/{costing['id']}", json=costing,
        )
        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        saved_costing = response.get_json()['data']
        ballroom_rows = [
            row for row in saved_costing['lineItems']
            if row['subprojectId'] == 'main'
        ]
        self.assertEqual(len(ballroom_rows), 2)
        self.assertEqual(
            {row['quotationLineId'] for row in ballroom_rows},
            {'ballroom-speaker'},
        )

        quote = self.client.get(
            f"/api/quotations/{quotation['id']}"
        ).get_json()['data']
        self.assertEqual(len(quote['lineItems']), 2)
        combined = next(
            row for row in quote['lineItems'] if row['subprojectId'] == 'main'
        )
        breakout = next(
            row for row in quote['lineItems'] if row['subprojectId'] == 'breakout'
        )
        self.assertEqual((combined['quantity'], combined['total']), (5, 560))
        self.assertEqual((breakout['quantity'], breakout['total']), (2, 240))

        quote['subprojects'] = [{'id': 'main', 'name': 'Ballroom'}]
        quote['lineItems'] = [combined]
        updated = self.client.put(
            f"/api/quotations/{quote['id']}", json=quote,
        )
        self.assertEqual(updated.status_code, 200, updated.get_data(as_text=True))
        costing_after_quote = self.client.get(
            f"/api/costings/{costing['id']}"
        ).get_json()['data']
        self.assertEqual(costing_after_quote['subprojects'], [{'id': 'main', 'name': 'Ballroom'}])
        self.assertEqual(
            {row['id'] for row in costing_after_quote['lineItems']},
            {'self-split', 'vendor-split'},
        )

    def test_split_sale_rate_is_shared_unless_multiplier_differs(self):
        self.login('owner')
        quotation = self.client.post('/api/quotations', json={
            'projectName': 'Split Price Project',
            'lineItems': [{
                'id': 'speaker-line',
                'catalogKey': 'inventory:ax|l-acoustics|sb18',
                'sourceAssetIds': ['AX#01'],
                'description': 'L-Acoustics SB18 Subwoofer',
                'department': 'Audio',
                'departmentCode': 'AX',
                'subprojectId': 'main',
                'quantity': 5,
                'days': 1,
                'totalMode': 'amount',
                'total': 500,
            }],
        }).get_json()['data']
        costing = self.client.get(
            f"/api/costings/{quotation['sourceCostingId']}"
        ).get_json()['data']
        template = costing['lineItems'][0]
        costing['lineItems'] = [{
            **template,
            'id': 'self-price-split',
            'quantity': 3,
            'multiplier': 1,
            'multiplierLabel': 'Day',
            'salePrice': 300,
            'vendorName': 'Self',
        }, {
            **template,
            'id': 'vendor-price-split',
            'catalogKey': '',
            'sourceAssetIds': [],
            'brand': '',
            'model': '',
            'isCustom': True,
            'quantity': 2,
            'multiplier': 1,
            'multiplierLabel': 'Mult',
            'salePrice': 260,
            'vendorName': 'Rental House',
        }, {
            **template,
            'id': 'different-days-split',
            'quotationLineId': '',
            'quantity': 1,
            'multiplier': 2,
            'multiplierLabel': 'Day',
            'salePrice': 400,
            'vendorName': 'Second Rental House',
        }]
        # Keep the matching custom allocation non-adjacent so canonical
        # capture must regroup and then rehydrate the Costing projection.
        costing['lineItems'] = [
            costing['lineItems'][0],
            costing['lineItems'][2],
            costing['lineItems'][1],
        ]
        response = self.client.put(
            f"/api/costings/{costing['id']}", json=costing,
        )
        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        saved = response.get_json()['data']
        one_day = [row for row in saved['lineItems'] if row['multiplier'] == 1]
        self.assertEqual(len(one_day), 2)
        self.assertEqual(
            {round(row['salePrice'] / row['quantity'], 2) for row in one_day},
            {112.0},
        )
        two_day = next(row for row in saved['lineItems'] if row['multiplier'] == 2)
        self.assertEqual(two_day['salePrice'] / (two_day['quantity'] * 2), 200)

        linked_quote = self.client.get(
            f"/api/quotations/{quotation['id']}"
        ).get_json()['data']
        self.assertEqual(len(linked_quote['lineItems']), 2)
        quote_one_day = next(row for row in linked_quote['lineItems'] if row['days'] == 1)
        quote_two_day = next(row for row in linked_quote['lineItems'] if row['days'] == 2)
        self.assertEqual((quote_one_day['quantity'], quote_one_day['total']), (5, 560))
        self.assertEqual((quote_two_day['quantity'], quote_two_day['total']), (1, 400))
        self.assertNotEqual(quote_one_day['id'], quote_two_day['id'])

        saved['lineItems'][0]['salePrice'] = 450
        propagated = self.client.put(
            f"/api/costings/{costing['id']}", json=saved,
        )
        self.assertEqual(
            propagated.status_code, 200, propagated.get_data(as_text=True)
        )
        propagated_rows = [
            row for row in propagated.get_json()['data']['lineItems']
            if row['multiplier'] == 1
        ]
        self.assertEqual(
            {round(row['salePrice'] / row['quantity'], 2) for row in propagated_rows},
            {150.0},
        )

    def test_sent_quotation_requires_costing_revision_decision(self):
        self.login('owner')
        created = self.client.post('/api/quotations', json={
            'projectName': 'Revision Decision Project',
            'lineItems': [{
                'id': 'priced-line',
                'description': 'Projector',
                'department': 'Video',
                'quantity': 1,
                'days': 1,
                'totalMode': 'amount',
                'total': 500,
            }],
        }).get_json()['data']
        sent_response = self.client.put(
            f"/api/quotations/{created['id']}",
            json={'status': 'sent'},
        )
        self.assertEqual(sent_response.status_code, 200, sent_response.get_data(as_text=True))
        sent = sent_response.get_json()['data']
        costing = self.client.get(
            f"/api/costings/{created['sourceCostingId']}"
        ).get_json()['data']
        costing['lineItems'][0]['salePrice'] = 650

        blocked = self.client.put(
            f"/api/costings/{costing['id']}", json=costing,
        )
        self.assertEqual(blocked.status_code, 409, blocked.get_data(as_text=True))
        self.assertEqual(
            blocked.get_json()['code'], 'quotation_revision_decision_required'
        )
        unchanged = self.client.get(
            f"/api/quotations/{created['id']}"
        ).get_json()['data']
        self.assertEqual((unchanged['revision'], unchanged['status']), (1, 'sent'))
        self.assertEqual(unchanged['lineItems'][0]['total'], 500)

        revised = self.client.put(
            f"/api/costings/{costing['id']}",
            json={**costing, 'quotationSyncMode': 'new-revision'},
        )
        self.assertEqual(revised.status_code, 200, revised.get_data(as_text=True))
        revised_quote = self.client.get(
            f"/api/quotations/{created['id']}"
        ).get_json()['data']
        self.assertEqual((revised_quote['revision'], revised_quote['status']), (2, 'draft'))
        self.assertEqual(revised_quote['lineItems'][0]['total'], 650)
        self.assertEqual(len(revised_quote['revisions']), 1)
        self.assertEqual(revised_quote['revisions'][0]['snapshot']['lineItems'][0]['total'], 500)

        sent_again = self.client.put(
            f"/api/quotations/{created['id']}", json={'status': 'sent'},
        ).get_json()['data']
        costing = self.client.get(
            f"/api/costings/{costing['id']}"
        ).get_json()['data']
        costing['lineItems'][0]['salePrice'] = 700
        edited = self.client.put(
            f"/api/costings/{costing['id']}",
            json={**costing, 'quotationSyncMode': 'edit-current'},
        )
        self.assertEqual(edited.status_code, 200, edited.get_data(as_text=True))
        edited_quote = self.client.get(
            f"/api/quotations/{created['id']}"
        ).get_json()['data']
        self.assertEqual((edited_quote['revision'], edited_quote['status']), (2, 'sent'))
        self.assertEqual(edited_quote['lineItems'][0]['total'], 700)
        current_snapshot = next(
            row for row in edited_quote['revisions'] if row['revision'] == 2
        )
        self.assertEqual(current_snapshot['snapshot']['lineItems'][0]['total'], 700)

    def test_provider_suggestions_put_vendors_before_workers(self):
        self.login('owner')
        workforce = load_workforce(self.manager.data_folder)
        workforce['vendors'] = [{
            'id': 'vendor-one',
            'name': 'Alpha Rentals',
            'memberIds': [],
            'active': True,
        }]
        workforce['freelancers'] = [{
            'id': 'worker-one',
            'name': 'Aaron Worker',
            'active': True,
        }]
        save_workforce(self.manager.data_folder, workforce)
        response = self.client.get('/api/costings/lookups')
        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        providers = response.get_json()['data']['vendors']
        self.assertEqual(
            [(row['name'], row['type']) for row in providers],
            [('Alpha Rentals', 'vendor'), ('Aaron Worker', 'worker')],
        )

    def test_linked_lines_are_canonical_and_survive_repeated_load_and_save(self):
        self.login('owner')
        quotation = self.client.post('/api/quotations', json={
            'projectName': 'Canonical Line Project',
            'lineItems': [{
                'id': 'canonical-line',
                'catalogKey': 'inventory:ax|l-acoustics|sb18',
                'sourceAssetIds': ['AX#01'],
                'description': 'L-Acoustics SB18 Subwoofer',
                'department': 'Audio',
                'departmentCode': 'AX',
                'subprojectId': 'main',
                'quantity': 3,
                'days': 1,
                'totalMode': 'amount',
                'total': 450,
            }],
        }).get_json()['data']
        finance_path = os.path.join(
            self.manager.data_folder, app_module.FINANCE_FILENAME,
        )

        with open(finance_path, 'r', encoding='utf-8') as finance_file:
            persisted = json.load(finance_file)
        raw_quote = next(
            row for row in persisted['documents']
            if row.get('id') == quotation['id']
        )
        raw_costing = next(
            row for row in persisted['documents']
            if row.get('id') == quotation['sourceCostingId']
        )
        self.assertNotIn('lineItems', raw_quote)
        self.assertNotIn('lineItems', raw_costing)
        shared = persisted['linkedLineItems'][quotation['id']]
        self.assertEqual(shared['quotationLineCount'], 1)
        self.assertEqual(shared['costingLineCount'], 1)
        self.assertEqual(len(shared['checksum']), 64)

        hydrated = app_module._load_finance_data()
        app_module._save_finance_data(hydrated)
        with open(finance_path, 'r', encoding='utf-8') as finance_file:
            raw_payload = json.load(finance_file)
        app_module._save_finance_data(raw_payload)

        reloaded_quote = self.client.get(
            f"/api/quotations/{quotation['id']}"
        ).get_json()['data']
        reloaded_costing = self.client.get(
            f"/api/costings/{quotation['sourceCostingId']}"
        ).get_json()['data']
        self.assertEqual(reloaded_quote['lineItems'][0]['id'], 'canonical-line')
        self.assertEqual(reloaded_costing['lineItems'][0]['quotationLineId'], 'canonical-line')

    def test_version_13_migration_is_lossless_and_idempotent(self):
        self.login('owner')
        quotation = self.client.post('/api/quotations', json={
            'projectName': 'Migration Project',
            'lineItems': [{
                'id': 'migration-line',
                'description': 'Migration Speaker',
                'department': 'Audio',
                'departmentCode': 'AX',
                'subprojectId': 'main',
                'quantity': 4,
                'days': 2,
                'totalMode': 'amount',
                'total': 800,
            }],
        }).get_json()['data']
        finance_path = os.path.join(
            self.manager.data_folder, app_module.FINANCE_FILENAME,
        )
        hydrated = app_module._load_finance_data()
        legacy = {**hydrated, 'version': 13}
        legacy.pop('linkedLineItems', None)
        with open(finance_path, 'w', encoding='utf-8') as finance_file:
            json.dump(legacy, finance_file, indent=2)

        first_load = app_module._load_finance_data()
        second_load = app_module._load_finance_data()
        for loaded in (first_load, second_load):
            quote = next(
                row for row in loaded['documents']
                if row.get('id') == quotation['id']
            )
            costing = next(
                row for row in loaded['documents']
                if row.get('id') == quotation['sourceCostingId']
            )
            self.assertEqual(len(quote['lineItems']), 1)
            self.assertEqual(len(costing['lineItems']), 1)
            self.assertEqual(quote['lineItems'][0]['id'], 'migration-line')

        with open(finance_path, 'r', encoding='utf-8') as finance_file:
            migrated = json.load(finance_file)
        self.assertEqual(migrated['version'], app_module.FINANCE_VERSION)
        record = migrated['linkedLineItems'][quotation['id']]
        self.assertEqual(record['quotationLineCount'], 1)
        self.assertEqual(record['costingLineCount'], 1)

    def test_invalid_canonical_checksum_fails_without_overwriting_data(self):
        self.login('owner')
        quotation = self.client.post('/api/quotations', json={
            'projectName': 'Checksum Project',
            'lineItems': [{
                'id': 'checksum-line',
                'description': 'Checksum Item',
                'department': 'Audio',
                'quantity': 1,
                'days': 1,
                'total': 100,
            }],
        }).get_json()['data']
        finance_path = os.path.join(
            self.manager.data_folder, app_module.FINANCE_FILENAME,
        )
        with open(finance_path, 'r', encoding='utf-8') as finance_file:
            tampered = json.load(finance_file)
        tampered['linkedLineItems'][quotation['id']]['checksum'] = 'invalid'
        with open(finance_path, 'w', encoding='utf-8') as finance_file:
            json.dump(tampered, finance_file, indent=2)

        with self.assertRaisesRegex(ValueError, 'checksum mismatch'):
            app_module._load_finance_data()
        with open(finance_path, 'r', encoding='utf-8') as finance_file:
            untouched = json.load(finance_file)
        self.assertEqual(
            untouched['linkedLineItems'][quotation['id']]['checksum'],
            'invalid',
        )

    def test_linked_costing_can_be_deleted_without_deleting_quotation(self):
        self.login('owner')
        quotation = self.client.post('/api/quotations', json={
            'projectName': 'Keep the quotation',
            'lineItems': [{
                'description': 'Audio package',
                'department': 'Audio',
                'quantity': 1,
                'days': 1,
                'total': 200,
            }],
        }).get_json()['data']
        costing_id = quotation['sourceCostingId']

        deleted = self.client.delete(f'/api/costings/{costing_id}')

        self.assertEqual(deleted.status_code, 200, deleted.get_data(as_text=True))
        refreshed = self.client.get(
            f"/api/quotations/{quotation['id']}"
        ).get_json()['data']
        self.assertEqual(refreshed['sourceCostingId'], '')
        self.assertEqual(refreshed['projectName'], 'Keep the quotation')
        self.assertEqual(self.client.get(f'/api/costings/{costing_id}').status_code, 404)

        recreated = self.client.post(
            f"/api/quotations/{quotation['id']}/costing", json={},
        )
        self.assertEqual(recreated.status_code, 201, recreated.get_data(as_text=True))
        replacement_id = recreated.get_json()['data']['id']
        self.assertNotEqual(replacement_id, costing_id)
        self.assertEqual(
            recreated.get_json()['quotation']['sourceCostingId'], replacement_id,
        )

    def test_line_group_metadata_round_trips_between_quote_and_costing(self):
        self.login('owner')
        quotation = self.client.post('/api/quotations', json={
            'projectName': 'Grouped package',
            'lineItems': [{
                'id': 'grouped-line',
                'catalogKey': 'inventory|l-acoustics|sb18',
                'sourceAssetIds': ['AX#01'],
                'brand': 'L-Acoustics',
                'model': 'SB18',
                'description': 'Subwoofer',
                'department': 'Audio',
                'quantity': 1,
                'days': 1,
                'total': 100,
                'groupId': 'speaker-package',
                'groupTitle': 'Speaker package',
                'groupDisplayFields': ['brand', 'model'],
                'groupItemDays': 2,
                'groupItemQuantity': 3,
                'groupItemUom': 'units',
                'groupItemUnitPrice': 45,
                'groupItemDiscountPercent': 10,
                'groupItemTotalMode': 'calculated',
                'groupItemTotal': 243,
                'groupItemPriceContribution': 121.5,
                'groupItemCommercialStored': True,
            }],
        }).get_json()['data']

        quote_line = quotation['lineItems'][0]
        costing = self.client.get(
            f"/api/costings/{quotation['sourceCostingId']}"
        ).get_json()['data']
        cost_line = costing['lineItems'][0]
        for line in (quote_line, cost_line):
            self.assertEqual(line['groupId'], 'speaker-package')
            self.assertEqual(line['groupTitle'], 'Speaker package')
            self.assertEqual(line['groupDisplayFields'], ['brand', 'model'])
            self.assertEqual(line['groupItemQuantity'], 3)
            self.assertEqual(line.get('groupHeaderQuantity', 1), 1)
            self.assertTrue(line['groupLeader'])
            self.assertEqual(line['groupItemDays'], 2)
            self.assertEqual(line['groupItemUom'], 'units')
            self.assertEqual(line['groupItemUnitPrice'], 45)
            self.assertEqual(line['groupItemDiscountPercent'], 10)
            self.assertEqual(line['groupItemTotal'], 243)
            self.assertEqual(line['groupItemPriceContribution'], 121.5)
            self.assertTrue(line['groupItemCommercialStored'])

    def test_sent_revision_keeps_original_item_spelling_after_inventory_rename(self):
        self.login('owner')
        catalog = self.client.get(
            '/api/finance/catalog?query=SB18'
        ).get_json()['data'][0]
        quotation = self.client.post('/api/quotations', json={
            'projectName': 'Historical Spelling Project',
            'lineItems': [{
                **catalog,
                'id': 'renamed-inventory-line',
                'subprojectId': 'main',
                'quantity': 1,
                'days': 1,
                'totalMode': 'amount',
                'total': 100,
            }],
        }).get_json()['data']
        original_spelling = quotation['lineItems'][0]['description']
        sent = self.client.put(
            f"/api/quotations/{quotation['id']}", json={'status': 'sent'},
        ).get_json()['data']
        revised = self.client.put(
            f"/api/quotations/{quotation['id']}",
            json={**sent, 'notes': 'Create a new working revision'},
        ).get_json()['data']
        self.assertEqual((revised['revision'], revised['status']), (2, 'draft'))

        renamed = self.client.put('/api/assets/AX%2301', json={
            'id': 'AX#01',
            'department': 'AX',
            'brand': 'L-Acoustics',
            'model': 'SB18 Renamed',
            'description': 'New inventory spelling',
            'applyTo': 'single',
        })
        self.assertEqual(renamed.status_code, 200, renamed.get_data(as_text=True))

        current = self.client.get(
            f"/api/quotations/{quotation['id']}"
        ).get_json()['data']
        costing = self.client.get(
            f"/api/costings/{quotation['sourceCostingId']}"
        ).get_json()['data']
        self.assertIn('SB18 Renamed', current['lineItems'][0]['description'])
        self.assertEqual(
            costing['lineItems'][0]['description'],
            current['lineItems'][0]['description'],
        )
        revision_one = next(
            row for row in current['revisions'] if row['revision'] == 1
        )
        self.assertEqual(
            revision_one['snapshot']['lineItems'][0]['description'],
            original_spelling,
        )


if __name__ == '__main__':
    unittest.main()
