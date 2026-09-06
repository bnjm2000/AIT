"""Isolated local UI review, with synthetic data and ordinary app sign-in."""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from tests.test_accounting_workspace import AccountingWorkspaceTests
import app as app_module

fixture = AccountingWorkspaceTests()
fixture.setUp()
fixture.begin()
fixture.request('settings', dict(gstRegistered=True, gstRegistrationNumber='TEST-GST', accountingBasis='accrual'), method='put')
fixture.request('actions/controls', dict(roles={'alice': 'bookkeeper', 'bob': 'accountant'}, uen='DEMO ONLY', inventoryEnabled=True))
invoice = fixture.post_document(fixture.document(amount=12500, date='2026-09-01', dueDate='2026-09-30', contact='Sample Events Pte Ltd', lines=[dict(description='Production services', quantity=1, unitPrice=12500, taxCode='SR9')]))
fixture.post_document(fixture.document('bill', amount=3200, date='2026-09-02', dueDate='2026-09-20', contact='Sample Equipment Supplier'))
fixture.request('actions/payments', dict(date='2026-09-03', requestId='preview-receipt', allocations=[dict(documentId=invoice['id'], amount=5000, exchangeRate=1)]))
fixture.document('bill', amount=840, date='2026-09-03', dueDate='2026-09-20', contact='Sample Transport')
fixture.request('actions/tasks', dict(title='Review September bank statement', assignedTo='bob', dueDate='2026-09-30'))
fixture.request('actions/tasks', dict(title='Collect supplier tax invoice', assignedTo='alice', dueDate='2026-09-08'))
fixture.request('bank-transactions', dict(date='2026-09-03', description='Sample customer receipt', amount=5000, bankAccount='1000'), expected=201)
app_module.app.config.update(TESTING=True, SESSION_COOKIE_SECURE=False)
print('Isolated accounting preview at http://127.0.0.1:5057/accounting', flush=True)
try:
    app_module.app.run(host='127.0.0.1', port=5057, use_reloader=False, debug=False)
finally:
    fixture.tearDown()
