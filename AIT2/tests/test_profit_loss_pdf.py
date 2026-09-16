import io

from pypdf import PdfReader

from profit_loss_pdf import (
    _chart_wedge_angles,
    _expense_category,
    _expense_status,
    _profit_chart_rows,
    _solid_colour,
    _status_palette,
    build_profit_loss_pdf,
)


def _summary():
    return {
        'revenue': 12000,
        'quotationRevenue': 12000,
        'invoiceDiscount': 0,
        'directCosts': 3100,
        'manpowerCost': 2200,
        'transportCost': 900,
        'otherExpenses': 450,
        'beforeCommission': 8450,
        'commission': 250,
        'netProfit': 8200,
        'profitMargin': 68.33,
    }


def test_profit_chart_matches_the_app_palette_order_and_breakdown():
    payload = {
        'departmentColours': {'AU': '#DDEEFF'},
        'profitChart': [
            {'key': 'manpower-au', 'group': 'manpower', 'department': 'AU', 'label': 'Manpower - Audio', 'amount': 100},
            {'key': 'equipment-transport', 'group': 'equipment-transport', 'label': 'Equipment Transport', 'amount': 90},
            *[
                {'key': f'other-{index}', 'group': 'other', 'label': f'Other {index}', 'amount': 80 - index}
                for index in range(9)
            ],
        ],
    }

    rows = _profit_chart_rows(payload)

    assert len(rows) == 11
    assert [row['label'] for row in rows[:2]] == [
        'Manpower - Audio', 'Equipment Transport',
    ]
    assert rows[0]['colour'] == _solid_colour('#DDEEFF')
    assert rows[1]['colour'] == '#D97706'
    assert all(not row['label'].startswith('Other categories') for row in rows)


def test_expense_category_and_status_labels_match_the_app():
    assert _expense_category({
        'source': 'worker-claim', 'categoryKey': 'crew-transport',
        'categoryLabel': 'Transport', 'department': 'AU',
    }) == 'Crew Transport - AU'
    assert _expense_category({
        'source': 'worker-claim', 'categoryKey': 'equipment-transport',
        'categoryLabel': 'Transport', 'department': 'LG',
    }) == 'Equipment Transport - LG'
    assert _expense_category({
        'source': 'transport-invoice', 'categoryKey': 'transport',
        'categoryLabel': 'Transport', 'department': 'Transport',
    }) == 'Transport'
    assert _expense_status({'processingState': 'Queued'}) == 'Queued'
    assert _expense_status({'processingState': 'Processing'}) == 'Processing'
    assert _expense_status({'needsReview': True, 'status': 'Pending Review'}) == 'Pending Review'
    assert _expense_status({'status': 'Approved'}) == 'Approved'
    assert _status_palette('Approved') == ('#DCFCE7', '#166534')
    assert _status_palette('Paid') == ('#DBEAFE', '#1E40AF')


def test_profit_chart_sweeps_clockwise_like_the_app():
    wedges = _chart_wedge_angles([{'amount': 25}, {'amount': 75}])

    assert wedges == [(90.0, -90.0), (0.0, -270.0)]


def test_profit_loss_pdf_is_portrait_and_omits_recent_activity():
    payload = {
        'event': {
            'id': 77,
            'name': 'Portrait Export QA',
            'startDate': '2026-09-16',
            'endDate': '2026-09-17',
            'location': 'Studio A',
            'state': 'confirmed',
        },
        'summary': _summary(),
        'breakdown': {'manpowerInvoicesOrEstimate': 2200, 'transportBookings': 900},
        'profitChart': [
            {'key': 'manpower-au', 'group': 'manpower', 'department': 'AU', 'label': 'Manpower - Audio', 'amount': 2200},
            {'key': 'equipment-transport', 'group': 'equipment-transport', 'label': 'Equipment Transport', 'amount': 400},
            {'key': 'transport', 'group': 'transport', 'label': 'Transport', 'amount': 500},
            {'key': 'net-profit', 'group': 'profit', 'label': 'Net Profit', 'amount': 8200},
        ],
        'departmentColours': {'AU': '#DDEEFF'},
        'expenses': [
            {
                'id': 'claim-1', 'source': 'worker-claim', 'sourceLabel': 'Claim',
                'description': 'Crew taxi', 'categoryKey': 'crew-transport',
                'categoryLabel': 'Crew Transport', 'department': 'AU',
                'vendor': 'Alex Tan', 'expenseDate': '2026-09-16',
                'amount': 80, 'needsReview': True, 'status': 'Pending Review',
            },
            {
                'id': 'invoice-1', 'source': 'transport-invoice',
                'sourceLabel': 'Transport invoice', 'description': 'Vehicle booking',
                'categoryKey': 'transport', 'categoryLabel': 'Transport',
                'department': 'Transport', 'vendor': 'Example Transport',
                'expenseDate': '2026-09-16', 'amount': 500, 'status': 'Approved',
            },
        ],
        'activity': [{
            'timestamp': '2026-09-16T12:00:00',
            'user': 'QA User',
            'action': 'ACTIVITY-MUST-NOT-APPEAR',
        }],
    }
    pdf = build_profit_loss_pdf(
        payload,
        {'companyName': 'Example Events', 'themeColor': '#14B8A6'},
        generated_by='QA User',
    )

    reader = PdfReader(io.BytesIO(pdf))
    assert reader.pages
    assert all(
        float(page.mediabox.width) < float(page.mediabox.height)
        for page in reader.pages
    )
    text = '\n'.join(page.extract_text() or '' for page in reader.pages)
    assert 'Recent Event Activity' not in text
    assert 'ACTIVITY-MUST-NOT-APPEAR' not in text
    for expected in (
        'PROJECT PROFIT AND LOSS',
        'Profit Summary',
        'Manpower - Audio',
        'Equipment Transport',
        'Crew Transport - AU',
        'Transport',
        'Pending Review',
        'Approved',
    ):
        assert expected in text
